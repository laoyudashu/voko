export {};

/**
 * Lite CLI 命令实现
 *
 * 直接复用 core 模块，不调 HTTP / MCP。
 */

const { registerCapabilitiesForAgent } = require('./core/register-capabilities');
const { generateOSSSignature } = require('./server/oss');
const { createContext } = require('./context');
const { createToolHandlers } = require('./mcp/tools');
const { createMcpServer, getToolList } = require('./mcp/server');
const { processPendingPaymentOrder } = require('./core/payment');
const ENDPOINTS = require('./endpoints.json');
const pkg = require('../package.json');
const { compareVersions } = require('./core/auto-updater');
const { t } = require('./core/i18n');
const { runWithProviderCaller, detectProviderCaller } = require('./core/registration-caller-context');
const { detectCurrentAgentType } = require('./core/registration-orchestrator');
const { spawnSync } = require('child_process');
const path = require('path');
const crypto = require('crypto');

/**
 * 检查 OSS 最新版本（统一从 OSS manifest 读取）
 */
async function checkVersion(options: { notify?: boolean } = {}) {
  try {
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const result = spawnSync(npmCommand, ['view', '@voko/lite', 'version', '--registry=https://registry.npmjs.org/'], {
      encoding: 'utf8', windowsHide: true, timeout: 10000,
    });
    const latestVersion = String(result.stdout || '').trim();
    if (result.error || result.status !== 0 || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(latestVersion)) return null;
    const updateAvailable = compareVersions(latestVersion, pkg.version) > 0;
    if (updateAvailable && options.notify !== false) {
      console.error(t('cli.updater.new_version_available', { version: latestVersion, current: pkg.version }));
    }
    return { currentVersion: pkg.version, latestVersion, updateAvailable };
  } catch (_: any) {}
  return null;
}

/**
 * 优雅退出：Node 23/24 + Windows 上，内置 fetch(undici) 创建的 libuv async handle
 * 在关闭前若直接 process.exit 会触发 UV_HANDLE_CLOSING 断言（nodejs/node#58091）。
 * 改用 exitCode + 短延迟，让 handle 自然关闭后再退出。
 */
function softExit(code?: any) {
  process.exitCode = code;
  if (process.platform === 'win32') {
    setTimeout(() => process.exit(code), 300);
  } else {
    process.exit(code);
  }
}

/**
 * voko update — 通过 npm 官方 registry 手动升级到最新版。
 * 自动更新保持关闭；此处不会信任或执行更新源提供的安装包。
 */
async function updateLite(options: { installDir?: string; spawn?: any; exit?: (code?: any) => any } = {}) {
  const exit = options.exit || softExit;
  const installedPath = path.normalize(options.installDir || __dirname).toLowerCase();
  if (!installedPath.includes(path.join('node_modules', '@voko', 'lite').toLowerCase())) {
    console.error('当前是开发或链接安装，拒绝覆盖；请在发布版中运行 voko update。');
    return exit(1);
  }
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const spawn = options.spawn || spawnSync;
  const versionResult = spawn(npmCommand, ['view', '@voko/lite', 'version', '--registry=https://registry.npmjs.org/'], {
    encoding: 'utf8', windowsHide: true,
  });
  const latestVersion = String(versionResult.stdout || '').trim();
  if (versionResult.error || versionResult.status !== 0 || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(latestVersion)) {
    console.error(t('cli.updater.no_version'));
    return exit(1);
  }
  if (compareVersions(latestVersion, pkg.version) <= 0) {
    console.error(t('cli.updater.registry_not_newer', { current: pkg.version, latest: latestVersion }));
    return exit(0);
  }
  console.error(`正在从 npm 官方 registry 安装 @voko/lite@${latestVersion}…`);
  const result = spawn(npmCommand, [
    'install', '-g', '--ignore-scripts', '--registry=https://registry.npmjs.org/', `@voko/lite@${latestVersion}`,
  ], { stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) {
    console.error(t('cli.updater.install_failed'));
    return exit(1);
  }
  console.error(t('cli.updater.done'));
  return exit(0);
}

// ═══════════════════════════════════════════════
//  MCP Tool → CLI 命令桥接
// ═══════════════════════════════════════════════

/**
 * 参数类型映射表 — 每个 MCP tool 的每个参数的目标类型。
 * 类型：string | number | boolean | json
 * 推导自 packages/lite/src/mcp/server.js 的 Zod schema。
 * @type {Object<string, Object<string, string>>}
 */
const TOOL_PARAM_SCHEMAS = {
  manage_agent_registration: { action: 'string', registrationId: 'string', email: 'string', code: 'string', agentName: 'string', description: 'string', category: 'string', providerType: 'string', instanceId: 'string', deliveryModes: 'json', mode: 'string', taskId: 'string', approved: 'boolean', approvalToken: 'string', acknowledgeCost: 'boolean', registrationMode: 'string' },
  bug_report: { action: 'string', title: 'string', description: 'string', steps: 'string', expected: 'string', actual: 'string', severity: 'string', category: 'string', agentId: 'string', ownerEmail: 'string' },
  update_agent_profile:    { agentId: 'string', name: 'string', description: 'string', short_description: 'string', category: 'string', tags: 'string', iconUrl: 'string', address: 'string', contact_phone: 'string', backendType: 'string', backendInstanceId: 'string' },
  set_agent_status:        { agentId: 'string', status: 'number', visibility: 'number' },
  get_status:              { agentId: 'string' },
  get_agent_profile:       { agentId: 'string' },
  search_capabilities:     { agentId: 'string', keyword: 'string', page: 'number', limit: 'number' },
  declare_capabilities:    { agentId: 'string', ability: 'json' },
  send_message:            { agentId: 'string', toUid: 'string', content: 'string', contentType: 'number', channelType: 'number', mentions: 'json', conversationId: 'string', replyToMessageId: 'string' },
  get_chat_history:        { agentId: 'string', channelId: 'string', channelType: 'number', keyword: 'string', limit: 'number', offset: 'number' },
  get_visitor_profile:     { visitorId: 'string', agentId: 'string', limit: 'number', offset: 'number' },
  list_conversations:      { agentId: 'string', filter: 'string', channelType: 'string', limit: 'number', offset: 'number', keyword: 'string' },
  mark_conversation_read:  { agentId: 'string', channelId: 'string' },
  upload_and_send_file:    { agentId: 'string', toUid: 'string', filePath: 'string', fileName: 'string', message: 'string', channelType: 'number', mentions: 'json', conversationId: 'string', replyToMessageId: 'string' },
  whoami:                  { agentId: 'string' },
  list_agents:             { keyword: 'string', limit: 'number', offset: 'number' },
  start_worker:            { agentId: 'string' },
  stop_worker:             { agentId: 'string' },
  ask_human_for_help:      { agentId: 'string', visitorId: 'string', channelId: 'string', channelType: 'number', messageId: 'string', problem: 'string', suggestion: 'string' },
  check_human_replies:     { agentId: 'string', id: 'string', visitorId: 'string', since: 'number', limit: 'number', offset: 'number' },
  close_human_request:     { agentId: 'string', id: 'string' },
  create_payment:          { agentId: 'string', visitorId: 'string', amount: 'number', description: 'string' },
  check_payments:          { agentId: 'string', orderId: 'string', visitorId: 'string', status: 'string', since: 'number', limit: 'number', offset: 'number' },
  add_payment_auth:        { name: 'string', idCard: 'string', bankCard: 'string', phone: 'string', bankCode: 'string', bankName: 'string' },
  list_payment_auth:       { keyword: 'string' },
  delete_payment_auth:     { id: 'string' },
  apply_payment_auth:      { paymentAuthId: 'string', email: 'string' },
  refresh_payment_auth:    { paymentAuthId: 'string', email: 'string' },
  search_banks:            { keyword: 'string' },
  bind_agent_payment_auth: { agentId: 'string', paymentAuthId: 'string' },
  agent_pricing:           { agentId: 'string', pricingModel: 'string', price: 'number', durationMinutes: 'number', trialMinutes: 'number' },
  fetch_new_messages:      { agentId: 'string', visitorId: 'string', channelId: 'string', channelType: 'number', messageSeq: 'number', onlyReplies: 'boolean', limit: 'number', blockTimeout: 'number' },
  manage_whitelist:        { agentId: 'string', action: 'string', visitorId: 'string', id: 'string', reason: 'string' },
  manage_blacklist:        { agentId: 'string', action: 'string', visitorId: 'string', id: 'string', reason: 'string' },
  list_access_lists:       { agentId: 'string', listType: 'string', limit: 'number', offset: 'number', keyword: 'string' },
  set_private_mode:        { agentId: 'string', enabled: 'boolean' },
  invite_friend:           { agentId: 'string', friendEmail: 'string' },
  list_audit_rules:        { direction: 'string' },
  manage_audit_rules:      { action: 'string', ruleId: 'string', direction: 'string', keyword: 'string', actionType: 'string', prompt: 'string' },
  // 群聊
  create_group:            { agentId: 'string', name: 'string' },
  invite_to_group:         { agentId: 'string', channelId: 'string', members: 'json', groupName: 'string' },
  accept_invitation:       { agentId: 'string', channelId: 'string' },
  decline_invitation:      { agentId: 'string', channelId: 'string' },
  get_group_members:       { agentId: 'string', channelId: 'string' },
  get_group_context:       { agentId: 'string', channelId: 'string', limit: 'number' },
  kick_from_group:         { agentId: 'string', channelId: 'string', targetUid: 'string' },
  quit_group:              { agentId: 'string', channelId: 'string' },
  update_group:            { agentId: 'string', channelId: 'string', name: 'string', notice: 'string', avatar: 'string', approve_mode: 'string', searchable: 'number' },
  list_groups:             { agentId: 'string', limit: 'number', offset: 'number' },
  list_group_applies:      { agentId: 'string', channelId: 'string' },
  approve_group_apply:     { agentId: 'string', channelId: 'string', applyId: 'string', action: 'string' },
  mute_member:             { agentId: 'string', channelId: 'string', targetUid: 'string', muted: 'boolean', durationSeconds: 'number' },
  search_groups:           { agentId: 'string', keyword: 'string', page: 'number', page_size: 'number' },
  apply_group:             { agentId: 'string', channelId: 'string', message: 'string' },
};

/**
 * 将 kebab-case 转为 camelCase
 * --agent-id → agentId
 * --only-replies → onlyReplies
 */
function kebabToCamel(str?: any) {
  return str.replace(/-([a-z])/g, (_?: any, c?: any) => c.toUpperCase());
}

/**
 * 将 kebab-case 转为 snake_case
 * --agent-id → agent_id
 * --block-timeout → block_timeout
 */
function kebabToSnake(str?: any) {
  return str.replace(/-/g, '_');
}

/**
 * 将 CLI 字符串参数转换为 handler 期望的 JS 类型
 * @param {string} value — 原始字符串值
 * @param {string} expectedType — 'string' | 'number' | 'boolean' | 'json'
 * @returns {*}
 */
function convertParam(value?: any, expectedType?: any) {
  if (expectedType === 'number') {
    const n = Number(value);
    if (Number.isNaN(n)) throw new Error(t('cli.tool.param_not_number', { value: JSON.stringify(value) }));
    return n;
  }
  if (expectedType === 'boolean') {
    if (value === 'true' || value === '1' || value === true) return true;
    if (value === 'false' || value === '0' || value === false) return false;
    return Boolean(value);
  }
  if (expectedType === 'json') {
    if (typeof value === 'string' && (value.startsWith('[') || value.startsWith('{'))) {
      try { return JSON.parse(value); } catch (_: any) {
        if (value.startsWith('[') && value.endsWith(']')) {
          return value.slice(1, -1).split(',').map((item) =>
            item.trim().replace(/^\\?["']|\\?["']$/g, ''),
          ).filter(Boolean);
        }
        return value;
      }
    }
    return value;
  }
  // 'string' 或未识别类型 → 原样返回
  return value;
}

/**
 * 运行 MCP tool 作为 CLI 命令
 *
 * 1. 通过 core 创建 context(cx) 和 tool handlers
 * 2. 将 CLI 参数（--key=value）转换为 handler 期望的格式
 * 3. 调用 handler，输出 JSON 到 stdout
 * 4. 关闭 DB 连接
 *
 * @param {string} toolName — 工具名（如 send_message、whoami）
 * @param {Object} rawParams — parseArgs() 输出的原始键值对（值均为字符串或 true）
 * @param {Object} core — initCore() 返回的 { db, databaseAPI, agentRegistration, agentManager }
 * @returns {Promise<Object|null>} null 表示工具不存在
 */
async function runToolCommand(toolName?: any, rawParams?: any, core?: any, cliCtx: any = {}) {
  if (toolName === 'register_agent' || toolName === 'verify_agent_email') {
    console.log(JSON.stringify({
      success: false,
      code: 'REGISTRATION_API_REMOVED',
      error: `${toolName} has been removed; use manage_agent_registration and keep the same registrationId`,
      nextAction: { type: 'start_registration', command: ['voko', 'manage_agent_registration', '--action', 'start', '--registration-mode', 'agent'] },
    }, null, 2));
    return { success: false };
  }
  const { db, databaseAPI, agentRegistration, agentManager, deliver, wukongimSender, sendMessage } = core;
  const cx = createContext({ db, databaseAPI, agentRegistration, agentManager, deliver, wukongimSender, sendMessage });

  // 注入支付处理能力（与 MCP 保持一致，CLI 也需要 DApp 签名 + 调支付 API + 通知访客）
  cx.processPaymentOrder = (order?: any) => processPendingPaymentOrder(order, {
    db, databaseAPI,
    agentWorkers: agentManager.workers,
    deliver: cx.deliver,  // 统一 VokoIMSDK Hub 投递
    sendMessage: cx.sendMessage,  // 统一发送（落库 + 投递 + UI 通知）
    endpoints: ENDPOINTS,
  });

  const handlers: Record<string, any> = createToolHandlers(cx);

  if (typeof handlers[toolName] !== 'function') {
    return null;
  }

  // 剔除 CLI 全局保留键（身份/帮助/日志开关），它们不是工具参数
  const RESERVED_KEYS = new Set(['agent', 'as', 'help', 'h', 'verbose', 'debug', 'tools', 'interactive']);
  const cleanParams: Record<string, any> = {};
  for (const [k, v] of Object.entries(rawParams || {})) {
    if (!RESERVED_KEYS.has(k)) cleanParams[k] = v;
  }

  // 参数名标准化 + 类型转换
  const schema: Record<string, any> = (TOOL_PARAM_SCHEMAS as Record<string, any>)[toolName] || {};
  const hasAgentIdParam = Object.prototype.hasOwnProperty.call(schema, 'agentId');
  const optionalAgentId = toolName === 'bug_report';
  const needsAgentId = hasAgentIdParam && !optionalAgentId && toolName !== 'whoami' && toolName !== 'list_agents';
  try {
    const params: Record<string, any> = {};

    for (const [key, value] of Object.entries(cleanParams)) {
      // 生成候选 key：原样、camelCase、snake_case
      const candidates = [
        key,                       // 原样（--agent_id 直接匹配 agent_id）
        kebabToCamel(key),         // --agent-id → agentId
        kebabToSnake(key),         // --agent-id → agent_id
      ];

      // 按优先级匹配 schema 中的 key
      let schemaKey = null;
      for (const c of candidates) {
        if (Object.prototype.hasOwnProperty.call(schema, c)) {
          schemaKey = c;
          break;
        }
      }

      const targetKey = schemaKey || candidates[1] || key; // 优先用 schema key，兜底用 camelCase
      const expectedType = schemaKey ? schema[schemaKey] : 'string';
      params[targetKey] = convertParam(value, expectedType);
    }

    // 身份注入 / 缺身份业务错误：需要 agentId 的工具，优先用显式参数，否则用 --agent / VOKO_AGENT_ID。
    // 杜绝缺身份时的静默失败（cx.query 吞错返回空 / send_message 用 'voko' 兜底）。
    if (hasAgentIdParam && !params.agentId && cliCtx.agentId) {
      params.agentId = cliCtx.agentId;
    }
    if (needsAgentId && !params.agentId) {
      if (!cliCtx.agentId) {
        console.log(JSON.stringify({
          success: false,
          error: t('cli.tool.no_agent'),
        }, null, 2));
        return { success: false };
      }
    }

    // whoami 特殊化（仅 CLI 层，handler 不改、MCP 不受影响）：
    // 带 --agent 返回该 agent 资料；否则返回 agent 列表 + 提示
    const providerType = detectCurrentAgentType();
    const caller = {
      source: 'cli',
      ...detectProviderCaller(providerType),
    };
    if (toolName === 'whoami') {
      const r = await runWithProviderCaller(caller, () => handlers.whoami({ ...params, ...(cliCtx.agentId ? { agentId: cliCtx.agentId } : {}) }));
      console.log(JSON.stringify(r, null, 2));
      console.error(t('cli.tool.whoami_hint'));
      return { success: r.success !== false };
    }

    const result = await runWithProviderCaller(caller, () => handlers[toolName](params));
    console.log(JSON.stringify(result, null, 2));
    return { success: result.success !== false };
  } catch (err: any) {
    if (cliCtx.debug) console.error(err.stack);
    console.error(JSON.stringify({ success: false, error: err.message }));
    return { success: false };
  }
}

/**
 * Execute transport-dependent CLI tools inside the running VOKO process.
 * The Hub and its authenticated clients are process-owned, so a short-lived
 * CLI process must not create a second connection for the same Agent.
 */
async function runRuntimeToolCommand(toolName?: any, rawParams?: any, dbPath?: any, cliCtx: any = {}) {
  const { getActiveRuntimePort } = require('./core/runtime-port');
  const { readInstanceMetadata } = require('./core/process-lifecycle');
  const port = getActiveRuntimePort(dbPath);
  const instance = readInstanceMetadata(dbPath);
  const emit = (result: any) => {
    if (cliCtx.print !== false) console.log(JSON.stringify(result, null, 2));
    return result;
  };
  const { probeRuntimeIdentity } = require('./core/runtime-probe');
  const probe = port && instance?.mcpToken
    ? await probeRuntimeIdentity({ port, instance })
    : instance
      ? { ok: false, code: 'RUNTIME_MISMATCH', message: '当前 Lite 运行实例身份不匹配' }
      : { ok: false, code: 'RUNTIME_REQUIRED', message: '请先运行 voko start --no-open --no-interactive' };
  if (!probe.ok) return emit({ success: false, code: probe.code, error: probe.message });

  const schema: Record<string, any> = (TOOL_PARAM_SCHEMAS as Record<string, any>)[toolName] || {};
  const reserved = new Set([
    'agent', 'as', 'help', 'h', 'verbose', 'debug', 'tools', 'interactive',
    'db', 'port', 'no-open', 'noOpen', 'no-interactive', 'noInteractive',
  ]);
  const params: Record<string, any> = {};
  for (const [key, value] of Object.entries(rawParams || {})) {
    if (reserved.has(key)) continue;
    const candidates = [key, kebabToCamel(key), kebabToSnake(key)];
    const schemaKey = candidates.find(candidate => Object.prototype.hasOwnProperty.call(schema, candidate));
    const targetKey = schemaKey || candidates[1] || key;
    params[targetKey] = convertParam(value, schemaKey ? schema[schemaKey] : 'string');
  }
  if (Object.prototype.hasOwnProperty.call(schema, 'agentId') && !params.agentId && cliCtx.agentId) {
    params.agentId = cliCtx.agentId;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-VOKO-Token': instance.mcpToken,
    'X-VOKO-Instance-ID': instance.instanceId,
    'X-VOKO-Caller-Connection': crypto.randomUUID(),
  };
  const providerType = detectCurrentAgentType();
  const caller = detectProviderCaller(providerType);
  if (caller.providerType) headers['X-VOKO-Caller-Provider'] = caller.providerType;
  if (caller.providerInstanceId) headers['X-VOKO-Caller-Instance'] = caller.providerInstanceId;
  if (caller.nativeSessionId) {
    headers['X-VOKO-Caller-Session'] = caller.nativeSessionId;
    headers['X-VOKO-Caller-Evidence'] = caller.evidence || 'provider_env';
  }

  let response: any;
  try {
    response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tools/call',
        params: { name: `voko_${toolName}`, arguments: params },
      }),
      signal: AbortSignal.timeout(120000),
    });
  } catch (_) {
    return emit({ success: false, code: 'RUNTIME_UNAVAILABLE', error: '无法连接当前 Lite 运行实例' });
  }
  const rpc = await response.json().catch(() => null) as any;
  if (!response.ok || !rpc || rpc.error) {
    return emit({ success: false, code: rpc?.error?.data?.code || rpc?.code || 'RUNTIME_UNAVAILABLE', error: rpc?.error?.message || rpc?.error || `HTTP ${response.status}` });
  }

  let result: any = rpc.result;
  const textBlock = Array.isArray(result?.content)
    ? result.content.find((block: any) => block?.type === 'text' && typeof block.text === 'string')
    : null;
  if (textBlock) {
    try { result = JSON.parse(textBlock.text); }
    catch { result = { success: result?.isError !== true, message: textBlock.text }; }
  }
  if (cliCtx.print !== false) console.log(JSON.stringify(result, null, 2));
  return { success: result?.success !== false && rpc.result?.isError !== true, result };
}

/**
 * Send one explicitly acknowledged message through the running Lite runtime
 * and wait for the persisted outbound reply. This is intentionally separate
 * from doctor: it invokes the configured Provider and may send a real IM
 * message to the supplied visitor.
 */
async function runRuntimeProbe(rawParams: any = {}, dbPath?: string, cliCtx: any = {}) {
  const emit = (result: any) => {
    if (cliCtx.print !== false) console.log(JSON.stringify(result, null, 2));
    return result;
  };
  const agentId = String(rawParams.agentId || rawParams['agent-id'] || '').trim();
  const visitorId = String(rawParams.visitorId || rawParams['visitor-id'] || '').trim();
  const confirmed = rawParams.confirm === true || rawParams.confirm === 'true' || rawParams.confirm === '1';
  if (!agentId || !visitorId) return emit({ success: false, code: 'INVALID_ARGUMENT', error: 'probe requires --agent-id and --visitor-id' });
  if (!confirmed) return emit({ success: false, code: 'CONFIRM_REQUIRED', error: 'probe sends a real Provider request and IM reply; pass --confirm to continue' });

  const timeoutSeconds = Math.min(300, Math.max(5, Number(rawParams.timeout || rawParams['timeout-seconds'] || 120) || 120));
  const content = String(rawParams.message || `[VOKO probe] Reply briefly to confirm the VOKO delivery path. ${Date.now()}`).trim();
  if (!content) return emit({ success: false, code: 'INVALID_ARGUMENT', error: 'probe message must not be empty' });

  const { getActiveRuntimePort } = require('./core/runtime-port');
  const { readInstanceMetadata } = require('./core/process-lifecycle');
  const { probeRuntimeIdentity } = require('./core/runtime-probe');
  const port = getActiveRuntimePort(dbPath);
  const instance = readInstanceMetadata(dbPath);
  const identity = port && instance?.mcpToken
    ? await probeRuntimeIdentity({ port, instance })
    : { ok: false, code: 'RUNTIME_REQUIRED', message: 'run voko start before using voko probe' };
  if (!identity.ok) return emit({ success: false, code: identity.code, error: identity.message });

  const { DatabaseSync: Database } = require('node:sqlite');
  let db: any = null;
  const startedAt = Date.now();
  const messageId = `voko-probe-${crypto.randomUUID()}`;
  try {
    db = new Database(dbPath, { readOnly: true });
    const baseline = Number(db.prepare('SELECT COALESCE(MAX(rowid), 0) AS rowid FROM messages WHERE agent_id=? AND channel_id=? AND channel_type=1').get(agentId, visitorId)?.rowid || 0);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-VOKO-Token': String(instance.mcpToken),
      'X-VOKO-Instance-ID': String(instance.instanceId),
    };
    let response: any;
    try {
      response = await fetch(`http://127.0.0.1:${port}/api/gateway/forward`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ agentId, visitorId, message: content, messageId }),
        signal: AbortSignal.timeout(10000),
      });
    } catch (_) {
      return emit({ success: false, code: 'RUNTIME_UNAVAILABLE', error: 'unable to submit probe to the active Lite runtime' });
    }
    const accepted = await response.json().catch(() => null) as any;
    if (!response.ok || accepted?.success !== true) {
      return emit({ success: false, code: accepted?.code || 'PROBE_REJECTED', error: accepted?.error || `HTTP ${response.status}` });
    }

    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      const reply = db.prepare(
        `SELECT id, status, timestamp FROM messages
         WHERE agent_id=? AND channel_id=? AND channel_type=1 AND is_me=1 AND rowid>?
         ORDER BY rowid DESC LIMIT 1`,
      ).get(agentId, visitorId, baseline) as { id?: string; status?: string; timestamp?: number } | undefined;
      if (reply?.id) {
        const status = String(reply.status || 'pending');
        if (status === 'sent' || status === 'failed') {
          return emit({
            success: status === 'sent',
            status,
            code: status === 'sent' ? 'PROBE_OK' : 'PROBE_DELIVERY_FAILED',
            agentId,
            visitorId,
            messageId: reply.id,
            elapsedMs: Date.now() - startedAt,
          });
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 1000));
    }
    return emit({ success: false, status: 'pending', code: 'PROBE_TIMEOUT', error: 'no persisted Agent reply before timeout; do not resend automatically', agentId, visitorId, elapsedMs: Date.now() - startedAt });
  } finally {
    try { db?.close(); } catch (_) {}
  }
}

// ═══════════════════════════════════════════════
//  工具文档（voko --tools / voko <tool> --help）
// ═══════════════════════════════════════════════

/**
 * 是否为已知 CLI 工具名（TOOL_PARAM_SCHEMAS 的 key，不带 voko_ 前缀）
 */
function isKnownTool(name?: any) {
  return Object.prototype.hasOwnProperty.call(TOOL_PARAM_SCHEMAS, name);
}

/**
 * 构造 context + handlers + mcpServer，用于读取 zod 生成的工具 schema（单一来源）。
 * 复用 runToolCommand 同款注入，确保 schema 与实际可调工具一致。
 */
function _buildMcpForSchema(core?: any) {
  const { db, databaseAPI, agentRegistration, agentManager, deliver, wukongimSender, sendMessage } = core;
  const cx = createContext({ db, databaseAPI, agentRegistration, agentManager, deliver, wukongimSender, sendMessage });
  cx.processPaymentOrder = (order?: any) => processPendingPaymentOrder(order, {
    db, databaseAPI,
    agentWorkers: agentManager.workers,
    deliver: cx.deliver,
    sendMessage: cx.sendMessage,
    endpoints: ENDPOINTS,
  });
  const handlers = createToolHandlers(cx);
  return createMcpServer(handlers, { version: pkg.version });
}

function _hasAgentIdParam(toolName?: any) {
  const schema: Record<string, any> = (TOOL_PARAM_SCHEMAS as Record<string, any>)[toolName] || {};
  return Object.prototype.hasOwnProperty.call(schema, 'agentId');
}

/**
 * voko <tool> --help：打印该工具的参数说明（人类可读，工具名无 voko_ 前缀）
 */
async function printToolHelp(toolName?: any, core?: any) {
  let mcpServer;
  try {
    mcpServer = _buildMcpForSchema(core);
  } catch (e: any) {
    console.error(t('cli.tool.schema_read_failed', { msg: e.message }));
    return;
  }
  const tools = await getToolList(mcpServer);
  const tool = (tools || []).find((t: any) => t.name === 'voko_' + toolName);
  if (!tool) {
    console.error(t('cli.tool.not_found', { tool: toolName }));
    return;
  }
  const inputSchema = tool.inputSchema || {};
  const props: Record<string, any> = inputSchema.properties || {};
  const required = new Set(inputSchema.required || []);
  const lines = [];
  lines.push(toolName);
  lines.push('  ' + (tool.description || t('cli.tool.no_desc')));
  lines.push('');
  lines.push(t('cli.tool.params_header'));
  if (Object.keys(props).length === 0) {
    lines.push('  ' + t('cli.tool.no_params'));
  } else {
    for (const [k, v] of Object.entries(props)) {
      const req = required.has(k) ? t('cli.tool.required') : t('cli.tool.optional');
      const type = (v && v.type) || 'any';
      const desc = v && v.description ? '  ' + v.description : '';
      lines.push(`  --${k}  [${type}, ${req}]${desc}`);
    }
  }
  lines.push('');
  lines.push(t('cli.tool.usage_header') + ` voko ${toolName}${_hasAgentIdParam(toolName) ? ' --agent <agentId>' : ''} [--param=value ...]`);
  console.log(lines.join('\n'));
}

/**
 * voko --tools：输出所有工具的 JSON Schema（去掉 voko_ 前缀，对齐 CLI 命令名）
 */
async function printAllToolSchemas(core?: any) {
  let mcpServer;
  try {
    mcpServer = _buildMcpForSchema(core);
  } catch (e: any) {
    console.error(t('cli.tool.list_read_failed', { msg: e.message }));
    return;
  }
  const tools = await getToolList(mcpServer);
  const cleaned = (tools || []).map((t: any) => ({ ...t, name: String(t.name || '').replace(/^voko_/, '') }));
  console.log(JSON.stringify(cleaned, null, 2));
}

module.exports = { checkVersion, updateLite, runToolCommand, runRuntimeToolCommand, runRuntimeProbe, isKnownTool, printToolHelp, printAllToolSchemas, convertParam };
