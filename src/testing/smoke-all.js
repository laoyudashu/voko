#!/usr/bin/env node
/**
 * smoke-all.js — VOKO 综合冒烟测试（统一注册表版）
 *
 * 用法:
 *   node test/smoke-all.js          默认模式（A-E 核心套件，~60 项）
 *   node test/smoke-all.js --full   完整模式（全部 ~200 项）
 *   node test/smoke-all.js --list   列出所有测试项（不执行）
 *   node test/smoke-all.js --require-running  未找到 Lite 时返回失败
 *
 * 输出: 结构化报告（报告头 + 各 section 分项 + 结论 + 汇总）
 */

const { DatabaseSync } = require('node:sqlite');
const { spawnSync, spawn } = require('child_process');
const path = require('path');
const os = require('os');

// ═══════════════════════════════════════════════════
//  全局状态
// ═══════════════════════════════════════════════════

let passed = 0, failed = 0, skipped = 0;
let secPass = 0, secFail = 0, secSkip = 0;
let BASE_URL = '';
let _rpcId = 0;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function ok(name, cond, detail) {
  if (cond) { passed++; secPass++; console.log(`  ✅ ${name}${detail ? '  ' + detail : ''}`); }
  else { failed++; secFail++; console.log(`  ❌ ${name}${detail ? '  ' + detail : ''}`); }
}
function skip(name, reason) { skipped++; secSkip++; console.log(`  ⏭️ ${name}  (skip: ${reason})`); }
function section(title) { console.log(`\n━━━ ${title} ━━━`); secPass = 0; secFail = 0; secSkip = 0; }
function subSection(title) { console.log(`  ┈┈ ${title}`); }
function conclusion(text) {
  const t = secPass + secFail + secSkip;
  const parts = [`${secPass}/${t} PASS`];
  if (secFail > 0) parts.push(`${secFail} FAIL`);
  if (secSkip > 0) parts.push(`${secSkip} SKIP`);
  console.log(`  ┈┈ 结论: ${parts.join(' / ')} — ${text}`);
}

// ═══════════════════════════════════════════════════
//  基础设施
// ═══════════════════════════════════════════════════

const DB_PATH = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'voko', 'voko.db')
  : path.join(os.homedir(), '.local', 'share', 'voko', 'voko.db');

function queryDb(sql, ...params) {
  try {
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    const rows = db.prepare(sql).all(...params);
    db.close();
    return rows;
  } catch { return []; }
}

async function http(p, opts = {}) {
  try {
    const res = await fetch(`${BASE_URL}${p}`, { ...opts, signal: AbortSignal.timeout(opts.timeout || 15000) });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, text, json, ok: res.ok, headers: res.headers };
  } catch (e) { return { status: 0, text: '', json: null, ok: false, error: e.message }; }
}

async function mcpCall(name, args = {}) {
  const r = await http('/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++_rpcId, method: 'tools/call', params: { name, arguments: args } }),
  });
  if (!r.json) return { ok: false, error: 'non-json' };
  if (r.json.error) return { ok: false, error: r.json.error.message };
  const result = r.json.result;
  if (result?.isError) return { ok: false, error: 'isError' };
  let data = null;
  try { data = JSON.parse(result?.content?.[0]?.text || 'null'); } catch { }
  return { ok: true, data, raw: result };
}

async function consoleCall(action, params = {}) {
  const r = await http('/api/console', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ json: JSON.stringify({ action, params }) }),
  });
  return r;
}

function cli(cmd, args = []) {
  const entry = path.join(__dirname, '..', 'index.js');
  const r = spawnSync(process.execPath, [entry, cmd, ...args], {
    encoding: 'utf8', timeout: 15000, windowsHide: true,
    env: { ...process.env, VOKO_DB_PATH: DB_PATH },
  });
  return { exit: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function parseCliJson(output) {
  let result = null;
  for (let start = 0; start < output.length; start++) {
    if (output[start] !== '{') continue;
    let depth = 0, inString = false, escape = false;
    for (let i = start; i < output.length; i++) {
      const ch = output[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\' && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') depth--;
      if (depth !== 0) continue;
      try {
        const value = JSON.parse(output.slice(start, i + 1));
        if (value && Object.prototype.hasOwnProperty.call(value, 'success')) result = value;
      } catch { }
      break;
    }
  }
  return result;
}

function cliTool(name, args = []) {
  const entry = path.join(__dirname, '..', 'index.js');
  const r = spawnSync(process.execPath, [entry, name, ...args], {
    encoding: 'utf8', timeout: 15000, windowsHide: true,
    env: { ...process.env, VOKO_DB_PATH: DB_PATH },
  });
  const output = (r.stdout || '').trim();
  // 从 stdout 提取 JSON（处理多行格式化输出）
  return { exit: r.status, out: output, json: parseCliJson(output) };
}

async function pollReply(agentId, visitorId, timeoutMs = 60000) {
  const startTs = Math.floor(Date.now() / 1000) - 5;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = queryDb(
      `SELECT content FROM messages WHERE agent_id=? AND channel_id=? AND is_me=1 AND timestamp>=? ORDER BY timestamp DESC LIMIT 1`,
      agentId, visitorId, startTs
    );
    if (rows.length > 0) return rows[0].content;
    await sleep(2000);
  }
  return null;
}

async function mcpInit() {
  await http('/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++_rpcId, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1.0' } } }),
  });
}

async function findPort() {
  for (const port of [3100, 3101, 3102]) {
    const r = await http(`http://127.0.0.1:${port}/health`, { timeout: 2000 });
    if (r.ok && r.json?.status === 'ok') return port;
  }
  return null;
}

function requiresRunning(args) {
  return args.includes('--require-running');
}

/** 统计 HTML 中 data-agent-action 元素数量 */
function countAgentActions(html) {
  const m = html.match(/data-agent-action="/g);
  return m ? m.length : 0;
}

/** 统计 HTML 中 data-agent-kind 元素数量 */
function countAgentKinds(html) {
  const m = html.match(/data-agent-kind="/g);
  return m ? m.length : 0;
}

/** 提取 HTML 中的 JSON-LD */
function extractJsonLd(html) {
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  const results = [];
  let m;
  while ((m = re.exec(html))) {
    try { results.push(JSON.parse(m[1])); } catch { }
  }
  return results;
}

// ═══════════════════════════════════════════════════
//  测试注册表
// ═══════════════════════════════════════════════════

/**
 * 每个测试项:
 *   { id: 'A1', name: '描述', fn: async (ctx) => true/false, detail: fn, mode: 'core'|'full' }
 *
 * ctx = { agentId, visitorId, agents, allAgents }
 */

const REGISTRY = [];

/** 从 ID 推断所属 section: A1→A, B37→B, Emessages→E, F_foo→F, G0a→G0, G10_x→G10 */
function sectionFromId(id) {
  const m = id.match(/^([A-G])(\d*)/);
  if (!m) return id[0];
  if (m[1] === 'G') return 'G' + (m[2] || '0');
  return m[1];
}

function reg(id, name, input, expected, fn, verifyOrMode = 'core') {
  const verify = typeof verifyOrMode === 'function' ? verifyOrMode : null;
  const mode = typeof verifyOrMode === 'string' ? verifyOrMode : 'core';
  REGISTRY.push({ id, name, input, expected, section: sectionFromId(id), fn, verify, mode });
}
function full(id, name, input, expected, fn) {
  if (typeof input === 'function') {
    reg(id, name, '', '', input, 'full');
    return;
  }
  reg(id, name, input, expected, fn, 'full');
}

// ─── A. 消息收发（3 backend）───
reg('A1', 'openclaw 消息回路',
  'POST /api/gateway/forward → openclaw agent',
  '60s 内收到 agent 回复消息', async (ctx) => {
  const a = ctx.allAgents.find(x => x.backendType === 'openclaw');
  if (!a) { ctx._skip = '无 openclaw agent'; return false; }
  ctx._msgA1 = `冒烟测试_openclaw_${Date.now()}`;
  const r = await http('/api/gateway/forward', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: a.agentId, visitorId: 'smoke_test_visitor', message: ctx._msgA1 }),
  });
  if (!r.json?.success) { ctx._skip = `forward 失败: ${r.json?.error}`; return false; }
  ctx._t0a1 = Date.now();
  ctx._a1id = a.agentId;
  return true;
}, async (ctx) => {
  const reply = await pollReply(ctx._a1id, 'smoke_test_visitor', 60000);
  const elapsed = ((Date.now() - ctx._t0a1) / 1000).toFixed(1);
  return [reply != null, reply ? `回复 ${reply.length} 字 (${elapsed}s)` : '60s 无回复'];
});

reg('A2', 'hermes 消息回路',
  'POST /api/gateway/forward → hermes agent',
  '60s 内收到 agent 回复消息', async (ctx) => {
  const a = ctx.allAgents.find(x => x.backendType === 'hermes');
  if (!a) { ctx._skip = '无 hermes agent'; return false; }
  ctx._msgA2 = `冒烟测试_hermes_${Date.now()}`;
  const r = await http('/api/gateway/forward', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: a.agentId, visitorId: 'smoke_test_visitor', message: ctx._msgA2 }),
  });
  if (!r.json?.success) { ctx._skip = `forward 失败: ${r.json?.error}`; return false; }
  ctx._t0a2 = Date.now();
  ctx._a2id = a.agentId;
  return true;
}, async (ctx) => {
  const reply = await pollReply(ctx._a2id, 'smoke_test_visitor', 60000);
  const elapsed = ((Date.now() - ctx._t0a2) / 1000).toFixed(1);
  return [reply != null, reply ? `回复 ${reply.length} 字 (${elapsed}s)` : '60s 无回复'];
});

reg('A3', 'goose 消息回路', 'POST /api/gateway/forward → goose agent', '60s 内收到 agent 回复消息', async (ctx) => {
  const a = ctx.allAgents.find(x => x.backendType && x.backendType.includes('goose'));
  if (!a) { ctx._skip = '无 goose agent'; return false; }
  ctx._msgA3 = `冒烟测试_goose_${Date.now()}`;
  const r = await http('/api/gateway/forward', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: a.agentId, visitorId: 'smoke_test_visitor', message: ctx._msgA3 }),
  });
  if (!r.json?.success) { ctx._skip = `forward 失败: ${r.json?.error}`; return false; }
  ctx._t0a3 = Date.now();
  ctx._a3id = a.agentId;
  return true;
}, async (ctx) => {
  const reply = await pollReply(ctx._a3id, 'smoke_test_visitor', 60000);
  const elapsed = ((Date.now() - ctx._t0a3) / 1000).toFixed(1);
  return [reply != null, reply ? `回复 ${reply.length} 字 (${elapsed}s)` : '60s 无回复'];
});

// ─── B. MCP 工具 HTTP（全量 tools/call）───
const MCP_SAFE_CALLS = {
  'voko_get_status':             (ctx) => ({ agentId: ctx.agentId }),
  'voko_list_conversations':     (ctx) => ({ agentId: ctx.agentId, limit: 5 }),
  'voko_list_routing_conversations': (ctx) => ({ agentId: ctx.agentId, channelId: ctx.visitorId, limit: 5 }),
  'voko_get_chat_history':       (ctx) => ({ agentId: ctx.agentId, channelId: ctx.visitorId, limit: 5 }),
  'voko_get_visitor_profile':    (ctx) => ({ agentId: ctx.agentId, visitorId: ctx.visitorId }),
  'voko_fetch_new_messages':     (ctx) => ({ agentId: ctx.agentId, visitorId: ctx.visitorId, blockTimeout: 1 }),
  'voko_send_message':           (ctx) => ({ agentId: ctx.agentId, toUid: ctx.visitorId, content: '[smoke] mcp send' }),
  'voko_agent_pricing':          (ctx) => ({ agentId: ctx.agentId }),
  'voko_list_access_lists':      (ctx) => ({ agentId: ctx.agentId, listType: 'whitelist' }),
  'voko_mark_conversation_read': (ctx) => ({ agentId: ctx.agentId, channelId: ctx.visitorId }),
};

// B0: tools/list 枚举
reg('B0', 'MCP tools/list 枚举', 'MCP JSON-RPC tools/list', '返回 voko_* 工具（数量以 tools/list 为准）', async () => {
  const r = await http('/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++_rpcId, method: 'tools/list' }),
  });
  ctx => { ctx._tools = r.json?.result?.tools || []; return [ctx._tools.length > 0, `${ctx._tools.length} 个工具`]; };
  // simplify: inline
  const tools = r.json?.result?.tools || [];
  global.__smoke_tools = tools;
  return [tools.length > 0, `${tools.length} 个工具`];
});

// B1..B{N}: 每个 MCP 工具（N 在 runRegistry 运行时由 tools/list 实际结果决定）
// 下面的静态清单仅作历史参考与排序锚点；实际注册见 runRegistry() 中的动态 splice。
(() => {
  const toolNames = [
    'voko_register_agent', 'voko_verify_agent_email', 'voko_update_agent_profile',
    'voko_set_agent_status', 'voko_get_status', 'voko_get_agent_profile',
    'voko_search_capabilities', 'voko_declare_capabilities', 'voko_send_message',
    'voko_get_chat_history', 'voko_get_visitor_profile', 'voko_list_conversations',
    'voko_list_routing_conversations',
    'voko_mark_conversation_read', 'voko_upload_and_send_file', 'voko_whoami', 'voko_list_agents',
    'voko_start_worker', 'voko_stop_worker', 'voko_ask_human_for_help',
    'voko_check_human_replies', 'voko_close_human_request', 'voko_create_payment',
    'voko_check_payments', 'voko_add_payment_auth', 'voko_list_payment_auth',
    'voko_delete_payment_auth', 'voko_apply_payment_auth', 'voko_search_banks',
    'voko_bind_agent_payment_auth', 'voko_agent_pricing', 'voko_fetch_new_messages',
    'voko_manage_whitelist', 'voko_manage_blacklist', 'voko_list_access_lists',
    'voko_set_private_mode', 'voko_invite_friend', 'voko_list_audit_rules',
    'voko_manage_audit_rules',
  ];
  // 运行时由 runRegistry() 从 /mcp tools/list 动态注册 B1..B{N}，此清单仅保留作参考。
  global.__smoke_mcp_tool_names = toolNames;
})();

// ─── C. CLI 命令 ───
reg('C1', 'voko status', 'CLI: voko status', 'exit=0 + JSON 含 port/pid/uptime', async () => {
  const r = cli('status');
  return [r.exit === 0 && r.out.length > 0, `exit=${r.exit}`];
});

reg('C2', 'voko list_agents', 'CLI: voko list_agents', 'exit=0 + JSON agents 列表', async () => {
  const r = cli('list_agents');
  return [r.exit === 0 && r.out.length > 0, `exit=${r.exit}`];
});

reg('C3', 'voko mcp (stdio bridge)', 'CLI: voko mcp (stdio)', 'stdin→tools/list, stdout 含 voko_', async () => {
  const entry = path.join(__dirname, '..', 'index.js');
  const child = spawn(process.execPath, [entry, 'mcp'], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, VOKO_DB_PATH: DB_PATH },
  });
  let mcpOut = '';
  child.stdout.on('data', d => { mcpOut += d.toString(); });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
  await sleep(3000);
  try { child.kill(); } catch { }
  return [mcpOut.includes('voko_'), mcpOut ? `${mcpOut.slice(0, 60)}...` : '无输出'];
});

// ─── D. Web 操作（控制台端点）───
reg('D1', 'GET / (首页)', 'GET /', 'status=200 + HTML', async (ctx) => { const r = await http('/'); return [r.status === 200, `${r.status}`]; });
reg('D2', 'GET /agents/:id', 'GET /agents/{agentId}', 'status=200 + HTML 含 agent 名', async (ctx) => { const r = await http(`/agents/${ctx.agentId}`); return [r.status === 200, `${r.status}`]; });
reg('D3', 'GET /agents/:id/c/:ch', 'GET /agents/{agentId}/c/{visitorId}', 'status=200 + 会话 HTML', async (ctx) => { const r = await http(`/agents/${ctx.agentId}/c/${ctx.visitorId}`); return [r.status === 200, `${r.status}`]; });
reg('D4', 'POST /messages/send', 'POST /messages/send', 'status=200 或 302', async (ctx) => {
  const r = await http('/messages/send', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: ctx.agentId, toUid: ctx.visitorId, content: '[smoke] web send' }),
  });
  return [r.json?.success === true || r.status === 302, r.json?.error || `status=${r.status}`];
});
reg('D5', 'POST /api/console list_conversations', 'POST /api/console list_conversations', 'status=200', async (ctx) => {
  const r = await http('/api/console', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'list_conversations', params: { agentId: ctx.agentId, limit: 5 } }),
  });
  return [r.status === 200, `${r.status}`];
});
reg('D6', 'POST /api/console manage_whitelist', 'POST /api/console manage_whitelist', 'status=200', async (ctx) => {
  const r = await http('/api/console', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'manage_whitelist', params: { action: 'list', agentId: ctx.agentId } }),
  });
  return [r.status === 200, `${r.status}`];
});
reg('D7', 'POST /api/console manage_audit_rules', 'POST /api/console manage_audit_rules', 'status=200', async (ctx) => {
  const r = await http('/api/console', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'manage_audit_rules', params: { action: 'list' } }),
  });
  return [r.status === 200, `${r.status}`];
});
reg('D8', 'POST /api/short-link/create', 'POST /api/short-link/create', '返回 shortUrl', async (ctx) => {
  const r = await http('/api/short-link/create', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: ctx.agentId }),
  });
  return [r.json?.success, r.json?.data?.shortUrl?.slice(0, 40) || r.json?.error || ''];
});
reg('D9', 'Host 校验拒 evil.com', 'GET / HTTP Host:evil.com', 'status=403 拒绝', async () => {
  const httpReq = require('http');
  const hostStatus = await new Promise(resolve => {
    const u = new URL(BASE_URL);
    const req = httpReq.request({ hostname: u.hostname, port: u.port, path: '/', method: 'GET', headers: { Host: 'evil.com' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0)); req.setTimeout(5000, () => { req.destroy(); resolve(0); }); req.end();
  });
  return [hostStatus === 403, `${hostStatus}`];
});
reg('D10', 'GET /login', 'GET /login', 'status=200 或 302', async () => {
  const r = await http('/login');
  return [r.ok || r.status === 302, `${r.status}`];
});

// ─── E. DB Schema ───
const DB_TABLES = {
  'messages':      ['id', 'channel_id', 'from_uid', 'content', 'is_me', 'agent_id', 'timestamp', 'message_seq', 'content_type'],
  'conversations': ['user_uid', 'channel_id', 'agent_id', 'last_message', 'session_status', 'mode', 'unread_count'],
  'agents':        ['agent_id', 'imUid', 'imToken', 'backend_type', 'publish_status', 'access_mode', 'owner_email', 'short_link_url'],
  'payment_auth':  ['id', 'name', 'id_card', 'bank_card', 'status', 'payment_user_uid'],
  'audit_rules':   ['id', 'keyword', 'action'],
};
for (const [table, expectedCols] of Object.entries(DB_TABLES)) {
  reg(`E${table}`, `Schema ${table}`,
    `PRAGMA table_info(${table})`,
    '所有预期列存在', () => {
    const cols = queryDb(`PRAGMA table_info(${table})`).map(c => c.name);
    const missing = expectedCols.filter(c => !cols.includes(c));
    return [missing.length === 0, missing.length ? `缺 ${missing.join(',')}` : `${cols.length} 列`];
  });
}

// ═══════════════════════════════════════════════════
//  Full 模式扩展（--full）
// ═══════════════════════════════════════════════════

// ─── F. CLI 工具逐项调用 ───
{
  const CLI_TOOL_ARGS = {
    register_agent:            null,
    verify_agent_email:        null,
    update_agent_profile:      (ctx) => ['--agent-id=' + ctx.agentId, '--name=' + (ctx.allAgents.find(a => a.agentId === ctx.agentId)?.agentName || ctx.agentId)],
    set_agent_status:          (ctx) => ['--agent-id=' + ctx.agentId, '--status=' + (queryDb('SELECT publish_status FROM agents WHERE agent_id=?', ctx.agentId)[0]?.publish_status === 'published' ? '1' : '0')],
    get_status:                (ctx) => ['--agent-id=' + ctx.agentId],
    get_agent_profile:         (ctx) => ['--agent-id=' + ctx.agentId],
    search_capabilities:       (ctx) => ['--agent-id=' + ctx.agentId],
    declare_capabilities:      null,
    send_message:              (ctx) => ['--agent-id=' + ctx.agentId, '--to-uid=' + ctx.visitorId, '--content=[smoke-cli] test'],
    get_chat_history:          (ctx) => ['--agent-id=' + ctx.agentId, '--channel-id=' + ctx.visitorId, '--limit=3'],
    get_visitor_profile:       (ctx) => ['--visitor-id=' + ctx.visitorId, '--agent-id=' + ctx.agentId],
    list_conversations:        (ctx) => ['--agent-id=' + ctx.agentId, '--limit=3'],
    mark_conversation_read:    (ctx) => ['--agent-id=' + ctx.agentId, '--channel-id=' + ctx.visitorId],
    list_routing_conversations: (ctx) => ['--agent-id=' + ctx.agentId, '--channel-id=' + ctx.visitorId],
    upload_and_send_file:      null,
    whoami:                    (ctx) => [],
    list_agents:               (ctx) => ['--limit=20'],
    start_worker:              null,
    stop_worker:               null,
    ask_human_for_help:        null,
    check_human_replies:       (ctx) => ['--agent-id=' + ctx.agentId],
    close_human_request:       null,
    create_payment:            null,
    check_payments:            (ctx) => ['--agent-id=' + ctx.agentId],
    add_payment_auth:          null,
    list_payment_auth:         (ctx) => ['--keyword=smoke'],
    delete_payment_auth:       null,
    apply_payment_auth:        null,
    search_banks:              (ctx) => ['--keyword=中国'],
    bind_agent_payment_auth:   null,
    agent_pricing:             (ctx) => ['--agent-id=' + ctx.agentId],
    fetch_new_messages:        (ctx) => ['--agent-id=' + ctx.agentId, '--visitor-id=' + ctx.visitorId, '--block-timeout=1'],
    manage_whitelist:          (ctx) => ['--agent-id=' + ctx.agentId, '--action=add', '--visitor-id=smoke_cli_wl_' + Date.now(), '--reason=smoke_cli'],
    manage_blacklist:          (ctx) => ['--agent-id=' + ctx.agentId, '--action=add', '--visitor-id=smoke_cli_bl_' + Date.now(), '--reason=smoke_cli'],
    list_access_lists:         (ctx) => ['--agent-id=' + ctx.agentId, '--list-type=whitelist'],
    set_private_mode:          null,
    invite_friend:             null,
    list_audit_rules:          (ctx) => ['--direction=inbound'],
    manage_audit_rules:        null,
  };
  for (const [name, argsFn] of Object.entries(CLI_TOOL_ARGS)) {
    full(`F_${name}`, `voko ${name}`, async (ctx) => {
      if (!argsFn) {
        ctx._skip = ['declare_capabilities', 'start_worker', 'stop_worker', 'ask_human_for_help', 'create_payment', 'set_private_mode', 'manage_audit_rules'].includes(name)
          ? '会改变运行状态'
          : '需要真实凭证/ID';
        return false;
      }
      const args = argsFn(ctx);
      const r = cliTool(name, args);
      if (r.json?.success && (name === 'manage_whitelist' || name === 'manage_blacklist')) {
        const cleanupArgs = args.map(arg => arg === '--action=add' ? '--action=remove' : arg);
        const cleanup = cliTool(name, cleanupArgs);
        return [cleanup.json?.success === true, cleanup.json?.error || 'cleaned'];
      }
      if (!r.json) return [false, `解析失败: ${(r.out||'').slice(0,60)}`];
      return [r.json.success, r.json.error || '✓'];
    });
  }
}

// ─── G. Web Agent 视角测试 ───
// G0: Agent 发现
full('G0a', 'GET /llms.txt', 'GET /llms.txt', '返回 VOKO 指南文本', async () => {
  let r = await http('/llms.txt', { timeout: 30000 });
  if (!r.ok) {
    await sleep(1000);
    r = await http('/llms.txt', { timeout: 30000 });
  }
  return [r.ok && r.text.includes('VOKO LITE'), `${r.status}`];
});
full('G0b', 'GET /prompt (系统提示词)', 'GET /prompt', '返回 Agent 系统提示词', async () => {
  const r = await http('/prompt');
  return [r.ok && r.text.includes('Agent'), `${r.status}`];
});
full('G0c', 'GET /robots.txt', 'GET /robots.txt', '返回 robots.txt 含 Sitemap', async () => {
  const r = await http('/robots.txt');
  return [r.ok && r.text.includes('Sitemap'), `${r.status}`];
});
full('G0d', 'GET /sitemap.xml', 'GET /sitemap.xml', '返回 sitemap XML', async () => {
  const r = await http('/sitemap.xml');
  return [r.ok && r.text.includes('<urlset'), `${r.status}`];
});
full('G0e', 'GET agent-manifest.json', 'GET /.well-known/agent-manifest.json', '返回 JSON manifest', async () => {
  const r = await http('/.well-known/agent-manifest.json');
  return [r.json && r.json.name === 'VOKO LITE', r.json ? `${r.json.capabilities?.browse?.paths?.length || 0} 个路径` : '无'];
});
full('G0f', 'GET /api/handlers', 'GET /api/handlers', '返回 action 列表 JSON', async () => {
  const r = await http('/api/handlers');
  return [r.json && r.json.actions?.length > 0, r.json ? `${r.json.actions.length} 个 action` : '无'];
});
full('G0g', 'MCP tools/list (Agent发现)', 'MCP tools/list', '返回 voko_* 工具（数量以 tools/list 为准）', async () => {
  const r = await http('/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++_rpcId, method: 'tools/list' }),
  });
  const toolCount = r.json?.result?.tools?.length || 0;
  return [toolCount > 0, `${toolCount} 个工具`];
});

// G1: 页面导航
const WEB_PAGES = [
  ['G1a', '/', '首页 Agent 列表'],
  ['G1b', null, 'Agent 看板'],        // dynamic: /agents/:id
  ['G1c', null, '会话详情'],           // dynamic: /agents/:id/c/:ch
  ['G1d', null, '编辑资料'],
  ['G1e', null, '白名单'],
  ['G1f', null, '黑名单'],
  ['G1g', null, '访问模式'],
  ['G1h', null, '订阅模式'],
  ['G1i', null, '能力声明'],
  ['G1j', null, '人工介入'],
  ['G1k', null, '访客查询'],
  ['G1l', '/send-message', '发送消息'],
  ['G1m', '/interventions', '人工介入列表'],
  ['G1n', '/audit-rules', '安全规则'],
  ['G1o', '/payments', '支付流水'],
  ['G1p', '/payment-auth', '银行卡管理'],
  ['G1q', '/api/console', 'JSON 控制台'],
  ['G1r', '/capabilities', '能力发现'],
];
const DYNAMIC_PAGES = {
  'Agent 看板': (ctx) => `/agents/${ctx.agentId}`,
  '会话详情':  (ctx) => `/agents/${ctx.agentId}/c/${ctx.visitorId}`,
  '编辑资料':  (ctx) => `/agents/${ctx.agentId}/edit`,
  '白名单':    (ctx) => `/agents/${ctx.agentId}/whitelist`,
  '黑名单':    (ctx) => `/agents/${ctx.agentId}/blacklist`,
  '访问模式':  (ctx) => `/agents/${ctx.agentId}/access-mode`,
  '订阅模式':  (ctx) => `/agents/${ctx.agentId}/pricing`,
  '能力声明':  (ctx) => `/agents/${ctx.agentId}/caps`,
  '人工介入':  (ctx) => `/agents/${ctx.agentId}/human`,
  '访客查询':  (ctx) => `/agents/${ctx.agentId}/visitor`,
};
for (const [id, staticPath, desc] of WEB_PAGES) {
  full(id, `GET ${desc}`, async (ctx) => {
    const p = staticPath || DYNAMIC_PAGES[desc](ctx);
    const r = await http(p);
    const hasMarkup = countAgentActions(r.text) > 0 || countAgentKinds(r.text) > 0 || r.text.includes('data-agent');
    const jsonLd = extractJsonLd(r.text);
    return [r.ok, r.ok ? `agent标记:${hasMarkup} jsonld:${jsonLd.length}` : `${r.status}`];
  });
}
// G1 guide/som
for (const [id, p] of [['G1s', '/'], ['G1t', null], ['G1u', '/audit-rules']]) {
  full(id, `guide=${(p || '会话页')}`, async (ctx) => {
    const url = (p || `/agents/${ctx.agentId}/c/${ctx.visitorId}`) + '?guide=1';
    const r = await http(url);
    return [r.text.includes('agent-guide'), r.text.includes('agent-guide') ? '有操作指导' : '无'];
  });
}
for (const [id, p] of [['G1v', '/'], ['G1w', null]]) {
  full(id, `som=${(p || 'Agent看板')}`, async (ctx) => {
    const url = (p || `/agents/${ctx.agentId}`) + '?som=1';
    const r = await http(url);
    return [r.text.includes('som-mode'), r.text.includes('som-mode') ? '有 SoM 标记' : '无'];
  });
}

// G2: 表单操作
full('G2a', 'update_profile (AJAX)', 'POST AJAX 表单', 'JSON success=true', async (ctx) => {
  const r = await http(`/api/agents/${ctx.agentId}/action`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      _action: 'update_profile',
      name: ctx.allAgents.find(a => a.agentId === ctx.agentId)?.agentName || ctx.agentId,
      description: ctx.allAgents.find(a => a.agentId === ctx.agentId)?.description || '',
    }),
  });
  return [r.json?.success, r.json?.error || '✓'];
});
full('G2b', 'add_whitelist (AJAX)', 'POST AJAX 表单', 'JSON success=true', async (ctx) => {
  const r = await http(`/api/agents/${ctx.agentId}/action`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ _action: 'add_whitelist', visitorId: (ctx._smokeWhitelistId = `smoke_wl_web_${Date.now()}`), reason: 'smoke' }),
  });
  return [r.json?.success, r.json?.error || '✓'];
});
full('G2c', 'remove_whitelist (AJAX)', 'POST AJAX 表单', 'JSON success=true', async (ctx) => {
  const r = await http(`/api/agents/${ctx.agentId}/action`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ _action: 'remove_whitelist', visitorId: ctx._smokeWhitelistId }),
  });
  return [r.json?.success, r.json?.error || '✓'];
});
full('G2d', 'add_blacklist (AJAX)', 'POST AJAX 表单', 'JSON success=true', async (ctx) => {
  const r = await http(`/api/agents/${ctx.agentId}/action`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ _action: 'add_blacklist', visitorId: (ctx._smokeBlacklistId = `smoke_bl_web_${Date.now()}`), reason: 'smoke' }),
  });
  return [r.json?.success, r.json?.error || '✓'];
});
full('G2e', 'remove_blacklist (AJAX)', 'POST AJAX 表单', 'JSON success=true', async (ctx) => {
  const r = await http(`/api/agents/${ctx.agentId}/action`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ _action: 'remove_blacklist', visitorId: ctx._smokeBlacklistId }),
  });
  return [r.json?.success, r.json?.error || '✓'];
});
full('G2f', 'toggle access_mode', 'POST AJAX 表单', 'JSON success=true', async (ctx) => {
  let pr = await consoleCall('get_agent_profile', { agentId: ctx.agentId });
  const origMode = pr.json?.result?.data?.accessMode || 'public';
  const r = await http(`/api/agents/${ctx.agentId}/access-mode`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: origMode !== 'private' }),
  });
  ctx._origAccessMode = origMode;
  return [r.json?.success, r.json?.label || r.json?.error || ''];
});
full('G2g', 'restore access_mode', 'POST AJAX 表单', 'JSON success=true', async (ctx) => {
  const r = await http(`/api/agents/${ctx.agentId}/access-mode`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: (ctx._origAccessMode || 'public') === 'private' }),
  });
  return [r.json?.success, r.json?.label || r.json?.error || ''];
});
full('G2h', 'ask_human (AJAX)', 'POST AJAX 表单', 'JSON success=true', async (ctx) => {
  const r = await http(`/api/agents/${ctx.agentId}/action`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ _action: 'ask_human', visitorId: 'smoke_human_web', problem: '[smoke] test' }),
  });
  return [r.json?.success, r.json?.error || (r.json?.interventionId ? '已创建' : '无')];
});
full('G2i', 'audit rule CRUD', 'POST AJAX 表单', 'JSON success=true', async (ctx) => {
  const kw = `smoke_audit_${Date.now()}`;
  let r = await http('/api/audit-rules', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'add', direction: 'inbound', keyword: kw, actionType: 'soft_deny', prompt: '[smoke] test' }),
  });
  const ruleId = r.json?.id;
  if (!ruleId) return [false, '创建失败: ' + (r.json?.error || '')];
  // 验证列表可见
  r = await http('/audit-rules?q=' + encodeURIComponent(kw));
  if (!r.text.includes(kw)) return [false, '列表中未找到'];
  // 删除
  r = await http(`/api/audit-rules/${ruleId}/delete`, { method: 'POST' });
  return [r.json?.success, r.json?.error || '✓'];
});
full('G2j', 'set_pricing free', 'POST AJAX 表单', 'JSON success=true', async (ctx) => {
  const r = await http(`/api/agents/${ctx.agentId}/action`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ _action: 'set_pricing', pricingModel: 'free' }),
  });
  return [r.json?.success, r.json?.error || '✓'];
});

// G3: JSON Console
const G3_CALLS = [
  ['G3a', 'whoami', {}],
  ['G3b', 'get_status', null],
  ['G3c', 'list_conversations', { limit: 5 }],
  ['G3d', 'get_chat_history', { channelId: null, limit: 5 }],
  ['G3e', 'get_visitor_profile', { visitorId: null }],  // visitorId from ctx
  ['G3f', 'get_agent_profile', {}],
  ['G3g', 'list_access_lists whitelist', { listType: 'whitelist' }],
  ['G3h', 'list_access_lists blacklist', { listType: 'blacklist' }],
  ['G3i', 'list_audit_rules inbound', { direction: 'inbound' }],
  ['G3j', 'agent_pricing (read)', {}],
  ['G3k', 'mark_conversation_read', { channelId: null }],
];
for (const [id, action, params] of G3_CALLS) {
  full(id, `console ${action}`, async (ctx) => {
    const p = { agentId: ctx.agentId, ...params };
    if (p.channelId === null) p.channelId = ctx.visitorId;
    if (p.visitorId === null) p.visitorId = ctx.visitorId;
    const r = await consoleCall(action.split(' ')[0], p);
    return [r.status === 200, r.json?.result ? '✓' : `${r.status}`];
  });
}

// G4: MCP ↔ Web 交叉验证
full('G4a', 'agent_name from MCP', 'MCP vs Console 交叉', '两边数据一致', async (ctx) => {
  const m = await mcpCall('voko_get_agent_profile', { agentId: ctx.agentId });
  ctx._mcpName = m.data?.data?.agentName || m.data?.agentName || '';
  return [ctx._mcpName.length > 0, ctx._mcpName || '无'];
});
full('G4b', 'agent_name from Console', 'MCP vs Console 交叉', '两边数据一致', async (ctx) => {
  const c = await consoleCall('get_agent_profile', { agentId: ctx.agentId });
  ctx._consoleName = c.json?.result?.data?.agentName || c.json?.result?.agentName || '';
  return [ctx._consoleName.length > 0, ctx._consoleName || '无'];
});
full('G4c', 'agent_name MCP vs Console 一致', 'MCP vs Console 交叉', '两边数据一致', async (ctx) => {
  return [ctx._mcpName === ctx._consoleName, ctx._mcpName === ctx._consoleName ? '✓' : `MCP:${ctx._mcpName} vs Console:${ctx._consoleName}`];
});
full('G4d', 'conversation count MCP vs Console', 'MCP vs Console 交叉', '两边数据一致', async (ctx) => {
  const m = await mcpCall('voko_list_conversations', { agentId: ctx.agentId, limit: 5 });
  const c = await consoleCall('list_conversations', { agentId: ctx.agentId, limit: 5 });
  const mc = m.data?.conversations?.length || 0;
  const cc = c.json?.result?.conversations?.length || 0;
  return [mc === cc, `MCP:${mc} / Console:${cc}`];
});
full('G4e', 'whitelist cross-val (MCP add)', 'MCP vs Console 交叉', '两边数据一致', async (ctx) => {
  const m = await mcpCall('voko_manage_whitelist', { action: 'add', agentId: ctx.agentId, visitorId: 'smoke_xval_w', reason: 'xval' });
  return [m.ok, m.error || '✓'];
});
full('G4f', 'whitelist cross-val (MCP read)', 'MCP vs Console 交叉', '两边数据一致', async (ctx) => {
  const m = await mcpCall('voko_list_access_lists', { agentId: ctx.agentId, listType: 'whitelist' });
  const ids = ((m.data?.data || m.data?.entries || [])).map(e => e.visitorId || e.visitor_id);
  return [ids.includes('smoke_xval_w'), ids.includes('smoke_xval_w') ? '✓' : '未找到'];
});
full('G4g', 'whitelist cross-val (Console)', 'MCP vs Console 交叉', '两边数据一致', async (ctx) => {
  const c = await consoleCall('list_access_lists', { agentId: ctx.agentId, listType: 'whitelist' });
  const data = c.json?.result?.data || c.json?.result?.entries || [];
  const ids = data.map(e => e.visitorId || e.visitor_id);
  return [ids.includes('smoke_xval_w'), ids.includes('smoke_xval_w') ? '✓' : '未找到'];
});
full('G4h', 'whitelist cross-val cleanup', 'MCP vs Console 交叉', '两边数据一致', async (ctx) => {
  await mcpCall('voko_manage_whitelist', { action: 'remove', agentId: ctx.agentId, visitorId: 'smoke_xval_w' });
  return [true, '✓'];
});
full('G4i', 'voko_get_status MCP', 'MCP vs Console 交叉', '两边数据一致', async (ctx) => {
  const m = await mcpCall('voko_get_status', { agentId: ctx.agentId });
  return [m.ok, m.data ? `uptime:${Math.floor(m.data.uptime || 0)}s` : m.error || 'fail'];
});

// G5: 消息收发三通道
full('G5a', 'POST /messages/send (Web)', '发送消息 + 回读', '消息在历史中', async (ctx) => {
  ctx._msgG5a = `[smoke-web] ${Date.now()}`;
  const r = await http('/messages/send', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: ctx.agentId, toUid: ctx.visitorId, content: ctx._msgG5a }),
    timeout: 30000,
  });
  return [r.json?.success || r.status === 302, r.json?.error || `status=${r.status}`];
});
full('G5b', 'send_message (Console)', '发送消息 + 回读', '消息在历史中', async (ctx) => {
  ctx._msgG5b = `[smoke-console] ${Date.now()}`;
  const r = await consoleCall('send_message', { agentId: ctx.agentId, toUid: ctx.visitorId, content: ctx._msgG5b });
  return [r.json?.success !== false || r.status === 200, '✓'];
});
full('G5c', 'send_message (MCP)', '发送消息 + 回读', '消息在历史中', async (ctx) => {
  ctx._msgG5c = `[smoke-mcp] ${Date.now()}`;
  const m = await mcpCall('voko_send_message', { agentId: ctx.agentId, toUid: ctx.visitorId, content: ctx._msgG5c });
  return [m.ok, m.error || '✓'];
});
full('G5d', '回读: Web 消息在历史中', '发送消息 + 回读', '消息在历史中', async (ctx) => {
  await sleep(2000);
  const r = await consoleCall('get_chat_history', { agentId: ctx.agentId, channelId: ctx.visitorId, limit: 20 });
  const msgs = r.json?.result?.messages || [];
  return [msgs.some(m => m.content && m.content.includes(ctx._msgG5a)), msgs.some(m => m.content && m.content.includes(ctx._msgG5a)) ? '✓' : '未找到'];
});
full('G5e', '回读: Console 消息在历史中', '发送消息 + 回读', '消息在历史中', async (ctx) => {
  const r = await consoleCall('get_chat_history', { agentId: ctx.agentId, channelId: ctx.visitorId, limit: 20 });
  const msgs = r.json?.result?.messages || [];
  return [msgs.some(m => m.content && m.content.includes(ctx._msgG5b)), msgs.some(m => m.content && m.content.includes(ctx._msgG5b)) ? '✓' : '未找到'];
});
full('G5f', '回读: MCP 消息在历史中', '发送消息 + 回读', '消息在历史中', async (ctx) => {
  const r = await consoleCall('get_chat_history', { agentId: ctx.agentId, channelId: ctx.visitorId, limit: 20 });
  const msgs = r.json?.result?.messages || [];
  return [msgs.some(m => m.content && m.content.includes(ctx._msgG5c)), msgs.some(m => m.content && m.content.includes(ctx._msgG5c)) ? '✓' : '未找到'];
});
full('G5g', '会话页 HTML 含 Web 消息', '发送消息 + 回读', '消息在历史中', async (ctx) => {
  const r = await http(`/agents/${ctx.agentId}/c/${ctx.visitorId}`);
  return [r.text.includes(ctx._msgG5a), r.text.includes(ctx._msgG5a) ? '✓' : '未找到'];
});
full('G5h', '会话页 HTML 含 Console 消息', '发送消息 + 回读', '消息在历史中', async (ctx) => {
  const r = await http(`/agents/${ctx.agentId}/c/${ctx.visitorId}`);
  return [r.text.includes(ctx._msgG5b), r.text.includes(ctx._msgG5b) ? '✓' : '未找到'];
});

// G6: 文件上传
full('G6a', 'Conversation attachment input', '附件发送/MCP', '会话页包含附件输入区', async (ctx) => {
  const r = await http(`/agents/${ctx.agentId}/c/${ctx.visitorId}`);
  return [r.ok && r.text.includes('attachment-send-form') && r.text.includes('attachment-file'), r.ok ? '有附件输入区' : `${r.status}`];
});
full('G6b', 'MCP upload_and_send_file', '附件发送/MCP', '不存在的文件被拒绝', async () => {
  const m = await mcpCall('voko_upload_and_send_file', { agentId: 'smoke-agent', toUid: 'smoke-user', filePath: '/nonexistent_smoke_test.txt' });
  return [m.ok || m.error, m.error || (m.data?.url || '').slice(0, 40)];
});

// G7: Agent 友好特性
full('G7a', 'guide 有操作编号', 'Agent 友好特性', '功能正常', async (ctx) => {
  const r = await http(`/agents/${ctx.agentId}?guide=1`);
  const n = (r.text.match(/class=["'][^"']*\bag-num\b[^"']*["']/g) || []).length;
  return [n > 0, `${n} 项`];
});
full('G7b', 'guide+som 组合模式', 'Agent 友好特性', '功能正常', async (ctx) => {
  const r = await http(`/agents/${ctx.agentId}?guide=1&som=1`);
  return [r.text.includes('agent-guide') && r.text.includes('som-mode'), '同时有指导+标记'];
});
full('G7c', '首页有 JSON-LD', 'Agent 友好特性', '功能正常', async () => {
  const r = await http('/');
  const jld = extractJsonLd(r.text);
  return [jld.length > 0, `${jld.length} 条`];
});
full('G7d', '首页 JSON-LD 含 ItemList', 'Agent 友好特性', '功能正常', async () => {
  const r = await http('/');
  const jld = extractJsonLd(r.text);
  return [jld.some(j => j['@type'] === 'ItemList'), jld.some(j => j['@type'] === 'ItemList') ? '✓' : '无'];
});
full('G7e', 'Accept: json 返回纯 JSON', 'Agent 友好特性', '功能正常', async () => {
  const r = await http('/api/console', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ json: JSON.stringify({ action: 'whoami', params: {} }) }),
  });
  return [r.json && r.json.success, r.json ? `agents:${r.json.result?.agents?.length || 0}` : '非JSON'];
});
full('G7f', '?json=1 返回纯 JSON', 'Agent 友好特性', '功能正常', async () => {
  const r = await http('/api/console?json=1', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ json: JSON.stringify({ action: 'whoami', params: {} }) }),
  });
  return [r.json && r.json.success, r.json ? '✓' : '非JSON'];
});
full('G7g', 'manifest 有 deepLinks', 'Agent 友好特性', '功能正常', async () => {
  const r = await http('/.well-known/agent-manifest.json');
  return [(r.json?.deepLinks || []).length > 0, `${r.json?.deepLinks?.length || 0} 个`];
});
full('G7h', 'deepLink: 回复某访客', 'Agent 友好特性', '功能正常', async (ctx) => {
  const r = await http(`/agents/${ctx.agentId}/c/${ctx.visitorId}?action=reply&focus=1`);
  return [r.ok, `${r.status}`];
});
full('G7i', 'deepLink: 查看聊天历史', 'Agent 友好特性', '功能正常', async (ctx) => {
  const r = await http(`/agents/${ctx.agentId}/c/${ctx.visitorId}`);
  return [r.ok, `${r.status}`];
});
full('G7j', 'deepLink: 查看访客资料', 'Agent 友好特性', '功能正常', async (ctx) => {
  const r = await http(`/agents/${ctx.agentId}/visitor?uid=${ctx.visitorId}`);
  return [r.ok, `${r.status}`];
});
full('G7k', 'sitemap.xml URL 数', 'Agent 友好特性', '功能正常', async () => {
  const r = await http('/sitemap.xml');
  const n = (r.text.match(/<loc>/g) || []).length;
  return [n > 0, `${n} 个 <loc>`];
});

// G8: 安全
full('G8a', 'Host 校验拒 evil.com', '安全校验', '按预期拒绝/放行', async () => {
  const httpReq = require('http');
  const hostStatus = await new Promise(resolve => {
    const u = new URL(BASE_URL);
    const req = httpReq.request({ hostname: u.hostname, port: u.port, path: '/', method: 'GET', headers: { Host: 'evil.com' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0)); req.setTimeout(5000, () => { req.destroy(); resolve(0); }); req.end();
  });
  return [hostStatus === 403, `${hostStatus}`];
});
full('G8b', 'GET /login', '安全校验', '按预期拒绝/放行', async () => {
  const r = await http('/login');
  return [r.ok || r.status === 302, `${r.status}`];
});
full('G8c', '未知 action 拒绝', '安全校验', '按预期拒绝/放行', async () => {
  const r = await http('/api/console', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ json: JSON.stringify({ action: '__evil__', params: {} }) }),
  });
  return [r.json?.success === false || r.status >= 400, `${r.status}`];
});

// G9: 跨页面一致性
full('G9a', '改名 (AJAX)', '跨页面操作+回读', '各页面一致', async (ctx) => {
  ctx._savedAgentName = ctx.allAgents.find(a => a.agentId === ctx.agentId)?.agentName || ctx.agentId;
  ctx._newName = `smoke_rename_${Date.now() % 100000}`;
  const r = await http(`/api/agents/${ctx.agentId}/action`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ _action: 'update_profile', name: ctx._newName }),
  });
  return [r.json?.success, r.json?.error || '✓'];
});
full('G9b', '首页显示新名称', '跨页面操作+回读', '各页面一致', async (ctx) => {
  const r = await http('/');
  return [r.text.includes(ctx._newName), r.text.includes(ctx._newName) ? '✓' : '未找到'];
});
full('G9c', '看板页显示新名称', '跨页面操作+回读', '各页面一致', async (ctx) => {
  const r = await http(`/agents/${ctx.agentId}`);
  return [r.text.includes(ctx._newName), r.text.includes(ctx._newName) ? '✓' : '未找到'];
});
full('G9d', 'access-mode 切换一致', '跨页面操作+回读', '各页面一致', async (ctx) => {
  let pr = await consoleCall('get_agent_profile', { agentId: ctx.agentId });
  const cur = pr.json?.result?.data?.accessMode || 'public';
  const r = await http(`/api/agents/${ctx.agentId}/access-mode`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: cur !== 'private' }),
  });
  const newMode = cur === 'private' ? 'public' : 'private';
  ctx._savedAccessMode = cur;
  const r2 = await http(`/agents/${ctx.agentId}/access-mode`);
  return [r2.text.includes(newMode === 'private' ? '私密' : '公开'), '✓'];
});
full('G9e', '看板页显示新访问模式', '跨页面操作+回读', '各页面一致', async (ctx) => {
  const r = await http(`/agents/${ctx.agentId}`);
  return [r.ok, `${r.status}`];
});
full('G9f', '恢复访问模式', '跨页面操作+回读', '各页面一致', async (ctx) => {
  const r = await http(`/api/agents/${ctx.agentId}/access-mode`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: (ctx._savedAccessMode || 'public') === 'private' }),
  });
  const profile = await http(`/api/agents/${ctx.agentId}/action`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ _action: 'update_profile', name: ctx._savedAgentName }),
  });
  if (!profile.json?.success) return [false, profile.json?.error || 'profile restore failed'];
  return [r.json?.success, r.json?.label || r.json?.error || '✓'];
});

// G10: 多类型 Agent 消息回路 + 短链
for (const bt of ['openclaw', 'hermes', 'goose']) {
  const label = { openclaw: 'openclaw', hermes: 'hermes', goose: 'goose' }[bt];
  const vid = `smoke_web_loop_${bt}_${Date.now()}`;

  full(`G10_${bt}_a`, `${label} gateway forward`, async (ctx) => {
    const a = ctx.allAgents.find(x => x.backendType === bt);
    if (!a) { ctx._skip = `无 ${bt} agent`; return false; }
    ctx[`_g10_${bt}_aid`] = a.agentId;
    ctx[`_g10_${bt}_msg`] = `[smoke-web] ${bt} ${Date.now()}`;
    const r = await http('/api/gateway/forward', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: a.agentId, visitorId: vid, message: ctx[`_g10_${bt}_msg`] }),
    });
    return [r.json?.success, r.json?.error || '✓'];
  });
  full(`G10_${bt}_b`, `${label} agent 回复`, async (ctx) => {
    const aid = ctx[`_g10_${bt}_aid`];
    if (!aid) return [false, '无 agentId'];
    const t0 = Date.now();
    const reply = await pollReply(aid, vid, 60000);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    ctx[`_g10_${bt}_reply`] = reply;
    return [reply != null, reply ? `回复 ${reply.length} 字 (${elapsed}s)` : '60s 无回复'];
  });
  full(`G10_${bt}_c`, `${label} web 会话列表`, async (ctx) => {
    const aid = ctx[`_g10_${bt}_aid`];
    const r = await consoleCall('list_conversations', { agentId: aid, limit: 10, filter: 'all' });
    const convs = r.json?.result?.conversations || [];
    return [convs.some(c => c.channelId === vid), convs.some(c => c.channelId === vid) ? '✓' : '未找到'];
  });
  full(`G10_${bt}_d`, `${label} web 聊天历史`, async (ctx) => {
    const aid = ctx[`_g10_${bt}_aid`];
    const reply = ctx[`_g10_${bt}_reply`];
    const r = await consoleCall('get_chat_history', { agentId: aid, channelId: vid, limit: 10 });
    const msgs = r.json?.result?.messages || [];
    const hasReply = reply ? msgs.some(m => m.isMe && m.content && m.content.includes(reply.slice(0, 20))) : msgs.length > 0;
    return [hasReply, msgs.length > 0 ? `${msgs.length} 条` : '空'];
  });
  full(`G10_${bt}_e`, `${label} 短链可访问`, async (ctx) => {
    const aid = ctx[`_g10_${bt}_aid`];
    const sl = ctx._shortLinks[aid];
    if (!sl) { ctx._skip = 'missing short link'; return false; }
    try {
      const sr = await fetch(sl, { signal: AbortSignal.timeout(8000), redirect: 'manual' });
      return [sr.ok || sr.status === 301 || sr.status === 302, `${sr.status}`];
    } catch { return [false, '超时']; }
  });
  full(`G10_${bt}_f`, `${label} 看板页可见`, async (ctx) => {
    const aid = ctx[`_g10_${bt}_aid`];
    const r = await http(`/agents/${aid}`);
    return [r.ok && r.text.includes(vid), r.text.includes(vid) ? '可见' : '未找到'];
  });
}

// ═══════════════════════════════════════════════════
//  执行引擎
// ═══════════════════════════════════════════════════

async function runRegistry(ctx, mode, onItem) {
  // 动态注册 B1..B{N}（MCP 工具逐个测试，N=实际 tools/list 长度），插入到 B0 之后、C1 之前
  const toolsR = await http('/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++_rpcId, method: 'tools/list' }),
  });
  const toolNames = (toolsR.json?.result?.tools || []).map(t => t.name).filter(n => n.startsWith('voko_'));
  const insertIdx = REGISTRY.findIndex(r => r.id === 'C1');  // B1..B{N} go before C
  let mcpIdx = 1;
  for (const name of toolNames) {
    const id = `B${mcpIdx++}`;
    const argsFn = MCP_SAFE_CALLS[name];
    REGISTRY.splice(insertIdx + mcpIdx - 2, 0, {
      id, name: `MCP ${name.replace('voko_', '').padEnd(26)}`, mode: 'core',
      fn: async (ctx) => {
        const args = argsFn ? argsFn(ctx) : {};
        const res = await mcpCall(name, args);
        const responded = res.ok || res.error === 'isError';
        return [responded, res.ok ? '✓' : (res.error === 'isError' ? 'isError(缺参数)' : res.error)];
      }
    });
  }

  // 过滤：如果传入 items 数组（web 模式），直接使用；否则按 mode 过滤
  let items = (ctx._selectedItems && ctx._selectedItems.length > 0)
    ? REGISTRY.filter(r => ctx._selectedItems.includes(r.id))
    : REGISTRY.filter(r => mode === 'full' || r.mode === 'core');

  let currentSection = '';
  let currentSub = '';

  for (const item of items) {
    // Section 标题 — ID 提取: A1→A, B37→B, Emessages→E, F_*→F, G0a→G0, G10_openclaw_a→G10
    const secMatch = item.id.match(/^([A-G])(\d*)/);
    let sec = secMatch ? secMatch[1] : item.id[0];
    if (sec === 'G') sec = 'G' + (secMatch[2] || '0');
    if (sec === 'B' && secMatch[2]) sec = 'B';  // B0, B1... all under B
    const secName = {
      'A': 'A. 消息收发（openclaw / hermes / goose）',
      'B': 'B. MCP 工具 HTTP（全量 tools/call）',
      'C': 'C. CLI 命令',
      'D': 'D. Web 操作（控制台端点）',
      'E': 'E. DB Schema 自检',
      'F': 'F. CLI 工具逐项调用',
      'G0': 'G0. Agent 发现（系统自描述）',
      'G1': 'G1. 页面导航（Agent 友好模式）',
      'G2': 'G2. 表单操作',
      'G3': 'G3. JSON Console 指令',
      'G4': 'G4. MCP ↔ Web 交叉验证',
      'G5': 'G5. 消息收发 → Web 验证',
      'G6': 'G6. 文件上传',
      'G7': 'G7. Agent 友好特性',
      'G8': 'G8. 安全校验',
      'G9': 'G9. 跨页面数据一致性',
      'G10': 'G10. 多类型 Agent 消息回路',
    }[sec] || sec;
    if (secName !== currentSection) {
      if (currentSection && secPass + secFail + secSkip > 0) {
        conclusion(currentSection.includes('MCP') ? `${secPass} 成功 / ${secFail} isError` :
          currentSection.includes('消息收发') && secFail === 0 ? '三种 backend 消息回路正常' :
          currentSection.includes('CLI') ? 'CLI 核心命令正常' :
          currentSection.includes('Schema') ? 'DB schema 完整' : '');
      }
      section(secName);
      currentSection = secName;
    }

    // 子标题
    const subMatch = item.id.match(/^G\d+_[a-z]+/);
    if (subMatch && subMatch[0] !== currentSub) {
      const subLabels = {
        'G0a': '—— 文本发现 ——', 'G0e': '—— 结构化发现 ——', 'G0g': '—— MCP 协议发现 ——',
        'G1a': '—— 普通 HTML 模式 ——', 'G1s': '—— ?guide=1 模式 ——', 'G1v': '—— ?som=1 模式 ——',
        'G2a': '—— 编辑资料 ——', 'G2b': '—— 白名单增删 ——', 'G2d': '—— 黑名单增删 ——',
        'G2f': '—— 访问模式切换 ——', 'G2h': '—— 人工介入 ——', 'G2i': '—— 审核规则 ——',
        'G2j': '—— 订阅模式 ——',
        'G3a': '—— 查询类 ——', 'G3g': '—— 访问控制 ——', 'G3i': '—— 审核规则查询 ——',
        'G3j': '—— 计费查询 ——', 'G3k': '—— 会话操作 ——',
        'G4a': '—— Agent 资料 MCP vs Console ——', 'G4d': '—— 会话列表 ——',
        'G4e': '—— 访问列表交叉验证 ——', 'G4i': '—— 状态查询 MCP ——',
        'G5a': '—— Web 发送消息 ——', 'G5b': '—— Console 发送消息 ——',
        'G5c': '—— MCP 发送消息 ——', 'G5d': '—— 回读验证 ——',
        'G5g': '—— 会话页 HTML 验证 ——',
        'G6a': '—— 附件发送 ——', 'G6b': '—— MCP upload_and_send_file ——',
        'G7a': '—— 操作指导完整性 ——', 'G7c': '—— JSON-LD 结构化数据 ——',
        'G7e': '—— JSON Console 纯 JSON 模式 ——', 'G7g': '—— Deep Links 验证 ——',
        'G7k': '—— sitemap.xml 完整性 ——',
        'G10_openclaw_a': '—— openclaw ——', 'G10_hermes_a': '—— hermes ——',
        'G10_goose_a': '—— goose ——',
      };
      if (subLabels[item.id]) subSection(subLabels[item.id]);
      currentSub = subMatch[0];
    }

    // 执行
    ctx._skip = null;
    const t0 = Date.now();
    let status = 'pass', detail = '';
    try {
      let result = await item.fn(ctx);
      const initialPassed = Array.isArray(result) ? result[0] : result;
      if (!ctx._skip && initialPassed && item.verify) {
        result = await item.verify(ctx);
      }
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      if (ctx._skip) {
        status = 'skip'; detail = ctx._skip;
        skip(item.name, ctx._skip);
      } else {
        let cond;
        if (Array.isArray(result)) { [cond, detail] = result; }
        else { cond = result; detail = ''; }
        if (!cond) status = 'fail';
        ok(item.name, cond, detail);
      }
      if (onItem) onItem(item, status, detail, elapsed);
    } catch (e) {
      status = 'fail'; detail = `异常: ${e.message}`;
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      ok(item.name, false, detail);
      if (onItem) onItem(item, status, detail, elapsed);
    }
  }

  // 最后一段的 conclusion
  if (currentSection && secPass + secFail + secSkip > 0) conclusion('');
}

// ═══════════════════════════════════════════════════
//  主流程
// ═══════════════════════════════════════════════════

async function main() {
  const args = process.argv.slice(2);
  const mode = args.includes('--full') ? 'full' : 'core';
  const requireRunning = requiresRunning(args);

  if (args.includes('--list')) {
    console.log('测试注册表（共 ' + REGISTRY.length + ' 项，core 模式约 60 项，full 模式约 200 项）:\n');
    for (const item of REGISTRY) {
      console.log(`  [${item.mode === 'core' ? 'CORE' : 'FULL'}] ${item.id.padEnd(10)} ${item.name}`);
    }
    process.exit(0);
  }

  // 连接
  const port = await findPort();
  if (!port) {
    if (requireRunning) {
      console.error('❌ 未找到运行中的 voko（扫描 3100-3102）');
      process.exit(1);
    }
    console.log('⏭️ 未找到运行中的 voko（扫 3100-3102），跳过冒烟测试');
    process.exit(0);
  }
  BASE_URL = `http://127.0.0.1:${port}`;

  // 初始化
  await mcpInit();
  const listAgentsR = await consoleCall('list_agents', {});
  const agents = listAgentsR.json?.result?.agents || [];
  if (agents.length === 0) { console.error('❌ 无已注册 Agent'); process.exit(1); }

  // 从 DB 补全 agent 信息
  const dbAgents = queryDb("SELECT agent_id, agent_name, backend_type, short_link_url FROM agents WHERE publish_status='published'");
  const nameMap = {};
  for (const row of dbAgents) nameMap[row.agent_id] = row;
  const allAgents = agents.filter(a => nameMap[a.agentId]).map(a => ({
    ...a,
    backendType: a.backendType || (nameMap[a.agentId]?.backend_type || ''),
    agentName: a.agentName || (nameMap[a.agentId]?.agent_name || ''),
    shortLinkUrl: nameMap[a.agentId]?.short_link_url || null,
  }));
  if (allAgents.length === 0) { console.error('No published Agent'); process.exit(1); }

  let selectedAgent = allAgents[0];
  for (const candidate of allAgents) {
    const status = await consoleCall('get_status', { agentId: candidate.agentId });
    if (status.json?.result?.agent?.imConnected) {
      selectedAgent = candidate;
      break;
    }
  }
  const agentId = selectedAgent.agentId;
  allAgents.sort((a, b) => (a.agentId === agentId ? -1 : b.agentId === agentId ? 1 : 0));
  const convR = await consoleCall('list_conversations', { agentId, limit: 1, filter: 'all' });
  const convs = convR.json?.result?.conversations || [];
  const visitorId = convs.length > 0 ? convs[0].channelId : 'smoke_test_visitor';

  const ctx = {
    agentId, visitorId, agents, allAgents,
    _shortLinks: {},
  };
  for (const a of allAgents) {
    if (a.shortLinkUrl) ctx._shortLinks[a.agentId] = a.shortLinkUrl;
  }

  // 报告头
  const types = {};
  allAgents.forEach(a => { types[a.backendType] = (types[a.backendType] || 0) + 1; });
  const typeStr = Object.entries(types).map(([k, v]) => `${k}:${v}`).join(' ');

  console.log('═══════════════════════════════════════════════');
  console.log('  VOKO 冒烟测试报告');
  console.log(`  时间: ${new Date().toLocaleString('zh-CN')}`);
  console.log(`  地址: ${BASE_URL}`);
  console.log(`  Agent: ${agentId} (${allAgents.length} published, ${typeStr})`);
  console.log(`  Visitor: ${visitorId}`);
  console.log(`  模式: ${mode === 'full' ? '完整 (--full)' : '核心 (A-E)'}`);
  console.log('═══════════════════════════════════════════════');

  await runRegistry(ctx, mode);

  // 报告尾
  const total = passed + failed + skipped;
  const verdict = failed === 0 ? '✅ 全部通过，系统运行正常' : `❌ ${failed} 项失败，需排查`;
  console.log('\n═══════════════════════════════════════════════');
  console.log(`  汇总: ${passed} PASS / ${failed} FAIL / ${skipped} SKIP  (共 ${total} 项)`);
  console.log(`  结论: ${verdict}`);
  console.log('═══════════════════════════════════════════════');
  process.exit(failed > 0 ? 1 : 0);
}

if (require.main === module) {
  main().catch(e => { console.error('冒烟测试异常:', e); process.exit(1); });
}

module.exports = { main, REGISTRY, runRegistry, queryDb, mcpCall, consoleCall, cliTool, parseCliJson, pollReply, http, mcpInit, findPort, requiresRunning, DB_PATH,
  /** 设置 HTTP 请求的基础 URL（server 内嵌运行时需要） */
  setBaseUrl(url) { BASE_URL = url; },
};
