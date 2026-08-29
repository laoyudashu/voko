#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createReporter, loadEnv } = require('./real-test');

const ROOT = path.join(__dirname, '..');
const ENV_FILE = path.resolve(process.env.VOKO_REAL_MATRIX_ENV || path.join(ROOT, '.env.real-matrix.local'));
const ARTIFACT_ROOT = path.join(ROOT, 'artifacts', 'real-tests');

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`missing ${name} in ${ENV_FILE}`);
  return value;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    encoding: 'utf8',
    timeout: options.timeout || 180_000,
    input: options.input,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  if (result.status !== 0) {
    throw new Error(`${command} exited ${result.status}: ${(stderr || stdout).slice(-1200)}`);
  }
  return stdout;
}

function parseJson(output, label) {
  const text = String(output || '').trim();
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{' && text[start] !== '[') continue;
    const stack = [];
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') { inString = true; continue; }
      if (char === '{' || char === '[') stack.push(char);
      else if (char === '}' || char === ']') {
        const expected = char === '}' ? '{' : '[';
        if (stack.pop() !== expected) break;
        if (stack.length === 0) {
          try { return JSON.parse(text.slice(start, index + 1)); } catch (_) { break; }
        }
      }
    }
  }
  throw new Error(`${label} did not return JSON: ${text.slice(-500)}`);
}

class Host {
  constructor(name, config) {
    this.name = name;
    this.kind = config.kind;
    this.config = config;
  }

  voko(args, timeout = 180_000) {
    const result = this.vokoOutcome(args, timeout);
    if (result.code !== 0) throw new Error(`${this.name} voko exited ${result.code}: ${result.output.slice(-1200)}`);
    return result.output;
  }

  vokoOutcome(args, timeout = 180_000) {
    if (this.kind === 'local') {
      const result = spawnSync(this.config.voko, args, {
        cwd: ROOT, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
      });
      if (result.error) throw result.error;
      return { code: Number(result.status), output: `${result.stdout || ''}${result.stderr || ''}` };
    }
    if (this.kind === 'parallels') {
      const result = spawnSync('prlctl', ['exec', this.config.vm, '--current-user', this.config.node,
        this.config.entry, ...args], {
        cwd: ROOT, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
      });
      if (result.error) throw result.error;
      return { code: Number(result.status), output: `${result.stdout || ''}${result.stderr || ''}` };
    }
    if (this.kind === 'utm') return this._utmVoko(args, timeout);
    throw new Error(`unsupported host kind: ${this.kind}`);
  }

  _utmVoko(args, timeout) {
    const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const scriptPath = `/tmp/voko-real-${suffix}.sh`;
    const outputPath = `/tmp/voko-real-${suffix}.out`;
    const codePath = `/tmp/voko-real-${suffix}.code`;
    const command = [this.config.node, this.config.entry, ...args].map(shellQuote).join(' ');
    const script = `#!/bin/bash\nset +e\nrunuser -u ${shellQuote(this.config.user)} -- env XDG_RUNTIME_DIR=/run/user/${this.config.uid} DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${this.config.uid}/bus ${command} > ${shellQuote(outputPath)} 2>&1\ncode=$?\nprintf '%s' "$code" > ${shellQuote(codePath)}\nexit 0\n`;
    run(this.config.utmctl, ['file', 'push', this.config.vm, scriptPath], { input: script, timeout: 30_000 });
    run(this.config.utmctl, ['exec', this.config.vm, '--cmd', '/bin/bash', scriptPath], { timeout });
    const deadline = Date.now() + timeout;
    let codeText = '';
    while (Date.now() < deadline) {
      const probe = spawnSync(this.config.utmctl, ['file', 'pull', this.config.vm, codePath], {
        cwd: ROOT, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
      });
      if (probe.status === 0 && String(probe.stdout || '').trim()) {
        codeText = String(probe.stdout).trim();
        break;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
    if (!codeText) throw new Error(`Linux VOKO command timed out after ${timeout}ms`);
    const output = run(this.config.utmctl, ['file', 'pull', this.config.vm, outputPath], { timeout: 30_000 });
    const code = Number(codeText);
    spawnSync(this.config.utmctl, ['exec', this.config.vm, '--cmd', '/bin/rm', '-f', scriptPath, outputPath, codePath], {
      cwd: ROOT, encoding: 'utf8', timeout: 30_000,
    });
    return { code, output };
  }

  json(args, timeout) {
    return parseJson(this.voko(args, timeout), `${this.name} voko ${args[0]}`);
  }

  inventory() {
    const status = this.json(['status', '--json']);
    const listed = this.json(['list_agents']);
    const runtimeById = new Map((status.agents || []).map((agent) => [agent.agentId, agent]));
    const agents = (listed.agents || []).map((agent) => ({ ...agent, runtime: runtimeById.get(agent.agentId) || null }));
    return { status, agents };
  }
}

function configFromEnv() {
  const utmctl = process.env.VOKO_REAL_UTMCTL || '/Applications/UTM.app/Contents/MacOS/utmctl';
  return {
    hosts: {
      macos: new Host('macos', { kind: 'local', voko: required('VOKO_REAL_MAC_VOKO') }),
      windows: new Host('windows', {
        kind: 'parallels', vm: required('VOKO_REAL_WINDOWS_VM'), node: required('VOKO_REAL_WINDOWS_NODE'),
        entry: required('VOKO_REAL_WINDOWS_ENTRY'),
      }),
      linux: new Host('linux', {
        kind: 'utm', vm: required('VOKO_REAL_LINUX_VM'), node: required('VOKO_REAL_LINUX_NODE'),
        entry: required('VOKO_REAL_LINUX_ENTRY'), user: process.env.VOKO_REAL_LINUX_USER || 'tjyu',
        uid: Number(process.env.VOKO_REAL_LINUX_UID || 1000), utmctl,
      }),
    },
    senders: JSON.parse(required('VOKO_REAL_MATRIX_SENDERS')),
    targets: JSON.parse(required('VOKO_REAL_MATRIX_TARGETS')),
  };
}

function resolveAgent(inventory, selector) {
  const matches = inventory.agents.filter((agent) => agent.agentName === selector.agentName
    && (!selector.backendType || agent.backendType === selector.backendType));
  if (matches.length !== 1) throw new Error(`expected one ${selector.agentName}/${selector.backendType}, found ${matches.length}`);
  return matches[0];
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function allAutomaticTargets(inventories) {
  const senderByTargetHost = { macos: 'linux', windows: 'macos', linux: 'windows' };
  return Object.entries(inventories).flatMap(([host, inventory]) => inventory.agents
    .filter(agent => agent.publishStatus === 'published'
      && agent.accessMode === 'public'
      && agent.runtime?.automaticDeliveryReady === true)
    .map(agent => ({
      senderHost: senderByTargetHost[host],
      host,
      agentName: agent.agentName,
      backendType: agent.backendType,
      restoreVisibility: Number(agent.visibilityType || 0),
    })));
}

async function pollResult(host, agentId, messageId, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    try {
      latest = host.json(['get_message_result', '--agentId', agentId, '--messageId', messageId], 30_000);
    } catch (error) {
      if (!/RUNTIME_(STARTING|UNAVAILABLE|MISMATCH)/.test(String(error?.message || ''))) throw error;
      await sleep(2_000);
      continue;
    }
    const execution = latest?.execution || {};
    const terminalFailure = ['FAILED', 'AUTH_REQUIRED', 'DELIVERY_UNKNOWN'].includes(execution.state);
    const completedReply = execution.state === 'COMPLETED'
      && execution.phase === 'reply'
      && latest?.reply?.state === 'DELIVERED';
    if (terminalFailure || completedReply) return latest;
    await sleep(5_000);
  }
  return latest;
}

function checkPreflight(config, reporter, inventories) {
  const digests = new Set();
  for (const [name, host] of Object.entries(config.hosts)) {
    const inventory = host.inventory();
    inventories[name] = inventory;
    const status = inventory.status;
    reporter.check(`${name} runtime READY`, status.runtimeState === 'ready',
      `version=${status.version} schema=${status.schemaVersion} agents=${status.startup?.loadedAgents}/${status.startup?.totalAgents}`);
    reporter.check(`${name} schema v8`, Number(status.schemaVersion) === 8, `schema=${status.schemaVersion}`);
    reporter.check(`${name} build current`, status.buildMismatch === false && !!status.buildDigest,
      `digest=${String(status.buildDigest || '').slice(0, 12)}`);
    if (status.buildDigest) digests.add(status.buildDigest);
    const disconnected = inventory.agents.filter((agent) => agent.runtime?.imConnected === false);
    reporter.check(`${name} Agent IM connected`, disconnected.length === 0, `disconnected=${disconnected.length}`);
  }
  reporter.check('three hosts use one build digest', digests.size === 1, `digests=${digests.size}`);
}

async function providerMatrix(config, reporter, inventories) {
  const changedVisibility = [];
  const restoreVisibility = () => {
    while (changedVisibility.length) {
      const item = changedVisibility.pop();
      try { item.host.json(['set_agent_status', '--agentId', item.agentId, '--visibility', String(item.visibility)]); }
      catch (error) { reporter.check(`restore visibility ${item.agentId.slice(0, 8)}`, false, error.message); }
    }
  };
  const onSignal = () => { restoreVisibility(); process.exit(130); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const visibilitySelectors = [
      ...Object.entries(config.senders).map(([host, selector]) => ({ host, ...selector })),
      ...config.targets,
    ];
    const seenAgents = new Set();
    for (const target of visibilitySelectors) {
      const host = config.hosts[target.host];
      const agent = resolveAgent(inventories[target.host], target);
      if (seenAgents.has(agent.agentId)) continue;
      seenAgents.add(agent.agentId);
      const restore = Number.isInteger(target.restoreVisibility)
        ? target.restoreVisibility : Number(agent.visibilityType || 0);
      changedVisibility.push({ host, agentId: agent.agentId, visibility: restore });
      if (Number(agent.visibilityType) !== 1) {
        host.json(['set_agent_status', '--agentId', agent.agentId, '--visibility', '1']);
      }
    }
    await sleep(10_000);

    for (const target of config.targets) {
      const agent = resolveAgent(inventories[target.host], target);
      const automatic = agent.runtime?.automaticDeliveryReady === true;
      reporter.check(`${target.host}/${target.agentName} automatic channel ready`, automatic,
        `mode=${agent.runtime?.activeAutomaticMode || 'none'}`);
      if (!automatic) continue;
    }

    for (const target of config.targets) {
      const senderSelector = config.senders[target.senderHost];
      const senderHost = config.hosts[target.senderHost];
      const targetHost = config.hosts[target.host];
      const sender = resolveAgent(inventories[target.senderHost], senderSelector);
      const targetAgent = resolveAgent(inventories[target.host], target);
      if (targetAgent.runtime?.automaticDeliveryReady !== true) continue;
      const marker = `${reporter.runId}-${target.host}-${target.backendType}`.replace(/[^a-zA-Z0-9-]/g, '-');
      const content = `VOKO真机测试 ${marker}。请用一句自然语言确认收到，并在结尾写数字 ${String(Date.now()).slice(-6)}。`;
      try {
        const sent = senderHost.json(['send_message', '--agentId', sender.agentId, '--toUid', targetAgent.imUid,
          '--channelType', '1', '--content', content], 45_000);
        reporter.summary.counters.sent += sent?.success === true ? 1 : 0;
        reporter.check(`${target.agentName} encrypted send accepted`, sent?.success === true && sent?.securityMode === 'e2ee',
          `security=${sent?.securityMode || 'none'} delivery=${sent?.deliveryState || 'unknown'}`);
        if (!sent?.messageId) continue;
        const result = await pollResult(senderHost, sender.agentId, sent.messageId);
        const completed = result?.execution?.state === 'COMPLETED' && result?.reply?.state === 'DELIVERED';
        reporter.check(`${target.agentName} Provider replied exactly once`, completed,
          `execution=${result?.execution?.state || 'unknown'} phase=${result?.execution?.phase || 'none'} `
          + `reason=${result?.execution?.reasonCode || 'none'} reply=${result?.reply?.state || 'unknown'} `
          + `message=${String(sent.messageId).slice(0, 32)}`);
        if (completed) reporter.summary.counters.verified += 1;
        else reporter.summary.counters.lost += 1;
      } catch (error) {
        reporter.check(`${target.agentName} real loop`, false, error.message);
      }
    }
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    restoreVisibility();
  }
}

function productChecks(config, reporter, inventories) {
  for (const [name, host] of Object.entries(config.hosts)) {
    try {
      const outcome = host.vokoOutcome(['doctor', '--json', '--deep'], 180_000);
      const doctor = parseJson(outcome.output, `${name} doctor`);
      reporter.check(`${name} doctor deep completed`, doctor?.success !== false && Number(doctor?.summary?.errors || 0) === 0,
        `passed=${doctor?.summary?.passed || 0} warnings=${doctor?.summary?.warnings || 0} errors=${doctor?.summary?.errors || 0}`);
    } catch (error) { reporter.check(`${name} doctor deep completed`, false, error.message); }
    try {
      const help = host.voko(['send_message', '--help'], 30_000);
      reporter.check(`${name} CLI help contract`, /agentId/.test(help) && /toUid/.test(help));
    } catch (error) { reporter.check(`${name} CLI help contract`, false, error.message); }
    const pullSender = resolveAgent(inventories[name], config.senders[name]);
    try {
      const identity = host.json(['whoami', '--agentId', pullSender.agentId], 30_000);
      reporter.check(`${name} whoami ownership`, identity?.success !== false && identity?.currentAgent?.agentId === pullSender.agentId,
        `agent=${pullSender.agentName}`);
    } catch (error) { reporter.check(`${name} whoami ownership`, false, error.message); }
  }
}

async function main() {
  loadEnv(ENV_FILE);
  const config = configFromEnv();
  const scenario = process.argv.find((arg) => arg.startsWith('--suite='))?.split('=')[1] || 'all';
  const reporter = createReporter(`matrix-${scenario}`, ARTIFACT_ROOT);
  const inventories = {};
  try {
    checkPreflight(config, reporter, inventories);
    if (scenario === 'providers-all') config.targets = allAutomaticTargets(inventories);
    const targetFilter = String(process.env.VOKO_REAL_PROVIDER_FILTER || '').trim();
    if (targetFilter) {
      config.targets = config.targets.filter(target => `${target.host}:${target.backendType}` === targetFilter
        || `${target.host}:${target.agentName}` === targetFilter);
      if (!config.targets.length) throw new Error(`no Provider target matched ${targetFilter}`);
    }
    if (scenario === 'providers' || scenario === 'providers-all' || scenario === 'all') {
      await providerMatrix(config, reporter, inventories);
    }
    if (scenario === 'product' || scenario === 'all') productChecks(config, reporter, inventories);
    if (!['preflight', 'providers', 'providers-all', 'product', 'all'].includes(scenario)) throw new Error(`unknown suite: ${scenario}`);
  } catch (error) {
    reporter.check('matrix scenario completed', false, error.stack || error.message);
  }
  process.exitCode = reporter.finish() ? 0 : 1;
}

if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });

module.exports = { Host, allAutomaticTargets, configFromEnv, parseJson, pollResult, resolveAgent, shellQuote };
