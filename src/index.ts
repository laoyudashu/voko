#!/usr/bin/env node
export {};
import type { AccessControlLike } from './core/messenger-types';
const { normalizeBackendType } = require('./core/agent-backend-types');


// 兼容旧的开发启动命令：源码目录中可能包含已迁移为 .ts 的模块，
// Node.js 不能直接 require；先构建，再将参数原样交给 build 入口。
if (require.main === module && require('path').basename(__dirname) === 'src') {
  const { spawnSync } = require('child_process');
  const path = require('path');
  const packageDir = path.join(__dirname, '..');
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const build = spawnSync(npmCommand, ['run', 'build:ts'], {
    cwd: packageDir,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (build.error) console.error('[VOKO Lite] 构建启动失败:', build.error.message);
  if (build.status !== 0) process.exit(build.status ?? 1);

  const run = spawnSync(process.execPath, [path.join(packageDir, 'build', 'index.js'), ...process.argv.slice(2)], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (run.error) console.error('[VOKO Lite] 编译产物启动失败:', run.error.message);
  process.exit(run.status ?? 1);
}

// 抑制 ExperimentalWarning（node:sqlite 等）
const _emit = process.emit.bind(process);
(process as any).emit = (type?: any, ...args: any) => {
  if (type === 'warning' && args[0]?.name === 'ExperimentalWarning') return true;
  return _emit(type, ...args);
};

/**
 * VOKO Lite — Node.js 轻量版入口
 *
 * 用法：
 *   voko                   默认启动 MCP Server
 *   voko start             启动 MCP Server
 *   voko list              列出 agents
 *   voko status            查看运行状态
 *   voko register-capabilities <agentId>  注册能力
 *
 * @package @voko/lite
 */

// ── node:sqlite 内置模块，无需原生编译 ──

const path = require('path');
const os = require('os');
const express = require('express');
const { ensureLoopbackNoProxy } = require('./core/loopback-env');

ensureLoopbackNoProxy(process.env);

// ── core 模块 ──
const {
  initDatabase,
  createDatabaseAPI,
  getUserAccessToken,
  SCHEMA_VERSION,
} = require('./core/database');
const { createAgentRegistration } = require('./core/agent-registration');
const { createLocalWebSessionStore } = require('./core/local-web-session');
const { assertSecureEndpoint } = require('./core/url-security');
const {
  isAllowedLocalHost,
  isAllowedLocalOrigin,
  isAllowedLocalWebSocketOrigin,
  requiresLocalToken,
  isAllowedBridgeConfigType,
  setLocalSecurityHeaders,
} = require('./core/local-http-security');
const { generateOSSSignature, initOSSFromConfig } = require('./server/oss');
const { AgentWorkerManager } = require('./core/worker-manager');
const { createDeliver, createSendMessage } = require('./core/send-message');
const {
  acquireInstanceLock,
  cleanupOrphanedWorkers,
  isInstanceAlive,
  readInstanceMetadata,
} = require('./core/process-lifecycle');
const { stopVoko } = require('./core/stop-voko');

// ── Lite 模块 ──
const { createContext } = require('./context');
const cli = require('./cli');

// ── MCP 模块 ──
const { createMcpServer, getToolList } = require('./mcp/server');
const { createToolHandlers } = require('./mcp/tools');
const { createHttpTransport } = require('./mcp/transport/http');

// ── Web 模块 ──
const { createWebRouter } = require('./web');

// ── i18n（进程级 locale：CLI 文案与默认 locale 由 main() 启动时设定）──
const { setLocale, getLocale, detectCliLocale, t } = require('./core/i18n');

let __instanceLock: any = null;
let __httpServer: any = null;
let __webSocketServer: any = null;
let __consoleLiveEvents: any = null;
let __shuttingDown = false;
let __serviceHealth: 'ok' | 'draining' | 'unhealthy' = 'ok';
let __fatalHandling = false;
let __shutdownContext: { agentManager?: any; wukongimSender?: any; db?: any; taskManager?: any } | null = null;

function handleFatalError(kind: 'uncaughtException' | 'unhandledRejection', error: unknown): void {
  console.error(`[Lite][${kind}]`, error instanceof Error ? error.stack || error.message : error);
  __serviceHealth = 'unhealthy';
  process.exitCode = 1;

  if (__fatalHandling) {
    process.exit(1);
    return;
  }
  __fatalHandling = true;

  const forceExit = setTimeout(() => process.exit(1), 8000);
  forceExit.unref();
  const context = __shutdownContext || {};
  void shutdownAll(
    context.agentManager,
    context.wukongimSender,
    context.db,
    `fatal:${kind}`,
    1,
    context.taskManager,
  ).then(
    () => process.exit(1),
    (shutdownError: unknown) => {
      console.error('[Lite][fatal] shutdown failed:', shutdownError);
      process.exit(1);
    },
  );
}

process.on('unhandledRejection', (reason: unknown) => handleFatalError('unhandledRejection', reason));
process.on('uncaughtException', (error: Error) => handleFatalError('uncaughtException', error));

interface RuntimeSnapshot {
  instanceId?: string;
  pid?: number;
  ts?: number;
  port?: number;
  userEmail?: string;
  agents?: unknown[];
}

// ── 渠道模块 ──
const registry = require('./channels/registry');
const { AgentEmailApi } = require('./server/agent-email-api');
const { OwnerInterventionNotifier } = require('./server/owner-intervention-notifier');
const notifier = require('./core/notifier');

const pkg = require('../package.json');

// ═══════════════════════════════════════════════
//  工具函数
// ═══════════════════════════════════════════════

function _initFileLogger() {
  try {
    const fs = require('fs');
    let logDir;
    if (process.platform === 'win32' && process.env.APPDATA) {
      logDir = path.join(process.env.APPDATA, 'voko');
    } else if (process.platform === 'darwin') {
      logDir = path.join(os.homedir(), 'Library', 'Application Support', 'voko');
    } else {
      logDir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'voko');
    }
    try { fs.mkdirSync(logDir, { recursive: true }); } catch (_: any) {}
    // 清理已废弃的 agent-worker.log（日志统一到 voko-im.log）
    try { fs.unlinkSync(path.join(logDir, 'agent-worker.log')); } catch (_: any) {}
    const logPath = path.join(logDir, 'voko-im.log');
    function rotateIfNeeded(p?: any, maxSize: any = 10*1024*1024, keep: any = 5) {
      try {
        if (!fs.existsSync(p) || fs.statSync(p).size < maxSize) return;
        for (let i = keep; i >= 1; i--) {
          const src = i === 1 ? p : `${p}.${i - 1}`;
          const dst = `${p}.${i}`;
          try { if (i === keep) fs.unlinkSync(dst); if (fs.existsSync(src)) fs.renameSync(src, dst); } catch (_: any) {}
        }
      } catch (_: any) {}
    }
    // ── LOG_LEVEL ──
    const _levelPriority: Record<string, number> = { DBG: 0, LOG: 1, WRN: 2, ERR: 3 };
    const _currentLevel = _levelPriority[String(process.env.VOKO_LOG_LEVEL).toUpperCase()] ?? 1;
    function _shouldLog(level?: any) {
      return (_levelPriority[level] ?? 1) >= _currentLevel;
    }
    function fmt(level?: any, a?: any) {
      const n = new Date(), p = (x: any) => String(x).padStart(2, '0');
      const ms = String(n.getMilliseconds()).padStart(3, '0');
      const ts = `${n.getFullYear()}-${p(n.getMonth()+1)}-${p(n.getDate())} ${p(n.getHours())}:${p(n.getMinutes())}:${p(n.getSeconds())}.${ms}`;
      return `${ts} [${level}] ` + a.map((x: any) => typeof x === 'object' ? (x instanceof Error ? x.stack || x.message : JSON.stringify(x)) : String(x)).join(' ');
    }
    function persist(level?: any, a?: any) {
      if (!_shouldLog(level)) return;
      try { rotateIfNeeded(logPath); fs.appendFileSync(logPath, fmt(level, a) + '\n'); } catch (_: any) {}
    }
    // log/error/warn/debug 统一写 voko-im.log
    const _origLog = console.log, _origError = console.error, _origWarn = console.warn, _origDebug = console.debug;
    console.log = function(...a: any) { persist('LOG', a); _origLog.apply(console, a); };
    console.error = function(...a: any) { persist('ERR', a); _origError.apply(console, a); };
    console.warn = function(...a: any) { persist('WRN', a); _origWarn.apply(console, a); };
    console.debug = function(...a: any) { persist('DBG', a); if (_origDebug) _origDebug.apply(console, a); };
  } catch (_: any) {}
}

function parseArgs(argv?: any) {
  const args: Record<string, any> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const eq = argv[i].indexOf('=');
      if (eq > 0) {
        args[argv[i].slice(2, eq)] = argv[i].slice(eq + 1);
      } else {
        const key = argv[i].slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          args[key] = next;
          i++;
        } else {
          args[key] = true;
        }
      }
    }
  }
  return args;
}

function hasGraphicalSession(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (platform === 'linux') return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
  if (platform === 'darwin' || platform === 'win32') {
    return !env.SSH_CONNECTION && !env.SSH_TTY;
  }
  return false;
}

function printHeadlessLoginGuidance(port: number) {
  console.error(t('cli.index.headless_login', { port }));
}

function interactiveStartEnabled(
  args: Record<string, any>,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): boolean {
  const rawDisabled = args.noInteractive ?? args['no-interactive'];
  const disabled = rawDisabled === true || rawDisabled === 'true' || rawDisabled === '1';
  return !disabled && !hasGraphicalSession(platform, env) && !!input.isTTY && !!output.isTTY;
}

function hasAgentForOwner(db: any, email: string | null): boolean {
  if (!email) return false;
  try {
    return !!db.prepare('SELECT 1 FROM agents WHERE LOWER(TRIM(owner_email)) = ? LIMIT 1')
      .get(String(email).trim().toLowerCase());
  } catch {
    return false;
  }
}

async function runHeadlessOnboarding(args: Record<string, any>, core: any) {
  if (!interactiveStartEnabled(args)) return false;
  const interactive = require('./cli-interactive');
  let email = getCurrentUserEmail(core.db);
  if (!email) {
    console.error(t('cli.index.headless_onboarding'));
    const login = await interactive.runInteractiveLogin(core);
    email = login.email;
  }
  if (!hasAgentForOwner(core.db, email)) {
    console.error(t('cli.index.headless_register'));
    await interactive.runInteractiveRegistration(core);
  }
  return true;
}

function openLocalWebPage(port: number) {
  if (!hasGraphicalSession()) return false;
  const url = `http://localhost:${port}/`;
  try {
    const childProcess = require('child_process');
    let child;
    if (process.platform === 'win32') {
      child = childProcess.spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
      child = childProcess.spawn(command, [url], { detached: true, stdio: 'ignore' });
    }
    child.once('error', (error: Error) => {
      console.error(`[Lite] 无法自动打开 ${url}: ${error.message}`);
    });
    child.unref();
    return true;
  } catch (error: any) {
    console.error(`[Lite] 无法自动打开 ${url}: ${error.message}`);
    return false;
  }
}

function checkVersionAndPersist(db: any): void {
  void cli.checkVersion().then((result: any) => {
    if (!result) return;
    try {
      db.prepare("INSERT OR REPLACE INTO config (type, data, updated_at) VALUES ('update_status', ?, ?)")
        .run(JSON.stringify({ ...result, checkedAt: Date.now() }), Date.now());
    } catch (_: any) {}
  });
}

function parseRuntimeSnapshot(value: unknown): RuntimeSnapshot {
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as RuntimeSnapshot
      : {};
  } catch {
    return {};
  }
}

function runtimeMatchesInstance(
  runtime: RuntimeSnapshot,
  instance: { instanceId: string; pid: number },
): boolean {
  if (runtime.instanceId) return runtime.instanceId === instance.instanceId;
  return runtime.pid === instance.pid;
}

function clearCurrentRuntimeSnapshot(db: any): void {
  try {
    const row = db.prepare("SELECT data FROM config WHERE type = 'runtime'").get();
    const runtime = parseRuntimeSnapshot(row?.data);
    const instance = __instanceLock?.metadata;
    const owned = instance
      ? runtimeMatchesInstance(runtime, instance)
      : runtime.pid === process.pid;
    if (owned) {
      db.prepare("DELETE FROM config WHERE type = 'runtime'").run();
    }
  } catch {}
}

function getDefaultDbPath() {
  const platform = process.platform;
  if (platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'voko', 'voko.db');
  }
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'voko', 'voko.db');
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  const configDir = xdg || path.join(os.homedir(), '.config');
  return path.join(configDir, 'voko', 'voko.db');
}

function resolveDbPath(args?: any, options: any = {}) {
  if (args.db) return args.db;
  // 环境变量优先，便于隔离测试或指定数据目录。
  if (process.env.VOKO_DB_PATH) {
    return process.env.VOKO_DB_PATH;
  }
  const defaultDb = getDefaultDbPath();
  if (!options.noCreate) {
    try { require('fs').mkdirSync(path.dirname(defaultDb), { recursive: true }); } catch (_: any) {}
  }
  return defaultDb;
}

function inspectSetup(args?: any) {
  const fs = require('fs');
  const dbPath = resolveDbPath(args, { silent: true });
  const entryPath = path.resolve(process.argv[1]);
  const nodeVersion = process.versions.node;
  const [major, minor] = nodeVersion.split('.').map(Number);
  const nodeSupported = major > 22 || (major === 22 && minor >= 5);
  const instance = readInstanceMetadata(dbPath);
  const running = Boolean(instance && isInstanceAlive(instance));
  let database = { exists: fs.existsSync(dbPath), readable: false, schemaVersion: null as number | null };
  let authenticated = false;
  let agentCount = 0;

  if (database.exists) {
    const { DatabaseSync: Database } = require('node:sqlite');
    let db: any = null;
    try {
      db = new Database(dbPath, { readOnly: true });
      database.readable = true;
      const schema = db.prepare("SELECT data FROM config WHERE type = 'schema_version'").get();
      database.schemaVersion = Number(schema?.data) || null;
      authenticated = Boolean(db.prepare("SELECT 1 FROM config WHERE type IN ('user_access_token', 'current_user_email') LIMIT 1").get());
      agentCount = Number(db.prepare('SELECT COUNT(*) AS count FROM agents').get()?.count || 0);
    } catch (_) {
      database.readable = false;
    } finally {
      try { if (db?.open) db.close(); } catch (_) {}
    }
  }

  let nextAction: any;
  if (!nodeSupported) nextAction = { type: 'upgrade_node', minimumVersion: '22.5.0' };
  else if (!database.exists || !authenticated) nextAction = { type: 'login', command: ['voko', 'login'] };
  else if (agentCount === 0) nextAction = { type: 'start_registration', command: ['voko', 'manage_agent_registration', '--action', 'start', '--registration-mode', 'agent'] };
  else if (!running) nextAction = { type: 'start_lite', command: ['voko', 'start', '--no-open', '--no-interactive'] };
  else nextAction = { type: 'ready' };

  return {
    success: nodeSupported,
    headlessCompatible: true,
    browserOpened: false,
    version: pkg.version,
    node: { version: nodeVersion, supported: nodeSupported, minimumVersion: '22.5.0' },
    database,
    authentication: { configured: authenticated },
    agents: { count: agentCount },
    runtime: { running, port: running ? (instance?.port || null) : null },
    stableCommands: {
      mcp: { command: process.execPath, args: [entryPath, 'mcp'] },
      start: { command: process.execPath, args: [entryPath, 'start', '--no-open', '--no-interactive'] },
    },
    nextAction,
  };
}

function initCore(args?: any, options: any = {}) {
  const dbPath = resolveDbPath(args, options);
  const db = initDatabase(dbPath, { silent: options.silent });
  const databaseAPI = createDatabaseAPI(db);
  const agentRegistration = createAgentRegistration({ db });
  const agentManager = new AgentWorkerManager(db, {
    dbPath,
    instance: __instanceLock?.metadata || null,
  });
  // 兼容旧依赖字段名；实际发送由共享 Hub 管理器完成。
  const wukongimSender = agentManager;
  const deliver = createDeliver({ transportManager: agentManager });
  const sendMessage = createSendMessage({ db, deliver, agentWorkers: agentManager.workers, mainWindow: null });
  agentManager.setDeliver(deliver);
  agentManager.sendImMessage = sendMessage;  // 供 /api/message/send 等 HTTP 端点统一发送（自带兜底）
  return { db, databaseAPI, agentRegistration, agentManager, wukongimSender, deliver, sendMessage };
}

function printReadyBanner(db: any, port: number, ownerEmail: string | null, agentManager: any) {
  const ORANGE = '\x1b[38;5;202m';
  const RESET = '\x1b[0m';
  const summary = agentManager?.getHubSummary?.() || { hubCount: 0, agentCount: 0 };
  const connected = agentManager?.connectedAgents?.size || 0;
  const details = [
    '  Version:    ' + pkg.version,
    '  PID:        ' + process.pid,
    '  Time:       ' + new Date().toLocaleString('zh-CN', { hour12: false }),
    '  Port:       ' + port,
    `  IM:         ${connected}/${summary.agentCount || 0} connected, ${summary.hubCount || 0} Hub(s)`,
  ];
  if (ownerEmail) details.push('  Owner:      ' + ownerEmail);
  details.push(
    '  DB:         ' + (db._dbPath || ''),
    '  Web:        http://localhost:' + port,
    '  MCP:        http://localhost:' + port + '/mcp',
    '  Status:     READY',
  );
  console.error([
    '',
    ORANGE + '██╗   ██╗ ██████╗ ██╗  ██╗ ██████╗ ' + RESET,
    ORANGE + '██║   ██║██╔═══██╗██║ ██╔╝██╔═══██╗' + RESET,
    ORANGE + '██║   ██║██║   ██║█████╔╝ ██║   ██║' + RESET,
    ORANGE + '╚██╗ ██╔╝██║   ██║██╔═██╗ ██║   ██║' + RESET,
    ORANGE + ' ╚████╔╝ ╚██████╔╝██║  ██╗╚██████╔╝' + RESET,
    ORANGE + '  ╚═══╝   ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ' + RESET,
    '',
    ...details,
    '',
  ].join('\n'));
}

// ═══════════════════════════════════════════════
//  MCP Server 模式
// ═══════════════════════════════════════════════

// 实际监听端口（tryListen 成功后回写；可能与 args.port 不同——端口被占时递增）。
// startHeartbeat 引用此变量写 DB runtime，确保记录的是真实端口而非命令行参数。
let __runtimePort: any = null;

/**
 * 启动 MCP 传输层（stdio 或 HTTP）
 */
async function startTransport(args?: any, mcpServer?: any, agentManager?: any, db?: any, databaseAPI?: any, webRouter?: any, handlers?: any, runtimeState?: any, wukongimSender?: any, taskManager?: any) {
  const port = parseInt(args.port, 10) || 3100;
  const app = express();
  app.use((req?: any, res?: any, next?: any) => {
    setLocalSecurityHeaders(res);
    if (!isAllowedLocalOrigin(req.headers.origin, req.headers.host, req.method, req.headers['sec-fetch-site'])) {
      return res.status(403).json({ error: 'LOCAL_ORIGIN_REJECTED' });
    }
    next();
  });

  // Host 头校验：服务绑 127.0.0.1，仅允许本机 Host，挡 DNS-rebinding（恶意网站把域名解析到 127.0.0.1 后同源调本接口）
  app.use((req?: any, res?: any, next?: any) => {
    if (!isAllowedLocalHost(req.headers.host)) {
      return res.status(403).json({ error: t('errors.forbidden_host') });
    }
    next();
  });

  // MCP 默认使用每次 Lite 实例生成的随机 token。stdio 代理从仅当前用户可访问的
  // runtime owner 文件读取，避免任意本地 HTTP 调用方直接获得 Agent 高权限工具。
  const _authToken = process.env.VOKO_MCP_TOKEN || __instanceLock?.metadata?.mcpToken;
  app.use((req?: any, res?: any, next?: any) => {
    if (!requiresLocalToken(req.path)) return next();
    const suppliedToken = req.headers['x-voko-token'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!_authToken || suppliedToken !== _authToken) return res.status(401).json({ error: t('errors.unauthorized_token') });
    next();
  });

  // 先完成来源、Host 和可选 token 校验，再读取请求体，避免无效来源消耗解析资源。
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  const currentOwnsAgent = (agentId: string): boolean => {
    if (!agentId) return false;
    const row = db.prepare('SELECT owner_email FROM agents WHERE agent_id=? LIMIT 1').get(agentId);
    const current = String(getCurrentUserEmail(db) || '').trim().toLowerCase();
    return !!row?.owner_email && !!current && current === String(row.owner_email).trim().toLowerCase();
  };
  const interventionAgentId = (id: string): string => String(
    db.prepare('SELECT agent_id FROM owner_interventions WHERE id=? LIMIT 1').get(id)?.agent_id || '',
  );

  // 所有直接本地 API 在命中现有 Agent 时统一校验当前登录 owner，避免绕过 handlers。
  app.use('/api', (req?: any, res?: any, next?: any) => {
    const pathMatch = String(req.path || '').match(/^\/agents?\/([^/]+)/);
    const agentId = String(req.body?.agentId || req.query?.agentId || pathMatch?.[1] || '').trim();
    if (!agentId) return next();
    try {
      const row = db.prepare('SELECT owner_email FROM agents WHERE agent_id=? LIMIT 1').get(agentId);
      if (!row) return next();
      if (currentOwnsAgent(agentId)) return next();
      return res.status(403).json({ success: false, error: '当前登录用户无权访问该 Agent', code: 'AGENT_OWNER_MISMATCH' });
    } catch (_) { return res.status(500).json({ success: false, error: '无法验证 Agent 归属', code: 'AGENT_OWNER_CHECK_FAILED' }); }
  });

  const httpTransport = createHttpTransport(mcpServer, { version: pkg.version, db });
  app.use('/mcp', httpTransport);

  // DB 元信息（供 desktop 启动时协商 schema 兼容性；只读，放行无需 token）
  app.get('/api/db-info', (req?: any, res?: any) => {
    let dbSchemaVer = null;
    try {
      const row = db.prepare("SELECT data FROM config WHERE type = 'schema_version'").get();
      dbSchemaVer = row ? (parseInt(JSON.parse(row.data), 10) || 0) : 0;
    } catch (_: any) {}
    res.json({ schemaVersion: SCHEMA_VERSION, dbSchemaVersion: dbSchemaVer, appVersion: pkg.version });
  });

  // 文件上传端点 — 需要 raw body 解析 multipart
  app.post('/api/agents/:agentId/send-file', (req?: any, res?: any, next?: any) => {
    if (req.is('multipart/form-data')) {
      let chunks: Buffer[] = [];
      let total = 0;
      let tooLarge = false;
      const maxBytes = 25 * 1024 * 1024;
      req.on('data', (c: any) => {
        if (tooLarge) return;
        total += c.length;
        if (total > maxBytes) {
          tooLarge = true;
          chunks = [];
          if (!res.headersSent) res.status(413).end();
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (tooLarge) return;
        req.rawBody = Buffer.concat(chunks);
        next();
      });
    } else {
      next();
    }
  });

  // Agent Web 页面 — 用可变引用，支持热更新
  let currentWebRouter = webRouter;
  if (currentWebRouter) {
    app.use('/', (req?: any, res?: any, next?: any) => currentWebRouter(req, res, next));
  }

  // 网页热更新（不重启服务器，不中断 IM/Worker）
  app.post('/api/reload-web', (req?: any, res?: any) => {
    try {
      delete require.cache[require.resolve('./web')];
      delete require.cache[require.resolve('./web/register')];
      const { createWebRouter: reloaded } = require('./web');
      currentWebRouter = reloaded(handlers, db, { getToolList: () => getToolList(mcpServer) });
      console.error('[Lite] 网页已热更新');
      res.json({ success: true, message: '网页已热更新' });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.get('/health', (req?: any, res?: any) => res.status(__serviceHealth === 'ok' ? 200 : 503).json({
    status: __serviceHealth,
    uptime: process.uptime(),
    instanceId: __instanceLock?.metadata?.instanceId || null,
    tasks: taskManager?.snapshot?.() || [],
  }));
  app.post('/api/quit', (req?: any, res?: any) => {
    const expected = __instanceLock?.metadata?.instanceId;
    const supplied = String(req.headers['x-voko-instance-id'] || '');
    if (expected && supplied !== expected) {
      return res.status(409).json({ success: false, error: 'Lite 实例身份不匹配' });
    }
    res.json({ success: true, message: 'Lite 正在关闭' });
    // 通知 Desktop 退出
    const bus = require('./core/lite-bus');
    bus.emit('app:quit');
    setTimeout(() => shutdownAll(agentManager, wukongimSender, db, 'api-quit'), 1000);
  });

  // ════════════════════════════════════════════
  //  Desktop Bridge API — 供 Desktop 通过 HTTP 调用
  // ════════════════════════════════════════════

  // ── Hermes 网关状态 ──
  app.get('/api/hermes/status', (req?: any, res?: any) => {
    const h = (global as any).__hermesHandler;
    if (!h) return res.json({ initialized: false, handler: null });
    try {
      const st = typeof h.getStatus === 'function' ? h.getStatus() : {};
      let profiles = {};
      let apiKey = h.options?.apiKey || '';
      try {
        const hermesCfg = databaseAPI.getConfigFromDb('hermes_config') || {};
        profiles = Object.fromEntries(Object.entries(hermesCfg?.profiles || {}).map(([profileId, profile]: [string, any]) => [
          profileId,
          { port: profile?.port || null, hasApiKey: !!profile?.apiKey || !!hermesCfg?.apiKey },
        ]));
        apiKey = apiKey || hermesCfg?.apiKey || '';
      } catch (_: any) {}
      const connectedAgents = h.connectedAgents ? Array.from(h.connectedAgents) : [];
      res.json({
        initialized: true,
        handler: {
          connected: st.connected || false,
          enabled: st.enabled !== false,
          clientReady: st.clientReady || false,
          host: h.options?.host || '127.0.0.1',
          port: h.options?.port || 8642,
          hasApiKey: !!apiKey,
          connectedAgents,
          profiles,
          logs: st.logs || [],
        },
      });
    } catch (e: any) {
      res.json({ initialized: true, handler: { connected: false, hasApiKey: false, logs: [], error: e.message } });
    }
  });
  app.post('/api/hermes/reconnect', async (req?: any, res?: any) => {
    const h = (global as any).__hermesHandler;
    if (!h) return res.json({ success: false, error: 'Hermes 未初始化' });
    try {
      if (typeof h._ensureGatewayRunning === 'function') await h._ensureGatewayRunning();
      res.json({ success: true });
    } catch (e: any) { res.json({ success: false, error: e.message }); }
  });
  app.post('/api/hermes/test-connection', async (req?: any, res?: any) => {
    const h = (global as any).__hermesHandler;
    if (!h || !h.client) return res.json({ success: false, error: 'Hermes 未连接' });
    try {
      await h.healthCheck();
      res.json({ success: true });
    } catch (e: any) { res.json({ success: false, error: e.message }); }
  });
  app.post('/api/hermes/test-agent', async (req?: any, res?: any) => {
    const h = (global as any).__hermesHandler;
    const { agentId } = req.body || {};
    if (!h || !h.client) return res.json({ success: false, error: 'Hermes 未连接' });
    try {
      const result = await h.client.ping(agentId);
      res.json({ success: true, alive: result?.alive || false });
    } catch (e: any) { res.json({ success: false, error: e.message }); }
  });

  // ── OpenClaw 网关状态 ──
  app.get('/api/openclaw/status', (req?: any, res?: any) => {
    const o = (global as any).__openclawHandler;
    if (!o) return res.json({ connected: false });
    try {
      const st = typeof o.getStatus === 'function' ? o.getStatus() : {};
      res.json({ connected: o.connected || false, ...st });
    } catch (e: any) { res.json({ connected: false, error: e.message }); }
  });
  app.post('/api/openclaw/reconnect', async (req?: any, res?: any) => {
    const o = (global as any).__openclawHandler;
    if (!o) return res.json({ success: false, error: 'OpenClaw 未初始化' });
    try {
      if (typeof o.reconnect === 'function') await o.reconnect();
      else if (typeof o._ensureGatewayRunning === 'function') await o._ensureGatewayRunning();
      res.json({ success: true });
    } catch (e: any) { res.json({ success: false, error: e.message }); }
  });

  // ── 网关通信模式检测 + 可选配置（/agent/add 创建时调用）──
  const gatewaySetup = require('./core/gateway-setup');
  app.get('/api/gateway/check', (req?: any, res?: any) => {
    try { res.json(gatewaySetup.checkGateway(req.query.backend, databaseAPI)); }
    catch (e: any) { res.json({ ready: false, error: e.message }); }
  });
  app.post('/api/gateway/setup', (req?: any, res?: any) => {
    res.status(410).json({
      success: false,
      error: '请通过 Agent 注册流程查看变更计划并明确确认后再配置消息通道',
      code: 'GATEWAY_SETUP_REQUIRES_REGISTRATION_APPROVAL',
    });
  });
  app.get('/api/gateway/setup-status', (req?: any, res?: any) => {
    res.status(410).json({
      success: false,
      error: '请通过注册流程查询当前会话的配置任务',
      code: 'GATEWAY_SETUP_STATUS_REQUIRES_REGISTRATION_SESSION',
    });
  });

  // ── Gateway 转发（desktop gateway:forwardToAgent → 此端点） ──
  app.post('/api/gateway/forward', async (req?: any, res?: any) => {
    try {
      const { visitorId, message, agentId } = req.body || {};
      if (!agentId || !visitorId || !message) return res.json({ success: false, error: '缺少参数' });
      const dispatcher = (global as any).__dispatcher;
      if (!dispatcher) return res.json({ success: false, error: 'dispatcher 未初始化' });
      // 统一走 dispatcher 决策：连接就绪则 push，否则留库等 agent pull
      dispatcher.dispatch(agentId, {
        agentId, fromUid: visitorId, content: message, channelId: visitorId,
        channelType: 1, contentType: 1, messageId: '', timestamp: Math.floor(Date.now() / 1000)
      });
      res.json({ success: true });
    } catch (e: any) { res.json({ success: false, error: e.message }); }
  });

  // ── Steer 注入（desktop owner-intervention:steer-to-agent → 此端点） ──
  app.post('/api/owner-intervention/steer', async (req?: any, res?: any) => {
    try {
      const { agentId, visitorId, content } = req.body || {};
      if (!agentId || !visitorId || !content) return res.json({ success: false, error: '缺少参数' });
      const dispatcher = (global as any).__dispatcher;
      if (!dispatcher) return res.json({ success: false, error: 'dispatcher 未初始化' });
      const enriched = '[Owner Instruction] ' + content;
      // dispatcher.steer 统一构造 sessionKey + hermes 补偿 emit（在 dispatcher 内）
      const r = await dispatcher.steer(agentId, visitorId, enriched);
      res.json({ success: true, output: r?.output || '' });
    } catch (e: any) { res.json({ success: false, error: e.message }); }
  });

  // ── LLM 配置 ──
  app.get('/api/llm/config', (req?: any, res?: any) => {
    const db2 = (global as any).__db || db;
    try {
      const row = db2.prepare("SELECT data FROM config WHERE type='llm_config'").get();
      res.json({ success: true, data: row ? JSON.parse(row.data) : null });
    } catch (e: any) { res.json({ success: false, error: e.message }); }
  });

  // ── 会话操作 ──
  app.post('/api/conversations/update-mode', (req?: any, res?: any) => {
    const { channelId, agentId, mode } = req.body || {};
    if (!channelId || !agentId) return res.status(400).json({ success: false, error: '缺少 channelId 或 agentId' });
    try {
      const validModes = [null, 'MANUAL', 'AUTO'];
      if (!validModes.includes(mode)) return res.json({ success: false, error: '无效模式' });
      db.prepare(`UPDATE conversations SET mode = ? WHERE channel_id = ? AND agent_id = ?`).run(mode, channelId, agentId);
      res.json({ success: true });
    } catch (e: any) { res.json({ success: false, error: e.message }); }
  });

  // ── 会话操作 ──
  app.post('/api/conversations/save', (req?: any, res?: any) => {
    try {
      const { userUid, conversation } = req.body || {};
      const agentId = String(conversation?.agentId || conversation?.agent_id || '');
      if (!currentOwnsAgent(agentId)) return res.status(403).json({ success: false, error: '当前登录用户无权访问该 Agent' });
      databaseAPI.saveConversation(userUid, conversation);
      res.json({ success: true });
    } catch (e: any) { res.json({ success: false, error: e.message }); }
  });

  app.post('/api/conversations/delete', (req?: any, res?: any) => {
    const { channelId, agentId } = req.body || {};
    if (!channelId || !agentId) return res.status(400).json({ success: false, error: '缺少 channelId 或 agentId' });
    try {
      db.prepare(`DELETE FROM messages WHERE channel_id = ? AND agent_id = ?`).run(channelId, agentId);
      db.prepare(`DELETE FROM conversations WHERE channel_id = ? AND agent_id = ?`).run(channelId, agentId);
      res.json({ success: true });
    } catch (e: any) { res.json({ success: false, error: e.message }); }
  });

  // ── 用户缓存操作 ──
  app.post('/api/user-cache/update', (req?: any, res?: any) => {
    const { uid, nickname, avatarPath, avatarUrl } = req.body || {};
    if (!uid) return res.json({ success: false, error: '缺少 uid' });
    try {
      db.prepare(`INSERT OR REPLACE INTO user_cache (uid, nickname, avatar_path, avatar_url, updated_at) VALUES (?, ?, ?, ?, ?)`)
        .run(uid, nickname || null, avatarPath || null, avatarUrl || null, Date.now());
      res.json({ success: true });
    } catch (e: any) { res.json({ success: false, error: e.message }); }
  });

  // ── 主人介入操作 ──
  app.post('/api/owner-intervention/update-reply', (req?: any, res?: any) => {
    const { id, ownerReply, replyTime, channelType } = req.body || {};
    if (!id) return res.json({ success: false, error: '缺少 id' });
    try {
      if (!currentOwnsAgent(interventionAgentId(id))) return res.status(403).json({ success: false, error: '无权修改该介入记录' });
      const { createDatabaseAPI } = require('./core/database');
      const api = createDatabaseAPI(db);
      api.updateOwnerInterventionReply(id, ownerReply, replyTime, channelType || null);
      res.json({ success: true });
    } catch (e: any) { res.json({ success: false, error: e.message }); }
  });
  app.post('/api/owner-intervention/delete', (req?: any, res?: any) => {
    const { id } = req.body || {};
    if (!id) return res.json({ success: false, error: '缺少 id' });
    try {
      if (!currentOwnsAgent(interventionAgentId(id))) return res.status(403).json({ success: false, error: '无权删除该介入记录' });
      db.prepare('DELETE FROM owner_interventions WHERE id = ?').run(id);
      res.json({ success: true });
    } catch (e: any) { res.json({ success: false, error: e.message }); }
  });

  // ── 主人介入 upsert（Desktop 审核介入 / 渠道测试消息落库）──
  app.post('/api/owner-intervention/save', (req?: any, res?: any) => {
    try {
      const { intervention } = req.body || {};
      if (!intervention || !intervention.id) return res.json({ success: false, error: '缺少 intervention.id' });
      if (!currentOwnsAgent(String(intervention.agentId || intervention.agent_id || ''))) return res.status(403).json({ success: false, error: '无权保存该介入记录' });
      const { createDatabaseAPI } = require('./core/database');
      createDatabaseAPI(db).saveOwnerIntervention(intervention);
      res.json({ success: true, id: intervention.id });
    } catch (e: any) { res.json({ success: false, error: e.message }); }
  });

  // ── 主人介入字段更新（skip_reply / is_sent / parentMessageId 等白名单）──
  app.post('/api/owner-intervention/update', (req?: any, res?: any) => {
    try {
      const { id, fields } = req.body || {};
      if (!id) return res.json({ success: false, error: '缺少 id' });
      if (!currentOwnsAgent(interventionAgentId(id))) return res.status(403).json({ success: false, error: '无权修改该介入记录' });
      const COL_MAP: Record<string, string> = {
        skip_reply: 'skip_reply', is_sent: 'is_sent',
        parentMessageId: 'parent_message_id', parent_message_id: 'parent_message_id',
        status: 'status', ownerReply: 'owner_reply', replyTime: 'reply_time', resolvedAt: 'resolved_at',
      };
      const sets = [], vals = [];
      for (const [k, v] of Object.entries(fields || {})) {
        const col = COL_MAP[k];
        if (col) { sets.push(`${col} = ?`); vals.push(v); }
      }
      if (!sets.length) return res.json({ success: false, error: '无可更新字段' });
      sets.push('updated_at = ?'); vals.push(Date.now()); vals.push(id);
      db.prepare(`UPDATE owner_interventions SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      res.json({ success: true });
    } catch (e: any) { res.json({ success: false, error: e.message }); }
  });

  // ── 通用配置读写（channel_config / llm_config / model 等，对应 databaseAPI.saveConfigToDb）──
  app.post('/api/config/save', (req?: any, res?: any) => {
    try {
      const { type, data } = req.body || {};
      if (data === undefined) return res.json({ success: false, error: '缺少 data' });
      const configType = String(type || 'channel_config').trim();
      if (!isAllowedBridgeConfigType(configType)) {
        return res.status(400).json({ success: false, error: '不支持写入该配置类型' });
      }
      const normalizedData = configType === 'model' && data?.baseUrl
        ? { ...data, baseUrl: assertSecureEndpoint(data.baseUrl, 'http') }
        : data;
      db.prepare('INSERT OR REPLACE INTO config (type, data, updated_at) VALUES (?, ?, ?)')
        .run(configType, JSON.stringify(normalizedData), Date.now());
      res.json({ success: true });
    } catch (e: any) { res.json({ success: false, error: e.message }); }
  });

  app.post('/api/config/delete', (req?: any, res?: any) => {
    try {
      const { type } = req.body || {};
      if (!type) return res.json({ success: false, error: '缺少 type' });
      const configType = String(type).trim();
      if (!isAllowedBridgeConfigType(configType)) {
        return res.status(400).json({ success: false, error: '不支持删除该配置类型' });
      }
      db.prepare('DELETE FROM config WHERE type = ?').run(configType);
      res.json({ success: true });
    } catch (e: any) { res.json({ success: false, error: e.message }); }
  });

  // ── Agent 缓存（agent_cache config 行，对应 databaseAPI.saveAgentCache）──
  app.post('/api/agent/cache-save', (req?: any, res?: any) => {
    try {
      const { data } = req.body || {};
      if (data === undefined) return res.json({ success: false, error: '缺少 data' });
      db.prepare('INSERT OR REPLACE INTO config (type, data, updated_at) VALUES (?, ?, ?)')
        .run('agent_cache', JSON.stringify(data), Date.now());
      res.json({ success: true });
    } catch (e: any) { res.json({ success: false, error: e.message }); }
  });

  // ── Agent 注册写入 agents 表（Desktop 只读 DB 经此写入）──
  app.post('/api/agent/register-in-db', (req?: any, res?: any) => {
    try {
      const { registerAgentInDbOnDb } = require('./core/agent-registration');
      const body = req.body || {};
      const result = registerAgentInDbOnDb(db, body);
      res.json(result);

      // 注册成功后异步启动 Worker（与 MCP Step 4 一致）
      if (result.success !== false && body.agentId && body.uid && body.token) {
        const { agentId, uid, token, serverUrl, backendType } = body;
        setImmediate(() => {
          try {
            agentManager.start(agentId, { uid, token, serverUrl, backendType: normalizeBackendType(backendType) });
          } catch (e: any) {
            console.error('[Lite] 注册后启动 Worker 失败:', agentId, e.message);
          }
        });
      }
    } catch (e: any) { res.json({ success: false, error: e.message }); }
  });

  // ── Agent 绑定字段更新（snake_case updates，与 agent-registration.updateAgentBinding 一致）──
  app.post('/api/agent/update-binding-fields', async (req?: any, res?: any) => {
    try {
      const { updateAgentBindingOnDb } = require('./core/agent-registration');
      const { agentId, updates } = req.body || {};
      if (!agentId) return res.json({ success: false, error: '缺少 agentId' });
      const allowed = new Set(['backend_type', 'backend_instance_id', 'delivery_modes', 'agent_name', 'category', 'description', 'access_mode']);
      const safeUpdates = Object.fromEntries(Object.entries(updates || {}).filter(([key]) => allowed.has(key)));
      const result = updateAgentBindingOnDb(db, { agentId, updates: safeUpdates });
      if (result.success !== false) try {
        const backendType = String(safeUpdates.backend_type || db.prepare('SELECT backend_type FROM agents WHERE agent_id=?').get(agentId)?.backend_type || '');
        await (global as any).__dispatcher?.ensureBackend?.(backendType);
        (global as any).__dispatcher?.invalidateMeta?.(agentId);
      } catch (_: any) {}
      res.json(result);
    } catch (e: any) { res.json({ success: false, error: e.message }); }
  });

  // ── 能力同步到远程服务器（从 DB 读取 ability/capability，无需 MCP ability 参数）──
  app.post('/api/agent/register-capabilities', async (req?: any, res?: any) => {
    try {
      const { agentId } = req.body || {};
      if (!agentId) return res.json({ success: false, error: '缺少 agentId' });
      const { registerCapabilitiesForAgent } = require('./core/register-capabilities');
      const result = await registerCapabilitiesForAgent({ db, agentId });
      res.json(result);
    } catch (e: any) { res.json({ success: false, error: e.message }); }
  });

  // ── Agent 绑定更新（imUid/imToken/did/keys 等，对应 ipc/agent.js connect 的本地 UPDATE）──
  app.post('/api/agent/update-binding', async (req?: any, res?: any) => {
    try {
      const d = req.body || {};
      const { agentId } = d;
      if (!agentId) return res.json({ success: false, error: '缺少 agentId' });
      const F = {
        backend_type: d.backendType === undefined ? undefined : normalizeBackendType(d.backendType),
        backend_instance_id: d.instanceId,
        delivery_modes: d.deliveryModes === undefined ? undefined : JSON.stringify(Array.isArray(d.deliveryModes) ? d.deliveryModes : []),
        agent_name: d.agentName,
        category: d.category,
      };
      const sets = [], vals = [];
      for (const [k, v] of Object.entries(F)) {
        if (v !== undefined) { sets.push(`${k} = ?`); vals.push(v); }
      }
      if (sets.length) {
        vals.push(agentId);
        db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE agent_id = ?`).run(...vals);
        try {
          await (global as any).__dispatcher?.ensureBackend?.(F.backend_type || db.prepare('SELECT backend_type FROM agents WHERE agent_id=?').get(agentId)?.backend_type);
          (global as any).__dispatcher?.invalidateMeta?.(agentId);
        } catch (_: any) {}
      }
      res.json({ success: true });
    } catch (e: any) { res.json({ success: false, error: e.message }); }
  });
  // ── Agent 发布/下架（Desktop connect/disconnect 经此；在 Lite 可写上下文跑 publishAgent，避免只读 DB 写失败）──
  app.post('/api/agent/publish', async (req?: any, res?: any) => {
    try {
      const { agentId } = req.body || {};
      if (!agentId) return res.json({ success: false, error: '缺少 agentId' });
      const { publishAgent } = require('./core/publish-agent');
      const { registerCapabilitiesForAgent } = require('./core/register-capabilities');
      const { updateAgentProfile } = require('./core/update-agent-profile');
      const { setAgentStatus } = require('./core/set-agent-status');
      const result = await publishAgent({
        db, agentId,
        startAgentWorker: (id?: any, cfg?: any) => agentManager.start(id, cfg),
        stopAgentWorker: (id?: any) => agentManager.stop(id),
        registerCapabilities: (id?: any) => registerCapabilitiesForAgent({ db, agentId: id }),
        updateAgentProfile: (params?: any) => updateAgentProfile({ db, ...params }),
        setAgentStatus: (params?: any) => setAgentStatus({ db, ...params }),
        endpoints: require('./endpoints.json'),
      });
      if (result?.success !== false) {
        const backendType = db.prepare('SELECT backend_type FROM agents WHERE agent_id=?').get(agentId)?.backend_type;
        await (global as any).__dispatcher?.ensureBackend?.(backendType);
        (global as any).__dispatcher?.invalidateMeta?.(agentId);
      }
      res.json(result);
    } catch (e: any) { res.json({ success: false, error: e.message }); }
  });

  app.post('/api/agent/unpublish', async (req?: any, res?: any) => {
    try {
      const { agentId } = req.body || {};
      if (!agentId) return res.json({ success: false, error: '缺少 agentId' });
      const { unpublishAgent } = require('./core/publish-agent');
      const { setAgentStatus } = require('./core/set-agent-status');
      const result = await unpublishAgent({
        db, agentId,
        stopAgentWorker: (id?: any) => agentManager.stop(id),
        setAgentStatus: (params?: any) => setAgentStatus({ db, ...params }),
      });
      res.json(result);
    } catch (e: any) { res.json({ success: false, error: e.message }); }
  });

  // ── 重启 Agent 运行环境（切换用户后）──
  app.post('/api/agents/restart', async (req?: any, res?: any) => {
    try {
      const email = getCurrentUserEmail(db);
      if (!email) return res.json({ success: false, error: '未登录' });
      // 1. 停止所有 worker
      await agentManager.stopAll();
      // 2. 查当前用户已发布 agent
      const agents = db.prepare(
        "SELECT * FROM agents WHERE publish_status = 'published' AND owner_email = ?"
      ).all(email);
      // 3. 逐个启动
      await agentManager.startMany(agents.map((a: any) => ({
        agentId: a.agent_id,
        config: { uid: a.imUid, token: a.imToken, serverUrl: a.im_server_url },
      })));
      // 4. 立刻写 runtime
      const agentList = agents.map((a: any) => ({
        agentId: a.agent_id, agentName: a.agent_name || a.agent_id,
        imConnected: false, backendConnected: false,
      }));
      db.prepare("INSERT OR REPLACE INTO config (type, data, updated_at) VALUES ('runtime', ?, ?)")
        .run(JSON.stringify({
          instanceId: __instanceLock?.metadata?.instanceId,
          pid: process.pid,
          ts: Date.now(),
          port: __runtimePort || 3100,
          userEmail: email,
          agents: agentList,
        }), Date.now());
      // 通知 desktop 等监听方：用户已切换，刷新各自的数据过滤范围
      try { require('./core/lite-bus').emit('user:switched', { email }); } catch (_: any) {}
      res.json({ success: true, count: agents.length });
    } catch (e: any) { res.json({ success: false, error: e.message }); }
  });

  // ── payment_auth 写（Desktop saveAuth/receiverApply 经此；Desktop 只读 DB 不可写）──
  // mode='insert' 新建（自动补 status/created_at），mode='update' 按 id 更新传入字段
  // 字段白名单：禁止把任意列名拼进 SQL（防 SQL 注入，SEC-11）
  const ALLOWED_AUTH_FIELDS = new Set([
    'name', 'id_card', 'bank_card', 'phone', 'status',
    'receiver_type', 'bank_code', 'bank_name',
    'company_name', 'unified_social_credit_code',
    'legal_name', 'legal_licence_no',
    'request_no', 'receiver_no',
    'receiver_apply_status', 'receiver_sign_status', 'receiver_sign_url', 'merchant_sign_url',
    'payment_user_uid',
  ]);
  app.post('/api/payment/write-auth', (req?: any, res?: any) => {
    try {
      const { id, fields, mode } = req.body || {};
      const ownerEmail = String(getCurrentUserEmail(db) || '').trim().toLowerCase();
      if (!ownerEmail) return res.status(403).json({ success: false, error: '未登录' });
      const now = Date.now();
      const cols = Object.keys(fields || {}).filter((k: any) => ALLOWED_AUTH_FIELDS.has(k));
      if (mode === 'insert') {
        const allCols = ['id', 'owner_email', ...cols, 'status', 'created_at', 'updated_at'];
        const allVals = [id, ownerEmail, ...cols.map((k?: any) => fields[k]), 'unverified', now, now];
        db.prepare(`INSERT INTO payment_auth (${allCols.join(', ')}) VALUES (${allCols.map(() => '?').join(', ')})`).run(...allVals);
      } else {
        if (!id) return res.json({ success: false, error: '缺少 id' });
        if (!cols.length) return res.json({ success: false, error: '缺少 fields' });
        const sets = cols.map((k?: any) => `${k} = ?`);
        const vals = [...cols.map((k?: any) => fields[k]), now, id];
        vals.push(ownerEmail);
        db.prepare(`UPDATE payment_auth SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND LOWER(TRIM(owner_email))=?`).run(...vals);
      }
      res.json({ success: true, id });
    } catch (e: any) { res.json({ success: false, error: e.message }); }
  });

  // ── 支付操作 ──
  app.post('/api/payment/submit', (req?: any, res?: any) => {
    const { agentId, visitorId, amount, description, type } = req.body || {};
    if (!agentId || !visitorId || !amount) return res.json({ success: false, error: '缺少必填参数' });
    try {
      const hasAuth = db.prepare('SELECT pa.* FROM payment_auth pa JOIN agents a ON pa.id = a.payment_auth_id WHERE a.agent_id=?').get(agentId);
      if (!hasAuth) return res.json({ success: false, error: '该 Agent 未配置支付认证' });
      const now = Date.now();
      const id = 'po_' + now + '_' + Math.random().toString(36).substr(2, 8);
      const fromUid = db.prepare('SELECT imUid FROM agents WHERE agent_id=?').get(agentId)?.imUid || '';
      db.prepare(`INSERT INTO payment_orders (id, agent_id, visitor_id, from_uid, amount, description, type, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        id, agentId, visitorId, fromUid, parseFloat(amount), description || '', type || 'service', 'pending', now, now
      );
      res.json({ success: true, message: '支付请求已提交', id });
    } catch (e: any) { res.json({ success: false, error: e.message }); }
  });

  // ── Agent 文件操作 ──
  app.get("/api/agent/detail", (req?: any, res?: any) => {
    const mgr = (global as any).__agentManager;
    const { agentId } = req.query;
    if (!mgr || !agentId) return res.json(null);
    try { res.json(mgr.getAgentDetail(agentId)); }
    catch (e: any) { res.json(null); }
  });
  // agent workspace 文件读写（独立模块，不再依赖 (global as any).__agentManager——后者实为 AgentWorkerManager）
  const agentFiles = require('./core/agent-files');
  app.get('/api/agent/files', (req?: any, res?: any) => {
    const { agentId } = req.query;
    if (!agentId) return res.json({ success: false, error: '缺少 agentId' });
    try {
      res.json({ success: true, data: agentFiles.getAgentFiles(agentId) });
    } catch (e: any) { res.json({ success: false, error: e.message }); }
  });
  app.get('/api/agent/file', (req?: any, res?: any) => {
    const { agentId, filename } = req.query;
    if (!agentId || !filename) return res.json({ success: false, error: '缺少参数' });
    try {
      res.json({ success: true, data: agentFiles.readFile(agentId, filename) });
    } catch (e: any) { res.json({ success: false, error: e.message }); }
  });
  app.post('/api/agent/file', (req?: any, res?: any) => {
    const { agentId, filename, content } = req.body || {};
    if (!agentId || !filename || content === undefined) return res.json({ success: false, error: '缺少参数' });
    try {
      agentFiles.writeFile(agentId, filename, content);
      res.json({ success: true });
    } catch (e: any) { res.json({ success: false, error: e.message }); }
  });

  app.post('/api/simulate-message', (req?: any, res?: any) => {
    try {
      const { fromUid, toUid, content, agentId } = req.body;
      if (!fromUid || !toUid || !content || !agentId) {
        return res.status(400).json({ success: false, error: '缺少参数: fromUid, toUid, content, agentId' });
      }
      const now = Math.floor(Date.now() / 1000);
      const msgId = `sim_${agentId}_${Date.now()}`;
      databaseAPI.saveMessage({
        id: msgId, channelId: fromUid, channelType: 1,
        fromUid, toUid, agentId, content, timestamp: now,
        isMe: false, status: 'received',
        messageSeq: null, clientMsgNo: null,
        contentType: 1,
      });
      res.json({ success: true, messageId: msgId, note: '已写入 DB（Lite 模式，不触发 agent 处理）' });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // Agent 出站消息发送（desktop agent-wukongim:sendMessage → 此端点）
  app.post('/api/message/send', async (req?: any, res?: any) => {
    try {
      const { agentId, channelId, content, fromUid, messageType } = req.body || {};
      if (!agentId || !channelId || !content) {
        return res.json({ success: false, error: '缺少参数: agentId, channelId, content' });
      }
      // 统一发送：落库 + 会话更新 + 共享 Hub 投递
      res.json(await agentManager.sendImMessage(agentId, channelId, content, fromUid, messageType));
    } catch (e: any) {
      res.json({ success: false, error: e.message });
    }
  });

  // 插入系统消息（desktop db:insertSystemMessage → 此端点，content_type=10）
  app.post('/api/messages/insert-system', (req?: any, res?: any) => {
    try {
      databaseAPI.insertSystemMessage(req.body || {});
      res.json({ success: true });
    } catch (e: any) { res.json({ success: false, error: e.message }); }
  });

  // 退出清理
  process.on('SIGINT', () => shutdownAll(agentManager, wukongimSender, db, 'SIGINT'));
  process.on('SIGTERM', () => shutdownAll(agentManager, wukongimSender, db, 'SIGTERM'));
  if (process.platform === 'win32') {
    process.on('SIGBREAK', () => shutdownAll(agentManager, wukongimSender, db, 'SIGBREAK'));
  } else {
    process.on('SIGHUP', () => shutdownAll(agentManager, wukongimSender, db, 'SIGHUP'));
  }
  process.on('disconnect', () => shutdownAll(agentManager, wukongimSender, db, 'disconnect'));

  // 父进程生命周期由外部管理，Lite 不主动轮询 ppid（detached 后 ppid 不可靠，
  // 且独立 CLI 启动时 CLI 父进程会立即 exit，轮询会导致误判自杀）：
  //   - Desktop 正常退出 → shutdown() 发 /api/quit；Desktop 崩溃 → 上面 fork 的 IPC 'disconnect' 兜底
  //   - `voko` / `voko start` 独立启动 → 由 `voko stop` 管理

  process.on('exit', () => {
    try { agentManager?.killAll?.(); } catch {}
    try { if (db?.open) db.close(); } catch (_: any) {}
    try { __instanceLock?.release(); } catch {}
  });

  // ── OSS 签名（前端直传 OSS，对应 renderer 的 uploadAndSendFile） ──
  app.post('/api/oss-signature', (req?: any, res?: any) => {
    try {
      const { filename, dir, contentType } = req.body || {};
      if (!filename) return res.json({ success: true }); // CLI 连通性测试（空 body）
      const objectName = `${dir || 'chat/files'}/${filename}`;
      res.json({ success: true, data: generateOSSSignature(objectName, contentType) });
    } catch (e: any) { res.json({ success: false, error: e.message }); }
  });

  // ── WebSocket 服务器（事件推送） ──
  const WebSocket = require('ws');
  let _wss: any = null;
  const _eventWsClients = new Set<any>();
  function broadcast(event?: any, data?: any) {
    const msg = JSON.stringify({ event, data });
    for (const client of _eventWsClients) {
      if (client.readyState === WebSocket.OPEN) {
        try { client.send(msg); } catch (_: any) {}
      }
    }
  }
  // 将 broadcast 挂在全局，供其他模块调用
  (global as any).__liteBroadcast = broadcast;

  // 桥接 lite-bus 事件 → WebSocket
  const bus = require('./core/lite-bus');
  const WS_EVENTS = ['app:quit', 'agent-wukongim:message', 'agent-wukongim:status', 'agent-wukongim:sent',
    'owner-intervention:new', 'owner-intervention:email-reply',
    'owner-intervention:updated', 'channels:test-success',
    'wechat:session-expired', 'owner-reply', 'voko:notification', 'user:switched'];
  for (const evt of WS_EVENTS) {
    bus.on(evt, (data?: any) => broadcast(evt, data));
  }

  {
    const server = app.listen(port, '127.0.0.1')
      .on('listening', () => {
        const actualPort = server.address().port;
        __runtimePort = actualPort;
        __httpServer = server;
        __serviceHealth = 'ok';
        __instanceLock?.updatePort(actualPort);
        try {
          const prev = db.prepare("SELECT data FROM config WHERE type = 'runtime'").get();
          const data = prev ? JSON.parse(prev.data) : {};
          data.instanceId = __instanceLock?.metadata?.instanceId;
          data.pid = process.pid;
          data.port = actualPort;
          db.prepare("INSERT OR REPLACE INTO config (type, data, updated_at) VALUES ('runtime', ?, ?)")
            .run(JSON.stringify(data), Date.now());
        } catch (_: any) {}
        if (process.env.VOKO_SMOKE_TEST === '1' && process.env.VOKO_TEST_FATAL_MODE) {
          const mode = process.env.VOKO_TEST_FATAL_MODE;
          setImmediate(() => {
            if (mode === 'unhandledRejection') {
              void Promise.reject(new Error('VOKO_TEST_FATAL_UNHANDLED_REJECTION'));
            } else if (mode === 'uncaughtException') {
              throw new Error('VOKO_TEST_FATAL_UNCAUGHT_EXCEPTION');
            }
          });
        }
        // 由 Desktop fork 启动时（process.send 存在），把实际端口通知父进程
        if (typeof process.send === 'function') {
          try { process.send({ type: 'voko:listening', port: actualPort }); } catch (_: any) {}
        }
        // 在 HTTP server 上附加 WebSocket
        _wss = new WebSocket.Server({ server });
        __webSocketServer = _wss;
        _wss.on('connection', (ws?: any, req?: any) => {
          const requestPath = String(req.url || '').split('?', 1)[0];
          if (requestPath === '/ws') {
            if (!isAllowedLocalWebSocketOrigin(req.headers.origin, req.headers.host)) {
              ws.close(4001, 'Unauthorized');
              return;
            }
            _eventWsClients.add(ws);
            const remove = () => _eventWsClients.delete(ws);
            ws.on('close', remove);
            ws.on('error', remove);
            return;
          }
          if (requestPath !== '/voko/events/ws') {
            ws.close(4004, 'Unknown WebSocket endpoint');
          }
        });
        // Console 实时 WS — 依附在已有 _wss 上，按路径 /voko/events/ws 路由
        const { createLiveEventsWs } = require('./web/live-events-ws');
        const consoleWs = createLiveEventsWs(_wss, runtimeState, taskManager);
        __consoleLiveEvents = consoleWs;
        taskManager?.subscribe?.((tasks: object[]) => {
          const message = JSON.stringify({ type: 'tasks', data: tasks });
          for (const ws of consoleWs.clients) {
            try { ws.send(message); } catch {}
          }
        });
        // RuntimeState 变更时广播到 WS 客户端
        if (runtimeState) {
          const { getHistory } = require('./core/lite-events');
          const { query } = require('./core/audit-log');
          runtimeState.subscribe((agents?: any) => {
            const msg = JSON.stringify({ type: 'snapshot', data: {
              agents, summary: runtimeState.summary(),
              tasks: taskManager?.snapshot?.() || [],
              recentEvents: getHistory(null, null, 100),
              recentAudit: query({ limit: 50 }),
            }});
            for (const ws of consoleWs.clients) {
              try { ws.send(msg); } catch {}
            }
          });
        }
        // 默认打开本地管理页面；自动化和无界面环境可传 --no-open。
        if (!args.noOpen && !args['no-open'] && process.env.VOKO_SMOKE_TEST !== '1') {
          printReadyBanner(db, actualPort, getCurrentUserEmail(db), agentManager);
          openLocalWebPage(port);
        } else {
          printReadyBanner(db, actualPort, getCurrentUserEmail(db), agentManager);
        }
      })
      .on('error', (err?: any) => {
        console.error(t('cli.index.port_start_failed', { port, msg: err.message }));
        __instanceLock?.release();
        process.exit(1);
      });
  }
}

async function startMcpServer(args?: any, core?: any) {
  const { db, databaseAPI, agentRegistration, agentManager, deliver, wukongimSender, sendMessage } = core;
  const { TaskManager } = require('./core/task-manager');
  const taskManager = new TaskManager();
  __shutdownContext = { agentManager, wukongimSender, db, taskManager };
  const userEmail = getCurrentUserEmail(db);
  const litePort = parseInt(args.port, 10) || 3100;

  // ── 初始化文件日志（写入 voko-im.log，仅首次生效） ──
  if (!(global as any).__vokoFileLoggerStarted) { (global as any).__vokoFileLoggerStarted = true; _initFileLogger(); }

  // ── 从 DB 加载 OSS 凭证（与 Desktop main.js 一致，供 /api/oss-signature 端点使用） ──
  const _ossRow = db.prepare("SELECT data FROM config WHERE type = ?").get('oss_config');
  if (_ossRow) {
    initOSSFromConfig({ oss_config: JSON.parse(_ossRow.data) });
  } else {
    initOSSFromConfig(databaseAPI.getChannelConfig());
  }

  // 初始化消息通知模块（lite 进程：_mainWindow=null → 总 emit voko:notification 经 WebSocket 给 desktop）
  notifier.init(null, db);

  const orphanResult = cleanupOrphanedWorkers(db._dbPath);
  if (orphanResult.killed.length > 0) {
    console.error(`[Lite] 已精确清理 ${orphanResult.killed.length} 个孤儿 worker`);
  }

  // ── 自动恢复已发布的 agent（仅当前用户名下） ──
  if (!userEmail) {
    console.error(t('cli.index.login_required', { port: parseInt(args.port, 10) || 3100 }));
    if (!hasGraphicalSession()) {
      printHeadlessLoginGuidance(litePort);
    }
  }
  const published = userEmail
    ? db.prepare("SELECT * FROM agents WHERE publish_status = 'published' AND owner_email = ?").all(userEmail)
    : db.prepare("SELECT * FROM agents WHERE publish_status = 'published'").all();
  const publishedAgentCount = published.length;
  const startupResults = await agentManager.startMany(published.map((agent: any) => ({
    agentId: agent.agent_id,
    config: { uid: agent.imUid, token: agent.imToken, serverUrl: agent.im_server_url },
  })));
  const startupConnected = startupResults.filter((result: any) => result.connected).length;
  if (publishedAgentCount > 0) console.error(`[VOKO Lite] 已启动 ${startupConnected}/${publishedAgentCount} 个 Agent IM 连接`);

  // ── 版本检查（异步，不阻塞） ──
  checkVersionAndPersist(db);

  // ── 创建后端处理器（OpenClaw + Hermes） ──
  let openclawHandler = null;
  let hermesHandler = null;
  let messageHandler: any = null;
  let dispatcher: any = null;
  try {
    const hc = databaseAPI.getConfigFromDb('hermes_config') || {};
    const hcResult = createHandlers({
      db,
      databaseAPI,
      openclawMode: 'ws',
      backendTypes: published.map((agent: any) => agent.backend_type || 'openclaw'),
      hermesConfig: { apiHost: hc.apiHost, apiPort: hc.apiPort, apiKey: hc.apiKey, profiles: hc.profiles || {} },
      onAgentReply: (data?: any) => {
        void messageHandler?.handleAgentReply(data)?.catch((error: any) => {
          console.error('[Agent回复] 处理失败:', error.message);
        });
      },
    });
    openclawHandler = hcResult.openclawHandler;
    hermesHandler = hcResult.hermesHandler;
    dispatcher = hcResult.dispatcher;
  } catch (e: any) {
    console.error('[Lite] 创建后端处理器失败:', e.message);
  }

  let ownerInterventionNotifier: any = null; // 在后面创建，供 callback 闭包引用

  // ── 创建 MessageHandler（消息转发/审核/计费） ──
  try {
    const audit = require('./core/audit');
    // 访问控制：包装 access-control-api 纯函数，使独立 Lite 下黑名单/白名单/private 模式同样生效
    const acApi = require('./core/access-control-api');
    const ac: AccessControlLike = {
      isBlacklisted: (database, agentId, visitorId) => acApi.isBlacklisted(database, agentId, visitorId),
      isWhitelisted: (database, agentId, visitorId) => acApi.isWhitelisted(database, agentId, visitorId),
      addEntry: (database, entry) => acApi.addEntry(database, entry),
      autoApproveIfFriendRequest: (database, sendSystemMessage, intervention, ownerReply) =>
        acApi.autoApproveIfFriendRequest(database, sendSystemMessage, intervention, ownerReply),
    };
    messageHandler = createMessageHandler(db, {
      databaseAPI,
      agentWorkers: agentManager.workers,
      deliver,
      ac,
      sendSystemMessage: (...a: any) => agentManager.sendSystemMessage(...a),
      checkAuditRules: (msg?: any, dir?: any) => audit.checkAuditRules(msg, dir, db),
      substitutePromptVariables: (p?: any, vars?: any) => audit.substitutePromptVariables(p, vars, db),
      notifyUI: (event?: any, data?: any) => {
        const bus = require('./core/lite-bus');
        if (event === 'agent-wukongim:message') bus.emit('agent-wukongim:message', data);
      },
      enqueueIntervention: (record?: any) => {
        if (ownerInterventionNotifier) ownerInterventionNotifier.enqueue(record);
        const bus = require('./core/lite-bus');
        bus.emit('owner-intervention:new');
      },
      createPendingPayment: () => {},
      onOwnerInterventionNew: () => { const bus = require('./core/lite-bus'); bus.emit('owner-intervention:new'); },
    });
    messageHandler?.setDispatcher(dispatcher);
  } catch (e: any) {
    console.error('[Lite] 创建 MessageHandler 失败:', e.message);
  }

  // ── 接管 IM Hub 事件：主消息持久化后才向服务端 ACK ──
  agentManager.on('message', (msg?: any) => {
    const data = msg?.data || msg;
    try {
      if (messageHandler) {
        messageHandler.handleAgentMessage(msg.agentId, data);
      } else {
        // 兜底：只存不转发；写入失败必须进入 NACK。
        const d = msg.data || msg;
        databaseAPI.saveMessage({
          id: d.messageId || `wk-${msg.agentId}-${Date.now()}`,
          channelId: d.channelId, channelType: d.channelType || 1,
          fromUid: d.fromUid, toUid: d.toUid || msg.agentId, agentId: msg.agentId,
          content: d.content || '', timestamp: d.timestamp || Math.floor(Date.now() / 1000),
          isMe: false, status: 'received', messageSeq: d.messageSeq,
          clientMsgNo: d.clientMsgNo, contentType: d.contentType || 1,
        });
      }
      data?.ack?.();
    } catch (e: any) {
      console.error('[VOKO Lite] 消息处理失败，已 NACK:', e.message);
      data?.nack?.(e);
    }
  });

  // ── 接管 sent 事件：更新 Agent 回复的 message_seq（防离线同步全量重拉） ──
  agentManager.on('sent', (msg?: any) => {
    if (msg.success && msg.localMsgId) {
      try {
        const info = db.prepare(`UPDATE messages SET message_seq = COALESCE(?, message_seq), client_msg_no = COALESCE(?, client_msg_no) WHERE id = ?`)
          .run(msg.messageSeq, msg.clientMsgNo, msg.localMsgId);
        // 回填后清理「早于回填到达」的 echo received 副本（同 client_msg_no；
        // agent_id 限定防止群聊里别的 agent 的合法 received 行被误删）
        if (msg.clientMsgNo && info.changes > 0 && msg.agentId) {
          db.prepare(`DELETE FROM messages WHERE client_msg_no = ? AND status = 'received' AND agent_id = ? AND id != ?`)
            .run(msg.clientMsgNo, msg.agentId, msg.localMsgId);
        }
      } catch (e: any) { console.error('[sent] 更新失败:', e.message); }
    }
  });

  // ── 离线消息同步：Agent 连接后拉取服务端缓存消息 ──
  await taskManager.start('offline-sync', () => {
    let _offlineSyncTriggered = false;
    const _syncingAgents = new Set<string>();
    const _syncAgent = (agentId: string) => {
      if (!agentId || !messageHandler || _syncingAgents.has(agentId)) return;
      _syncingAgents.add(agentId);
      const { syncOfflineMessages: doSync } = require('./core/offline-sync');
      doSync(db, messageHandler, agentId)
        .catch((e: any) => console.error('[离线同步] Agent 失败:', agentId, e.message))
        .finally(() => _syncingAgents.delete(agentId));
    };
    const _trySync = () => {
      if (_offlineSyncTriggered) return;
      _offlineSyncTriggered = true;
      console.log('[Lite] 开始离线同步');
      const { syncOfflineMessages: doSync } = require('./core/offline-sync');
      doSync(db, messageHandler).catch((e: any) => console.error('[离线同步] 失败:', e.message));
    };
    // 每个 Agent 连接时检查是否全部就绪
    const onStatus = (msg?: any) => {
      if (msg.status === 'connected') _syncAgent(msg.agentId);
      if ((msg.status === 'connected' || msg.statusCode === 2) &&
          publishedAgentCount > 0 &&
          agentManager.connectedAgents.size >= publishedAgentCount) {
        _trySync();
      }
    };
    agentManager.on('status', onStatus);
    // 兜底：启动 30 秒后仍尝试一次
    const fallbackTimer = setTimeout(() => { _trySync(); }, 30000);
    fallbackTimer.unref?.();
    return () => {
      clearTimeout(fallbackTimer);
      agentManager.off?.('status', onStatus);
    };
  });

  // ── 将处理器挂在全局，供 startTransport 的 API 路由使用 ──
  (global as any).__openclawHandler = openclawHandler;
  (global as any).__hermesHandler = hermesHandler;
  (global as any).__dispatcher = dispatcher;
  (global as any).__agentManager = agentManager;
  (global as any).__db = db;

  // ── 创建 AgentEmailApi（供渠道和通知器使用） ──
  let _agentEmailApi = null;
  try {
    const { AgentEmailApi: EA } = require('./server/agent-email-api');
    _agentEmailApi = new EA({
      apiBaseUrl: (() => { try { return require('./endpoints.json').api.baseUrl; } catch (_: any) { return ''; } })(),
      getUserAccessToken: () => {
        try {
          const email = getCurrentUserEmail(db);
          if (!email) return null;
          const { getUserAccessToken } = require('./core/database');
          return getUserAccessToken(db, email);
        } catch (_: any) { return null; }
      },
    });
  } catch (e: any) { console.error('[Lite] AgentEmailApi 创建失败:', e.message); }

  // ── 渠道初始化 ──
  try {
    registry.initializeAllChannels({
      databaseAPI, openclawHandler, db,
      buildOwnerReplyPrompt: registry.buildOwnerReplyPrompt,
      agentEmailApi: _agentEmailApi,
      resumeOwnerIntervention: createResumeOwnerIntervention(dispatcher),
    });
  } catch (e: any) {
    console.error('[Lite] 渠道初始化失败:', e.message);
  }

  // ── 主人介入通知器 ──
  try {
    ownerInterventionNotifier = new OwnerInterventionNotifier({
      databaseAPI, registry, db,
      getEnabledChannel: databaseAPI.getEnabledChannel,
      getOpenclawHandler: () => openclawHandler,
      getHermesHandler: () => hermesHandler,
      buildOwnerReplyPrompt: registry.buildOwnerReplyPrompt,
      agentEmailApi: _agentEmailApi,
      sendSystemMessage: (...a: any) => agentManager.sendSystemMessage(...a),
      resumeOwnerIntervention: createResumeOwnerIntervention(dispatcher),
    });
    await taskManager.start('owner-intervention', () => {
      ownerInterventionNotifier.startScan();
      return () => ownerInterventionNotifier.stop();
    });
  } catch (e: any) {
    console.error('[Lite] 主人介入通知器初始化失败:', e.message);  }

  // ── 支付轮询 ──
  let stopPaymentPolling = null;
  try {
    const ENDPOINTS = require('./endpoints.json');
    await taskManager.start('payment-polling', () => {
      stopPaymentPolling = require('./core/payment').startPaymentPolling({
        db, databaseAPI,
        agentWorkers: agentManager.workers,
        deliver,
        endpoints: ENDPOINTS,
        hermesHandler, openclawHandler,
        sendSystemMessage: (...a: any) => agentManager.sendSystemMessage(...a),
        payLog: () => {},
        ownerInterventionNotifier,
      });
      return stopPaymentPolling;
    });
  } catch (e: any) {
    console.error('[Lite] 支付轮询初始化失败:', e.message);
  }

  // ── 启动心跳（带处理器引用，支持健康检查 + 网关恢复） ──
  await taskManager.start('heartbeat', () => startHeartbeat(
    db, agentManager, openclawHandler, hermesHandler,
    { port: litePort, agentCount: publishedAgentCount, dispatcher },
  ));

  // ── 启动休眠唤醒检测（定时器偏差检测，不依赖 Electron powerMonitor） ──
  const { PowerManager } = require('./core/power-manager');
  const powerManager = new PowerManager(agentManager, db);
  await taskManager.start('power-manager', () => {
    powerManager.start();
    return () => powerManager.stop();
  });

  const cx = createContext({
    db,
    databaseAPI,
    agentRegistration,
    agentManager,
    agentEmailApi: _agentEmailApi,
    deliver,
    wukongimSender,
    sendMessage,
    enqueueOwnerIntervention: (record?: any) => ownerInterventionNotifier?.enqueue(record),
  });
  await taskManager.start('agent-access-sync', () => require('./core/agent-invitations').startAgentAccessSync({
    db,
    apiBaseUrl: require('./endpoints.json').api.baseUrl,
  }));
  // 注入支付处理能力（MCP 工具创建订单后立即处理，不依赖轮询）
  const { processPendingPaymentOrder } = require('./core/payment');
  const ENDPOINTS = require('./endpoints.json');
  cx.processPaymentOrder = (order?: any) => processPendingPaymentOrder(order, {
    db, databaseAPI,
    agentWorkers: agentManager.workers,
    deliver,
    sendMessage,
    endpoints: ENDPOINTS,
    notifyUI: (type?: any, data?: any) => {
      if ((global as any).__webSocketServer) {
        (global as any).__webSocketServer.broadcast(type, data);
      }
    },
  });
  const handlers = createToolHandlers(cx);
  const mcpServer = createMcpServer(handlers, { version: pkg.version });

  // Agent 网页版
  const webSessions = createLocalWebSessionStore(db);
  const webRouter = createWebRouter(handlers, db, {
    getToolList: () => getToolList(mcpServer),
    webSessions,
    localAuthToken: process.env.VOKO_MCP_TOKEN || __instanceLock?.metadata?.mcpToken,
  });

const { RuntimeState } = require('./core/runtime-state');
  const runtimeState = new RuntimeState();
  // 从 agentManager 灌入现有 agent 状态
  if (agentManager) {
    for (const [agentId, entry] of agentManager.workers) {
      const st = agentManager.getStatus(agentId);
      runtimeState.updateAgent(agentId, {
        status: st.status || 'unknown',
        connected: st.connected,
        backendType: entry.config?.backendType || '-',
        totalMessages: 0,
      });
    }
    // 监听后续状态变更
    agentManager.on('status', (msg?: any) => {
      runtimeState.updateAgent(msg.agentId, {
        status: msg.status,
        connected: msg.status === 'connected',
      });
      // 广播到 WebSocket 客户端
      try { require('./core/lite-bus').emit('agent-wukongim:status', { agentId: msg.agentId, imConnected: msg.status === 'connected' }); } catch (_: any) {}
    });
  }
  await startTransport(
    args,
    mcpServer,
    agentManager,
    db,
    databaseAPI,
    webRouter,
    handlers,
    runtimeState,
    wukongimSender,
    taskManager,
  );
}

// ═══════════════════════════════════════════════
//  createHandlers — 创建后端处理器（OpenClaw + Hermes）
// ═══════════════════════════════════════════════

/**
 * 创建后端处理器实例，供 Desktop 调用。
 * OpenClawWSHandler / HermesHandler 的 mainWindow 参数传 null，
 * 因为两者实际不使用 mainWindow（已确认仅存储未引用）。
 *
 * @param {object} params
 * @param {object}   params.databaseAPI - 来自 createDatabaseAPI()
 * @param {string}   [params.openclawMode='ws'] - 'ws' | 'cli'
 * @param {object}   [params.hermesConfig] - { apiHost, apiPort, apiKey, profiles }
 * @param {Function} [params.onAgentReply] - callback(data) 收到 agent 回复时触发
 * @returns {{ openclawHandler: object|null, hermesHandler: object|null }}
 */
function createResumeOwnerIntervention(dispatcher?: any) {
  return async function resumeOwnerIntervention(intervention?: any, content?: any) {
    if (!dispatcher || !intervention?.agentId) return { success: false, error: 'dispatcher unavailable' };
    const channelType = Number(intervention.targetChannelType) === 2 ? 2 : 1;
    const channelId = intervention.targetChannelId || intervention.visitorId;
    const senderUid = intervention.sourceSenderUid || intervention.visitorId;
    const sessionTarget = channelType === 2 ? `group:${channelId}` : channelId;
    const senderIsAgent = channelType === 2 && dispatcher.isAgentImUid?.(senderUid) === true;
    if (senderIsAgent) {
      // 主人的明确指令优先于此前的自动收敛状态；只放行这次定向恢复，
      // 后续 Agent 间消息仍会重新进入常规 A2A 轮次与熔断保护。
      dispatcher.resetA2AForAgent?.(intervention.agentId, senderUid, `group:${channelId}`);
    }
    const result = await dispatcher.steer(intervention.agentId, sessionTarget, content, {
      channelType,
      channelId,
      senderUid,
      interventionId: intervention.id,
      interventionResume: true,
    });
    return result === null ? { success: false, error: 'agent unavailable' } : { success: true, result };
  };
}

function createHandlers({ db, databaseAPI, openclawMode = 'ws', hermesConfig = {}, onAgentReply, backendTypes, startProviders = true }: any = {}) {
  let openclawHandler = null;
  let hermesHandler = null;
  const providers: Record<string, any> = {};
  const requiredBackends: Set<string> | null = Array.isArray(backendTypes)
    ? new Set(backendTypes.map((value: unknown) => String(value || '').trim()).filter(Boolean))
    : null;
  const needsBackend = (...types: string[]) => !requiredBackends || types.some(type => requiredBackends.has(type));

  // ── OpenClaw provider（连接/spawn 收敛在 provider 内） ──
  if (needsBackend('openclaw')) try {
    const OpenClawHandler = openclawMode === 'ws'
      ? require('./core/dispatcher/providers/openclaw-ws')
      : require('./server/openclaw-handler-cli');
    openclawHandler = new OpenClawHandler(db, null); // Provider 历史恢复需要原生数据库连接
    if (openclawMode === 'ws') {
      providers['openclaw-ws'] = openclawHandler;
      const status = openclawHandler.getStatus();
      if (!status.hasToken) console.warn(t('cli.index.gateway_token_needed'));
    }
    console.error(`[Lite] OpenClaw 处理器已创建 (${openclawMode} 模式)`);
  } catch (err: any) {
    console.error('[Lite] OpenClaw 处理器创建失败:', err.message);
  }

  // ── Hermes provider（连接/spawn 收敛在 provider 内） ──
  if (needsBackend('hermes')) try {
    const HermesHandler = require('./core/dispatcher/providers/hermes-http');
    hermesHandler = new HermesHandler(db, null, { // Provider 历史恢复需要原生数据库连接
      host: hermesConfig.apiHost || '127.0.0.1',
      port: hermesConfig.apiPort || 8642,
      apiKey: hermesConfig.apiKey || '',
      profiles: hermesConfig.profiles || {},
    });
    providers['hermes-http'] = hermesHandler;
    console.error(`[Lite] Hermes 处理器已创建 host=${hermesConfig.apiHost || '127.0.0.1'}:${hermesConfig.apiPort || 8642}`);
  } catch (err: any) {
    console.error('[Lite] Hermes 处理器创建失败:', err.message);
  }

  // ── CLI / ACP provider 注册表：新增 backend 只在 PROVIDER_REGISTRY 追加一行。
  //    openclaw-ws / hermes-http 长连接因构造参数与返回值依赖特殊，仍在上方单独构造。──
  //
  //    goose 默认从 PATH 解析，也可通过 VOKO_GOOSE_BIN 指定平台对应的完整版本；
  //    Claude Code 仅走 claude-cli；ACP 模式已移除，避免安装体积巨大的 Claude Agent SDK。
  const { resolveGooseCommand } = require('./core/dispatcher/goose-command');
  const GOOSE_BIN = resolveGooseCommand();
  const PROVIDER_REGISTRY = [
    // CLI 兜底（priority=1，长连接 isAvailable=false 时降级 spawn 本地 CLI；本地未装则 isAvailable=false 自动跳过）
    { backend: ['openclaw'], key: 'openclaw-cli', mod: './core/dispatcher/providers/openclaw-cli', args: { db, contextWindow: 20 } },
    { backend: ['hermes'], key: 'hermes-cli', mod: './core/dispatcher/providers/hermes-cli', args: { db, contextWindow: 20 } },
    { backend: ['goose', 'goose-ai', 'goose-acp', 'acp-goose'], key: 'goose-cli', mod: './core/dispatcher/providers/goose-cli', args: { db, binPath: GOOSE_BIN, contextWindow: 20 } },
    // Goose ACP（stdio JSON-RPC，priority=10 与 WS/HTTP 同级；backend_type='acp-goose'）
    { backend: ['acp-goose'], key: 'goose-acp', mod: './core/dispatcher/providers/goose-acp', named: 'GooseAcpProvider', args: { binPath: GOOSE_BIN, db, contextWindow: 20 } },
    // 各 CLI runtime（priority=1，本地装了对应 CLI 才 isAvailable）
    { backend: ['claude-code'], key: 'claude-cli', mod: './core/dispatcher/providers/claude-cli', named: 'ClaudeCliProvider', args: { db, contextWindow: 20 } },
    { backend: ['codex'], key: 'codex-cli', mod: './core/dispatcher/providers/codex-cli', named: 'CodexCliProvider', args: { db, contextWindow: 20 } },
    { backend: ['gemini'], key: 'gemini-cli', mod: './core/dispatcher/providers/gemini-cli', named: 'GeminiCliProvider', args: { db, contextWindow: 20 } },
    { backend: ['cursor'], key: 'cursor-acp', mod: './core/dispatcher/providers/cursor-acp', named: 'CursorAcpProvider', args: { db, contextWindow: 20 } },
    { backend: ['cursor'], key: 'cursor-cli', mod: './core/dispatcher/providers/cursor-cli', named: 'CursorCliProvider', args: { db, contextWindow: 20 } },
    { backend: ['opencode'], key: 'opencode-acp', mod: './core/dispatcher/providers/opencode-acp', named: 'OpenCodeAcpProvider', args: { db, contextWindow: 20 } },
    { backend: ['opencode'], key: 'opencode-attach', mod: './core/dispatcher/providers/opencode-attach', named: 'OpenCodeAttachProvider', args: { db, contextWindow: 20 } },
    { backend: ['github-copilot'], key: 'github-copilot-acp', mod: './core/dispatcher/providers/github-copilot-acp', named: 'GitHubCopilotAcpProvider', args: { db, contextWindow: 20 } },
    { backend: ['zeroclaw'], key: 'zeroclaw-ws', mod: './core/dispatcher/providers/zeroclaw-ws', named: 'ZeroClawWsProvider', args: { db, contextWindow: 20 } },
    { backend: ['zeroclaw'], key: 'zeroclaw-acp', mod: './core/dispatcher/providers/zeroclaw-acp', named: 'ZeroClawAcpProvider', args: { db, contextWindow: 20 } },
    { backend: ['opencode'], key: 'opencode-cli', mod: './core/dispatcher/providers/opencode-cli', named: 'OpenCodeCliProvider', args: { db, contextWindow: 20 } },
    { backend: ['pi'], key: 'pi-cli', mod: './core/dispatcher/providers/pi-cli', named: 'PiCliProvider', args: { db, contextWindow: 20 } },
    { backend: ['qwen-code'], key: 'qwen-cli', mod: './core/dispatcher/providers/qwen-cli', named: 'QwenCliProvider', args: { db, contextWindow: 20 } },
    { backend: ['kiro'], key: 'kiro-cli', mod: './core/dispatcher/providers/kiro-cli', named: 'KiroCliProvider', args: { db, contextWindow: 20 } },
    { backend: ['aider'], key: 'aider-cli', mod: './core/dispatcher/providers/aider-cli', named: 'AiderCliProvider', args: { db, contextWindow: 20 } },
    { backend: ['grok'], key: 'grok-cli', mod: './core/dispatcher/providers/grok-cli', named: 'GrokCliProvider', args: { db, contextWindow: 20 } },
  ];
  for (const { backend, key, mod, named, args } of PROVIDER_REGISTRY) {
    if (!needsBackend(...backend)) continue;
    try {
      const M = require(mod);
      const Ctor = named ? M[named] : M;
      providers[key] = new Ctor(args);
    } catch (e: any) { console.error(`[Lite] ${key} 注册失败:`, e.message); }
  }
  // 测试模式：注册 MockEchoProvider（不依赖外部 CLI/gateway）
  if (process.env.VOKO_SMOKE_TEST === '1') {
    try {
      const { MockEchoProvider } = require('./core/dispatcher/providers/mock-echo');
      providers['mock-echo'] = new MockEchoProvider();
      console.error('[Lite] MockEchoProvider 已注册（测试模式）');
    } catch (e: any) { console.error('[Lite] mock-echo 注册失败:', e.message); }
  }

  // ── Dispatcher：统一 push/pull 决策。onAgentReply 统一接到各 provider。
  //    启动期建连 gateway 由 dispatcher.start() 触发（等价原 createHandlers 的启动 spawn）。──
  let dispatcher: any = null;
  try {
    const { createDispatcher } = require('./core/dispatcher');
    dispatcher = createDispatcher({ db, providers, onAgentReply });
    const backendLoads = new Map<string, Promise<void>>();
    dispatcher.ensureBackend = (backendType: string) => {
      const type = String(backendType || '').trim();
      if (!type) return Promise.resolve();
      if (backendLoads.has(type)) return backendLoads.get(type);
      const load = (async () => {
        const additions: Record<string, any> = {};
        if (type === 'openclaw' && !dispatcher.providers['openclaw-ws']) {
          const OpenClawHandler = require('./core/dispatcher/providers/openclaw-ws');
          openclawHandler = new OpenClawHandler(db, null);
          additions['openclaw-ws'] = openclawHandler;
          (global as any).__openclawHandler = openclawHandler;
        }
        if (type === 'hermes' && !dispatcher.providers['hermes-http']) {
          const HermesHandler = require('./core/dispatcher/providers/hermes-http');
          hermesHandler = new HermesHandler(db, null, {
            host: hermesConfig.apiHost || '127.0.0.1',
            port: hermesConfig.apiPort || 8642,
            apiKey: hermesConfig.apiKey || '',
            profiles: hermesConfig.profiles || {},
          });
          additions['hermes-http'] = hermesHandler;
          (global as any).__hermesHandler = hermesHandler;
        }
        for (const { backend, key, mod, named, args } of PROVIDER_REGISTRY) {
          if (!backend.includes(type) || dispatcher.providers[key] || additions[key]) continue;
          const M = require(mod);
          const Ctor = named ? M[named] : M;
          additions[key] = new Ctor(args);
        }
        await dispatcher.addProviders(additions);
        dispatcher.invalidateMeta();
      })().catch((error: any) => {
        backendLoads.delete(type);
        throw error;
      });
      backendLoads.set(type, load);
      return load;
    };
    if (startProviders) dispatcher.start().catch((e: any) => console.error('[Lite] dispatcher.start 失败:', e.message));
  } catch (e: any) {
    console.error('[Lite] dispatcher 创建失败:', e.message);
  }

  return { openclawHandler, hermesHandler, dispatcher };
}

// ═══════════════════════════════════════════════
//  createMessageHandler — 创建消息处理器
// ═══════════════════════════════════════════════

/**
 * 创建 MessageHandler 实例。
 * MessageHandler 本身在 packages/lite/src/core/messenger.js，纯 Node.js 无 Electron 依赖。
 * Desktop 通过 params 注入回调（notifyUI、enqueueIntervention 等）。
 *
 * @param {object} db - node:sqlite DatabaseSync 实例
 * @param {object} params - 与 MessageHandler 构造器 options 一致
 * @returns {object} MessageHandler 实例
 */
function createMessageHandler(db?: any, params?: any) {
  const { MessageHandler } = require('./core/messenger');
  return new MessageHandler(db, params);
}

// ═══════════════════════════════════════════════
//  createLiteApp — 程序化入口，供 Desktop 和外部调用
// ═══════════════════════════════════════════════

/**
 * 创建 Lite 应用实例（清孤儿 → 初始化 DB → 自动恢复 worker → 按需创建处理器/消息处理/心跳）
 *
 * @param {object} [options]
 * @param {string} [options.dbPath] - 数据库路径，默认自动检测
 * @param {boolean} [options.autoStartWorkers] - 是否自动恢复 worker，默认 true
 * @param {object} [options.appPaths] - Electron 打包路径（isPackaged/resourcesPath/userDataPath），
 *                                      仅 Desktop 传入，纯 Node.js 环境不需要
 * @param {object} [options.handlers] - 后端处理器配置（传入则自动创建 OpenClaw + Hermes）
 * @param {string} [options.handlers.openclawMode='ws']
 * @param {object} [options.handlers.hermesConfig]
 * @param {Function} [options.handlers.onAgentReply] - agent.reply 回调
 * @param {object} [options.messageHandler] - MessageHandler 配置（传入则自动创建）
 * @param {object} [options.messageHandler.callbacks] - notifyUI/enqueueIntervention 等回调
 * @param {object} [options.messageHandler.ac] - access-control 模块
 * @param {object} [options.heartbeat] - 心跳配置（传入则自动启动）
 * @param {Function} [options.heartbeat.onWarnings] - 警告回调
 * @returns {Promise<{
 *   db, databaseAPI, agentManager, agentRegistration,
 *   openclawHandler, hermesHandler, messageHandler,
 *   stopHeartbeat: Function,
 *   dispose: Function
 * }>}
 */
async function createLiteApp(options: any = {}) {
  const dbPath = options.dbPath || resolveDbPath({});
  const { TaskManager } = require('./core/task-manager');
  const taskManager = new TaskManager();

  // ── 初始化文件日志（写入 voko-im.log，仅首次生效） ──
  if (!(global as any).__vokoFileLoggerStarted) { (global as any).__vokoFileLoggerStarted = true; _initFileLogger(); }

  // ── 最优先检测：是否有另一个 Lite 在运行 ──
  const _liteDetected = checkLiteRunning(dbPath);

  const db = initDatabase(dbPath);
  const databaseAPI = createDatabaseAPI(db);
  const agentRegistration = createAgentRegistration({ db });
  const agentManager = new AgentWorkerManager(db, {
    dbPath,
    instance: options.instance || null,
  });
  // 兼容旧依赖字段名；实际发送由共享 Hub 管理器完成。
  const wukongimSender = agentManager;
  const deliver = createDeliver({ transportManager: agentManager });
  const sendMessage = createSendMessage({ db, deliver, agentWorkers: agentManager.workers, mainWindow: null });
  agentManager.setDeliver(deliver);
  agentManager.sendImMessage = sendMessage;

  if (_liteDetected) {
    console.error(t('cli.index.another_instance'));
    return {
      db, databaseAPI, agentManager, agentRegistration,
      openclawHandler: null, hermesHandler: null, messageHandler: null,
      currentUserEmail: getCurrentUserEmail(db),
      _liteDetected: true,
      stopHeartbeat: () => {},
      dispose: () => shutdownAll(agentManager, wukongimSender, db, 'dispose'),
    };
  }

  cleanupOrphanedWorkers(dbPath);

  // ── 读取当前登录用户邮箱 ──
  const currentUserEmail = getCurrentUserEmail(db);
  if (currentUserEmail) {
    console.error(`[Auth] 当前登录用户: ${currentUserEmail}`);
  } else {
    console.error(t('cli.index.login_required', { port: options.port || 3100 }));
  }
  let stopAgentAccessSync = () => {};
  if (options.agentAccessSync !== false) {
    try {
      stopAgentAccessSync = require('./core/agent-invitations').startAgentAccessSync({
        db,
        apiBaseUrl: require('./endpoints.json').api.baseUrl,
        intervalMs: options.agentAccessSync?.intervalMs || 60000,
      });
    } catch (e: any) {
      console.error('[AccessSync] 初始化失败:', e.message);
    }
  }

  // ── 自动恢复 IM 连接（仅启动当前用户名下 agent） ──
  if (options.autoStartWorkers !== false) {
    const sql = currentUserEmail
      ? "SELECT * FROM agents WHERE publish_status = 'published' AND owner_email = ?"
      : "SELECT * FROM agents WHERE publish_status = 'published'";
    const published = currentUserEmail ? db.prepare(sql).all(currentUserEmail) : db.prepare(sql).all();
    const startupResults = await agentManager.startMany(published.map((agent: any) => ({
      agentId: agent.agent_id,
      config: { uid: agent.imUid, token: agent.imToken, serverUrl: agent.im_server_url },
    })));
    const startupConnected = startupResults.filter((result: any) => result.connected).length;
    if (published.length > 0) console.error(`[VOKO Lite] 已启动 ${startupConnected}/${published.length} 个 Agent IM 连接`);

    // 消息处理 handler 在 MessageHandler 创建后统一注册（见下方）
  }

  // ── 创建 MessageHandler（可选） ──
  let messageHandler: any = null;
  if (options.messageHandler) {
    const { MessageHandler } = require('./core/messenger');
    messageHandler = new MessageHandler(db, {
      databaseAPI,
      agentWorkers: agentManager.workers,
      deliver,  // 统一 VokoIMSDK Hub 投递，供 handleAgentReply 使用
      ac: options.messageHandler.ac || null,
      ...options.messageHandler.callbacks,
    });
  }

  // ── 独立 createLiteApp 调用也必须完成持久化后 ACK ──
  agentManager.on('message', (msg?: any) => {
    const data = msg?.data || msg;
    try {
      if (messageHandler) {
        messageHandler.handleAgentMessage(msg.agentId, data);
      } else {
        databaseAPI.saveMessage({
          id: data.messageId || `wk-${msg.agentId}-${Date.now()}`,
          channelId: data.channelId, channelType: data.channelType || 1,
          fromUid: data.fromUid, toUid: data.toUid || msg.agentId, agentId: msg.agentId,
          content: data.content || '', timestamp: data.timestamp || Math.floor(Date.now() / 1000),
          isMe: false, status: 'received', messageSeq: data.messageSeq,
          clientMsgNo: data.clientMsgNo, contentType: data.contentType || 1,
        });
      }
      data?.ack?.();
    } catch (error: any) {
      console.error('[VOKO Lite] 消息处理失败，已 NACK:', error.message);
      data?.nack?.(error);
    }
  });
  if (messageHandler) {
    const syncingAgents = new Set<string>();
    const syncAgent = (agentId: string) => {
      if (!agentId || syncingAgents.has(agentId)) return;
      syncingAgents.add(agentId);
      require('./core/offline-sync').syncOfflineMessages(db, messageHandler, agentId)
        .catch((error: any) => console.error('[离线同步] Agent 失败:', agentId, error.message))
        .finally(() => syncingAgents.delete(agentId));
    };
    agentManager.on('status', (msg?: any) => {
      if (msg.status === 'connected') syncAgent(msg.agentId);
    });
    void require('./core/offline-sync').syncOfflineMessages(db, messageHandler)
      .catch((error: any) => console.error('[离线同步] 初始同步失败:', error.message));
  }

  // ── 创建后端处理器（可选） ──
  let openclawHandler = null;
  let hermesHandler = null;
  let dispatcher = null;
  if (options.handlers) {
    const h = options.handlers;
    // 如果未提供 hermesConfig 或 apiKey 为空，从数据库读取 channel_config
    let hermesConfig = h.hermesConfig || {};
    if (!hermesConfig.apiKey) {
      try {
        const hc = databaseAPI.getConfigFromDb('hermes_config') || {};
        hermesConfig = {
          apiHost: hc.apiHost || '127.0.0.1',
          apiPort: hc.apiPort || 8642,
          apiKey: hc.apiKey || '',
          profiles: hc.profiles || {},
        };
      } catch (_: any) {}
    }
    const result = createHandlers({
      db,
      databaseAPI,
      openclawMode: h.openclawMode || 'ws',
      backendTypes: h.backendTypes || db.prepare("SELECT DISTINCT backend_type FROM agents WHERE publish_status='published'")
        .all().map((row: any) => row.backend_type || 'openclaw'),
      hermesConfig,
      onAgentReply: h.onAgentReply
        ? (data?: any) => h.onAgentReply(data, messageHandler)
        : undefined,
    });
    openclawHandler = result.openclawHandler;
    hermesHandler = result.hermesHandler;
    dispatcher = result.dispatcher;
    (global as any).__dispatcher = dispatcher;
    messageHandler?.setDispatcher(dispatcher);
  }

  // ── 启动心跳（可选） ──
  let stopHeartbeat = null;
  if (options.heartbeat !== false) {
    const hbOpts = options.heartbeat || {};
    stopHeartbeat = startHeartbeat(db, agentManager, openclawHandler, hermesHandler, {
      onWarnings: hbOpts.onWarnings || undefined,
      dispatcher,
    });
  }

  // ── 渠道初始化（在核心服务就绪后） ──
  let channelInstances = {};
  if (options.channels !== false) {
    try {
      const agentEmailApi = new AgentEmailApi({
        apiBaseUrl: (databaseAPI.getConfigFromDb && databaseAPI.getConfigFromDb('endpoints'))?.im?.baseUrl
          || (() => { try { return require('./endpoints.json').api.baseUrl; } catch (_: any) { return ''; } })(),
        getUserAccessToken: () => {
          const email = currentUserEmail;
          if (!email) return null;
          try {
            const { getUserAccessToken } = require('./core/database');
            return getUserAccessToken(db, email);
          } catch (_: any) { return null; }
        },
      });
      const chOpts = options.channels || {};
      channelInstances = registry.initializeAllChannels({
        databaseAPI,
        openclawHandler,
        buildOwnerReplyPrompt: chOpts.buildOwnerReplyPrompt || registry.buildOwnerReplyPrompt,
        autoApproveWhitelistIfFriendRequest: chOpts.autoApproveWhitelistIfFriendRequest
          || ((intervention?: any, reply?: any) => messageHandler?.autoApproveWhitelistIfFriendRequest(intervention, reply)),
        agentEmailApi: chOpts.agentEmailApi || agentEmailApi,
        resumeOwnerIntervention: createResumeOwnerIntervention(dispatcher),
        db,
      });
    } catch (e: any) {
      console.error('[Lite] 渠道初始化失败:', e.message);
    }
  }

  // ── 支付轮询（处理 created→paid/expired 查单） ──
  let stopPaymentPolling = null;
  if (options.paymentPolling !== false) {
    try {
      const ENDPOINTS = require('./endpoints.json');
      stopPaymentPolling = require('./core/payment').startPaymentPolling({
        db,
        databaseAPI,
        agentWorkers: agentManager.workers,
        deliver,
        sendMessage,
        endpoints: ENDPOINTS,
        hermesHandler,
        openclawHandler,
        sendSystemMessage: (...a: any) => agentManager.sendSystemMessage(...a),
        payLog: options.paymentPolling?.payLog || (() => {}),
        ownerInterventionNotifier: null, // 将在下方初始化后更新
      });
      // 启动时恢复遗留在 pending 状态的支付订单
      setTimeout(async () => {
        try {
          // 上次进程可能在领取订单后崩溃；仅回收超过两分钟的 processing 租约，
          // 避免与仍在执行的创建请求并发。
          const staleBefore = Date.now() - 2 * 60 * 1000;
          db.prepare(`UPDATE payment_orders SET status = 'pending', updated_at = ? WHERE status = 'processing' AND updated_at < ?`)
            .run(Date.now(), staleBefore);
          const pendingOrders = db.prepare(`SELECT * FROM payment_orders WHERE status = 'pending'`).all();
          for (const order of pendingOrders) {
            const { processPendingPaymentOrder } = require('./core/payment');
            processPendingPaymentOrder(order, {
              db, databaseAPI, agentWorkers: agentManager.workers,
              deliver, sendMessage,
              endpoints: ENDPOINTS, payLog: () => {},
            }).catch((e: any) => console.error('[Payment] 恢复处理订单失败:', order.id, e.message));
          }
          if (pendingOrders.length > 0) {
            console.log('[Payment] 启动恢复：已提交 ' + pendingOrders.length + ' 条待处理订单');
          }
        } catch (e: any) {
          console.error('[Payment] 启动恢复扫描失败:', e.message);
        }
      }, 10000);
    } catch (e: any) {
      console.error('[Lite] 支付轮询初始化失败:', e.message);
    }
  }

  // ── 主人介入通知器（事件驱动，替代轮询） ──
  let ownerInterventionNotifier: any = null;
  if (options.ownerInterventionNotifier !== false) {
    try {
      const oiOpts = options.ownerInterventionNotifier || {};
      ownerInterventionNotifier = new OwnerInterventionNotifier({
        databaseAPI,
        registry,
        db,
        getEnabledChannel: databaseAPI.getEnabledChannel,
        agentEmailApi: oiOpts.agentEmailApi || undefined,
        getOpenclawHandler: () => openclawHandler,
        getHermesHandler: () => hermesHandler,
        buildOwnerReplyPrompt: oiOpts.buildOwnerReplyPrompt || registry.buildOwnerReplyPrompt,
        sendSystemMessage: (...a: any) => agentManager.sendSystemMessage(...a),
        resumeOwnerIntervention: createResumeOwnerIntervention(dispatcher),
      });
      // 启动恢复扫描（延迟执行，确保依赖就绪）
      ownerInterventionNotifier.startScan();

      // 将 notifier 注入支付轮询（支付成功时推送主人通知）
      if (stopPaymentPolling) {
        // 重建支付轮询以注入 notifier（简单方式：重启轮询）
        try {
          const ENDPOINTS = require('./endpoints.json');
          // 停止旧轮询，用新的 notifier 重新启动
          if (typeof stopPaymentPolling === 'function') stopPaymentPolling();
          stopPaymentPolling = require('./core/payment').startPaymentPolling({
            db, databaseAPI,
            agentWorkers: agentManager.workers,
            deliver,
            sendMessage,
            endpoints: ENDPOINTS,
            hermesHandler, openclawHandler,
            sendSystemMessage: (...a: any) => agentManager.sendSystemMessage(...a),
            payLog: () => {},
            ownerInterventionNotifier,
          });
        } catch (_: any) {}
      }
    } catch (e: any) {
      console.error('[Lite] 主人介入通知器初始化失败:', e.message);
    }
  }

  // ── 版本检查（异步，不阻塞） ──
  checkVersionAndPersist(db);

  if (typeof stopAgentAccessSync === 'function') await taskManager.start('agent-access-sync', () => stopAgentAccessSync);
  if (typeof stopHeartbeat === 'function') await taskManager.start('heartbeat', () => stopHeartbeat);
  if (typeof stopPaymentPolling === 'function') await taskManager.start('payment-polling', () => stopPaymentPolling);
  if (ownerInterventionNotifier) await taskManager.start('owner-intervention', () => () => ownerInterventionNotifier.stop());

  return {
    db, databaseAPI, agentManager, agentRegistration,
    openclawHandler, hermesHandler, messageHandler,
    channelInstances,
    ownerInterventionNotifier,
    taskManager,
    currentUserEmail,
    stopHeartbeat: stopHeartbeat || (() => {}),
    stopPaymentPolling: stopPaymentPolling || (() => {}),
    stopAgentAccessSync,
    dispose: async () => {
      await taskManager.stopAll();
      await shutdownAll(agentManager, wukongimSender, db, 'dispose');
    },
  };
}

/**
 * 获取当前登录用户邮箱
 */
function getCurrentUserEmail(db?: any) {
  try {
    const { getCurrentUserEmail: getActiveUserEmail } = require('./core/database');
    return getActiveUserEmail(db);
  } catch (_: any) {}
  return null;
}

/**
 * 启动心跳检测（每 60 秒上报 agent 状态到服务端）
 *
 * 完整模式（传 handler 引用）：健康检查 + 网关恢复 + 逐 agent IM ping/pong + 心跳上报
 * 简单模式（handler=null）：仅上报 IM 连接数
 *
 * @param {object}   db - node:sqlite 实例
 * @param {object}   agentManager - AgentWorkerManager 实例
 * @param {object}   [openclawHandler] - OpenClawWSHandler 实例（可选）
 * @param {object}   [hermesHandler] - HermesHandler 实例（可选）
 * @param {object}   [options]
 * @param {Function} [options.onWarnings] - 警告回调 (warnings[])
 * @returns {Function} stop - 调用此函数停止心跳
 */
function startHeartbeat(db?: any, agentManager?: any, openclawHandler?: any, hermesHandler?: any, options: any = {}) {
  const { onWarnings, port, agentCount } = options;
  const dispatcher = options.dispatcher || (global as any).__dispatcher;
  const ENDPOINTS = require('./endpoints.json');
  const BASE_URL = ENDPOINTS.im.baseUrl;

  // 写入初始 runtime 标记（含端口号）
  try {
    const email = getCurrentUserEmail(db);
    db.prepare("INSERT OR REPLACE INTO config (type, data, updated_at) VALUES ('runtime', ?, ?)")
      .run(JSON.stringify({
        instanceId: __instanceLock?.metadata?.instanceId,
        pid: process.pid,
        ts: Date.now(),
        port: __runtimePort || port || null,
        userEmail: email || '',
        agents: [],
      }), Date.now());
  } catch (_: any) {}

  let isBeating = false;
  const heartbeatFn = async () => {
    if (isBeating) { console.error('[心跳] 上一轮未结束，跳过本次（慢操作堆积）'); return; }
    isBeating = true;
    try {
      const userEmail = getCurrentUserEmail(db);
      // ── Hermes 健康检查 + 自动恢复 ──
      if (hermesHandler?.client) {
        try { await hermesHandler.healthCheck(); } catch (_: any) {}
        try {
          const sql = userEmail
            ? `SELECT agent_id, delivery_modes FROM agents WHERE backend_type = 'hermes' AND publish_status = 'published' AND owner_email = ?`
            : `SELECT agent_id, delivery_modes FROM agents WHERE backend_type = 'hermes' AND publish_status = 'published'`;
          const hermesAgents = userEmail ? db.prepare(sql).all(userEmail) : db.prepare(sql).all();
          for (const { agent_id, delivery_modes } of hermesAgents) {
            let selectedModes: string[] | null = null;
            try {
              const parsed = typeof delivery_modes === 'string' ? JSON.parse(delivery_modes) : delivery_modes;
              if (Array.isArray(parsed)) selectedModes = parsed.map(String);
            } catch (_) {}
            if (selectedModes && !selectedModes.includes('http')) continue;
            if (hermesHandler.isProfileReady?.(agent_id)) continue;
            try { await hermesHandler._ensureGatewayRunning(agent_id); }
            catch (e: any) { console.error('[Lite] Hermes gateway 恢复失败:', agent_id, e.message); }
          }
        } catch (_: any) {}
      }

      // ── 遍历 agent 检测状态 ──
      const warnings = [];
      const agentSql = userEmail
        ? "SELECT agent_id, agent_name, imUid, backend_type, owner_email FROM agents WHERE publish_status = 'published' AND owner_email = ?"
        : "SELECT agent_id, agent_name, imUid, backend_type, owner_email FROM agents WHERE publish_status = 'published'";
      const rows = userEmail ? db.prepare(agentSql).all(userEmail) : db.prepare(agentSql).all();
      let imOnline = 0, backendOnline = 0, posted = 0;
      const deliveryStatuses = new Map<string, any>();

      for (const agent of rows) {
        // IM 状态
        let imOk = agentManager?.getStatus(agent.agent_id)?.connected || false;

        let deliveryStatus: any;
        try {
          deliveryStatus = dispatcher?.getAgentDeliveryStatus?.(agent.agent_id) || {
            backendType: agent.backend_type || null, configuredModes: [], availableModes: [],
            activeMode: null, methods: [], backendAvailable: false,
          };
        } catch (_) {
          deliveryStatus = {
            backendType: agent.backend_type || null, configuredModes: [], availableModes: [],
            activeMode: null, methods: [], backendAvailable: false,
          };
        }
        deliveryStatuses.set(agent.agent_id, deliveryStatus);
        const backendOk = !!deliveryStatus.backendAvailable;

        if (imOk) imOnline++;
        if (backendOk) backendOnline++;

        const agentName = agent.agent_name || agent.agent_id;
        if (!imOk) warnings.push({ type: 'agent-im-offline', message: `⚠️ ${agentName} IM 连接断开`, action: 'agent-detail', agentId: agent.agent_id });
        if (!backendOk) {
          warnings.push({ type: 'agent-backend-offline', message: `⚠️ ${agentName} 当前没有可用的消息接收方式`, action: 'agent-detail', agentId: agent.agent_id });
        } else {
          const failedConfigured = deliveryStatus.methods?.find((method: any) => method.configured && !method.available && method.status !== 'unknown');
          if (failedConfigured) {
            const activeLabel = deliveryStatus.activeMode === 'pull' ? 'MCP Pull（按需）' : deliveryStatus.activeMode;
            warnings.push({ type: 'agent-backend-degraded', message: `⚠️ ${agentName} ${failedConfigured.mode} 不可用，当前使用 ${activeLabel}`, action: 'agent-detail', agentId: agent.agent_id });
          }
        }

        if (imOk) {
          try {
            const ownerEmail = String(agent.owner_email || userEmail || '').trim();
            const userAccessToken = ownerEmail ? getUserAccessToken(db, ownerEmail) : null;
            const r = await fetch(`${BASE_URL}/api/heartbeat`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(userAccessToken ? {
                  Authorization: `Bearer ${userAccessToken}`,
                  'X-Voko-Agent-Uid': agent.imUid,
                } : {}),
              },
              body: JSON.stringify({ uid: agent.imUid }),
            });
            if (r.ok) posted++;
          } catch (_: any) {}
        }
      }

      // ── OpenClaw gateway 恢复 ──
      if (openclawHandler) {
        const ocStatus = openclawHandler.getStatus?.();
        if (!ocStatus?.connected && !ocStatus?.connecting && openclawHandler._ensureGatewayRunning) {
          openclawHandler._ensureGatewayRunning();
        }
      }

      // ── 上报 ──
      const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      const hubCount = agentManager?.getHubSummary?.()?.hubCount || 0;
      console.log(`[${ts}][IM 心跳] Hub=${hubCount} IM=${imOnline}/${rows.length} 接收能力=${backendOnline}/${rows.length} 上报=${posted}/${rows.length}`);
      if (warnings.length > 0) {
        console.error(`[${ts}][心跳] 发现 ${warnings.length} 个异常:\n${warnings.map((w: any) => `  ${w.message}`).join('\n')}`);
      }
      if (onWarnings) onWarnings(warnings);

      // 更新 runtime 标记（连接详情）
      try {
        const prev = db.prepare("SELECT data FROM config WHERE type = 'runtime'").get();
        const prevData = prev ? JSON.parse(prev.data) : {};
        const agentList = rows.map((a: any) => {
          const deliveryStatus = deliveryStatuses.get(a.agent_id) || {
            backendType: a.backend_type || null, configuredModes: [], availableModes: [],
            activeMode: null, methods: [], backendAvailable: false,
          };
          return {
            agentId: a.agent_id,
            agentName: a.agent_name || a.agent_id,
            imConnected: agentManager?.getStatus(a.agent_id)?.connected || false,
            backendConnected: !!deliveryStatus.backendAvailable,
            availableModes: deliveryStatus.availableModes || [],
            activeMode: deliveryStatus.activeMode || null,
            deliveryStatus,
          };
        });
        db.prepare("INSERT OR REPLACE INTO config (type, data, updated_at) VALUES ('runtime', ?, ?)")
          .run(JSON.stringify({
            instanceId: __instanceLock?.metadata?.instanceId,
            pid: process.pid,
            ts: Date.now(),
            port: __runtimePort || port || prevData.port || null,
            userEmail: prevData.userEmail || '',
            agents: agentList,
          }), Date.now());
        // WebSocket 广播 runtime 状态，前端局部刷新 footer
        try {
          const imDown = agentList.some((a: any) => !a.imConnected);
          const statusKey = agentList.length ? (imDown ? 'common.footer.status_im_down' : 'common.footer.status_ok') : 'common.footer.status_init';
          const statusColor = imDown ? '#d93025' : (agentList.length ? '#0f9d58' : '#888');
          (global as any).__liteBroadcast('runtime:updated', {
            pid: process.pid,
            port: __runtimePort || port || prevData.port || null,
            statusKey, statusColor,
            ts: Date.now(),
          });
        } catch (_: any) {}
      } catch (_: any) {}
    } catch (e: any) {
      console.error('[Lite] 心跳异常:', e.message);
    } finally {
      isBeating = false;
    }
  };
  const timer = setInterval(heartbeatFn, 60000);
  let firstBeatTimer: NodeJS.Timeout | null = null;
  let firstBeatStatusHandler: ((msg: any) => void) | null = null;

  // Agent 全部连接就绪后立即执行首次心跳（无需等 60s），5s 兜底
  if (agentCount > 0) {
    let _firstBeatDone = false;
    const _tryFirstBeat = () => {
      if (_firstBeatDone) return;
      if (agentManager.connectedAgents.size >= agentCount) {
        _firstBeatDone = true;
        heartbeatFn();
      }
    };
    firstBeatStatusHandler = (msg?: any) => {
      if (msg.status === 'connected' || msg.statusCode === 2) _tryFirstBeat();
    };
    agentManager.on('status', firstBeatStatusHandler);
    firstBeatTimer = setTimeout(() => _tryFirstBeat(), 5000);
  }

  return () => {
    clearInterval(timer);
    if (firstBeatTimer) clearTimeout(firstBeatTimer);
    if (firstBeatStatusHandler) agentManager.off?.('status', firstBeatStatusHandler);
  };
}

function checkLiteRunning(dbOrPath?: any) {
  try {
    const db = typeof dbOrPath === 'string' ? require('./core/database').initDatabase(dbOrPath) : dbOrPath;
    const row = db.prepare("SELECT data FROM config WHERE type = 'runtime'").get();
    if (typeof dbOrPath === 'string') db.close();
    if (!row) { console.error('[Runtime] 无 runtime 记录'); return false; }
    const data = JSON.parse(row.data);
    if (!data || !data.pid) return false;
    if (Date.now() - data.ts > 120000) { console.error('[Runtime] runtime 已过期（>2分钟）'); return false; }
    try { process.kill(data.pid, 0); console.error('[Runtime] 检测到实例 PID=' + data.pid); return true; }
    catch { console.error('[Runtime] PID=' + data.pid + ' 已不存在'); return false; }
  } catch { return false; }
}

// ═══════════════════════════════════════════════
//  退出清理
// ═══════════════════════════════════════════════

async function shutdownAll(
  agentManager?: any,
  wukongimSender?: any,
  db?: any,
  signal?: any,
  exitCode = 0,
  taskManager?: any,
) {
  if (__shuttingDown) return;
  __shuttingDown = true;
  taskManager ||= __shutdownContext?.taskManager;
  __serviceHealth = signal?.startsWith?.('fatal:') ? 'unhealthy' : 'draining';
  if (signal !== 'api-quit') console.error(t('cli.index.signal_cleanup', { signal }));
  try { await taskManager?.stopAll?.(); } catch (e: any) { console.error('[VOKO Lite] 后台任务清理失败:', e.message); }
  try {
    const handlers = registry.getAllHandlers?.() || {};
    for (const handler of Object.values(handlers) as any[]) await handler?.stop?.();
  } catch {}
  // 停各 provider（含 gateway 进程清理，避免 detached gateway 在退出后泄漏）
  try { await (global as any).__dispatcher?.stop?.(); } catch (e: any) { console.error('[VOKO Lite] dispatcher.stop 失败:', e.message); }
  try { await agentManager?.stopAll?.(); } catch (e: any) { console.error('[VOKO Lite] IM Hub 清理失败:', e.message); }
  if (wukongimSender && wukongimSender !== agentManager) {
    try { await wukongimSender.disconnectAll?.(); } catch (e: any) { console.error('[VOKO Lite] 兼容发送器清理失败:', e.message); }
  }
  if (__consoleLiveEvents) {
    try { __consoleLiveEvents.close?.(); } catch {}
    __consoleLiveEvents = null;
  }
  if (__webSocketServer) {
    try {
      for (const client of __webSocketServer.clients || []) {
        try { client.terminate?.(); } catch {}
      }
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 1000);
        __webSocketServer.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    } catch {}
    __webSocketServer = null;
    try { delete (global as any).__liteBroadcast; } catch {}
  }
  if (__httpServer) {
    try {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => {
          try { __httpServer.closeAllConnections?.(); } catch {}
          resolve();
        }, 2000);
        __httpServer.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    } catch {}
    __httpServer = null;
  }
  if (db && db.open) {
    clearCurrentRuntimeSnapshot(db);
    try { db.close(); } catch (_: any) {}
  }
  try { __instanceLock?.release(); } catch {}
  __instanceLock = null;
  __shutdownContext = null;
  console.error(t('cli.index.graceful_exit'));
  process.exit(exitCode);
}

// ── CLI 命令入口 ──

function printUsage() {
  console.log(
    t('cli.usage.title') + '\n\n' +
    t('cli.usage.usage_header') + '\n' +
    '  voko                       ' + t('cli.usage.start_default') + '\n' +
    '  voko start [--port PORT]   ' + t('cli.usage.start') + '\n' +
    '  voko setup                 Headless installation and readiness diagnosis (JSON)\n' +
    '  voko login                 ' + t('cli.usage.login') + '\n' +
    '  voko manage_agent_registration --interactive\n' +
    '                             ' + t('cli.usage.register_interactive') + '\n' +
    '  voko <tool-name> [--agent <id>] [--param=value ...]\n' +
    '                             ' + t('cli.usage.invoke_tool') + '\n' +
    '  voko <tool-name> --help    ' + t('cli.usage.tool_help') + '\n' +
    '  voko --tools               ' + t('cli.usage.tools_list') + '\n' +
    '  voko stop                  ' + t('cli.usage.stop') + '\n' +
    '  voko uninstall [--purge]   ' + t('cli.usage.uninstall') + '\n' +
    '  voko mcp                   ' + t('cli.usage.mcp') + '\n' +
    '  voko status                ' + t('cli.usage.status') + '\n' +
    '  voko update                ' + t('cli.usage.update') + '\n' +
    '  voko --version             ' + t('cli.usage.version') + '\n' +
    '  voko --help                ' + t('cli.usage.help') + '\n' +
    '\n' +
    t('cli.usage.identity_header') + '\n' +
    '  --agent <agentId>          ' + t('cli.usage.agent') + '\n' +
    '                             ' + t('cli.usage.agent_env') + '\n' +
    '  --verbose                  ' + t('cli.usage.verbose') + '\n' +
    '  --no-interactive           ' + t('cli.usage.no_interactive') + '\n' +
    '  --lang <zh|en>             ' + t('cli.usage.lang') + '\n' +
    '\n' +
    t('cli.usage.examples_header') + '\n' +
    '  voko whoami                                   ' + t('cli.usage.example_whoami') + '\n' +
    '  voko send_message --agent X --toUid Y --content "hi"\n' +
    '  voko list_conversations --agent X\n' +
    '  voko --tools\n' +
    '\n' +
    t('cli.usage.tools_header') + '\n' +
    '  manage_agent_registration\n' +
    '  update_agent_profile  set_agent_status  get_status  get_agent_profile\n' +
    '  search_capabilities  declare_capabilities\n' +
    '  send_message  get_chat_history  fetch_new_messages\n' +
    '  get_visitor_profile  list_conversations  mark_conversation_read\n' +
    '  upload_and_send_file  whoami  start_worker  stop_worker\n' +
    '  ask_human_for_help  check_human_replies  close_human_request\n' +
    '  create_payment  check_payments  agent_pricing\n' +
    '  add_payment_auth  list_payment_auth  delete_payment_auth\n' +
    '  apply_payment_auth  refresh_payment_auth  search_banks\n' +
    '  bind_agent_payment_auth\n' +
    '  manage_whitelist  manage_blacklist  list_access_lists  set_private_mode\n' +
    '  invite_friend  list_audit_rules  manage_audit_rules\n' +
    '  create_group  invite_to_group  accept_invitation  decline_invitation\n' +
    '  get_group_members  get_group_context  kick_from_group  quit_group\n' +
    '  update_group  list_groups  list_group_applies  approve_group_apply\n' +
    '  mute_member  search_groups  apply_group\n' +
    '  bug_report\n'
  );
}

async function main() {
  let argv = process.argv.slice(2);
  // 进程级 locale：--lang / VOKO_LANG / LANG（决定 CLI 文案与默认 locale）
  setLocale(detectCliLocale(argv, process.env));
  // 消费全局 flag --lang <val>，避免它占用 subcommand 槽位（如 `voko --lang en --help`）
  const _langIdx = argv.indexOf('--lang');
  if (_langIdx >= 0) argv = argv.filter((_?: any, i?: any) => i !== _langIdx && i !== _langIdx + 1);
  const subcommand = argv[0];

  // 帮助
  if (subcommand === '--help' || subcommand === '-h') {
    printUsage();
    return;
  }

  // 版本
  if (subcommand === '--version' || subcommand === '-v') {
    console.log(`voko ${pkg.version}`);
    return;
  }

  // 解析参数
  const args = parseArgs(argv);

  // CLI tool 身份：--agent <id> 或环境变量 VOKO_AGENT_ID（注入到需要 agentId 的工具）
  const cliAgent = args.agent || process.env.VOKO_AGENT_ID || null;
  // CLI tool 调用默认静默例行 DB 初始化日志；--verbose / --debug / VOKO_DEBUG 恢复
  const _systemCmds = new Set(['start', 'setup', 'mcp', 'stop', 'uninstall', 'status', 'update', 'login', '--help', '-h', '--version', '-v']);
  const isToolCmd = !!subcommand && !_systemCmds.has(subcommand);
  const verbose = !!(args.verbose || args.debug || process.env.VOKO_DEBUG);
  const silent = isToolCmd && !verbose;

  // ── 系统命令（无需初始化 core） ──

  // update
  if (subcommand === 'update') {
    await cli.updateLite();
    return;
  }

  // Read-only, browser-free installation diagnosis for shells, SSH and containers.
  if (subcommand === 'setup') {
    const result = inspectSetup(args);
    console.log(JSON.stringify(result, null, 2));
    if (!result.success) process.exitCode = 1;
    return;
  }

  if (subcommand === 'uninstall') {
    const dbPath = resolveDbPath(args, { silent: true, noCreate: true });
    const uninstall = require('./core/uninstall');
    const result = await uninstall.runUninstall({
      dbPath,
      dataPath: path.dirname(getDefaultDbPath()),
      defaultDataPath: path.dirname(getDefaultDbPath()),
      entryPath: process.argv[1],
      purge: !!args.purge,
      yes: !!args.yes,
      dryRun: !!args.dryRun || !!args['dry-run'],
      json: !!args.json,
      onGraceful: (port: number) => { if (!args.json) console.error(t('cli.index.stopping', { port })); },
    });
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else console.log(uninstall.formatUninstall(result, getLocale()));
    if (!result.success) process.exitCode = 1;
    return;
  }

  // status — 读取运行时信息（端口、PID、版本等），不需要初始化 core
  if (subcommand === 'status') {
    // 只需打开 DB 读 runtime 标记；用只读连接避免与运行中的 Lite 写连接冲突
    const dbPath = resolveDbPath(args);
    const { DatabaseSync: Database } = require('node:sqlite');
    const db = new Database(dbPath, { readOnly: true });
    try {
      const row = db.prepare("SELECT data FROM config WHERE type = 'runtime'").get();
      const runtime = parseRuntimeSnapshot(row?.data);
      const instance = readInstanceMetadata(dbPath);
      const running = Boolean(instance && isInstanceAlive(instance));
      const currentRuntime = running && instance && runtimeMatchesInstance(runtime, instance)
        ? runtime
        : {};
      const startedAt = running && instance ? instance.createdAt : null;
      const fs = require('fs');
      console.log(JSON.stringify({
        success: true,
        running,
        state: running ? 'running' : 'stopped',
        instanceId: running && instance ? instance.instanceId : null,
        port: running && instance ? (instance.port || currentRuntime.port || null) : null,
        pid: running && instance ? instance.pid : null,
        ts: running ? (currentRuntime.ts || instance?.updatedAt || null) : null,
        startedAt,
        lastSeenAt: runtime.ts || null,
        version: pkg.version,
        schemaVersion: SCHEMA_VERSION,
        userEmail: running ? (currentRuntime.userEmail || null) : null,
        uptime: startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : null,
        dbPath,
        dbSize: fs.existsSync(dbPath) ? (fs.statSync(dbPath).size / 1024 / 1024).toFixed(1) + ' MB' : null,
        agents: running && Array.isArray(currentRuntime.agents) ? currentRuntime.agents : [],
      }, null, 2));
    } catch (e: any) {
      console.error(JSON.stringify({ success: false, error: e.message }));
      process.exit(1);
    } finally {
      try { if (db?.open) db.close(); } catch (_: any) {}
    }
    return;
  }

  // mcp — stdio MCP 代理（供 Claude Code 等外部 MCP 客户端连接，端口透明）
  if (subcommand === 'mcp') {
    const { runMcpProxy } = require('./mcp/stdio-proxy');
    await runMcpProxy(resolveDbPath(args));
    return;
  }

  // stop — 先 HTTP 优雅关闭，再强杀兜底
  if (subcommand === 'stop') {
    const dbPath = resolveDbPath(args, { silent: true });
    const result = await stopVoko(dbPath, (port: number) => console.error(t('cli.index.stopping', { port })));
    if (!result.wasRunning) {
      console.error(t('cli.index.no_instance'));
      process.exit(1);
    }
    if (!result.stopped) {
      console.error(t('cli.index.stop_incomplete', {
        pids: result.remainingPids.join(', '),
      }));
      process.exit(1);
    }
    console.error(t('cli.index.stopped'));
    return;
  }

  // IM Hub clients belong to the long-running VOKO process. Short-lived CLI
  // calls must execute these tools through that process instead of opening a
  // duplicate IM connection or using the removed legacy direct sender.
  if (['send_message', 'upload_and_send_file', 'start_worker', 'stop_worker'].includes(subcommand)) {
    const result = await cli.runRuntimeToolCommand(
      subcommand,
      args,
      resolveDbPath(args, { silent: true }),
      { agentId: cliAgent, debug: verbose },
    );
    if (!result.success) process.exitCode = 1;
    return;
  }

  const willServe = !subcommand || subcommand === 'start';
  if (willServe) {
    const dbPath = resolveDbPath(args);
    const lockResult = await acquireInstanceLock(dbPath, path.resolve(process.argv[1]));
    if (!lockResult.acquired) {
      const existing = lockResult.existing;
      const port = existing?.port || parseInt(args.port, 10) || 3100;
      console.error(t('cli.index.instance_running', {
        pid: existing?.pid || '',
        port,
        url: `http://localhost:${port}`,
      }));
      if (!args.noOpen && !args['no-open'] && process.env.VOKO_SMOKE_TEST !== '1') {
        openLocalWebPage(port);
      }
      return;
    }
    __instanceLock = lockResult.lock;
  }

  // ── 需要初始化 core 的命令 ──
  const core = initCore(args, { silent });

  // voko --tools：输出所有工具的 JSON Schema（机器可读，供 MCP 客户端/agent 发现能力）
  if (args.tools) {
    await cli.printAllToolSchemas(core);
    try { if (core.db?.open) core.db.close(); } catch (_: any) {}
    return;
  }

  // voko <tool> --help：打印该工具的参数说明，不执行
  if ((args.help || args.h) && cli.isKnownTool(subcommand)) {
    await cli.printToolHelp(subcommand, core);
    try { await core.wukongimSender?.disconnectAll?.(); } catch (_: any) {}
    try { if (core.db?.open) core.db.close(); } catch (_: any) {}
    return;
  }

  try {
    if (!subcommand || subcommand === 'start') {
      // voko（无参数）或 voko start → 启动 Lite MCP Server
      await runHeadlessOnboarding(args, core);
      await startMcpServer(args, core);
    } else if (subcommand === 'login') {
      await require('./cli-interactive').runInteractiveLogin(core);
    } else if (subcommand === 'manage_agent_registration'
      && (args.interactive === true || args.interactive === 'true' || args.interactive === '1')) {
      await require('./cli-interactive').runInteractiveRegistration(core);
    } else {
      const result = await cli.runToolCommand(subcommand, args, core, { agentId: cliAgent, debug: verbose });
      if (result === null) {
        console.error(t('cli.index.unknown_cmd', { cmd: subcommand }));
        process.exit(1);
      }
      if (!result.success) process.exit(1);
    }
  } finally {
    if (subcommand && subcommand !== 'start' && subcommand !== 'stop') {
      try { await core.agentManager?.stopAll?.(); } catch (_: any) {}
      try { await core.wukongimSender?.disconnectAll?.(); } catch (_: any) {}
      try { if (core.db?.open) core.db.close(); } catch (_: any) {}
    }
  }
}

if (require.main === module) {
  main().catch((err: any) => {
    try { __instanceLock?.release(); } catch {}
    console.error(t('cli.index.start_failed', { msg: (err && err.message) || err }));
    process.exit(1);
  });
}

// ═══════════════════════════════════════════════
//  程序化导出 — 供 Desktop 和外部调用
// ═══════════════════════════════════════════════

module.exports = { initCore, createContext, createLiteApp, createHandlers, createMessageHandler, createResumeOwnerIntervention, startHeartbeat, getCurrentUserEmail, hasGraphicalSession, interactiveStartEnabled, hasAgentForOwner, runHeadlessOnboarding, checkLiteRunning, syncOfflineMessages: require('./core/offline-sync').syncOfflineMessages, processPendingPaymentOrder: require('./core/payment').processPendingPaymentOrder, startPaymentPolling: require('./core/payment').startPaymentPolling, AgentWorkerManager };
