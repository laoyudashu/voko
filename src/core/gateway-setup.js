/**
 * gateway-setup.js — /agent/add 创建时的网关通信模式检测与可选配置
 *
 * 检测 OpenClaw(ws) / Hermes(http) 长连接是否就绪；不就绪时可一键配置：
 *  - OpenClaw: 生成 token 写 openclaw.json gateway.auth.token（带 .bak 备份），
 *              依赖 openclawHandler 的 configWatcher 自动重载 + _ensureGatewayRunning 启动 gateway
 *  - Hermes:   移植自 desktop main.js:_ensureHermesApiKey —— 生成 apiKey、分配端口、
 *              写各 profile config.yaml、spawn gateway、重建 hermesHandler.client
 *
 * 配置非必需：dispatcher 现成"长连接(priority=10)优先 / CLI(priority=1)兜底"机制保证不配也能通信。
 * 进度通过内存 Map 暴露给 /api/gateway/setup-status 轮询（仿 release build-log 模式）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { getHermesProfilePath, getHermesProfilesDir } = require('./hermes-paths');

// ════════════════════════════════════════
//  进度任务表（内存，一次性）
// ════════════════════════════════════════
const _tasks = new Map(); // taskId -> { logs, done, ok, error, ts }
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
function checkGateway(backend, databaseAPI) {
  if (backend === 'openclaw') {
    const o = global.__openclawHandler;
    if (!o) return { backend, ready: false, mode: 'ws', detail: 'OpenClaw 处理器未初始化' };
    const st = typeof o.getStatus === 'function' ? o.getStatus() : {};
    const hasToken = !!st.hasToken;
    const connected = !!st.connected;
    return {
      backend, mode: 'ws', hasToken, connected,
      ready: hasToken && connected,
      detail: !hasToken
        ? 'openclaw.json 未配置 gateway.auth.token'
        : (connected ? 'WebSocket 长连接已就绪' : '已配置 token，Gateway 未运行'),
    };
  }
  if (backend === 'hermes') {
    const h = global.__hermesHandler;
    let apiKey = h?.options?.apiKey || '';
    try { const cfg = databaseAPI?.getConfigFromDb?.('hermes_config') || {}; apiKey = apiKey || cfg?.apiKey || ''; } catch (_) {}
    const hasApiKey = !!apiKey;
    const connected = !!h?.connected;
    return {
      backend, mode: 'http', hasApiKey, connected,
      ready: hasApiKey && connected,
      detail: !hasApiKey
        ? '未配置 Hermes API Key'
        : (connected ? 'HTTP API 长连接已就绪' : '已配置 API Key，Gateway 未运行'),
    };
  }
  // goose / claude-code / codex / gemini / cursor / grok / opencode / pi / others：走 CLI / pull，无需长连接
  return { backend, ready: true, mode: 'cli', detail: '该类型走 CLI/pull 通信，无需配置长连接' };
}

// ════════════════════════════════════════
//  OpenClaw 配置
// ════════════════════════════════════════
const OPENCLAW_CONFIG_PATH = path.join(os.homedir(), '.openclaw', 'openclaw.json');

async function setupOpenclawGateway(log) {
  const o = global.__openclawHandler;
  if (!o) throw new Error('OpenClaw 处理器未初始化');

  // 1. 读现有配置
  let config = {};
  try { config = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf-8')); } catch (_) { config = {}; }
  config.gateway = config.gateway || {};
  config.gateway.auth = config.gateway.auth || {};

  // 2. 已有 token 跳过生成；否则备份 + 生成写入
  if (config.gateway.auth.token) {
    log('✓ openclaw.json 已有 token，跳过生成');
  } else {
    const bak = OPENCLAW_CONFIG_PATH + '.bak';
    if (fs.existsSync(OPENCLAW_CONFIG_PATH) && !fs.existsSync(bak)) {
      try { fs.copyFileSync(OPENCLAW_CONFIG_PATH, bak); log('✓ 已备份 openclaw.json → openclaw.json.bak'); }
      catch (e) { log(`⚠ 备份失败: ${e.message}`); }
    }
    const token = `voko_${Date.now()}_${crypto.randomBytes(5).toString('hex')}`;
    config.gateway.auth.token = token;
    fs.writeFileSync(OPENCLAW_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
    log('✓ 已生成 gateway.auth.token 并写入 openclaw.json');
  }

  // 3. configWatcher 每 5s 检测 mtime；主动等其重载（最多 8s）
  log('⏳ 等待 OpenClaw 处理器自动重载配置（~5s）...');
  for (let i = 0; i < 8; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const st = typeof o.getStatus === 'function' ? o.getStatus() : {};
    if (st.hasToken) { log('✓ 处理器已重载 token'); break; }
  }

  // 4. 启动 gateway + 建立 WS 连接（start 幂等：_ensureGatewayRunning + setEnabled→connect）
  log('🚀 启动 OpenClaw Gateway 并建立 WS 连接...');
  if (typeof o.start === 'function') {
    await o.start();
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const cst = typeof o.getStatus === 'function' ? o.getStatus() : {};
      if (cst.connected) { log('✅ WS 长连接已建立'); return; }
    }
    log('⚠ Gateway 已启动，WS 未在 15s 内连上，请稍后在网关连接管理页确认');
  } else if (typeof o._ensureGatewayRunning === 'function') {
    const ok = await o._ensureGatewayRunning();
    if (!ok) throw new Error('Gateway 启动超时（15s），请确认 openclaw CLI 可用');
    log('✅ OpenClaw Gateway 已就绪');
  }
}

// ════════════════════════════════════════
//  Hermes 配置（移植自 desktop main.js:_ensureHermesApiKey + 辅助函数）
// ════════════════════════════════════════
function _profileHasApiServerKey(yaml) {
  const norm = String(yaml || '').replace(/\r\n/g, '\n');
  return /api_server:\s*\n(?:[ \t].*\n)*?[ \t]+extra:\s*\n[ \t]+key:\s*\S/m.test(norm);
}

function _profileHasRootPlatforms(yaml) {
  return /^platforms:\s*$/m.test(String(yaml || '').replace(/\r\n/g, '\n'));
}

function _writeKeyToProfile(profileName, apiKey, port, log) {
  const p = getHermesProfilePath(profileName, 'config.yaml');
  let yaml = '';
  try { yaml = fs.readFileSync(p, 'utf-8'); } catch (_) { log(`⚠ 无法读取 ${profileName} 的 config.yaml`); return; }
  const hasCRLF = yaml.includes('\r\n');
  yaml = yaml.replace(/\r\n/g, '\n');
  const block = '  api_server:\n    enabled: true\n    extra:\n      port: ' + port + '\n      key: ' + apiKey + '\n';
  yaml = yaml.replace(/^  api_server:\n(?:    .*\n)*/gm, '');
  if (_profileHasRootPlatforms(yaml)) {
    yaml = yaml.replace(/^(platforms:\s*\n)/m, '$1' + block);
  } else {
    if (!yaml.endsWith('\n')) yaml += '\n';
    yaml += 'platforms:\n' + block;
  }
  if (hasCRLF) yaml = yaml.replace(/\n/g, '\r\n');
  fs.writeFileSync(p, yaml, 'utf-8');
  log(`✓ 已写入 profile ${profileName} (port=${port})`);
}

async function setupHermesGateway(databaseAPI, agentId, log) {
  const h = global.__hermesHandler;
  if (!h) throw new Error('Hermes 处理器未初始化');

  let cfg = {};
  try { cfg = databaseAPI?.getConfigFromDb?.('hermes_config') || {}; } catch (_) {}
  // getHermesConfig 返回扁平结构 {apiKey, profiles}（旧嵌套已迁移），直接读写扁平字段，
  // 不再用 cfg.hermes_config.*（否则恒读不到 apiKey → 每次重生成覆盖所有 profile）
  cfg.profiles = cfg.profiles || {};
  let apiKey = cfg.apiKey;

  let usedPorts = new Set(Object.values(cfg.profiles).map(p => p.port));
  let nextPort = 8642;

  if (!apiKey) {
    // 首次：生成全局 key，写入所有 profile
    apiKey = crypto.randomBytes(32).toString('hex');
    let profiles = [];
    try { profiles = fs.readdirSync(getHermesProfilesDir()).filter(d => !d.startsWith('.')); } catch (_) {}
    if (profiles.length === 0) throw new Error('未找到任何 Hermes profile，请先用 hermes 创建 profile');
    for (const profile of profiles) {
      while (usedPorts.has(nextPort)) nextPort++;
      const port = nextPort++;
      _writeKeyToProfile(profile, apiKey, port, log);
      cfg.profiles[profile] = { port };
      usedPorts.add(port);
    }
    cfg.apiKey = apiKey;
    log(`✓ 已生成 API Key，写入 ${profiles.length} 个 profile`);
  } else {
    // 已有全局 key：仅补写当前 profile
    if (agentId) {
      if (!cfg.profiles[agentId]) {
        while (usedPorts.has(nextPort)) nextPort++;
        cfg.profiles[agentId] = { port: nextPort };
      }
      _writeKeyToProfile(agentId, apiKey, cfg.profiles[agentId].port, log);
      log(`✓ API Key 已补写到 profile ${agentId}`);
    } else {
      log('✓ API Key 已存在，无需生成');
    }
  }

  // 保存配置（扁平结构，与 getHermesConfig 一致）
  try { databaseAPI.saveConfigToDb(cfg, 'hermes_config'); log('✓ Hermes 配置已保存'); }
  catch (e) { log(`⚠ 保存配置失败: ${e.message}`); }

  // 重建 hermesHandler.client（刷新 apiKey / profiles）
  if (h.client && typeof h.client.destroy === 'function') {
    try { h.client.destroy(); } catch (_) {}
    h.client = null;
  }
  h.options = h.options || {};
  h.options.apiKey = apiKey;
  h.options.profiles = cfg.hermes_config.profiles;
  if (typeof h._initClient === 'function') { await h._initClient(); log('✓ Hermes 客户端已重建'); }

  // spawn gateway（--replace 替换同 profile 旧实例）
  const target = agentId || Object.keys(cfg.hermes_config.profiles)[0];
  if (target) {
    try {
      const cleanEnv = { ...process.env, HTTPS_PROXY: '', HTTP_PROXY: '' };
      require('child_process').spawn('hermes', ['--profile', target, 'gateway', 'run', '--replace'], {
        stdio: 'ignore', windowsHide: true, detached: true, env: cleanEnv,
      }).on('error', (err) => log(`⚠ gateway 启动失败: ${err.message}`)).unref();
      log(`🚀 gateway 已触发启动 (profile=${target})`);
    } catch (e) { log(`⚠ gateway spawn 异常: ${e.message}`); }

    log('⏳ 等待 gateway 就绪...');
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 1000));
      if (h.client && typeof h.client.ping === 'function') {
        try { if (await h.client.ping(target)) { log('✅ Hermes Gateway 已就绪'); return; } } catch (_) {}
      }
    }
    log('⚠ gateway 就绪检测超时，请稍后在网关连接管理页确认');
  }
}

// ════════════════════════════════════════
//  启动配置任务（异步运行，返回 taskId 供轮询）
// ════════════════════════════════════════
function startSetup(backend, agentId, databaseAPI) {
  const id = crypto.randomBytes(6).toString('hex');
  const task = { logs: [], done: false, ok: false, error: null, ts: Date.now() };
  _tasks.set(id, task);
  const log = _logger(task);

  (async () => {
    try {
      if (backend === 'openclaw') {
        await setupOpenclawGateway(log);
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
      task.done = true;
      task.ts = Date.now();
      _gc();
    }
  })();

  return { taskId: id };
}

module.exports = { checkGateway, startSetup, getTask };
