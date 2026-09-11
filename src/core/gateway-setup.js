/**
 * gateway-setup.js — /agent/add 创建时的网关通信模式检测与可选配置
 *
 * 检测 OpenClaw(ws) / Hermes(http) 长连接是否就绪；不就绪时可一键配置：
 *  - OpenClaw: 生成 token 写 openclaw.json gateway.auth.token（带 .bak 备份），
 *              依赖 openclawHandler 的 configWatcher 自动重载 + _ensureGatewayRunning 启动 gateway
 *  - Hermes:   移植自 desktop main.js:_ensureHermesApiKey —— 生成 apiKey、分配端口、
 *              备份并更新 profile config.yaml，复用 hermesHandler 启动和认证
 *
 * 配置非必需：dispatcher 现成"长连接(priority=10)优先 / CLI(priority=1)兜底"机制保证不配也能通信。
 * 进度通过内存 Map 暴露给 /api/gateway/setup-status 轮询（仿 release build-log 模式）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { getHermesProfilePath, getHermesProfilesDir, getHermesConfigPath } = require('./hermes-paths');
const { readHermesGatewayConfig, writeHermesGatewayConfig, readHermesGatewayEnvironment } = require('./hermes-gateway-config');

// ════════════════════════════════════════
//  进度任务表（内存，一次性）
// ════════════════════════════════════════
const _tasks = new Map(); // taskId -> { logs, done, ok, error, ts }
const _activeSetups = new Map(); // One configuration writer per framework.
const _TASK_TTL = 10 * 60 * 1000;

function _gc() {
  const now = Date.now();
  for (const [id, t] of _tasks) {
    if (t.done && now - t.ts > _TASK_TTL) _tasks.delete(id);
  }
}

function getTask(id) { _gc(); return _tasks.get(id); }

function _logger(task) {
  return (msg) => {
    const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`;
    task.logs.push(line);
    if (task.logs.length > 300) task.logs.shift();
    console.log(`[GatewaySetup] ${msg}`);
  };
}

// ════════════════════════════════════════
//  检测
// ════════════════════════════════════════
function checkGateway(backend, databaseAPI, profileId) {
  if (backend === 'openclaw') {
    const o = global.__openclawHandler;
    if (!o) return { backend, ready: false, mode: 'ws', detail: 'OpenClaw 处理器未初始化' };
    const st = typeof o.getStatus === 'function' ? o.getStatus() : {};
    const hasToken = !!st.hasToken;
    const connected = !!st.connected;
    return {
      backend, mode: 'ws', hasToken, connected,
      ready: !st.configurationError && hasToken && connected,
      configurationError: st.configurationError || null,
      detail: st.configurationDetail || st.configurationError || (!hasToken
        ? 'openclaw.json 未配置 gateway.auth.token'
        : (connected ? 'WebSocket 长连接已就绪' : '已配置 token，Gateway 未运行')),
    };
  }
  if (backend === 'hermes') {
    const h = global.__hermesHandler;
    const targets = profileId ? [profileId] : Object.keys(h?.options?.profiles || {});
    const profiles = targets.map(id => h?.getProfileStatus?.(id)
      || { profileId: id, hasApiKey: false, connected: false, ready: false });
    const hasApiKey = profiles.length > 0 && profiles.every(profile => profile.hasApiKey);
    const connected = profiles.length > 0 && profiles.every(profile => profile.connected);
    const ready = profiles.length > 0 && profiles.every(profile => profile.ready);
    return { backend, mode: 'http', profileId: profileId || null, profiles, hasApiKey, connected, ready,
      detail: ready ? '所选 Hermes Profile 已通过 HTTP API 认证'
        : !hasApiKey ? '所选 Hermes Profile 未配置 API Key'
          : '所选 Hermes Profile 尚未通过 Gateway 认证' };
  }

  // goose / claude-code / codex / gemini / cursor / grok / opencode / pi / others：走 CLI / pull，无需长连接
  return { backend, ready: true, mode: 'cli', detail: '该类型走 CLI/pull 通信，无需配置长连接' };
}

// ════════════════════════════════════════
//  OpenClaw 配置
// ════════════════════════════════════════
const { openClawPaths } = require('./dispatcher/openclaw-command');
const { readOpenClawConfig } = require('./dispatcher/openclaw-config');

async function setupOpenclawGateway(log, options = {}) {
  const o = global.__openclawHandler;
  if (!o) throw new Error('OpenClaw 处理器未初始化');

  const configPath = openClawPaths(process.env, os.homedir()).configPath;
  let config;
  try { config = readOpenClawConfig(configPath); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('OPENCLAW_CONFIG_UNREADABLE: 配置无法解析，未修改');
    config = {};
  }
  if (!config || Array.isArray(config) || typeof config !== 'object') throw new Error('OPENCLAW_CONFIG_INVALID');
  const gateway = config.gateway || {};
  const auth = gateway.auth || {};
  if (typeof gateway !== 'object' || Array.isArray(gateway) || typeof auth !== 'object' || Array.isArray(auth)) {
    throw new Error('OPENCLAW_CONFIG_INVALID');
  }
  if (gateway.mode && gateway.mode !== 'local') throw new Error('OPENCLAW_REMOTE_SETUP_UNSUPPORTED: 请使用现有远程配置');
  const switchingFromNone = auth.mode === 'none' && options.allowTokenModeSwitch === true;
  if ((auth.mode && auth.mode !== 'token' && !switchingFromNone) || auth.password || (auth.token && typeof auth.token !== 'string')) {
    throw new Error('OPENCLAW_AUTH_SETUP_UNSUPPORTED: 自动配置仅支持本地 Token 认证，未修改现有认证');
  }
  // This entry point is the user's explicit local Gateway setup action.
  if (gateway.mode !== 'local' || !auth.token || switchingFromNone) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    try { fs.copyFileSync(configPath, configPath + '.bak.' + crypto.randomBytes(6).toString('hex'), fs.constants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('OPENCLAW_CONFIG_BACKUP_FAILED'); }
    config.gateway = { ...gateway, mode: 'local', auth: { ...auth, mode: 'token', token: auth.token || crypto.randomBytes(32).toString('hex') } };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
    log('✓ 已配置本地 Gateway；已有 Token 保持不变');
  } else log('✓ 已有本地 Token 配置');
  if (typeof o.loadConfig === 'function') o.loadConfig();

  log('🚀 启动 OpenClaw Gateway 并验证 WS 认证连接...');
  if (typeof o.start !== 'function') throw new Error('OpenClaw 处理器未初始化');
  await o.start();
  const status = o.getStatus();
  if (!status.hasToken || status.configurationError || !status.connected) {
    throw new Error('OPENCLAW_WS_NOT_CONNECTED: 配置已保存，但 WebSocket 认证连接尚未成功');
  }
  log('✅ WS 长连接已建立');

}

// ════════════════════════════════════════
//  Hermes 配置（移植自 desktop main.js:_ensureHermesApiKey + 辅助函数）
// ════════════════════════════════════════
async function setupHermesGateway(databaseAPI, profileId, log) {
  const h = global.__hermesHandler;
  if (!h || typeof h._ensureGatewayRunning !== 'function') throw new Error('Hermes 处理器未初始化');
  if (!databaseAPI?.saveConfigToDb) throw new Error('HERMES_CONFIG_STORE_UNAVAILABLE');
  const stored = databaseAPI.getConfigFromDb?.('hermes_config') || {};
  const cfg = { ...stored, profiles: { ...(stored.profiles || {}) } };
  let profiles = [];
  try { profiles = fs.readdirSync(getHermesProfilesDir(), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (fs.existsSync(getHermesConfigPath())) profiles.push('default');
  const targets = profileId ? [profileId] : [...new Set(profiles)];
  if (!targets.length) throw new Error('未找到任何 Hermes profile，请先用 hermes 创建 profile');
  if (targets.some(id => !profiles.includes(id))) throw new Error('HERMES_PROFILE_NOT_FOUND');
  // Reserve ports of existing profiles too, including profiles not registered in VOKO.
  const configs = [...new Set(profiles)].flatMap(id => {
    const file = id === 'default' && fs.existsSync(getHermesConfigPath()) ? getHermesConfigPath() : getHermesProfilePath(id, 'config.yaml');
    if (!targets.includes(id) && !fs.existsSync(file)) return [];
    const scope = { portOnly: !targets.includes(id) };
    return [{ id, config: readHermesGatewayConfig(file, scope), environment: readHermesGatewayEnvironment(file, process.env, scope) }];
  });
  const usedPorts = new Set([...Object.values(cfg.profiles).map(p => p.port), ...configs.flatMap(({ id, config, environment }) =>
    [config.port, environment.port, !targets.includes(id) ? config.port || 8642 : null])]);
  let nextPort = 8642;
  for (const { id, config, environment } of configs.filter(item => targets.includes(item.id))) {
    const existing = cfg.profiles[id] || {};
    while (usedPorts.has(nextPort)) nextPort++;
    const port = config.port || existing.port || environment.port || nextPort++;
    const apiKey = config.apiKey || existing.apiKey || cfg.apiKey || crypto.randomBytes(32).toString('hex');
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || typeof apiKey !== 'string') throw new Error('HERMES_CONFIG_INVALID');
    usedPorts.add(port);
    if (config.apiKey !== apiKey || config.port !== port || !config.enabled) {
      const backup = writeHermesGatewayConfig(config, apiKey, port);
      log(`✓ 已更新 profile ${id} (port=${port})，原配置备份：${backup}`);
    }
    cfg.profiles[id] = { ...existing, port, apiKey, configPath: config.configPath };
    if (environment.apiKey || environment.port) log(`profile ${id} 存在 API 环境配置，将通过认证确定生效连接`);
  }
  // Failure must stop the task before changing the live client or starting a process.
  databaseAPI.saveConfigToDb(cfg, 'hermes_config');
  log('✓ Hermes 配置已保存');
  h.options.profiles = cfg.profiles;
  h.options.apiKey = cfg.apiKey || '';
  if (!h.client) await h.start();
  for (const id of targets) {
    h.client.setProfile(id, cfg.profiles[id]);
    h._invalidateProfile(id);
    const ready = await h._ensureGatewayRunning(id);
    if (!ready || !h.getProfileStatus(id).ready) throw new Error(`HERMES_GATEWAY_NOT_READY: profile=${id} 未通过 Gateway 认证`);
    log(`✅ Hermes Gateway 已就绪 (profile=${id})`);
  }
}

// ════════════════════════════════════════
//  启动配置任务（异步运行，返回 taskId 供轮询）
// ════════════════════════════════════════
function startSetup(backend, agentId, databaseAPI, options = {}) {
  const active = _activeSetups.get(backend);
  if (active) {
    if (active.agentId === agentId) return { taskId: active.taskId };
    throw new Error('GATEWAY_SETUP_IN_PROGRESS: 该框架正在配置，请等待当前任务完成');
  }
  const id = crypto.randomBytes(6).toString('hex');
  const task = { logs: [], done: false, ok: false, error: null, ts: Date.now() };
  _tasks.set(id, task);
  _activeSetups.set(backend, { agentId, taskId: id });
  const log = _logger(task);

  (async () => {
    try {
      if (backend === 'openclaw') {
        await setupOpenclawGateway(log, options);
      } else if (backend === 'hermes') {
        await setupHermesGateway(databaseAPI, agentId, log);
      } else {
        throw new Error(`不支持的 backend: ${backend}`);
      }
      task.ok = true;
      log('🎉 配置完成');
    } catch (e) {
      task.error = e.message;
      log(`❌ 失败: ${e.message}`);
    } finally {
      _activeSetups.delete(backend);
      task.done = true;
      task.ts = Date.now();
      _gc();
    }
  })();

  return { taskId: id };
}

module.exports = { checkGateway, startSetup, getTask };
