#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { configFromEnv, loadEnv, pollResult } = (() => {
  const matrix = require('./real-matrix');
  const real = require('./real-test');
  return { ...matrix, loadEnv: real.loadEnv };
})();

const ROOT = path.join(__dirname, '..');
const ENV_FILE = path.resolve(process.env.VOKO_REAL_MATRIX_ENV || path.join(ROOT, '.env.real-matrix.local'));
const ARTIFACT_ROOT = path.join(ROOT, 'artifacts', 'real-tests');
const TERMINAL = new Set(['PASS', 'FAIL', 'NEEDS_USER_ACTION', 'SKIPPED_NOT_READY', 'BLOCKED_BUILD_MISMATCH']);
let stopRequested = false;
const MATRIX_LOCK = path.join(ARTIFACT_ROOT, '.provider-runtime-matrix.lock');

const HELP = `Usage: node scripts/provider-runtime-matrix.js [options]

  --hosts macos,windows,linux
  --providers installed-ready
  --transports all-ready
  --repeat 3
  --resume <runId>
  --faults probe-timeout,runtime-timeout,fingerprint-change,circuit-breaker
  --continue-on-user-action
  --driver visitor|a2a
  --permissions all|none
  --visitor-base-url https://im.vokovoko.com
  --visitor-profile <persistent-profile-directory>
  --dry-run
  --help
`;

function acquireMatrixLock(lockFile = MATRIX_LOCK) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const create = () => {
    const fd = fs.openSync(lockFile, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    fs.closeSync(fd);
  };
  try { create(); } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let owner = null;
    try { owner = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch (_) {}
    let alive = false;
    if (Number(owner?.pid) > 0) {
      try { process.kill(Number(owner.pid), 0); alive = true; } catch (_) {}
    }
    if (alive) throw new Error(`provider runtime matrix is already running (pid ${owner.pid})`);
    fs.unlinkSync(lockFile);
    create();
  }
  return () => {
    try {
      const owner = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      if (Number(owner.pid) === process.pid) fs.unlinkSync(lockFile);
    } catch (_) {}
  };
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function atomicJson(file, value) {
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    // `key` is also used for the non-secret matrix cell identity. Match only
    // credential-shaped field names so checkpoint/resume metadata stays intact.
    if (/^(?:api[_-]?key|access[_-]?key|secret(?:[_-]?key)?|token|access[_-]?token|refresh[_-]?token|password|authorization|cookie)$/i.test(key)) {
      const present = item !== null && item !== undefined && String(item) !== '';
      return [key, present ? { present: true, digest: digest(String(item)).slice(0, 16) } : { present: false }];
    }
    if (/argv|command|path/i.test(key) && typeof item === 'string') return [key, item.replace(/[A-Za-z]:\\[^\s"]+|\/(?:Users|home)\/[^\s"]+/g, '[LOCAL_PATH]')];
    return [key, redact(item)];
  }));
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const [rawKey, inline] = arg.slice(2).split(/=(.*)/s, 2);
    if (inline !== undefined) values[rawKey] = inline;
    else if (argv[index + 1] && !argv[index + 1].startsWith('--')) values[rawKey] = argv[++index];
    else values[rawKey] = true;
  }
  const list = (name, fallback) => String(values[name] || fallback).split(',').map(item => item.trim()).filter(Boolean);
  return {
    hosts: list('hosts', 'macos,windows,linux'),
    providers: String(values.providers || 'installed-ready'),
    transports: String(values.transports || 'all-ready'),
    repeat: Math.max(1, Number(values.repeat || 3)),
    resume: String(values.resume || '').trim(),
    faults: list('faults', ''),
    continueOnUserAction: values['continue-on-user-action'] !== false,
    retries: Math.max(0, Number(values.retries || 2)),
    resultTimeoutMs: Math.max(10_000, Number(values['result-timeout-ms'] || process.env.VOKO_REAL_RESULT_TIMEOUT_MS || 180_000)),
    driver: String(values.driver || 'visitor'),
    permissions: String(values.permissions || 'all') === 'none' ? 'none' : 'all',
    visitorBaseUrl: String(values['visitor-base-url'] || process.env.VOKO_VISITOR_BASE_URL || 'https://im.vokovoko.com'),
    visitorProfile: String(values['visitor-profile'] || process.env.VOKO_VISITOR_PROFILE || path.join(ARTIFACT_ROOT, 'visitor-profile')),
    visitorHeaded: values['visitor-headed'] === true,
    dryRun: values['dry-run'] === true,
  };
}

function methodReady(method) {
  return method && method.configured !== false && method.automaticReady === true
    && method.available !== false && method.mode !== 'pull' && method.provider;
}

function methodNeedsVerification(method, agent = {}) {
  const dedicatedTestAgent = String(agent.agentName || '').startsWith('TEST-');
  return method && (method.configured !== false || dedicatedTestAgent) && method.available !== false
    && method.mode !== 'pull' && method.provider
    && method.automaticReady !== true && method.status === 'verification_required';
}

function methodReadyForDedicatedTest(method, agent = {}) {
  return String(agent.agentName || '').startsWith('TEST-') && method
    && method.available !== false && method.automaticReady === true
    && method.mode !== 'pull' && Boolean(method.provider);
}

function discoverCells(inventories, buildDigest) {
  const cells = [];
  const skipped = [];
  for (const [host, inventory] of Object.entries(inventories)) {
    for (const agent of inventory.agents) {
      const runtime = agent.runtime || {};
      const methods = runtime.deliveryStatus?.methods || runtime.methods || [];
      const candidates = methods.filter(method => methodReady(method)
        || methodReadyForDedicatedTest(method, agent) || methodNeedsVerification(method, agent));
      if (!agent.imUid || runtime.imConnected === false || candidates.length === 0) {
        const pendingMethod = methods.find(method => method.mode !== 'pull' && method.provider);
        skipped.push({ host, agentId: agent.agentId, agentName: agent.agentName, provider: agent.backendType,
          status: 'SKIPPED_NOT_READY', reason: pendingMethod?.reason
            ? `provider_not_ready:${pendingMethod.reason}`
            : runtime.pullOnly ? 'pull_only' : 'automatic_delivery_not_ready' });
        continue;
      }
      for (const method of candidates) {
        const evidence = method.safetyProfile || method.security || {};
        const identity = {
          host, agentId: agent.agentId, agentName: agent.agentName, imUid: agent.imUid,
          provider: agent.backendType, transport: method.provider, mode: method.mode,
          frameworkVersion: method.frameworkVersion || method.providerVersion || null,
          runtimeVersion: method.runtimeVersion || method.providerVersion || null,
          runtimeFingerprint: method.runtimeFingerprint || evidence.runtimeFingerprint || null,
          buildDigest,
        };
        cells.push({ ...identity, key: digest(identity), method: redact(method),
          needsVerification: methodNeedsVerification(method, agent) });
      }
    }
    const registeredTypes = new Set(inventory.agents.map(agent => agent.backendType));
    for (const provider of inventory.providerEnvironment?.detected || []) {
      if (!registeredTypes.has(provider.type)) skipped.push({ host, agentId: null,
        agentName: null, provider: provider.type, status: 'SKIPPED_NOT_READY',
        reason: 'installed_provider_not_registered', installed: true,
        instances: redact(provider.instances || []) });
    }
  }
  return { cells, skipped };
}

function filterCells(cells, options) {
  const providers = options.providers === 'installed-ready' ? null
    : new Set(String(options.providers).split(',').map(item => item.trim()).filter(Boolean));
  const transports = options.transports === 'all-ready' ? null
    : new Set(String(options.transports).split(',').map(item => item.trim()).filter(Boolean));
  return cells.filter(cell => (!providers || providers.has(cell.provider) || providers.has(cell.method?.family))
    && (!transports || transports.has(cell.transport) || transports.has(cell.mode)));
}

function runtimeBuildEvidence(status = {}) {
  const digestValue = String(status.runtimeBuildDigest || status.buildDigest || '');
  const state = status.buildState || (status.runtimeBuildDigest ? 'unknown' : 'legacy');
  return { digest: digestValue, state, usable: Boolean(digestValue) && !['stale', 'unknown'].includes(state) };
}

function enrichCellRuntime(host, cell) {
  const inspected = callRuntimeControl(host, ['inspect_provider_runtime', '--agentId', cell.agentId,
    '--transportId', cell.transport], 30_000);
  if (!inspected.ok || inspected.value?.success === false || !inspected.value?.data) {
    return { ...cell, runtimeInspection: { ok: false, error: inspected.error || inspected.value?.error || 'runtime_inspection_unavailable' } };
  }
  const runtime = inspected.value.data;
  const enriched = { ...cell,
    frameworkVersion: runtime.frameworkVersion || cell.frameworkVersion || null,
    runtimeVersion: runtime.runtimeVersion || cell.runtimeVersion || null,
    runtimeFingerprint: runtime.runtimeFingerprint || cell.runtimeFingerprint || null,
    platform: runtime.platform || null, arch: runtime.arch || null,
    runtimeInspection: redact(runtime),
  };
  enriched.key = digest({ host: enriched.host, agentId: enriched.agentId, provider: enriched.provider,
    transport: enriched.transport, frameworkVersion: enriched.frameworkVersion,
    runtimeVersion: enriched.runtimeVersion, runtimeFingerprint: enriched.runtimeFingerprint,
    buildDigest: enriched.buildDigest });
  return enriched;
}

function classifyResult(result) {
  const state = String(result?.execution?.state || '');
  const reason = String(result?.execution?.reasonCode || result?.error || '');
  if (state === 'COMPLETED' && result?.reply?.state === 'DELIVERED') return 'PASS';
  if (state === 'AUTH_REQUIRED' || /AUTH|LOGIN|CREDENTIAL/i.test(reason)) return 'NEEDS_USER_ACTION';
  if (['FAILED', 'DELIVERY_UNKNOWN'].includes(state)) return 'FAIL';
  return 'FAIL';
}

function mayRetryAttempt(attempt) {
  return attempt?.outcome === 'not_submitted';
}

function submittedOutcomeUnknown(rounds) {
  return (rounds || []).some(item => item?.execution?.state === 'DELIVERY_UNKNOWN'
    || (item?.messageId && !['COMPLETED', 'FAILED', 'AUTH_REQUIRED'].includes(String(item?.execution?.state || ''))));
}

function chooseSender(inventory, target) {
  return inventory.agents.find(agent => agent.agentId !== target.agentId && agent.imUid
    && agent.runtime?.imConnected !== false
    && (agent.runtime?.pullOnly === true || agent.runtime?.automaticDeliveryReady !== true)) || null;
}

function saferPolicyChange(security) {
  const rank = { low: 0, medium: 1, high: 2 };
  const config = security?.config || {};
  for (const control of security?.controls || []) {
    if (!control?.editable || control.kind !== 'enum' || !Array.isArray(control.values)) continue;
    const current = control.values.find(item => item.value === config[control.id]);
    if (!current) continue;
    const safer = control.values.filter(item => item.value !== current.value
      && (rank[item.risk] ?? 99) < (rank[current.risk] ?? 99)).sort((a, b) => (rank[a.risk] ?? 99) - (rank[b.risk] ?? 99))[0];
    if (safer) return { controlId: control.id, from: current.value, to: safer.value,
      config: { ...config, [control.id]: safer.value } };
  }
  return null;
}

function policyCanaries(security, agentName, marker = 'VOKO-CANARY') {
  const rank = { low: 0, medium: 1, high: 2 };
  const transportConfig = security?.transportPolicy?.config || security?.config || {};
  const instanceConfig = security?.instancePolicy?.config || {};
  const dedicated = String(agentName || '').startsWith('TEST-');
  const canaries = [];
  const scopedControls = [
    ...(security?.instancePolicy?.controls || []).map(control => ({ control, scope: 'agent', config: instanceConfig })),
    ...(security?.controls || []).map(control => ({ control, scope: 'transport', config: transportConfig })),
  ];
  for (const { control, scope, config } of scopedControls) {
    if (!control?.editable) continue;
    const scopedConfig = (next) => ({
      instanceConfig: scope === 'agent' ? next : instanceConfig,
      transportConfig: scope === 'transport' ? next : transportConfig,
    });
    if (control.kind === 'text') {
      const current = String(config[control.id] || '');
      const suffix = `\n[${marker}:${control.id}]`;
      const next = { ...config, [control.id]: `${current}${suffix}`.slice(0, control.maxLength || 2000) };
      canaries.push({ controlId: control.id, scope, kind: 'text', from: current, to: next[control.id],
        config: scopedConfig(next) });
      continue;
    }
    if (control.kind !== 'enum' || !Array.isArray(control.values)) continue;
    const current = control.values.find(item => item.value === config[control.id]);
    const alternatives = control.values.filter(item => item.value !== current?.value)
      .sort((a, b) => (rank[a.risk] ?? 99) - (rank[b.risk] ?? 99));
    const selected = alternatives.find(item => dedicated || (rank[item.risk] ?? 99) <= (rank[current?.risk] ?? 99));
    if (!selected) continue;
    const next = { ...config, [control.id]: selected.value };
    canaries.push({ controlId: control.id, scope, kind: 'enum', from: current?.value, to: selected.value, risk: selected.risk,
      config: scopedConfig(next) });
  }
  return canaries;
}

function commitPolicy(host, cell, config, confirmation = '') {
  const preflight = callSafe(host, ['preflight_provider_security', '--agentId', cell.agentId,
    '--transportId', cell.transport, '--config', JSON.stringify(config)]);
  if (!preflight.ok || preflight.value?.success === false) return { ok: false, stage: 'preflight', error: preflight.error || preflight.value?.error };
  const data = preflight.value.data || {};
  const commitArgs = ['commit_provider_security', '--agentId', cell.agentId, '--preflightToken', data.preflightToken];
  if (confirmation) commitArgs.push('--confirmation', confirmation);
  const committed = callSafe(host, commitArgs);
  return committed.ok && committed.value?.success !== false
    ? { ok: true, preflight: redact(data), commit: redact(committed.value.data) }
    : { ok: false, stage: 'commit', preflight: redact(data), error: committed.error || committed.value?.error };
}

async function captureTurnEvidence(host, cell, sender, turnId, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs ?? 5000));
  const intervalMs = Math.max(1, Number(options.intervalMs ?? 250));
  const args = ['inspect_provider_turn_evidence', '--agentId', cell.agentId];
  if (turnId) args.push('--turnId', turnId);
  if (sender?.imUid) args.push('--channelId', sender.imUid);
  if (sender?.since) args.push('--since', String(sender.since));
  if (cell.transport) args.push('--transportId', cell.transport);
  const deadline = Date.now() + timeoutMs;
  let evidence = null;
  do {
    const result = callSafe(host, args);
    evidence = result.ok ? redact(result.value) : { unavailable: true, error: result.error };
    const turn = evidence?.data?.turn;
    const matchCount = Number(evidence?.data?.matchCount ?? (turn ? 1 : 0));
    if (turn && (turnId || matchCount === 1)) return evidence;
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  } while (true);
  if (!turnId && Number(evidence?.data?.matchCount || 0) > 1) {
    return { ...evidence, data: { ...evidence.data, turn: null }, ambiguous: true };
  }
  return evidence;
}

class PersistentVisitorDriver {
  constructor(options) {
    this.options = options;
    this.context = null;
    this.page = null;
  }

  async start() {
    if (this.context) return;
    const { chromium } = require('playwright');
    this.context = await chromium.launchPersistentContext(this.options.visitorProfile, {
      headless: !this.options.visitorHeaded,
      viewport: { width: 1280, height: 800 },
    });
    this.page = this.context.pages()[0] || await this.context.newPage();
  }

  async visitorId() {
    await this.start();
    const base = this.options.visitorBaseUrl.replace(/\/$/, '');
    if (!this.page.url().startsWith(base)) {
      await this.page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    }
    const visitorId = await this.page.evaluate(() => localStorage.getItem('chat_uid'));
    if (!visitorId) throw new Error('VISITOR_ID_UNAVAILABLE');
    return visitorId;
  }

  async send(url, content, marker, artifact, timeoutMs) {
    await this.start();
    fs.mkdirSync(artifact, { recursive: true });
    const startedAt = Date.now();
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const input = this.page.locator('div.bg-white.border-t input[type="text"]').last();
    await input.waitFor({ state: 'attached', timeout: 60_000 });
    await this.page.waitForFunction(() => {
      const candidates = Array.from(document.querySelectorAll('div.bg-white.border-t input[type="text"]'));
      return candidates.length > 0 && !candidates.at(-1).disabled;
    }, null, { timeout: 45_000 });
    const agentBubbles = this.page.locator('.rounded-2xl:not(.bg-blue-500)');
    // Route changes keep the same SPA page alive. Wait until the asynchronously
    // restored conversation has stopped changing before taking the reply
    // baseline, otherwise an old bubble can be mistaken for this turn's reply.
    let stableSnapshot = '';
    let stableSamples = 0;
    const stableDeadline = Date.now() + 15_000;
    while (Date.now() < stableDeadline && stableSamples < 3) {
      const count = await agentBubbles.count();
      const last = count ? await agentBubbles.last().innerText().catch(() => '') : '';
      const snapshot = `${count}:${last}`;
      if (snapshot === stableSnapshot) stableSamples += 1;
      else { stableSnapshot = snapshot; stableSamples = 0; }
      if (stableSamples < 3) await this.page.waitForTimeout(300);
    }
    const beforeCount = await agentBubbles.count();
    const beforeLast = beforeCount ? await agentBubbles.last().innerText().catch(() => '') : '';
    await this.page.screenshot({ path: path.join(artifact, 'chat-ready.png'), fullPage: true });
    const sentAt = Date.now();
    await input.fill(content);
    await input.press('Enter');
    try {
      await this.page.waitForFunction(expectedMarker => Array.from(document.querySelectorAll('.rounded-2xl.bg-blue-500'))
        .some(element => (element.textContent || '').includes(expectedMarker)), marker, { timeout: 15_000 });
      await this.page.waitForFunction(expectedMarker => {
        const bubbles = Array.from(document.querySelectorAll('.rounded-2xl'));
        const sentIndex = bubbles.findIndex(element => element.classList.contains('bg-blue-500')
          && (element.textContent || '').includes(expectedMarker));
        return sentIndex >= 0 && bubbles.slice(sentIndex + 1)
          .some(element => !element.classList.contains('bg-blue-500'));
      }, marker, { timeout: timeoutMs });
      const replyText = await this.page.evaluate(expectedMarker => {
        const bubbles = Array.from(document.querySelectorAll('.rounded-2xl'));
        const sentIndex = bubbles.findIndex(element => element.classList.contains('bg-blue-500')
          && (element.textContent || '').includes(expectedMarker));
        const reply = bubbles.slice(sentIndex + 1).find(element => !element.classList.contains('bg-blue-500'));
        return reply?.textContent || '';
      }, marker);
      const result = { ok: true, url: this.page.url(), loadMs: Date.now() - startedAt,
        turn: { submitted: true, sentAt, repliedAt: Date.now(), marker, replyMatched: true,
          markerEchoed: replyText.includes(marker), replyText: replyText.slice(0, 1000) } };
      await this.page.screenshot({ path: path.join(artifact, 'chat-replied.png'), fullPage: true });
      atomicJson(path.join(artifact, 'result.json'), result);
      return result;
    } catch (error) {
      const result = { ok: false, url: this.page.url(), loadMs: Date.now() - startedAt,
        turn: { submitted: true, sentAt, repliedAt: null, marker, replyMatched: false,
          error: String(error.message || error), outcome: 'submitted_result_unknown_no_retry' } };
      await this.page.screenshot({ path: path.join(artifact, 'chat-timeout.png'), fullPage: true }).catch(() => {});
      atomicJson(path.join(artifact, 'result.json'), result);
      return result;
    }
  }

  async close() {
    const context = this.context;
    this.context = null;
    this.page = null;
    if (context) await context.close().catch(() => {});
  }
}

async function runVisitorTurn(ctx, cell, round, attempt, options, visitorDriver) {
  const marker = `${ctx.data.runId}-${cell.host}-${cell.transport}-r${round}-a${attempt}`.replace(/[^a-zA-Z0-9-]/g, '-');
  const content = `VOKO Provider 真机验证 ${marker}。请仅用一句话确认收到，并原样包含 ${marker}。不要调用工具。`;
  const artifact = path.join(ctx.dir, 'visitor', cell.key, `round-${round}-attempt-${attempt}`);
  fs.mkdirSync(artifact, { recursive: true });
  const startedAt = Date.now();
  let parsed = null;
  try {
    parsed = await visitorDriver.send(`${options.visitorBaseUrl.replace(/\/$/, '')}/#/chat?peer=${encodeURIComponent(cell.imUid)}`,
      content, marker, artifact, options.resultTimeoutMs);
  } catch (error) {
    return { round, attempt, marker, status: /login|auth/i.test(String(error.message || error)) ? 'NEEDS_USER_ACTION' : 'FAIL',
      durationMs: Date.now() - startedAt, error: String(error.message || error), outcome: 'not_submitted' };
  }
  if (!parsed?.turn?.replyMatched) {
    const error = parsed?.turn?.error || 'visitor_reply_not_observed';
    return { round, attempt, marker, status: /login|auth/i.test(error) ? 'NEEDS_USER_ACTION' : 'FAIL',
      durationMs: Date.now() - startedAt, error, outcome: parsed?.turn?.submitted ? 'submitted_result_unknown_no_retry' : 'not_submitted',
      browser: redact({ url: parsed?.url, loadMs: parsed?.loadMs, turn: parsed?.turn }) };
  }
  return { round, attempt, marker, status: 'PASS', durationMs: Date.now() - startedAt,
    browser: redact({ url: parsed.url, loadMs: parsed.loadMs, turn: parsed.turn }) };
}

function checkpointFor(runId, options, artifactRoot = ARTIFACT_ROOT) {
  const dir = path.join(artifactRoot, runId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'checkpoint.json');
  if (fs.existsSync(file)) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const immutable = ['hosts', 'providers', 'transports', 'repeat', 'faults', 'driver', 'permissions'];
    const changed = immutable.filter(key => JSON.stringify(data.options?.[key]) !== JSON.stringify(options[key]));
    if (changed.length) throw new Error(`resume options differ from checkpoint: ${changed.join(', ')}`);
    return { dir, file, data };
  }
  const data = { schema: 1, runId, startedAt: new Date().toISOString(), updatedAt: null, options, buildDigests: {}, buildStates: {},
    visitorAccess: {}, cells: {}, skipped: [], userActions: [], events: [] };
  atomicJson(file, data);
  return { dir, file, data };
}

function saveCheckpoint(ctx) {
  ctx.data.updatedAt = new Date().toISOString();
  atomicJson(ctx.file, redact(ctx.data));
}

function writeCellArtifact(ctx, record) {
  const dir = path.join(ctx.dir, 'cells');
  fs.mkdirSync(dir, { recursive: true });
  const identity = typeof record.key === 'string' ? record.key : digest({ host: record.host, agentId: record.agentId,
    transport: record.transport, buildDigest: record.buildDigest });
  atomicJson(path.join(dir, `${identity}.json`), redact(record));
}

function callSafe(host, args, timeout = 60_000) {
  try { return { ok: true, value: host.json(args, timeout) }; }
  catch (error) { return { ok: false, error: String(error.message || error) }; }
}

function prepareVisitorAccess(host, inventory, visitorId, agentIds = null) {
  const selectedAgentIds = agentIds ? new Set(agentIds) : null;
  const agents = inventory.agents.filter(agent => String(agent.agentName || '').startsWith('TEST-')
    && (!selectedAgentIds || selectedAgentIds.has(agent.agentId)));
  const results = [];
  for (const agent of agents) {
    const remove = callSafe(host, ['manage_blacklist', '--agentId', agent.agentId, '--action', 'remove',
      '--visitorId', visitorId]);
    const add = callSafe(host, ['manage_whitelist', '--agentId', agent.agentId, '--action', 'add',
      '--visitorId', visitorId, '--reason', 'provider-runtime-matrix']);
    const verify = callSafe(host, ['list_access_lists', '--agentId', agent.agentId, '--listType', 'whitelist',
      '--keyword', visitorId]);
    const rows = Array.isArray(verify.value?.data) ? verify.value.data : [];
    const verified = verify.ok && verify.value?.success !== false
      && rows.some(row => row.visitor_id === visitorId);
    results.push({ agentId: agent.agentId, agentName: agent.agentName,
      ok: remove.ok && remove.value?.success !== false && add.ok && add.value?.success !== false && verified,
      blacklistRemoved: remove.ok && remove.value?.success !== false,
      whitelistAdded: add.ok && add.value?.success !== false,
      whitelistVerified: verified,
      error: remove.error || add.error || verify.error || (!verified ? 'VISITOR_WHITELIST_NOT_VERIFIED' : null) });
  }
  return results;
}

function callRuntimeControl(host, args, timeout = 60_000, retries = 3) {
  let result = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    result = callSafe(host, args, timeout);
    if (result.ok || !/RUNTIME_(?:STARTING|UNAVAILABLE|MISMATCH)/.test(String(result.error || ''))) return result;
    if (attempt < retries) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_000);
  }
  return result;
}

async function runCell(ctx, host, inventory, cell, options, visitorDriver) {
  const previous = ctx.data.cells[cell.key];
  if (previous?.status === 'PASS') return previous;
  if (previous?.rounds?.some(item => item?.status === 'NEEDS_USER_ACTION')) {
    previous.status = 'NEEDS_USER_ACTION';
    return previous;
  }
  if (submittedOutcomeUnknown(previous?.rounds)) {
    previous.outcomeUnknown = true;
    previous.reason ||= 'previous_submitted_turn_outcome_unknown_no_retry';
    return previous;
  }
  if (previous?.status === 'NEEDS_USER_ACTION' || previous?.outcomeUnknown === true) return previous;
  const sender = options.driver === 'visitor' ? null : chooseSender(inventory, cell);
  if (options.driver !== 'visitor' && !sender) return { ...cell, status: 'SKIPPED_NOT_READY', reason: 'no_connected_sender' };
  const record = previous?.status === 'RUNNING'
    ? previous
    : { ...cell, status: 'RUNNING', startedAt: new Date().toISOString(), attempts: [], baseline: {}, rounds: [], faults: [] };
  ctx.data.cells[cell.key] = record;
  saveCheckpoint(ctx);

  const active = inventory.agents.find(agent => agent.agentId === cell.agentId)?.runtime || {};
  const activeMethods = active.deliveryStatus?.methods || active.methods || [];
  record.baseline = redact({ activeAutomaticMode: active.activeAutomaticMode,
    activeProvider: activeMethods.find(item => item.mode === active.activeAutomaticMode && item.automaticReady)?.provider,
    deliveryMethods: activeMethods });
  if (cell.needsVerification) {
    const verified = callRuntimeControl(host, ['verify_delivery_channel', '--agentId', cell.agentId,
      '--providerId', cell.transport], 180_000, 0);
    record.channelVerification = verified.ok ? redact(verified.value) : { error: verified.error };
    if (!verified.ok || verified.value?.success !== true) {
      record.status = /AUTH|LOGIN/i.test(verified.error || verified.value?.error || '') ? 'NEEDS_USER_ACTION' : 'FAIL';
      record.reason = verified.error || verified.value?.error || verified.value?.verification?.detail || 'delivery_channel_verification_failed';
      saveCheckpoint(ctx);
      writeCellArtifact(ctx, record);
      return record;
    }
  }
  const selected = callRuntimeControl(host, ['select_delivery_channel', '--agentId', cell.agentId,
    '--mode', cell.mode, '--providerId', cell.transport]);
  if (!selected.ok || selected.value?.success === false) {
    record.status = /AUTH|LOGIN/i.test(selected.error) ? 'NEEDS_USER_ACTION' : 'FAIL';
    record.reason = selected.error || selected.value?.error || 'delivery_channel_selection_failed';
    return record;
  }

  try {
    const inspected = callSafe(host, ['inspect_provider_security', '--agentId', cell.agentId, '--transportId', cell.transport]);
    record.securityBefore = inspected.ok ? redact(inspected.value) : { unavailable: true, error: inspected.error };
    const refreshStarted = Date.now();
    const refreshed = callSafe(host, ['refresh_provider_security_capability', '--agentId', cell.agentId,
      '--transportId', cell.transport], 35_000);
    record.capabilityRefresh = { durationMs: Date.now() - refreshStarted,
      ...(refreshed.ok ? { result: redact(refreshed.value) } : { error: refreshed.error }) };
    const config = inspected.ok ? inspected.value?.data?.config || {} : {};
    const preview = callSafe(host, ['preview_provider_security_invocation', '--agentId', cell.agentId,
      '--transportId', cell.transport, '--config', JSON.stringify(config)]);
    record.invocationPreview = preview.ok ? redact(preview.value) : { unavailable: true, error: preview.error };
    const securityData = inspected.ok ? inspected.value?.data : null;
    // send_message originates from another VOKO Agent, so this real-device
    // baseline is A2A. Provider visitor policies intentionally exclude A2A;
    // mutating them here would not prove argv changes and would only disturb
    // unrelated visitor traffic. A human visitor driver must run that phase.
    const policyChange = null;
    if (options.driver !== 'visitor' && saferPolicyChange(securityData)) record.policyMutation = {
      status: 'SKIPPED_NOT_READY', reason: 'a2a_scope_excluded_requires_visitor_driver' };
    if (policyChange) record.policyBaseline = { config: redact(securityData.config), revision: securityData.revision,
      capabilityDigest: securityData.capabilityDigest || securityData.capabilityEvidence?.verified?.capabilityDigest || null };

    const pending = record.attempts.at(-1);
    if (pending?.status === 'SUBMITTED' && pending.messageId) {
      const result = await pollResult(host, sender.agentId, pending.messageId, options.resultTimeoutMs);
      pending.status = classifyResult(result);
      pending.durationMs = Date.now() - pending.startedAtMs;
      pending.execution = redact(result?.execution || {});
      pending.reply = redact(result?.reply || {});
      pending.turnEvidence = await captureTurnEvidence(host, cell, sender, result?.execution?.turnId);
      record.rounds.push(pending);
      saveCheckpoint(ctx);
      if (pending.status !== 'PASS') {
        record.status = pending.status;
        record.reason = 'interrupted_submitted_turn_reconciled_without_retry';
        return record;
      }
    }
    for (let round = record.rounds.length + 1; round <= options.repeat; round += 1) {
      let final = null;
      for (let attempt = 0; attempt <= options.retries; attempt += 1) {
        const marker = `${ctx.data.runId}-${cell.host}-${cell.transport}-r${round}-a${attempt}`.replace(/[^a-zA-Z0-9-]/g, '-');
        const content = `VOKO Provider 真机验证 ${marker}。请仅用一句话确认收到，并原样包含 ${marker}。不要调用工具。`;
        const startedAt = Date.now();
        let submitted = false;
        try {
          if (options.driver === 'visitor') {
            final = await runVisitorTurn(ctx, cell, round, attempt, options, visitorDriver);
            record.attempts.push(final);
            if (final.status === 'PASS' || final.outcome === 'submitted_result_unknown_no_retry') {
              final.turnEvidence = await captureTurnEvidence(host, cell, { since: startedAt - 1000 }, null);
              const usedTransport = final.turnEvidence?.data?.turn?.transport_id;
              if (final.status === 'PASS') {
                if (!usedTransport) { final.status = 'FAIL'; final.error = 'provider_turn_evidence_missing'; }
                else if (usedTransport !== cell.transport) { final.status = 'FAIL'; final.error = `transport_mismatch:${usedTransport}`; }
              }
            }
            break;
          }
          const sent = host.json(['send_message', '--agentId', sender.agentId, '--toUid', cell.imUid,
            '--channelType', '1', '--content', content], 45_000);
          if (!sent?.messageId) throw new Error(sent?.error || 'message id missing');
          submitted = true;
          final = { round, attempt, marker, messageId: sent.messageId, securityMode: sent.securityMode,
            deliveryState: sent.deliveryState, startedAtMs: startedAt, durationMs: null, status: 'SUBMITTED' };
          record.attempts.push(final);
          saveCheckpoint(ctx);
          const result = await pollResult(host, sender.agentId, sent.messageId, options.resultTimeoutMs);
          const status = classifyResult(result);
          Object.assign(final, { durationMs: Date.now() - startedAt, status,
            execution: redact(result?.execution || {}), reply: redact(result?.reply || {}),
            turnEvidence: await captureTurnEvidence(host, cell, sender, result?.execution?.turnId) });
          const usedTransport = final.turnEvidence?.data?.turn?.transport_id;
          if (status === 'PASS' && usedTransport && usedTransport !== cell.transport) {
            final.status = 'FAIL';
            final.error = `transport_mismatch:${usedTransport}`;
          }
          // Once the server accepted a messageId, never create a second turn
          // for the same round. Even a confirmed Provider failure may have
          // produced side effects outside VOKO.
          break;
        } catch (error) {
          if (submitted && final) {
            Object.assign(final, { durationMs: Date.now() - startedAt, status: 'FAIL',
              error: String(error.message || error), outcome: 'submitted_result_unknown_no_retry' });
            break;
          }
          final = { round, attempt, marker, durationMs: Date.now() - startedAt, status: 'FAIL',
            error: String(error.message || error), outcome: 'not_submitted' };
          record.attempts.push(final);
          if (!mayRetryAttempt(final)) break;
        }
      }
      record.rounds.push(final);
      saveCheckpoint(ctx);
      if (round === 1 && final?.status === 'PASS' && policyChange) {
        const changed = commitPolicy(host, cell, policyChange.config);
        record.policyChange = { ...policyChange, result: changed };
        if (!changed.ok) { record.reason = `policy_change_${changed.stage}_failed`; break; }
        const after = callSafe(host, ['inspect_provider_security', '--agentId', cell.agentId, '--transportId', cell.transport]);
        record.securityAfterChange = after.ok ? redact(after.value) : { error: after.error };
        const changedData = after.value?.data || {};
        if (Number(changedData.revision) !== Number(securityData.revision) + 1) {
          record.reason = 'policy_revision_did_not_increment'; break;
        }
        if (securityData.capabilityDigest && changedData.capabilityDigest
          && securityData.capabilityDigest !== changedData.capabilityDigest) {
          record.reason = 'policy_change_modified_capability_digest'; break;
        }
        const changedPreview = callSafe(host, ['preview_provider_security_invocation', '--agentId', cell.agentId,
          '--transportId', cell.transport, '--config', JSON.stringify(changedData.config || policyChange.config)]);
        record.invocationPreviewAfterChange = changedPreview.ok ? redact(changedPreview.value) : { error: changedPreview.error };
        saveCheckpoint(ctx);
      }
      if (final?.status !== 'PASS') {
        if (final?.execution?.state === 'DELIVERY_UNKNOWN'
          || !['COMPLETED', 'FAILED', 'AUTH_REQUIRED'].includes(String(final?.execution?.state || ''))) {
          record.outcomeUnknown = true;
          final.outcome = 'submitted_result_unknown_no_retry';
        }
        break;
      }
      if (stopRequested) break;
    }
    const statuses = record.rounds.map(item => item?.status);
    const sessionDigests = record.rounds.map(item => item?.turnEvidence?.data?.binding?.nativeSessionDigest).filter(Boolean);
    const comparableSessions = record.policyChange?.result?.ok ? sessionDigests.slice(1) : sessionDigests;
    record.sessionEvidence = { digests: sessionDigests, policyChangeInvalidatedBinding: record.policyChange?.result?.ok === true,
      reused: comparableSessions.length > 1 ? new Set(comparableSessions).size === 1 : null };
    if (comparableSessions.length > 1 && !record.sessionEvidence.reused) record.reason = 'native_session_not_reused';
    record.status = statuses.includes('NEEDS_USER_ACTION') ? 'NEEDS_USER_ACTION'
      : statuses.length === options.repeat && statuses.every(item => item === 'PASS')
        && record.reason !== 'native_session_not_reused' ? 'PASS' : 'FAIL';
    if (record.status === 'PASS' && options.driver === 'visitor' && options.permissions !== 'none' && securityData) {
      record.permissionCanaries = record.permissionCanaries || [];
      const canaries = policyCanaries(securityData, cell.agentName, `${ctx.data.runId}-${cell.transport}`);
      for (const canary of canaries) {
        if (record.permissionCanaries.some(item => item.controlId === canary.controlId && item.status === 'PASS')) continue;
        if (canary.scope === 'agent') {
          const prior = Object.values(ctx.data.cells).find(item => item !== record && item.host === cell.host
            && item.agentId === cell.agentId && item.provider === cell.provider
            && item.permissionCanaries?.some(entry => entry.scope === 'agent'
              && entry.controlId === canary.controlId && entry.status === 'PASS'));
          if (prior) {
            record.permissionCanaries.push({ controlId: canary.controlId, scope: 'agent', status: 'PASS',
              reusedEvidenceFrom: prior.transport, reason: 'agent_scope_already_verified' });
            saveCheckpoint(ctx);
            continue;
          }
        }
        const item = { controlId: canary.controlId, scope: canary.scope, kind: canary.kind, from: canary.from, to: canary.to,
          status: 'RUNNING', startedAt: new Date().toISOString() };
        record.permissionCanaries.push(item);
        const changed = commitPolicy(host, cell, canary.config, cell.agentName);
        item.change = changed;
        if (!changed.ok) { item.status = 'FAIL'; item.reason = `change_${changed.stage}_failed`; record.status = 'FAIL'; break; }
        try {
          const changedState = callSafe(host, ['inspect_provider_security', '--agentId', cell.agentId, '--transportId', cell.transport]);
          item.securityAfterChange = changedState.ok ? redact(changedState.value) : { error: changedState.error };
          const changedConfig = changedState.value?.data?.config || canary.config;
          const previewAfter = callSafe(host, ['preview_provider_security_invocation', '--agentId', cell.agentId,
            '--transportId', cell.transport, '--config', JSON.stringify(changedConfig)]);
          item.invocationPreview = previewAfter.ok ? redact(previewAfter.value) : { error: previewAfter.error };
          const refreshedAfter = callSafe(host, ['refresh_provider_security_capability', '--agentId', cell.agentId,
            '--transportId', cell.transport], 35_000);
          item.capabilityRefresh = refreshedAfter.ok ? redact(refreshedAfter.value) : { error: refreshedAfter.error };
          const reselected = callRuntimeControl(host, ['select_delivery_channel', '--agentId', cell.agentId,
            '--mode', cell.mode, '--providerId', cell.transport], 35_000, 2);
          item.transportReselection = reselected.ok ? redact(reselected.value) : { error: reselected.error };
          if (!reselected.ok || reselected.value?.success === false) {
            item.status = 'FAIL'; item.reason = 'transport_not_ready_after_policy_restart';
          } else {
            const visitor = await runVisitorTurn(ctx, cell, `canary-${canary.controlId}`, 0, options, visitorDriver);
            item.visitorTurn = visitor;
            if (visitor.status === 'PASS') {
              visitor.turnEvidence = await captureTurnEvidence(host, cell, { since: Date.now() - visitor.durationMs - 2000 }, null);
              const turn = visitor.turnEvidence?.data?.turn;
              item.status = turn?.transport_id === cell.transport ? 'PASS' : 'FAIL';
              if (item.status === 'FAIL') item.reason = turn ? `transport_mismatch:${turn.transport_id}` : 'provider_turn_evidence_missing';
            } else { item.status = visitor.status; item.reason = visitor.error || 'visitor_canary_failed'; }
          }
        } finally {
          const baselineScoped = { instanceConfig: securityData.instancePolicy?.config || {},
            transportConfig: securityData.transportPolicy?.config || securityData.config || {} };
          item.restore = commitPolicy(host, cell, baselineScoped, cell.agentName);
          const restored = callSafe(host, ['inspect_provider_security', '--agentId', cell.agentId, '--transportId', cell.transport]);
          item.securityAfterRestore = restored.ok ? redact(restored.value) : { error: restored.error };
          const restoredData = restored.value?.data || {};
          if (!item.restore.ok
            || digest(restoredData.transportPolicy?.config || restoredData.config || {}) !== digest(baselineScoped.transportConfig)
            || digest(restoredData.instancePolicy?.config || {}) !== digest(baselineScoped.instanceConfig)) {
            item.status = 'FAIL'; item.reason = 'isolated_canary_restore_failed';
          }
          item.finishedAt = new Date().toISOString();
          saveCheckpoint(ctx);
        }
        if (item.status !== 'PASS') { record.status = item.status === 'NEEDS_USER_ACTION' ? item.status : 'FAIL'; break; }
      }
      record.unsupportedControls = (securityData.controls || []).filter(control => !control.editable)
        .map(control => ({ id: control.id, enforcement: control.enforcement, reason: 'not_editable_for_current_transport' }));
    }
    if (record.status === 'NEEDS_USER_ACTION') ctx.data.userActions.push({ host: cell.host, agentName: cell.agentName,
      provider: cell.provider, transport: cell.transport, reason: record.rounds.at(-1)?.execution?.reasonCode || 'authentication_required' });
  } finally {
    if (record.policyBaseline?.config && record.policyChange?.result?.ok) {
      record.policyRestore = commitPolicy(host, cell, record.policyBaseline.config, cell.agentName);
      const restored = callSafe(host, ['inspect_provider_security', '--agentId', cell.agentId, '--transportId', cell.transport]);
      record.securityAfterRestore = restored.ok ? redact(restored.value) : { error: restored.error };
      if (!record.policyRestore.ok || digest(restored.value?.data?.config || {}) !== digest(record.policyBaseline.config)) {
        record.status = 'FAIL';
        record.reason = 'policy_restore_failed';
      }
    }
    record.restore = callRuntimeControl(host, ['select_delivery_channel', '--agentId', cell.agentId, '--mode', 'auto']);
    record.finishedAt = new Date().toISOString();
    if (!record.restore.ok && record.status !== 'NEEDS_USER_ACTION') record.status = 'FAIL';
    saveCheckpoint(ctx);
    writeCellArtifact(ctx, record);
  }
  return record;
}

function faultEligibility(cell, fault) {
  if (!String(cell.agentName || '').startsWith('TEST-')) return { ok: false, reason: 'faults_require_TEST_agent' };
  if (![
    'workbuddy-http', 'qwen-office-cli', 'dumate-http',
    'zeroclaw-cli', 'zeroclaw-acp', 'zeroclaw-ws',
    'hermes-cli', 'hermes-http',
    'opencode-cli', 'opencode-acp', 'opencode-attach',
  ].includes(cell.transport)) {
    return { ok: false, reason: `capability_faults_not_applicable_to_${cell.transport}` };
  }
  if (!['probe-timeout', 'runtime-timeout', 'fingerprint-change', 'circuit-breaker'].includes(fault)) {
    return { ok: false, reason: `unknown_fault_${fault}` };
  }
  return { ok: true, injector: fault === 'fingerprint-change' ? 'capability-snapshot'
    : fault === 'circuit-breaker' ? 'policy-store' : 'dispatcher-delay' };
}

async function runFault(host, cell, fault) {
  const eligible = faultEligibility(cell, fault);
  if (!eligible.ok) return { fault, status: 'SKIPPED_NOT_READY', ...eligible };
  const timeout = fault === 'runtime-timeout' ? 40_000 : 12_000;
  const result = callRuntimeControl(host, ['exercise_provider_capability_fault', '--agentId', cell.agentId,
    '--transportId', cell.transport, '--fault', fault], timeout, 1);
  return result.ok && result.value?.success !== false
    ? { fault, ...eligible, ...redact(result.value.data) }
    : { fault, status: 'FAIL', ...eligible, error: result.error || result.value?.error };
}

async function runRecoveryTurn(ctx, host, cell, sender, timeoutMs, options, visitorDriver) {
  const marker = `${ctx.data.runId}-${cell.host}-${cell.transport}-recovery`.replace(/[^a-zA-Z0-9-]/g, '-');
  if (visitorDriver) return runVisitorTurn(ctx, cell, 'fault-recovery', 0,
    { ...options, resultTimeoutMs: timeoutMs }, visitorDriver);
  const startedAt = Date.now();
  try {
    const sent = host.json(['send_message', '--agentId', sender.agentId, '--toUid', cell.imUid,
      '--channelType', '1', '--content', `VOKO 故障恢复验证 ${marker}。请仅用一句话确认收到，不要调用工具。`], 45_000);
    if (!sent?.messageId) return { status: 'FAIL', outcome: 'not_submitted', error: sent?.error || 'message id missing' };
    const result = await pollResult(host, sender.agentId, sent.messageId, timeoutMs);
    return { status: classifyResult(result), messageId: sent.messageId, durationMs: Date.now() - startedAt,
      execution: redact(result?.execution || {}), reply: redact(result?.reply || {}) };
  } catch (error) {
    return { status: 'FAIL', durationMs: Date.now() - startedAt, error: String(error.message || error),
      outcome: 'submitted_result_unknown_no_retry' };
  }
}

function writeReport(ctx) {
  const cells = Object.values(ctx.data.cells);
  const counts = {};
  for (const item of [...cells, ...ctx.data.skipped]) counts[item.status] = (counts[item.status] || 0) + 1;
  const faultCounts = {};
  for (const item of cells) for (const fault of item.faults || []) {
    faultCounts[fault.status] = (faultCounts[fault.status] || 0) + 1;
  }
  const requestedFaultsComplete = !ctx.data.options.faults?.length
    || cells.every(item => ctx.data.options.faults.every(name => item.faults?.some(fault => fault.fault === name
      && (fault.status === 'PASS' || (fault.status === 'SKIPPED_NOT_READY' && /not_applicable/.test(String(fault.reason || '')))))));
  const summary = { runId: ctx.data.runId, startedAt: ctx.data.startedAt, finishedAt: new Date().toISOString(),
    counts, faultCounts, acceptancePassed: (counts.FAIL || 0) === 0 && (counts.BLOCKED_BUILD_MISMATCH || 0) === 0
      && requestedFaultsComplete, buildDigests: ctx.data.buildDigests, buildStates: ctx.data.buildStates,
    userActions: ctx.data.userActions, cells, skipped: ctx.data.skipped };
  atomicJson(path.join(ctx.dir, 'summary.json'), redact(summary));
  const esc = text => String(text ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[char]));
  const rows = [...cells, ...ctx.data.skipped].map(item => `<tr><td>${esc(item.status)}</td><td>${esc(item.host)}</td><td>${esc(item.agentName)}</td><td>${esc(item.provider)}</td><td>${esc(item.transport || '-')}</td><td>${esc(item.reason || '')}</td></tr>`).join('');
  fs.writeFileSync(path.join(ctx.dir, 'report.html'), `<!doctype html><meta charset="utf-8"><title>VOKO Provider runtime matrix</title><style>body{font:14px system-ui;max-width:1200px;margin:30px auto}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:8px}th{background:#f5f5f5}</style><h1>VOKO Provider runtime matrix</h1><pre>${esc(JSON.stringify({ runId: summary.runId, acceptancePassed: summary.acceptancePassed, counts, faultCounts, buildDigests: summary.buildDigests, buildStates: summary.buildStates }, null, 2))}</pre><table><tr><th>Status</th><th>Host</th><th>Agent</th><th>Provider</th><th>Transport</th><th>Reason</th></tr>${rows}</table>`);
  return summary;
}

async function main() {
  if (process.argv.slice(2).some(arg => arg === '--help' || arg === '-h')) {
    process.stdout.write(HELP);
    return;
  }
  const releaseLock = acquireMatrixLock();
  let visitorDriver = null;
  process.once('SIGINT', () => { stopRequested = true; console.error('Stopping after the current submitted round is reconciled...'); });
  process.once('SIGTERM', () => { stopRequested = true; console.error('Stopping after the current submitted round is reconciled...'); });
  try {
    loadEnv(ENV_FILE);
    const options = parseArgs(process.argv.slice(2));
    visitorDriver = options.driver === 'visitor' ? new PersistentVisitorDriver(options) : null;
    const runId = options.resume || `provider-runtime-${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${Math.random().toString(36).slice(2, 8)}`;
    const ctx = checkpointFor(runId, options);
    const config = configFromEnv();
    const hosts = Object.fromEntries(Object.entries(config.hosts).filter(([name]) => options.hosts.includes(name)));
    const inventories = {};
    const digests = new Set();
    for (const [name, host] of Object.entries(hosts)) {
      let inventory;
      try {
        inventory = host.inventory(20_000, options.providers === 'installed-ready');
        // A freshly restarted VOKO publishes its process status before all
        // Provider adapters finish their first readiness pass. Do not freeze
        // that transient all-unready snapshot into the matrix inventory.
        for (let attempt = 0; attempt < 6
          && inventory.agents.length > 0
          && !inventory.agents.some(agent => agent.runtime?.automaticDeliveryReady === true); attempt += 1) {
          await new Promise(resolve => setTimeout(resolve, 5_000));
          inventory = host.inventory(20_000, options.providers === 'installed-ready');
        }
      }
      catch (error) {
        ctx.data.skipped.push({ host: name, status: 'NEEDS_USER_ACTION', reason: 'host_inventory_unavailable',
          error: String(error.message || error) });
        ctx.data.userActions.push({ host: name, reason: 'host_inventory_unavailable' });
        continue;
      }
      inventories[name] = inventory;
      // The CLI executable can be replaced while an older VOKO process keeps
      // running. Formal evidence must bind to the digest captured by that
      // process at startup, not merely to the files currently on disk.
      const buildEvidence = runtimeBuildEvidence(inventory.status);
      const buildDigest = buildEvidence.digest;
      ctx.data.buildDigests[name] = buildDigest;
      ctx.data.buildStates[name] = buildEvidence.state;
      if (buildDigest) digests.add(buildDigest);
    }
  const discoveries = {};
  for (const [name, inventory] of Object.entries(inventories)) {
    discoveries[name] = discoverCells({ [name]: inventory }, ctx.data.buildDigests[name]);
    discoveries[name].selected = filterCells(discoveries[name].cells, options);
  }
  ctx.data.visitorAccess ||= {};
  if (visitorDriver && !options.dryRun) {
    const visitorId = await visitorDriver.visitorId();
    for (const [name, inventory] of Object.entries(inventories)) {
      const selectedAgentIds = [...new Set(discoveries[name].selected.map(cell => cell.agentId))];
      ctx.data.visitorAccess[name] = { visitorId: digest(visitorId).slice(0, 16),
        agents: prepareVisitorAccess(hosts[name], inventory, visitorId, selectedAgentIds) };
    }
    saveCheckpoint(ctx);
  }
  const sameBuild = digests.size === 1 && Object.values(ctx.data.buildDigests).every(Boolean)
    && Object.values(ctx.data.buildStates || {}).every(state => !['stale', 'unknown'].includes(state));
  for (const [name, inventory] of Object.entries(inventories)) {
    const discovered = discoveries[name];
    ctx.data.skipped.push(...discovered.skipped.filter(item => !ctx.data.skipped.some(old => old.host === item.host && old.agentId === item.agentId)));
    for (const discoveredCell of discovered.selected) {
      if (options.dryRun) {
        ctx.data.cells[discoveredCell.key] = { ...discoveredCell, status: 'SKIPPED_NOT_READY', reason: 'dry_run' };
        continue;
      }
      const access = ctx.data.visitorAccess[name]?.agents?.find(item => item.agentId === discoveredCell.agentId);
      if (visitorDriver && access && !access.ok) {
        ctx.data.cells[discoveredCell.key] = { ...discoveredCell, status: 'NEEDS_USER_ACTION',
          reason: 'visitor_access_preparation_failed', access };
        ctx.data.userActions.push({ host: name, agentId: discoveredCell.agentId,
          reason: 'visitor_access_preparation_failed', error: access.error });
        continue;
      }
      const cell = enrichCellRuntime(hosts[name], discoveredCell);
      if (!sameBuild) {
        ctx.data.cells[cell.key] = { ...cell, status: 'BLOCKED_BUILD_MISMATCH', reason: 'three_hosts_must_use_one_build_digest' };
        continue;
      }
      const result = await runCell(ctx, hosts[name], inventory, cell, options, visitorDriver);
      let performedFault = false;
      for (const fault of options.faults) {
        if (result.faults?.some(item => item.fault === fault)) continue;
        const faultResult = await runFault(hosts[name], cell, fault);
        result.faults.push(faultResult);
        if (faultResult.ok) performedFault = true;
      }
      if (performedFault) {
        const sender = chooseSender(inventory, cell);
        result.recoveryTurn = sender ? await runRecoveryTurn(ctx, hosts[name], cell, sender, options.resultTimeoutMs,
          options, visitorDriver)
          : { status: 'SKIPPED_NOT_READY', reason: 'no_connected_sender' };
        if (result.recoveryTurn.status !== 'PASS' || result.faults.some(item => item.ok && item.status !== 'PASS')) {
          result.status = 'FAIL';
          result.reason = result.recoveryTurn.status !== 'PASS' ? 'post_fault_recovery_failed' : 'fault_scenario_failed';
        }
      }
      saveCheckpoint(ctx);
      writeCellArtifact(ctx, result);
      if (result.status === 'NEEDS_USER_ACTION' && !options.continueOnUserAction) break;
      if (stopRequested) break;
    }
    if (stopRequested) break;
  }
    const summary = writeReport(ctx);
    console.log(`Provider runtime matrix: ${ctx.dir}`);
    if (!summary.acceptancePassed) process.exitCode = 1;
  } finally {
    if (visitorDriver) await visitorDriver.close();
    releaseLock();
  }
}

if (require.main === module) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

module.exports = { acquireMatrixLock, atomicJson, callRuntimeControl, captureTurnEvidence, checkpointFor, chooseSender, classifyResult, commitPolicy, digest, discoverCells, enrichCellRuntime, faultEligibility, filterCells, mayRetryAttempt, methodNeedsVerification, parseArgs, PersistentVisitorDriver, policyCanaries, prepareVisitorAccess, redact, runFault, runVisitorTurn, runtimeBuildEvidence, saferPolicyChange, submittedOutcomeUnknown, writeCellArtifact };
