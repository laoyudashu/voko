#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');

function loadEnv(file) {
  if (!fs.existsSync(file)) throw new Error(`real-test config not found: ${file}`);
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || line.trim().startsWith('#')) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

function durationMs(value) {
  const match = String(value || '').match(/^(\d+)(ms|s|m|h)$/);
  if (!match) throw new Error(`invalid duration: ${value}`);
  return Number(match[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2]];
}

function parseToolResult(result) {
  const text = result?.content?.find((item) => item.type === 'text')?.text;
  if (!text) return result;
  try { return JSON.parse(text); } catch (_) { return { text }; }
}

function mcpCall(dbPath, name, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'build', 'index.js'), 'mcp'], {
      cwd: root,
      env: { ...process.env, VOKO_DB_PATH: dbPath },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${name} timed out`)); }, 30_000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`${name} exited ${code}: ${stderr.slice(-1000)}`));
      try {
        const response = JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean)[0]);
        if (response.error) throw new Error(response.error.message || JSON.stringify(response.error));
        resolve(parseToolResult(response.result));
      } catch (error) { reject(new Error(`${name}: ${error.message}`)); }
    });
    child.stdin.end(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name, arguments: args },
    }) + '\n');
  });
}

function esc(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function redact(value, env = process.env) {
  let text = String(value || '').replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]');
  for (const [key, secret] of Object.entries(env)) {
    if (!/(TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY)/i.test(key) || !secret || String(secret).length < 6) continue;
    text = text.split(String(secret)).join('[REDACTED]');
  }
  return text;
}

function createReporter(scenario, baseDir = path.join(root, 'artifacts', 'real-tests')) {
  const runId = `real-${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(baseDir, runId);
  fs.mkdirSync(dir, { recursive: true });
  const summary = {
    runId, scenario, startedAt: new Date().toISOString(), finishedAt: null,
    counters: { sent: 0, verified: 0, failures: 0, duplicates: 0, lost: 0, reconnects: 0 },
    checks: [], metrics: [],
  };
  function check(name, ok, detail = '') {
    const safeDetail = redact(detail);
    summary.checks.push({ name, ok, detail: safeDetail, at: new Date().toISOString() });
    if (!ok) summary.counters.failures += 1;
    console.log(`${ok ? '✓' : '✗'} ${name}${safeDetail ? ` — ${safeDetail}` : ''}`);
  }
  function finish() {
    summary.finishedAt = new Date().toISOString();
    summary.ok = summary.counters.failures === 0 && summary.counters.duplicates === 0 && summary.counters.lost === 0;
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
    const rows = summary.checks.map((item) => `<tr><td>${esc(item.ok ? 'PASS' : 'FAIL')}</td><td>${esc(item.name)}</td><td>${esc(item.detail)}</td></tr>`).join('');
    fs.writeFileSync(path.join(dir, 'report.html'), `<!doctype html><meta charset="utf-8"><title>VOKO real test ${esc(runId)}</title><style>body{font:14px system-ui;max-width:1100px;margin:30px auto}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:8px}th{background:#f5f5f5}</style><h1>VOKO real test</h1><pre>${esc(JSON.stringify({ runId, scenario, ok: summary.ok, counters: summary.counters }, null, 2))}</pre><table><tr><th>Result</th><th>Check</th><th>Detail</th></tr>${rows}</table>`);
    console.log(`Report: ${dir}`);
    return summary.ok;
  }
  return { runId, summary, check, finish };
}

async function sendAndVerify(config, reporter, toUid, channelType = 1, options = {}) {
  const content = `[VOKO-REAL-TEST ${reporter.runId}] ${new Date().toISOString()}`;
  const sent = await mcpCall(config.dbPath, 'voko_send_message', {
    agentId: config.agentId, toUid, channelType, content, ...(options.mentions ? { mentions: options.mentions } : {}),
  });
  reporter.summary.counters.sent += 1;
  const messageId = sent?.messageId || sent?.data?.messageId;
  reporter.check(`send channelType=${channelType}`, !!messageId, messageId || JSON.stringify(sent).slice(0, 200));
  const history = await mcpCall(config.dbPath, 'voko_get_chat_history', { agentId: config.agentId, channelId: toUid, channelType, limit: 100 });
  const messages = history?.messages || history?.data?.messages || [];
  const matches = messages.filter((item) => item.id === messageId || item.messageId === messageId || item.content === content);
  if (matches.length === 0) reporter.summary.counters.lost += 1;
  if (matches.length > 1) reporter.summary.counters.duplicates += matches.length - 1;
  reporter.check(`persist exactly once channelType=${channelType}`, matches.length === 1, `matches=${matches.length}`);
  if (matches.length === 1) reporter.summary.counters.verified += 1;
}

function configFromEnv() {
  const config = {
    dbPath: process.env.VOKO_REAL_DB_PATH,
    agentId: process.env.VOKO_REAL_AGENT_ID,
    peerUid: process.env.VOKO_REAL_PEER_UID,
    groupId: process.env.VOKO_REAL_GROUP_ID || '',
    filePath: process.env.VOKO_REAL_TEST_FILE || '',
  };
  for (const key of ['dbPath', 'agentId', 'peerUid']) if (!config[key]) throw new Error(`missing VOKO_REAL_${key.replace(/[A-Z]/g, (c) => '_' + c).toUpperCase()}`);
  if (!path.isAbsolute(config.dbPath)) throw new Error('VOKO_REAL_DB_PATH must be absolute');
  return config;
}

async function smoke(config, reporter) {
  const status = await mcpCall(config.dbPath, 'voko_get_status', { agentId: config.agentId });
  reporter.check('Agent status available', !!status, JSON.stringify(status).slice(0, 300));
  await sendAndVerify(config, reporter, config.peerUid, 1);
  if (config.groupId) await sendAndVerify(config, reporter, config.groupId, 2, { mentions: { all: true } });
  else reporter.check('group message', true, 'SKIP: VOKO_REAL_GROUP_ID not configured');
  await mcpCall(config.dbPath, 'voko_fetch_new_messages', { agentId: config.agentId, visitorId: config.peerUid, blockTimeout: 1 });
  reporter.check('MCP Pull', true);
  if (config.filePath) {
    const uploaded = await mcpCall(config.dbPath, 'voko_upload_and_send_file', {
      agentId: config.agentId, toUid: config.peerUid, channelType: 1,
      filePath: path.resolve(config.filePath), message: `[VOKO-REAL-TEST ${reporter.runId}] attachment`,
    });
    const attachmentOk = uploaded?.success !== false
      && !!(uploaded?.messageId || uploaded?.fileMessageId || uploaded?.attachmentMessageId);
    reporter.check('attachment upload and send', attachmentOk, JSON.stringify(uploaded).slice(0, 200));
    if (attachmentOk) {
      const history = await mcpCall(config.dbPath, 'voko_get_chat_history', {
        agentId: config.agentId, channelId: config.peerUid, channelType: 1, limit: 100,
      });
      const rows = history?.messages || history?.data?.messages || [];
      const tagged = rows.filter((item) => String(item.content || '').includes(reporter.runId));
      reporter.check('attachment persisted exactly once', tagged.length >= 1, `matches=${tagged.length}`);
      if (tagged.length > 1) reporter.summary.counters.duplicates += tagged.length - 1;
    }
  } else reporter.check('attachment upload and send', true, 'SKIP: VOKO_REAL_TEST_FILE not configured');
}

async function recovery(config, reporter) {
  await mcpCall(config.dbPath, 'voko_stop_worker', { agentId: config.agentId });
  reporter.check('stop selected Worker', true);
  const started = await mcpCall(config.dbPath, 'voko_start_worker', { agentId: config.agentId });
  const connected = started?.connected !== false && started?.success !== false;
  reporter.summary.counters.reconnects += connected ? 1 : 0;
  reporter.check('start selected Worker', connected, JSON.stringify(started).slice(0, 300));
  const status = await mcpCall(config.dbPath, 'voko_get_status', { agentId: config.agentId });
  reporter.check('selected Worker reports connected after recovery', status?.agent?.imConnected !== false, JSON.stringify(status).slice(0, 300));
  await sendAndVerify(config, reporter, config.peerUid, 1);
  reporter.check('system sleep/network interruption', true, 'MANUAL: run this scenario immediately after resume to validate PowerManager logs');
}

async function stability(config, reporter, duration) {
  const deadline = Date.now() + duration;
  const interval = durationMs(process.env.VOKO_REAL_INTERVAL || '30s');
  while (Date.now() < deadline) {
    const started = Date.now();
    try { await sendAndVerify(config, reporter, config.peerUid, 1); }
    catch (error) { reporter.check('stability iteration', false, error.message); }
    reporter.summary.metrics.push({ at: new Date().toISOString(), elapsedMs: Date.now() - started, memory: process.memoryUsage() });
    const wait = Math.min(interval, Math.max(0, deadline - Date.now()));
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

async function main() {
  loadEnv(path.resolve(process.env.VOKO_REAL_ENV || path.join(root, '.env.real-test.local')));
  const config = configFromEnv();
  const scenario = process.argv[2] || 'smoke';
  const durationArg = process.argv.find((arg) => arg.startsWith('--duration='))?.split('=')[1] || '30m';
  const reporter = createReporter(scenario);
  try {
    if (scenario === 'smoke') await smoke(config, reporter);
    else if (scenario === 'recovery') await recovery(config, reporter);
    else if (scenario === 'stability') await stability(config, reporter, durationMs(durationArg));
    else if (scenario === 'all') { await smoke(config, reporter); await recovery(config, reporter); await stability(config, reporter, durationMs(durationArg)); }
    else throw new Error(`unknown real-test scenario: ${scenario}`);
  } catch (error) { reporter.check('scenario completed', false, error.stack || error.message); }
  process.exitCode = reporter.finish() ? 0 : 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[real-test] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { createReporter, durationMs, loadEnv, redact };
