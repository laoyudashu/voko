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
const { getHermesProfilePath, getHermesProfilesDir, getHermesConfigPath } = require('./hermes-paths');
const { resolveHermesCommand } = require('./dispatcher/hermes-command');

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
      detail: st.configurationError || (!hasToken
        ? 'openclaw.json 未配置 gateway.auth.token'
        : (connected ? 'WebSocket 长连接已就绪' : '已配置 token，Gateway 未运行')),
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
const { openClawPaths } = require('./dispatcher/openclaw-command');

async function setupOpenclawGateway(log) {
  const o = global.__openclawHandler;
  if (!o) throw new Error('OpenClaw 处理器未初始化');

  const configPath = openClawPaths(process.env, os.homedir()).configPath;
  let config;
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf-8')); }
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
  if ((auth.mode && auth.mode !== 'token') || auth.password || (auth.token && typeof auth.token !== 'string')) {
    throw new Error('OPENCLAW_AUTH_SETUP_UNSUPPORTED: 自动配置仅支持本地 Token 认证，未修改现有认证');
  }
  // This entry point is the user's explicit local Gateway setup action.
  if (gateway.mode !== 'local' || !auth.token) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    try { fs.copyFileSync(configPath, configPath + '.bak.' + crypto.randomBytes(6).toString('hex'), fs.constants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('OPENCLAW_CONFIG_BACKUP_FAILED'); }
    config.gateway = { ...gateway, mode: 'local', auth: { ...auth, token: auth.token || crypto.randomBytes(32).toString('hex') } };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
    log('✓ 已配置本地 Gateway；已有 Token 保持不变');
  } else log('✓ 已有本地 Token 配置');
  if (typeof o.loadConfig === 'function') o.loadConfig();

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
  const p = profileName === 'default' ? getHermesConfigPath() : getHermesProfilePath(profileName, 'config.yaml');
  let yaml = '';
  try { yaml = fs.readFileSync(p, 'utf-8'); }
  catch (error) {
    if (error?.code !== 'ENOENT') {
      log(`⚠ 无法读取 ${profileName} 的 config.yaml`);
      return;
    }
  }
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

function _readGatewayFromProfile(profileName) {
  try {
    const profilePath = profileName === 'default' ? getHermesConfigPath() : getHermesProfilePath(profileName, 'config.yaml');
    const yaml = fs.readFileSync(profilePath, 'utf-8');
    const block = yaml.match(/^\s{2}api_server:\s*\r?\n((?:\s{4,}.*(?:\r?\n|$))*)/m)?.[1] || '';
    const apiKey = block.match(/^\s+key:\s*([^\r\n#]+)/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '') || '';
    const port = Number(block.match(/^\s+port:\s*(\d+)/m)?.[1]);
    return { apiKey, port: Number.isSafeInteger(port) && port > 0 ? port : null };
  } catch (_) {
    return { apiKey: '', port: null };
  }
}

async function setupHermesGateway(databaseAPI, agentId, log) {
  const h = global.__hermesHandler;
  if (!h) throw new Error('Hermes 处理器未初始化');

  let cfg = {};
  try { cfg = databaseAPI?.getConfigFromDb?.('hermes_config') || {}; } catch (_) {}
  // getHermesConfig 返回扁平结构 {apiKey, profiles}（旧嵌套已迁移），直接读写扁平字段，
  // 不再用 cfg.hermes_config.*（否则恒读不到 apiKey → 每次重生成覆盖所有 profile）
  cfg.profiles = cfg.profiles || {};
  let usedPorts = new Set(Object.values(cfg.profiles).map(p => p.port));
  let nextPort = 8642;

  let profiles = [];
  try { profiles = fs.readdirSync(getHermesProfilesDir()).filter(d => !d.startsWith('.')); } catch (_) {}
  if (profiles.length === 0) throw new Error('未找到任何 Hermes profile，请先用 hermes 创建 profile');
  const targets = agentId ? [agentId] : profiles;
  for (const profile of targets) {
    const discovered = _readGatewayFromProfile(profile);
    const existing = cfg.profiles[profile] || {};
    while (usedPorts.has(nextPort)) nextPort++;
    const port = discovered.port || existing.port || nextPort++;
    const apiKey = discovered.apiKey || existing.apiKey || cfg.apiKey || crypto.randomBytes(32).toString('hex');
    cfg.profiles[profile] = { ...existing, port, apiKey };
    usedPorts.add(port);
    if (!discovered.apiKey || discovered.port !== port) _writeKeyToProfile(profile, apiKey, port, log);
    else log(`✓ 已读取 profile ${profile} 的独立 API Key (port=${port})`);
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
  h.options.apiKey = cfg.apiKey || '';
  h.options.profiles = cfg.profiles;
  if (typeof h._initClient === 'function') { await h._initClient(); log('✓ Hermes 客户端已重建'); }

  // spawn gateway（--replace 替换同 profile 旧实例）
  const target = agentId || Object.keys(cfg.profiles)[0];
  if (target) {
    try {
      const cleanEnv = { ...process.env, HTTPS_PROXY: '', HTTP_PROXY: '' };
      require('child_process').spawn(resolveHermesCommand(), ['--profile', target, 'gateway', 'run', '--replace'], {
        stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32', env: cleanEnv,
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
