#!/usr/bin/env node
export {};
import type { AccessControlLike } from './core/messenger-types';
const { normalizeBackendType } = require('./core/agent-backend-types');
const { isRoutingFeatureEnabled } = require('./core/provider-routing');


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
const fs = require('fs');
const express = require('express');
const { ensureLoopbackNoProxy } = require('./core/loopback-env');

ensureLoopbackNoProxy(process.env);

// ── core 模块 ──
const {
  initDatabase,
  createDatabaseAPI,
  getUserAccessToken,
  getPrimaryOwnerEmail,
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
const { generateOSSSignature } = require('./server/oss');
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
const { compareVersions } = require('./core/auto-updater');

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

function withRuntimeTimestamp(args: any[], now: Date = new Date()): any[] {
  const first = args[0];
  if (typeof first === 'string' && (/^\[\d{1,2}:\d{2}:\d{2}\]/.test(first)
    || /^\[\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{3})?\]/.test(first))) return args;
  const pad = (value: number, size = 2) => String(value).padStart(size, '0');
  const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  return [`[${timestamp}]`, ...args];
}

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
      const ts = `${n.getFullYear()}-${p(n.getMonth()+1)}-${p(n.getDate())} ${p(n.getHours())}:${p(n.getMinutes())}:${p(n.getSeconds())}`;
      return `${ts} [${level}] ` + a.map((x: any) => typeof x === 'object' ? (x instanceof Error ? x.stack || x.message : JSON.stringify(x)) : String(x)).join(' ');
    }
    function persist(level?: any, a?: any) {
      if (!_shouldLog(level)) return;
      try { rotateIfNeeded(logPath); fs.appendFileSync(logPath, fmt(level, a) + '\n'); } catch (_: any) {}
    }
    // 仅长驻 Lite 服务安装：CLI/MCP stdio/JSON 输出不会经过这里。
    const _origLog = console.log, _origInfo = console.info, _origError = console.error, _origWarn = console.warn, _origDebug = console.debug;
    console.log = function(...a: any) { persist('LOG', a); _origLog.apply(console, withRuntimeTimestamp(a)); };
    console.info = function(...a: any) { persist('LOG', a); _origInfo.apply(console, withRuntimeTimestamp(a)); };
    console.error = function(...a: any) { persist('ERR', a); _origError.apply(console, withRuntimeTimestamp(a)); };
    console.warn = function(...a: any) { persist('WRN', a); _origWarn.apply(console, withRuntimeTimestamp(a)); };
    console.debug = function(...a: any) { persist('DBG', a); if (_origDebug) _origDebug.apply(console, withRuntimeTimestamp(a)); };
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

function readStoredUpdateStatus(db: any): { latestVersion: string } | null {
  try {
    const row = db?.prepare("SELECT data FROM config WHERE type = 'update_status'").get();
    const status = row?.data ? JSON.parse(row.data) : null;
    if (!status?.updateAvailable || typeof status.latestVersion !== 'string') return null;
    if (compareVersions(status.latestVersion, pkg.version) <= 0) return null;
    return { latestVersion: status.latestVersion };
  } catch (_: any) {
    return null;
  }
}

function formatVersionLine(db: any): string {
  const base = `  Version:    ${pkg.version}`;
  const update = readStoredUpdateStatus(db);
  if (!update) return base;
  const YELLOW = '\x1b[33m';
  const RESET = '\x1b[0m';
  const hint = t('cli.updater.new_version_available', {
    version: update.latestVersion,
    current: pkg.version,
  });
  return `${YELLOW}${base}  ⚠️ ${hint}${RESET}`;
}

const versionChecksStarted = new WeakSet<object>();

function printVersionUpdateHint(result: any): void {
  if (!result?.updateAvailable || typeof result.latestVersion !== 'string') return;
  const YELLOW = '\x1b[33m';
  const RESET = '\x1b[0m';
  const hint = t('cli.updater.new_version_available', {
    version: result.latestVersion,
    current: pkg.version,
  });
  console.error(`${YELLOW}  Version:    ${pkg.version}  ⚠️ ${hint}${RESET}`);
}

function checkVersionAndPersist(db: any): void {
  if (db && typeof db === 'object') {
    if (versionChecksStarted.has(db)) return;
    versionChecksStarted.add(db);
  }
  const previous = readStoredUpdateStatus(db);
  void cli.checkVersion({ notify: false }).then((result: any) => {
    if (!result) return;
    try {
      db.prepare("INSERT OR REPLACE INTO config (type, data, updated_at) VALUES ('update_status', ?, ?)")
        .run(JSON.stringify({ ...result, checkedAt: Date.now() }), Date.now());
    } catch (_: any) {}
    if (result.updateAvailable && previous?.latestVersion !== result.latestVersion) {
      printVersionUpdateHint(result);
    }
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

/** Return a PATH-independent command for invoking the compiled Voko CLI. */
function stableNodeCommand(...args: string[]) {
  return {
    command: path.resolve(process.execPath),
    args: [path.resolve(__dirname, 'index.js'), ...args],
  };
}

function inspectSetup(args?: any) {
  const fs = require('fs');
  const { inspectMcpConfigs } = require('./core/mcp-config-diagnostics');
  const dbPath = resolveDbPath(args, { silent: true });
  const nodeVersion = process.versions.node;
  const [major, minor] = nodeVersion.split('.').map(Number);
  const nodeSupported = major > 22 || (major === 22 && minor >= 5);
  const instance = readInstanceMetadata(dbPath);
  const running = Boolean(instance && isInstanceAlive(instance));
  let database = { exists: fs.existsSync(dbPath), readable: false, schemaVersion: null as number | null };
  let authenticated = false;
  let agentCount = 0;
  const mcpClients = inspectMcpConfigs();

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
    runtime: {
      running,
      port: running ? (instance?.port || null) : null,
      instanceId: running ? (instance?.instanceId || null) : null,
      version: running ? pkg.version : null,
    },
    mcpClients,
    stableCommands: {
      mcp: stableNodeCommand('mcp'),
      start: stableNodeCommand('start', '--no-open', '--no-interactive'),
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
  const sendMessage = createSendMessage({ db, deliver, databaseAPI, agentWorkers: agentManager.workers, mainWindow: null });
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
    formatVersionLine(db),
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
async function startTransport(args?: any, mcpServer?: any, agentManager?: any, db?: any, databaseAPI?: any, webRouter?: any, handlers?: any, runtimeState?: any, wukongimSender?: any, taskManager?: any, webRouterOptions?: any) {
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

  const expectedRuntimeInstanceId = __instanceLock?.metadata?.instanceId || null;
  app.use('/mcp', (req?: any, res?: any, next?: any) => {
    const supplied = String(req.headers['x-voko-instance-id'] || '').trim();
    if (supplied && expectedRuntimeInstanceId && supplied !== expectedRuntimeInstanceId) {
      return res.status(409).json({ success: false, code: 'RUNTIME_MISMATCH', error: 'Lite 运行实例身份不匹配' });
    }
    next();
  });
  const httpTransport = createHttpTransport(mcpServer, {
    version: pkg.version,
    db,
    instanceId: expectedRuntimeInstanceId,
    edition: 'lite',
  });
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
  app.post(['/api/agents/:agentId/send-file', '/api/agents/:agentId/icon'], (req?: any, res?: any, next?: any) => {
    if (req.is('multipart/form-data')) {
      let chunks: Buffer[] = [];
      let total = 0;
      let tooLarge = false;
      const maxBytes = String(req.path || '').endsWith('/icon') ? 500 * 1024 + 64 * 1024 : 25 * 1024 * 1024;
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
  // Test-only provider control must be registered before the catch-all web
  // router, otherwise the browser router turns the endpoint into a 404.
  if (process.env.VOKO_E2E === '1') {
    app.post('/__test__/provider', (req?: any, res?: any) => {
      const provider = (global as any).__dispatcher?.providers?.['mock-echo'];
      if (!provider?.setAvailable) return res.status(404).json({ success: false, error: 'mock provider unavailable' });
      const scopedAgentId = String(req.body?.agentId || '').trim();
      try {
        provider.clearFault?.();
        if (scopedAgentId && typeof provider.setAgentAvailable === 'function'
          && Object.prototype.hasOwnProperty.call(req.body || {}, 'available')) {
          provider.setAgentAvailable(scopedAgentId, req.body?.available !== false);
        } else if (Object.prototype.hasOwnProperty.call(req.body || {}, 'available')) {
          provider.setAvailable(req.body?.available !== false);
        }
        const fault = req.body?.fault;
        if (fault) {
          const mode = typeof fault === 'string' ? fault : fault.mode;
          provider.setFault(mode, typeof fault === 'object' ? fault.count : 1, typeof fault === 'object' ? fault.disable !== false : false);
        }
      } catch (e: any) {
        return res.status(400).json({ success: false, error: e?.message || 'invalid provider fault' });
      }
      (global as any).__dispatcher?.invalidateRoutes?.({
        providerId: 'mock-echo',
        agentId: scopedAgentId || undefined,
        reason: 'e2e-provider-control',
        available: scopedAgentId ? provider.isAvailable?.(scopedAgentId) : provider.isAvailable?.(),
      });
      return res.json({ success: true, ...provider.getTestState?.(), available: !!provider.isAvailable?.() });
    });
    app.post('/__test__/delivery-modes', (req?: any, res?: any) => {
      const agentId = String(req.body?.agentId || '').trim();
      if (!agentId || !Object.prototype.hasOwnProperty.call(req.body || {}, 'modes')) {
        return res.status(400).json({ success: false, error: 'agentId and modes are required' });
      }
      try {
        const modes = req.body.modes === null ? null : (Array.isArray(req.body.modes) ? req.body.modes.map(String) : null);
        db.prepare('UPDATE agents SET delivery_modes=? WHERE agent_id=?').run(modes === null ? null : JSON.stringify(modes), agentId);
        (global as any).__dispatcher?.invalidateMeta?.(agentId);
        return res.json({ success: true, agentId, modes });
      } catch (e: any) {
        return res.status(500).json({ success: false, error: e?.message || 'delivery mode update failed' });
      }
    });
    app.post('/__test__/agent-owner', (req?: any, res?: any) => {
      const agentId = String(req.body?.agentId || '').trim();
      if (!agentId || !Object.prototype.hasOwnProperty.call(req.body || {}, 'ownerEmail')) {
        return res.status(400).json({ success: false, error: 'agentId and ownerEmail are required' });
      }
      try {
        const ownerEmail = req.body.ownerEmail === null ? null : String(req.body.ownerEmail || '').trim();
        db.prepare('UPDATE agents SET owner_email=?, updated_at=? WHERE agent_id=?').run(ownerEmail, Date.now(), agentId);
        (global as any).__dispatcher?.invalidateMeta?.(agentId);
        return res.json({ success: true, agentId, ownerEmail });
      } catch (e: any) {
        return res.status(500).json({ success: false, error: e?.message || 'agent owner update failed' });
      }
    });
    app.get('/__test__/runtime', (req?: any, res?: any) => {
      const agentId = String(req.query?.agentId || '').trim();
      if (!agentId) return res.status(400).json({ success: false, error: 'agentId is required' });
      try {
        const agent = db.prepare('SELECT agent_id, imUid, delivery_modes, backend_type FROM agents WHERE agent_id=? LIMIT 1').get(agentId);
        const deliveryStatus = (global as any).__dispatcher?.getAgentDeliveryStatus?.(agentId) || null;
        const checkpoints = db.prepare(`
          SELECT namespace, scope_key, cursor_kind, committed_value, pending_value, revision
          FROM sync_checkpoints WHERE namespace LIKE 'mcp.%' OR namespace='offline_messages'
          ORDER BY namespace, scope_key
        `).all();
        const messageStats = db.prepare(`
          SELECT channel_id AS channelId, channel_type AS channelType,
                 COUNT(*) AS total,
                 SUM(CASE WHEN is_me=1 THEN 1 ELSE 0 END) AS replies,
                 COUNT(DISTINCT id) AS uniqueIds,
                 COUNT(DISTINCT COALESCE(client_msg_no, id)) AS uniqueTurns
          FROM messages WHERE agent_id=? GROUP BY channel_id, channel_type
        `).all(agentId);
        const agentStatuses: Record<string, any> = {};
        for (const id of Array.from(agentManager?.workers?.keys?.() || [])) {
          agentStatuses[String(id)] = agentManager.getStatus(String(id));
        }
        return res.json({
          success: true,
          agent,
          deliveryStatus,
          checkpoints,
          messageStats,
          imStatus: agentManager?.getStatus?.(agentId) || null,
          agentStatuses,
          hubSummary: agentManager?.getHubSummary?.() || { hubCount: 0, agentCount: 0, hubs: [] },
          providerState: (global as any).__dispatcher?.providers?.['mock-echo']?.getTestState?.() || null,
        });
      } catch (e: any) {
        return res.status(500).json({ success: false, error: e?.message || 'runtime snapshot failed' });
      }
    });
  }

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
      currentWebRouter = reloaded(handlers, db, webRouterOptions || { getToolList: () => getToolList(mcpServer) });
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
    pid: process.pid,
    port: __runtimePort || port,
    version: pkg.version,
    edition: 'lite',
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
      const { visitorId, message, agentId, messageId } = req.body || {};
      if (!agentId || !visitorId || !message) return res.json({ success: false, error: '缺少参数' });
      const dispatcher = (global as any).__dispatcher;
      if (!dispatcher) return res.json({ success: false, error: 'dispatcher 未初始化' });
      // 统一走 dispatcher 决策：连接就绪则 push，否则留库等 agent pull
      dispatcher.dispatch(agentId, {
        agentId, fromUid: visitorId, content: message, channelId: visitorId,
        channelType: 1, contentType: 1, messageId: String(messageId || ''), timestamp: Math.floor(Date.now() / 1000)
      });
      res.json({ success: true });
    } catch (e: any) { res.json({ success: false, error: e.message }); }
  });

  // ── Steer 注入（desktop owner-intervention:steer-to-agent → 此端点） ──
  app.post('/api/owner-intervention/steer', async (req?: any, res?: any) => {
    try {
      const { agentId, visitorId, content, interventionId, conversationId, sourceMessageId } = req.body || {};
      if (!agentId || !visitorId || !content) return res.json({ success: false, error: '缺少参数' });
      const dispatcher = (global as any).__dispatcher;
      if (!dispatcher) return res.json({ success: false, error: 'dispatcher 未初始化' });
      const preciseIntervention = isRoutingFeatureEnabled(db, 'web_intervention_precise_route_v1', true);
      const channelType = Number(req.body?.channelType) === 2 ? 2 : 1;
      const channelId = String(req.body?.channelId || visitorId).replace(/^group:/, '');
      let selectedConversationId = String(conversationId || '');
      if (preciseIntervention && !selectedConversationId && interventionId) {
        selectedConversationId = String(db.prepare(`SELECT routing_conversation_id FROM owner_interventions
          WHERE id=? AND agent_id=? LIMIT 1`).get(interventionId, agentId)?.routing_conversation_id || '');
      }
      if (preciseIntervention && !selectedConversationId && sourceMessageId) {
        selectedConversationId = String(db.prepare(`SELECT conversation_id FROM provider_message_routes
          WHERE message_id=? AND agent_id=? AND channel_id=? AND channel_type=? AND status='active'
          ORDER BY created_at DESC LIMIT 1`).get(sourceMessageId, agentId, channelId, channelType)?.conversation_id || '');
      }
      if (preciseIntervention && !selectedConversationId) {
        const candidates = db.prepare(`SELECT id FROM provider_routing_conversations
          WHERE agent_id=? AND channel_id=? AND channel_type=? AND status='active' LIMIT 2`)
          .all(agentId, channelId, channelType);
        if (candidates.length === 1) selectedConversationId = candidates[0].id;
        else if (candidates.length > 1) return res.status(409).json({ success: false, code: 'CONVERSATION_REQUIRED', error: 'Multiple Provider conversations are available' });
      }
      let replyRouteContext: any = null;
      if (preciseIntervention && selectedConversationId) {
        const conversation = db.prepare(`SELECT id,provider_family,provider_instance_key,native_session_id
          FROM provider_routing_conversations WHERE id=? AND agent_id=? AND channel_id=? AND channel_type=? AND status='active' LIMIT 1`)
          .get(selectedConversationId, agentId, channelId, channelType);
        if (!conversation?.provider_family || !conversation?.native_session_id) {
          return res.status(409).json({ success: false, code: 'EXACT_SESSION_UNAVAILABLE', error: 'The original Provider session cannot be restored' });
        }
        replyRouteContext = { strictSessionRoute: true, conversationId: conversation.id,
          providerFamily: conversation.provider_family, providerInstanceKey: conversation.provider_instance_key || null,
          nativeSessionId: conversation.native_session_id };
      }
      const enriched = '[Owner Instruction] ' + content;
      // dispatcher.steer 统一构造 sessionKey + hermes 补偿 emit（在 dispatcher 内）
      const r = await dispatcher.steer(agentId, visitorId, enriched, {
        interventionId, channelId, channelType, replyRouteContext,
      });
      res.json({
        success: r?.success !== false,
        deliveryOutcome: r?.deliveryOutcome || (r?.success === false ? 'outcome_unknown' : 'delivered'),
        output: r?.output || '',
        ...(r?.error ? { error: r.error } : {}),
      });
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
      const saved = createDatabaseAPI(db).saveOwnerIntervention(intervention);
      if (saved?.success === false) return res.status(saved.code === 'CONVERSATION_REQUIRED' ? 409 : 400).json(saved);
      res.json({ success: true, id: intervention.id, conversationId: intervention.routingConversationId || null });
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
  app.post('/api/agent/register-in-db', async (req?: any, res?: any) => {
    try {
      const { registerAgentInDbOnDb } = require('./core/agent-registration');
      const body = req.body || {};
      const result = registerAgentInDbOnDb(db, body);
      let imConnection: any = null;
      let warning: string | null = null;
      let workerStatus = result.success === false ? 'failed' : 'not_started';
      // 注册成功后启动 Worker，并等待短暂的真实连接结果；连接瞬时失败不
      // 回滚已完成的注册，只把状态明确返回给调用方，稍后可用 start_worker 重试。
      if (result.success !== false && body.agentId && body.uid && body.token) {
        const { agentId, uid, token, serverUrl, backendType } = body;
        try {
          let status = await agentManager.start(agentId, { uid, token, serverUrl, backendType: normalizeBackendType(backendType) });
          if (status && typeof status === 'object' && status.status === 'connecting' && agentManager.waitForConnection) {
            const waited = await agentManager.waitForConnection(agentId, 5000);
            if (waited) status = waited;
          }
          if (status && typeof status === 'object') {
            const connected = status.connected === true || status.status === 'connected';
            imConnection = { connected, status: status.status || (connected ? 'connected' : 'unknown') };
            workerStatus = status.error || status.status === 'connect_fail' ? 'failed' : connected ? 'running' : 'starting';
            if (!connected) warning = 'Agent 已创建，IM 连接仍在建立，可稍后通过 start_worker 重试';
            if (status.error || status.status === 'connect_fail') {
              warning = status.error || 'Agent 已创建，但 IM 连接失败，可稍后通过 start_worker 重试';
            }
          }
        } catch (e: any) {
          workerStatus = 'failed';
          warning = 'Agent 已创建，但 IM Worker 启动失败，可稍后通过 start_worker 重试';
          console.error('[Lite] 注册后启动 Worker 失败:', body.agentId, e.message);
        }
      }
      const providerDelivery = body.agentId
        ? ((global as any).__dispatcher?.getAgentDeliveryStatus?.(body.agentId) || null)
        : null;
      res.json({
        ...result,
        ...(result.success !== false ? { creationStatus: 'created', workerStatus } : {}),
        ...(imConnection ? { imConnection } : {}),
        ...(providerDelivery ? { providerDelivery } : {}),
        ...(workerStatus !== 'running' && result.success !== false ? {
          recoveryAction: { action: 'start_worker', agentId: body.agentId, message: '可稍后通过 start_worker 重试 IM 连接' },
        } : {}),
        ...(warning ? { warning } : {}),
      });
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
      const prevSnap = db.prepare('SELECT backend_type, backend_instance_id, delivery_modes, imUid, imToken, im_server_url FROM agents WHERE agent_id=?').get(agentId);
      const result = updateAgentBindingOnDb(db, { agentId, updates: safeUpdates });
      let runtimeRebind: any;
      if (result.success !== false) runtimeRebind = await runRebindForRoute(db, agentId, prevSnap);
      res.json(runtimeRebind ? { ...result, runtimeRebind } : result);
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
      let runtimeRebind: any;
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
        const prevSnap = db.prepare('SELECT backend_type, backend_instance_id, delivery_modes, imUid, imToken, im_server_url FROM agents WHERE agent_id=?').get(agentId);
        // 补 updated_at（原实现遗漏，修复一致性）
        sets.push('updated_at = ?'); vals.push(Date.now());
        vals.push(agentId);
        db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE agent_id = ?`).run(...vals);
        runtimeRebind = await runRebindForRoute(db, agentId, prevSnap);
      }
      res.json(runtimeRebind ? { success: true, runtimeRebind } : { success: true });
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
      const prevSnap = db.prepare('SELECT backend_type, backend_instance_id, delivery_modes, imUid, imToken, im_server_url FROM agents WHERE agent_id=?').get(agentId);
      const result = await publishAgent({
        db, agentId,
        startAgentWorker: (id?: any, cfg?: any) => agentManager.start(id, cfg),
        waitForAgentConnection: (id?: any, timeoutMs?: any) => agentManager.waitForConnection(id, timeoutMs),
        stopAgentWorker: (id?: any) => agentManager.stop(id),
        registerCapabilities: (id?: any) => registerCapabilitiesForAgent({ db, agentId: id }),
        updateAgentProfile: (params?: any) => updateAgentProfile({ db, ...params }),
        setAgentStatus: (params?: any) => setAgentStatus({ db, ...params }),
        endpoints: require('./endpoints.json'),
      });
      if (result?.success !== false) {
        const runtimeRebind = await runRebindForRoute(db, agentId, prevSnap);
        if (runtimeRebind) (result as any).runtimeRebind = runtimeRebind;
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
      res.json(await handlers.restart_agent_runtime());
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
    const row = db.prepare('SELECT backend_type FROM agents WHERE agent_id=? LIMIT 1').get(agentId);
    if (!row || !currentOwnsAgent(agentId) || row.backend_type !== 'openclaw') return res.status(403).json({ success: false, error: 'Forbidden' });
    try {
      res.json({ success: true, data: agentFiles.getAgentFiles(agentId) });
    } catch (e: any) { res.json({ success: false, error: e.message }); }
  });
  app.get('/api/agent/file', (req?: any, res?: any) => {
    const { agentId, filename } = req.query;
    if (!agentId || !filename) return res.json({ success: false, error: '缺少参数' });
    const row = db.prepare('SELECT backend_type FROM agents WHERE agent_id=? LIMIT 1').get(agentId);
    if (!row || !currentOwnsAgent(agentId) || row.backend_type !== 'openclaw') return res.status(403).json({ success: false, error: 'Forbidden' });
    try {
      res.json({ success: true, data: agentFiles.readFile(agentId, filename) });
    } catch (e: any) { res.json({ success: false, error: e.message }); }
  });
  app.post('/api/agent/file', (req?: any, res?: any) => {
    const { agentId, filename, content } = req.body || {};
    if (!agentId || !filename || content === undefined) return res.json({ success: false, error: '缺少参数' });
    const row = db.prepare('SELECT backend_type FROM agents WHERE agent_id=? LIMIT 1').get(agentId);
    if (!row || !currentOwnsAgent(agentId) || row.backend_type !== 'openclaw') return res.status(403).json({ success: false, error: 'Forbidden' });
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

  // ── 短期上传授权（前端直传对象存储，不接触长期凭证） ──
  app.post('/api/oss-signature', async (req?: any, res?: any) => {
    try {
      const { filename, agentId, contentType, size, targetScopeType, targetScopeId, channelType, channelId } = req.body || {};
      if (!filename) return res.json({ success: true }); // CLI 连通性测试（空 body）
      if (!agentId || !currentOwnsAgent(agentId)) return res.status(403).json({ success: false, error: 'Forbidden' });
      const safeName = path.basename(String(filename)).replace(/[^a-zA-Z0-9._-]/g, '_').slice(-160);
      if (!safeName || safeName === '.' || safeName === '..') return res.status(400).json({ success: false, error: 'Invalid filename' });
      const ownerEmail = getPrimaryOwnerEmail(db);
      const token = ownerEmail ? getUserAccessToken(db, ownerEmail) : null;
      const resolvedScopeType = targetScopeType || (Number(channelType) === 2 ? 'group' : 'private');
      const resolvedScopeId = targetScopeId || channelId || null;
      const data = await generateOSSSignature({ userAccessToken: token, agentId, purpose: 'agent_attachment', fileName: safeName,
        size, contentType, targetScopeType: resolvedScopeType, targetScopeId: resolvedScopeId,
        idempotencyKey: String(req.get('idempotency-key') || `lite-web-${require('crypto').randomUUID()}`) });
      res.json({ success: true, data });
    } catch (e: any) { res.json({ success: false, error: e.message }); }
  });

  app.get('/api/uploads/:uploadId/download', async (req?: any, res?: any) => {
    try {
      const ownerEmail = getPrimaryOwnerEmail(db);
      const token = ownerEmail ? getUserAccessToken(db, ownerEmail) : null;
      if (!token) return res.status(401).end();
      const referer = String(req.get('referer') || '');
      const match = referer.match(/\/agents\/([^/?#]+)/);
      const agentId = match ? decodeURIComponent(match[1]) : String(req.query?.agentId || '');
      const channelType = Number(req.query?.channelType) === 2 ? 2 : 1;
      const targetScopeType = channelType === 2 ? 'group' : 'private';
      const targetScopeId = String(req.query?.channelId || '');
      const data = await require('./server/oss').getUploadDownload(req.params.uploadId, token, agentId || undefined,
        targetScopeType, targetScopeId || undefined);
      res.set('Cache-Control', 'no-store');
      res.redirect(302, data.url);
    } catch (_error: any) { res.status(404).end(); }
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
    'agent-delivery:status',
    'owner-intervention:new', 'owner-intervention:email-reply',
    'owner-intervention:updated', 'channels:test-success',
    'wechat:session-expired', 'owner-reply', 'owner-chat:updated', 'voko:notification', 'user:switched'];
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
  const { A2AModule, A2ARegistrationService } = require('./a2a');
  // A2A 状态必须与当前主库实例同位。测试、多实例或 --db 启动不得
  // 回落到默认用户目录的生产 voko-a2a.db，否则恢复扫描会误判正在执行的 Task。
  const mainDatabasePath = String(db._dbPath || '').trim();
  const a2aDatabasePath = String(process.env.VOKO_A2A_DB_PATH || '').trim()
    || path.join(path.dirname(path.resolve(mainDatabasePath)), 'voko-a2a.db');
  const a2aModule = new A2AModule({ databasePath: a2aDatabasePath });
  let a2aMailboxClient: any = null;
  const a2aOwnerToken = userEmail ? getUserAccessToken(db, userEmail) : null;
  const syncA2ARegistration = userEmail && a2aOwnerToken ? () => a2aModule.withDatabase((a2aDb: any) => {
    const endpoints = require('./endpoints.json');
    return new A2ARegistrationService({ mainDb: db, a2aDb, apiBaseUrl: endpoints.api.baseUrl,
      ownerEmail: userEmail, userAccessToken: a2aOwnerToken }).ensureRegistered();
  }) : undefined;
  if (a2aModule.enabled) {
    await taskManager.start('a2a-module', () => a2aModule.start());
  }
  const { createOwnerPullCallerAuthorizer, OwnerCommandProcessor, OwnerEventOutbox, OwnerGatewayKeyStore,
    OwnerLinkBridge, OwnerLinkIngress, OwnerLinkModule, OwnerPullService, matchesLocalAgentIdentity } = require('./owner-link');
  const ownerLinkModule = new OwnerLinkModule();
  let ownerLinkBridge: any = null;
  let ownerChatBridge: any = null;
  let ownerChatReadStore: any = null;
  let ownerPullService: any = null;
  if (ownerLinkModule.enabled) {
    try {
      await taskManager.start('owner-link-module', () => ownerLinkModule.start());
      const ownerKeyStore = new OwnerGatewayKeyStore(ownerLinkModule.getDatabase());
      ownerKeyStore.configureFromEnvironment(process.env);
      ownerLinkBridge = new OwnerLinkBridge({
        database: ownerLinkModule.getDatabase(),
        resolvePublicKey: (keyId: string) => ownerKeyStore.resolve(keyId),
        matchesAgentId: (localAgentId: string, envelopeAgentId: string) => {
          const row = db.prepare('SELECT did,owner_email,publish_status FROM agents WHERE agent_id=? LIMIT 1').get(localAgentId);
          const currentOwner = String(getCurrentUserEmail(db) || '').trim().toLowerCase();
          return !!currentOwner && String(row?.owner_email || '').trim().toLowerCase() === currentOwner
            && row?.publish_status === 'published' && matchesLocalAgentIdentity(localAgentId, row?.did, envelopeAgentId);
        },
      });
      const { initOwnerChatSchema, OwnerChatBridge, OwnerChatReadStore } = require('./owner-chat');
      initOwnerChatSchema(ownerLinkModule.getDatabase());
      ownerChatReadStore = new OwnerChatReadStore(ownerLinkModule.getDatabase());
      ownerChatBridge = new OwnerChatBridge({
        database: ownerLinkModule.getDatabase(),
        resolvePublicKey: (keyId: string) => ownerKeyStore.resolve(keyId),
        matchesAgentId: (localAgentId: string, envelopeAgentId: string) => {
          const row = db.prepare('SELECT did FROM agents WHERE agent_id=? LIMIT 1').get(localAgentId);
          return matchesLocalAgentIdentity(localAgentId, row?.did, envelopeAgentId);
        },
      });
      ownerChatBridge.setMessageHandler((messageId: string) => {
        const row = ownerLinkModule.getDatabase().prepare('SELECT local_agent_id,conversation_id FROM owner_chat_messages WHERE message_id=? LIMIT 1').get(messageId);
        if (row) require('./core/lite-bus').emit('owner-chat:updated', { agentId: row.local_agent_id, conversationId: row.conversation_id });
      });
    } catch (error: any) {
      console.error('[Owner Link] 安全入口初始化失败，Owner 专用消息将被拒绝:', error.message);
    }
  }
  const ownerLinkIngress = new OwnerLinkIngress(ownerLinkBridge);
  const litePort = parseInt(args.port, 10) || 3100;

  // ── 初始化文件日志（写入 voko-im.log，仅首次生效） ──
  if (!(global as any).__vokoFileLoggerStarted) { (global as any).__vokoFileLoggerStarted = true; _initFileLogger(); }

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
  // 未登录时不启动任何本机 Agent；不能把本地数据库中的其他主人 Agent
  // 当作当前实例恢复，更不能触发它们的离线消息同步。
  const published = userEmail
    ? db.prepare("SELECT * FROM agents WHERE publish_status = 'published' AND LOWER(TRIM(owner_email)) = ?").all(userEmail)
    : [];
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
    if (a2aModule.enabled && dispatcher) {
      try {
        const { A2ABridgeRuntime } = require('./a2a');
        if (syncA2ARegistration) {
          const bridgeConfig = await syncA2ARegistration();
          const { A2AMailboxClient } = require('./a2a');
          a2aMailboxClient = new A2AMailboxClient({ baseUrl: bridgeConfig.mailboxUrl, token: bridgeConfig.token });
        }
        const a2aRuntime = new A2ABridgeRuntime({ database: a2aModule.getDatabase(), mainDatabase: db, dispatcher,
          onError: (code: string) => console.error(`[A2A Bridge] ${code}`) });
        await taskManager.start('a2a-bridge', () => a2aRuntime.start());
      } catch (error: any) {
        console.error('[A2A Bridge] 启动失败，现有 VOKO 功能继续运行:', error.message);
      }
    }
  } catch (e: any) {
    console.error('[Lite] 创建后端处理器失败:', e.message);
  }

  if (ownerLinkBridge && ownerLinkModule.dispatchEnabled && dispatcher) {
    const resolveOwnerAgentIdentity = (agentId: string) => {
      const currentOwner = String(getCurrentUserEmail(db) || '').trim().toLowerCase();
      if (!currentOwner) return null;
      const row = db.prepare(`SELECT agent_id,did,imUid,private_key,owner_email,publish_status
        FROM agents WHERE agent_id=? LIMIT 1`).get(agentId);
      if (!row || String(row.owner_email || '').trim().toLowerCase() !== currentOwner
          || row.publish_status !== 'published' || !row.imUid || !row.private_key) return null;
      return { privateKey: row.private_key, keyId: row.did || row.agent_id, imUid: row.imUid };
    };
    const ownerProcessor = new OwnerCommandProcessor({
      store: ownerLinkBridge.store,
      dispatcher,
      dispatchEnabled: true,
      resolveAgentIdentity: resolveOwnerAgentIdentity,
    });
    ownerLinkBridge.setCommandHandler((messageId: string) => ownerProcessor.process(messageId));
    for (const messageId of ownerLinkBridge.store.listProcessableCommands()) {
      queueMicrotask(() => void ownerProcessor.process(messageId).catch((error: any) => {
        console.error('[Owner Link] 待处理命令恢复失败:', error?.code || 'OWNER_COMMAND_PROCESS_FAILED');
      }));
    }
    const ownerOutbox = new OwnerEventOutbox(ownerLinkBridge.store, { deliver }, 2_000, (row: any) => {
      const localAgentId = String(row.local_agent_id || row.agent_id || '');
      const identity = resolveOwnerAgentIdentity(localAgentId);
      if (!identity) return false;
      const liveUid = agentManager.getStatus?.(localAgentId)?.uid;
      return !liveUid || liveUid === identity.imUid;
    });
    await taskManager.start('owner-link-outbox', () => ownerOutbox.start());
    const { getProviderCaller } = require('./core/registration-caller-context');
    ownerPullService = new OwnerPullService({
      store: ownerLinkBridge.store,
      resolveAgentIdentity: resolveOwnerAgentIdentity,
      authorizeAgent: createOwnerPullCallerAuthorizer(db, getProviderCaller),
    });
  }

  if (ownerChatBridge && ownerLinkModule.dispatchEnabled && dispatcher) {
    const { OwnerChatInboxRecovery, OwnerChatOutbox, OwnerChatProcessor } = require('./owner-chat');
    const resolveOwnerChatAgentIdentity = (agentId: string) => {
      const currentOwner = String(getCurrentUserEmail(db) || '').trim().toLowerCase();
      if (!currentOwner) return null;
      const row = db.prepare(`SELECT agent_id,did,imUid,private_key,owner_email,publish_status
        FROM agents WHERE agent_id=? LIMIT 1`).get(agentId);
      if (!row || String(row.owner_email || '').trim().toLowerCase() !== currentOwner
          || row.publish_status !== 'published' || !row.imUid || !row.private_key) return null;
      return { privateKey: row.private_key, keyId: row.did || row.agent_id, imUid: row.imUid };
    };
    const ownerChatProcessor = new OwnerChatProcessor({ database: ownerLinkModule.getDatabase(), dispatcher,
      resolveAgentIdentity: resolveOwnerChatAgentIdentity });
    const ownerChatDatabase = ownerLinkModule.getDatabase();
    const emitOwnerChatUpdate = (messageId: string) => {
      const row = ownerChatDatabase.prepare('SELECT local_agent_id,conversation_id FROM owner_chat_messages WHERE message_id=? LIMIT 1').get(messageId);
      if (row) require('./core/lite-bus').emit('owner-chat:updated', { agentId: row.local_agent_id, conversationId: row.conversation_id });
    };
    ownerChatBridge.setMessageHandler(async (messageId: string) => {
      emitOwnerChatUpdate(messageId);
      try { return await ownerChatProcessor.process(messageId); }
      finally { emitOwnerChatUpdate(messageId); }
    });
    ownerChatBridge.setControlHandler(async (control: any) => {
      if (control.operation === 'approval') {
        return dispatcher.respondOwnerApproval(control.localAgentId,String(control.payload?.approvalId||''),control.payload?.decision);
      }
      if (control.operation === 'cancel') return dispatcher.cancelOwnerTurn(control.localAgentId,control.conversationId);
      return false;
    });
    const ownerChatRecovery = new OwnerChatInboxRecovery(ownerChatDatabase, ownerChatProcessor, 2000,
      (event: any) => require('./core/lite-bus').emit('owner-chat:updated', event));
    await taskManager.start('owner-chat-inbox-recovery', () => ownerChatRecovery.start());
    const ownerChatOutbox = new OwnerChatOutbox(ownerChatDatabase, { deliver }, 2000,
      (event: any) => require('./core/lite-bus').emit('owner-chat:updated', event));
    await taskManager.start('owner-chat-outbox', () => ownerChatOutbox.start());
  }

  let ownerInterventionNotifier: any = null; // 在后面创建，供 callback 闭包引用

  // ── 创建 MessageHandler（消息转发/审核/计费） ──
  try {
    const audit = require('./core/audit');
    const safetyClassifier = require('./core/safety-classifier');
    const groupClient = require('./core/group-client');
    const groupRouteContext = {
      query: (sql: string, params: unknown[] = []) => db.prepare(sql).all(...params),
    };
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
      classifyAuditDecision: (msg?: any, dir?: any, decision?: any) =>
        safetyClassifier.classifyUncertain(db, msg, dir, decision),
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
      createPendingPayment: (agentId: string, visitorId: string, fromUid: string, pricing: any, _timestamp: number, sourceMessageId?: string) => {
        void (async () => {
          const { resolveOwnerInterventionConversation } = require('./core/owner-intervention-routing');
          const resolution = resolveOwnerInterventionConversation(db, {
            agentId, channelId: visitorId, channelType: 1, sourceMessageId: sourceMessageId || null,
          });
          if (resolution.status === 'selection_required') {
            console.warn('[Payment] timed order requires an explicit Conversation; order was not created');
            return;
          }
          const now = Date.now();
          const order = {
            id: `timed_${now}_${Math.random().toString(36).slice(2, 8)}`,
            agent_id: agentId, visitor_id: visitorId, from_uid: fromUid,
            amount: Number(pricing.price || 0),
            description: `Timed service (${Number(pricing.duration_minutes || 0)} minutes)`,
            type: 'timed', status: 'pending', created_at: now, updated_at: now,
            routing_conversation_id: resolution.status === 'resolved' ? resolution.conversationId : null,
          };
          const saved = databaseAPI.savePaymentOrder(order);
          if ((saved as any)?.success === false) throw new Error((saved as any).error || 'payment order persistence failed');
          await require('./core/payment').processPendingPaymentOrder(order, {
            db, databaseAPI, agentWorkers: agentManager.workers, deliver, sendMessage,
            endpoints: require('./endpoints.json'),
          });
        })().catch((error: any) => console.error('[Payment] timed order creation failed:', error.message));
      },
      getGroupInfo: (agentId: string, channelId: string) =>
        groupClient.getInfo(groupRouteContext, { agentId, channelId }),
      onOwnerInterventionNew: () => { const bus = require('./core/lite-bus'); bus.emit('owner-intervention:new'); },
    });
    messageHandler?.setDispatcher(dispatcher);
  } catch (e: any) {
    console.error('[Lite] 创建 MessageHandler 失败:', e.message);
  }

  let e2eeCanaryRuntime: any = null;
  let e2eeDatabase: any = null;
  try {
    const { CanaryRuntimePolicy } = require('./e2ee/canary-policy');
    const canaryPolicy = new CanaryRuntimePolicy(process.env, false);
    const productionEnabled = process.env.VOKO_E2EE_PRODUCTION_ENABLED === 'true';
    if (canaryPolicy.enabled && productionEnabled) throw new Error('Canary and production E2EE cannot be enabled together');
    if (canaryPolicy.enabled || productionEnabled) {
      let endpoint = String(productionEnabled ? process.env.VOKO_E2EE_ENDPOINT : process.env.VOKO_E2EE_CANARY_ENDPOINT || '').trim();
      if (!endpoint || !path.isAbsolute(endpoint)) throw new Error(`${productionEnabled ? 'VOKO_E2EE_ENDPOINT' : 'VOKO_E2EE_CANARY_ENDPOINT'} must be an absolute path`);
      if (productionEnabled) {
        const { verifyNativeE2eeRelease } = require('./e2ee/native-release');
        endpoint = verifyNativeE2eeRelease({ executable:endpoint,
          manifestPath:String(process.env.VOKO_E2EE_ENDPOINT_MANIFEST || ''),
          publicKeyPem:String(process.env.VOKO_E2EE_RELEASE_PUBLIC_KEY_PEM || '').replace(/\\n/g,'\n') });
      }
      const { CanaryStore } = require('./e2ee/canary-store');
      const { CanaryRuntime } = require('./e2ee/canary-runtime');
      const { CanaryCryptoProcess } = require('./e2ee/canary-crypto-process');
      const { DatabaseSync } = require('node:sqlite');
      const defaultE2eePath = path.join(path.dirname(String(db._dbPath || '')), 'voko-e2ee.db');
      const e2eePath = path.resolve(String(process.env.VOKO_E2EE_DB_PATH || defaultE2eePath));
      if (e2eePath === path.resolve(String(db._dbPath || ''))) throw new Error('VOKO_E2EE_DB_PATH must differ from the main database');
      fs.mkdirSync(path.dirname(e2eePath), { recursive: true });
      e2eeDatabase = new DatabaseSync(e2eePath);
      e2eeDatabase.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
      let e2eeStore: any;
      let e2eePolicy: any = canaryPolicy;
      let migrated = { sessions:0,receipts:0 };
      const e2eeOwnerToken = productionEnabled && userEmail ? getUserAccessToken(db,userEmail) : null;
      if (productionEnabled) {
        const { ProductionE2eeStore } = require('./e2ee/production-store');
        const { ProductionE2eePolicy } = require('./e2ee/production-policy');
        e2eeStore = new ProductionE2eeStore(e2eeDatabase);
        e2eePolicy = new ProductionE2eePolicy(e2eeStore,true);
      } else {
        e2eeStore = new CanaryStore(e2eeDatabase);
        migrated = e2eeStore.migrateLegacy(db);
      }
      e2eeCanaryRuntime = new CanaryRuntime({ policy: e2eePolicy, store: e2eeStore,
        crypto: new CanaryCryptoProcess(endpoint), dispatcher,
        deliverRaw: async (agentId: string, channelId: string, envelope: string, messageId: string) => {
          const result = await agentManager.deliverEncrypted(agentId,channelId,envelope,messageId);
          if (!result?.success) {
            const error: any = new Error(result?.error || 'E2EE_REPLY_NOT_DELIVERED');
            error.deliveryOutcome = result?.outcomeUnknown ? 'outcome_unknown' : 'not_delivered';
            throw error;
          }
          return result;
        },
        downloadAttachment: productionEnabled && e2eeOwnerToken ? async (agentId: string, uploadId: string, targetScopeId: string) => {
          const { getUploadDownload } = require('./server/oss');
          const metadata = await getUploadDownload(uploadId,e2eeOwnerToken,agentId,'private',targetScopeId);
          const url = String(metadata?.url || '');
          if (!/^https:\/\//i.test(url)) throw new Error('E2EE_ATTACHMENT_DOWNLOAD_URL_INVALID');
          const response = await fetch(url,{signal:AbortSignal.timeout(15_000)});
          const length = Number(response.headers.get('content-length') || 0);
          if (!response.ok || !Number.isSafeInteger(length) || length < 2 || length > 40*1024*1024) {
            throw new Error('E2EE_ATTACHMENT_DOWNLOAD_INVALID');
          }
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (bytes.byteLength !== length) throw new Error('E2EE_ATTACHMENT_DOWNLOAD_TRUNCATED');
          return bytes;
        } : undefined });
      if (productionEnabled) {
        const { E2eeDirectoryClient } = require('./e2ee/directory-client');
        const { ProductionE2eeDirectoryWorker } = require('./e2ee/production-directory-worker');
        const { PendingRecipientProcess } = require('./e2ee/canary-crypto-process');
        const { serverAgentIdFromDid } = require('./core/agent-invitations');
        const nodeCrypto = require('node:crypto');
        const ownerToken = e2eeOwnerToken;
        if (!ownerToken) throw new Error('E2EE production requires an authenticated owner token');
        const apiBaseUrl = String(require('./endpoints.json').api.baseUrl || '');
        const deviceGeneration = e2eeStore.deviceGeneration(() => nodeCrypto.randomUUID());
        const configuredAgentIds = new Set(String(process.env.VOKO_E2EE_PRODUCTION_AGENT_IDS || '')
          .split(',').map(value => value.trim()).filter(Boolean));
        const agents = () => (db.prepare(`SELECT agent_id,did FROM agents
          WHERE publish_status='published' AND LOWER(owner_email)=LOWER(?) AND did IS NOT NULL AND TRIM(did)<>''`).all(userEmail) as any[])
          .filter((row: any) => configuredAgentIds.size === 0 || configuredAgentIds.has(String(row.agent_id)))
          .flatMap((row: any) => {
            const serverAgentId = serverAgentIdFromDid(row.did);
            if (!serverAgentId) return [];
            const suffix = nodeCrypto.createHash('sha256').update(`${deviceGeneration}\0${serverAgentId}`).digest('base64url').slice(0,32);
            const ownerScope = nodeCrypto.createHash('sha256').update(`voko-e2ee-owner/v1\0${String(userEmail).toLowerCase()}`).digest('base64url');
            return [{ localAgentId:String(row.agent_id),serverAgentId,targetAgentDid:String(row.did),
              ownerDeviceKeyId:`voko-lite-${suffix}`,ownerScope,bindingGeneration:1 }];
          });
        const directoryWorker = new ProductionE2eeDirectoryWorker({
          client:new E2eeDirectoryClient({ baseUrl:apiBaseUrl,token:ownerToken }),store:e2eeStore,agents,
          processFactory:(scope: any) => new PendingRecipientProcess(endpoint,scope),
          onError:(agentId: string,error: any) => console.warn(`[E2EE] Directory同步失败 agent=${agentId} operation=${String(error?.operation || 'local')}: ${String(error?.code || error?.message || 'unknown')}`),
        });
        await taskManager.start('e2ee-production-directory',() => directoryWorker.start());
        console.warn(`[E2EE] 正式运行时已启用，已发布 Agent=${agents().length}`);
      } else {
        console.warn(`[E2EE Canary] 内部运行时已启用，精确范围=${canaryPolicy.count()}（生产发布仍关闭）`);
      }
      if (migrated.sessions || migrated.receipts) console.warn(`[E2EE] 已迁移旧运行状态 sessions=${migrated.sessions} receipts=${migrated.receipts}`);
      await taskManager.start('e2ee-database', () => async () => { try { e2eeDatabase?.close(); } catch (_) {} });
    }
  } catch (error: any) {
    console.error('[E2EE Canary] 初始化失败，所有 E2EE 消息将硬拒绝:', error.message);
  }
  if (messageHandler) {
    messageHandler.handleEncryptedMessage = async (agentId: string, data: any) => {
      if (!e2eeCanaryRuntime) return { handled:true,accepted:false,code:'E2EE_CANARY_DISABLED' };
      return e2eeCanaryRuntime.handle(agentId,data);
    };
  }
  if (e2eeCanaryRuntime) {
    const { CanaryMonitor } = require('./e2ee/canary-monitor');
    const canaryMonitor = new CanaryMonitor(e2eeCanaryRuntime,{ onReport:(report: any) => {
      try { require('./core/lite-bus').emit('e2ee-canary:status',report); } catch (_) {}
    } });
    await taskManager.start('e2ee-canary-monitor',() => canaryMonitor.start());
  }

  // ── 接管 IM Hub 事件：主消息持久化后才向服务端 ACK ──
  agentManager.on('message', (msg?: any) => {
    const data = msg?.data || msg;
    try {
      if (Number(data?.contentType) === 13) {
        if (!e2eeCanaryRuntime) {
          console.warn('[E2EE Canary] 未启用或初始化失败，拒绝密文消息');
          data?.ack?.();
          return;
        }
        void e2eeCanaryRuntime.handle(msg.agentId,data).then((result: any) => {
          if (!result.accepted) console.warn(`[E2EE Canary] 已拒绝消息: ${result.code || 'E2EE_CANARY_REJECTED'}`);
          if (!data?.__e2eeReceiptAcked) data?.ack?.();
        }).catch((error: any) => {
          console.error('[E2EE Canary] 处理异常:', error.message);
          data?.nack?.(error);
        });
        return;
      }
      // When trusted remote is parked, reject both owner protocols before the
      // ordinary visitor handler. This keeps stale/forged owner payloads from
      // being interpreted as normal visitor messages.
      let ownerProtocol = '';
      try {
        const content = typeof data?.content === 'object' ? data.content : JSON.parse(String(data?.content || ''));
        ownerProtocol = String(content?.version || '');
      } catch (_) { /* ordinary text */ }
      if (!ownerLinkModule.enabled && (ownerProtocol === 'voko.owner/1' || ownerProtocol === 'voko.owner.chat/1')) {
        console.warn('[Owner Remote] 已停用，拒绝 Owner 专用消息');
        data?.ack?.();
        return;
      }
      const ownerChatResult = ownerChatBridge?.handle(msg.agentId, data);
      if (ownerChatResult?.handled) {
        if (!ownerChatResult.accepted) console.warn(`[Owner Chat] 已拒绝可信聊天消息: ${ownerChatResult.code || 'OWNER_CHAT_REJECTED'}`);
        data?.ack?.();
        return;
      }
      const ownerResult = ownerLinkIngress.handle(msg.agentId, data);
      if (ownerResult.handled) {
        if (!ownerResult.accepted) {
          console.warn(`[Owner Link] 已拒绝 Owner 专用消息: ${ownerResult.code || 'OWNER_ENVELOPE_REJECTED'}`);
        }
        data?.ack?.();
        return;
      }
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

  // ── 离线消息同步：Agent 连接后拉取服务端缓存消息（突发连接合并为一次全量同步）──
  const { createOfflineSyncCoordinator } = require('./core/offline-sync');
  const offlineSync = createOfflineSyncCoordinator(db, messageHandler);
  await taskManager.start('offline-sync', () => {
    offlineSync.start();
    const onStatus = (msg?: any) => {
      if (msg.status === 'connected') offlineSync.onAgentConnected(msg.agentId);
      if ((msg.status === 'connected' || msg.statusCode === 2) &&
          publishedAgentCount > 0 &&
          agentManager.connectedAgents.size >= publishedAgentCount) {
        offlineSync.onAllReady();
      }
    };
    agentManager.on('status', onStatus);
    return () => {
      offlineSync.stop();
      agentManager.off?.('status', onStatus);
    };
  });

  // ── 将处理器挂在全局，供 startTransport 的 API 路由使用 ──
  (global as any).__openclawHandler = openclawHandler;
  (global as any).__hermesHandler = hermesHandler;
  (global as any).__dispatcher = dispatcher;
  (global as any).__agentManager = agentManager;
  (global as any).__db = db;

  // ── 构造 rebindAgentRuntime（统一 Agent 配置变更后的运行时重绑定）──
  //    串行化：同一 agent 的 rebind 排队执行，避免并发竞争；跨 agent 并行。
  attachRebindAgentRuntime(dispatcher, agentManager, db);

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
      resumeOwnerIntervention: createResumeOwnerIntervention(dispatcher, db),
    });
  } catch (e: any) {
    console.error('[Lite] 渠道初始化失败:', e.message);
  }

  // ── 主人介入通知器 ──
  try {
    ownerInterventionNotifier = new OwnerInterventionNotifier({
      databaseAPI, registry, db,
      getEnabledChannel: databaseAPI.getEnabledChannel,
      buildOwnerReplyPrompt: registry.buildOwnerReplyPrompt,
      agentEmailApi: _agentEmailApi,
      sendSystemMessage: (...a: any) => agentManager.sendSystemMessage(...a),
      resumeOwnerIntervention: createResumeOwnerIntervention(dispatcher, db),
      autoApproveWhitelistIfFriendRequest: (intervention?: any, reply?: any) =>
        messageHandler?.autoApproveWhitelistIfFriendRequest(intervention, reply),
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
        resumeProviderConversation: (conversationId: string, agentId: string, visitorId: string, content: string) =>
          createResumeOwnerIntervention(dispatcher, db)({
            id: `payment_${Date.now()}`, agentId, visitorId,
            sourceSenderUid: visitorId, targetChannelId: visitorId, targetChannelType: 1,
            routingConversationId: conversationId,
          }, content),
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
  (cx as any).a2aMailboxClient = a2aMailboxClient;
  (cx as any).ownerPullService = ownerPullService;
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
  handlers.refresh_delivery_channels = async ({ agentId }: any = {}) => {
    const activeDispatcher = (global as any).__dispatcher;
    if (!activeDispatcher?.refreshAgentDeliveryChannels) return { success: false, error: 'Dispatcher unavailable' };
    return { success: true, agentId, deliveryStatus: await activeDispatcher.refreshAgentDeliveryChannels(String(agentId || '')) };
  };
  handlers.select_delivery_channel = async ({ agentId, mode, providerId }: any = {}) => {
    const activeDispatcher = (global as any).__dispatcher;
    if (!activeDispatcher?.selectTemporaryDeliveryChannel) return { success: false, error: 'Dispatcher unavailable' };
    return { success: true, agentId, deliveryStatus: activeDispatcher.selectTemporaryDeliveryChannel(String(agentId || ''), String(mode || ''), providerId) };
  };
  handlers.restart_agent_runtime = async () => {
    const email = getCurrentUserEmail(db);
    if (!email) return { success: false, error: '未登录' };
    await agentManager.stopAll();
    const agents = db.prepare(
      "SELECT * FROM agents WHERE publish_status = 'published' AND owner_email = ?"
    ).all(email);
    await agentManager.startMany(agents.map((a: any) => ({
      agentId: a.agent_id,
      config: { uid: a.imUid, token: a.imToken, serverUrl: a.im_server_url },
    })));
    const agentList = agents.map((a: any) => ({
      agentId: a.agent_id, agentName: a.agent_name || a.agent_id,
      imConnected: false, automaticDeliveryReady: false,
      automaticReadyModes: [], activeAutomaticMode: null, pullReady: true, pullOnly: false, lastDeliveredMode: null,
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
    try { require('./core/lite-bus').emit('user:switched', { email }); } catch (_: any) {}
    return { success: true, count: agents.length };
  };
  const mcpServer = createMcpServer(handlers, { version: pkg.version });

  // Agent 网页版
  const webSessions = createLocalWebSessionStore(db);
  const webRouterOptions = {
    getToolList: () => getToolList(mcpServer),
    webSessions,
    localAuthToken: process.env.VOKO_MCP_TOKEN || __instanceLock?.metadata?.mcpToken,
    a2aModule,
    a2aMailboxClient,
    syncA2ARegistration,
    trustedRemoteEnabled: ownerLinkModule.trustedRemoteEnabled,
    ownerChatReadStore,
    ownerChatDatabase: ownerLinkModule.running ? ownerLinkModule.getDatabase() : null,
    e2eeCanaryRuntime,
    uploadAgentIcon: async (data: Buffer, name: string, mime: string, agentId: string) => {
      const ownerEmail = getPrimaryOwnerEmail(db);
      const token = ownerEmail ? getUserAccessToken(db, ownerEmail) : null;
      return require('./server/oss').uploadToOSS(name, data, mime, null, { userAccessToken: token, agentId,
        purpose: 'agent_icon', fileName: path.basename(name), referenceType: 'agent_icon', referenceId: agentId || name });
    },
  };
  const webRouter = createWebRouter(handlers, db, webRouterOptions);

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
    webRouterOptions,
  );
}

// ═══════════════════════════════════════════════
//  attachRebindAgentRuntime — 构造并挂载 rebindAgentRuntime 到全局
// ═══════════════════════════════════════════════
// 统一 Agent 配置变更（backend_type / 实例 / IM 凭证）后的运行时重绑定：
// 加载目标 Provider → 失效旧会话绑定 → 清缓存 → 必要时重启当前 agent 的 IM Worker。
// 同一 agent 的 rebind 串行排队，跨 agent 并行；任一失败不外抛。
function attachRebindAgentRuntime(dispatcher: any, agentManager: any, db: any) {
  if (!dispatcher) return;
  const { createRebindAgentRuntime } = require('./core/rebind-agent-runtime');
  const rebindImpl = createRebindAgentRuntime({
    ensureBackend: (type: string) => dispatcher.ensureBackend?.(type) || Promise.resolve(),
    invalidateMeta: (agentId?: string) => dispatcher.invalidateMeta?.(agentId),
    invalidateBindingsForConfigChange: (input: any) =>
      dispatcher.invalidateBindingsForConfigChange?.(input) ?? 0,
    getAgentDeliveryStatus: (agentId: string) => dispatcher.getAgentDeliveryStatus?.(agentId),
    restartAgentWorker: (agentId: string) => agentManager?.restart(agentId),
    forceDeliveryModesPull: (database: any, agentId: string) =>
      database.prepare('UPDATE agents SET delivery_modes=?, updated_at=? WHERE agent_id=?')
        .run(JSON.stringify(['pull']), Date.now(), agentId),
  });
  const rebindLocks = new Map<string, Promise<any>>();
  (global as any).__rebindAgentRuntime = async (input: any) => {
    const prev = rebindLocks.get(input.agentId) || Promise.resolve();
    const next = prev.then(() => rebindImpl(input));
    // 失败不阻塞同 agent 后续 rebind
    rebindLocks.set(input.agentId, next.catch(() => undefined));
    return next;
  };
}

/**
 * HTTP 路由用的 rebind 触发器：在 DB 更新前读 prev 快照，更新后用 prev+当前行(next) 调 rebind。
 * 缺失 rebind（旧环境）时退化为 ensureBackend + invalidateMeta（保持原行为）。
 * 返回 rebind 结果（或 undefined）。
 */
async function runRebindForRoute(db: any, agentId: string, previousSnap: any): Promise<any> {
  const rebind = (global as any).__rebindAgentRuntime;
  if (rebind) {
    const nextRow = db.prepare('SELECT backend_type, backend_instance_id, delivery_modes, imUid, imToken, im_server_url FROM agents WHERE agent_id=?').get(agentId) || {};
    try {
      return await rebind({
        db, agentId,
        previous: {
          backendType: previousSnap.backend_type,
          backendInstanceId: previousSnap.backend_instance_id ?? null,
          deliveryModes: previousSnap.delivery_modes,
          imUid: previousSnap.imUid, imToken: previousSnap.imToken, imServerUrl: previousSnap.im_server_url,
        },
        next: {
          backendType: nextRow.backend_type,
          backendInstanceId: nextRow.backend_instance_id ?? null,
          deliveryModes: nextRow.delivery_modes,
          imUid: nextRow.imUid, imToken: nextRow.imToken, imServerUrl: nextRow.im_server_url,
        },
      });
    } catch (_: any) { return undefined; }
  }
  // 退化路径
  try {
    const cur = db.prepare('SELECT backend_type FROM agents WHERE agent_id=?').get(agentId)?.backend_type;
    await (global as any).__dispatcher?.ensureBackend?.(cur);
    (global as any).__dispatcher?.invalidateMeta?.(agentId);
  } catch (_: any) {}
  return undefined;
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
 * @param {object}   [params.hermesConfig] - { apiHost, apiPort, apiKey, profiles }
 * @param {Function} [params.onAgentReply] - callback(data) 收到 agent 回复时触发
 * @returns {{ openclawHandler: object|null, hermesHandler: object|null }}
 */
function createResumeOwnerIntervention(dispatcher?: any, db?: any) {
  return async function resumeOwnerIntervention(intervention?: any, content?: any) {
    if (!dispatcher || !intervention?.agentId) return { success: false, error: 'dispatcher unavailable' };
    const channelType = Number(intervention.targetChannelType) === 2 ? 2 : 1;
    const channelId = intervention.targetChannelId || intervention.visitorId;
    const senderUid = intervention.sourceSenderUid || intervention.visitorId;
    const sessionTarget = channelType === 2 ? `group:${channelId}` : channelId;
    const conversationId = String(intervention.routingConversationId || intervention.routing_conversation_id || '');
    let replyRouteContext: any = null;
    if (conversationId && db) {
      const conversation = db.prepare(`SELECT id,provider_family,provider_instance_key,native_session_id
        FROM provider_routing_conversations WHERE id=? AND agent_id=? AND channel_id=? AND channel_type=? AND status='active' LIMIT 1`)
        .get(conversationId, intervention.agentId, channelId, channelType);
      if (!conversation?.provider_family || !conversation?.native_session_id) {
        return { success: false, error: 'The original Provider session cannot be restored', code: 'EXACT_SESSION_UNAVAILABLE' };
      }
      replyRouteContext = { strictSessionRoute: true, conversationId: conversation.id,
        providerFamily: conversation.provider_family, providerInstanceKey: conversation.provider_instance_key || null,
        nativeSessionId: conversation.native_session_id };
    }
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
      replyRouteContext,
    });
    if (result && typeof result === 'object' && 'deliveryOutcome' in result) return result;
    if (result === null || result === undefined || result === false) {
      return { success: false, deliveryOutcome: 'not_delivered', error: 'agent unavailable' };
    }
    if (result && typeof result === 'object' && result.success === false) {
      return { ...result, deliveryOutcome: result.deliveryOutcome || 'outcome_unknown' };
    }
    return { success: true, deliveryOutcome: 'delivered', result };
  };
}

function createHandlers({ db, databaseAPI, hermesConfig = {}, onAgentReply, backendTypes, startProviders = true }: any = {}) {
  let openclawHandler = null;
  let hermesHandler = null;
  const providers: Record<string, any> = {};
  const requiredBackends: Set<string> | null = Array.isArray(backendTypes)
    ? new Set(backendTypes.map((value: unknown) => String(value || '').trim()).filter(Boolean))
    : null;
  const needsBackend = (...types: string[]) => !requiredBackends || types.some(type => requiredBackends.has(type));
  const { getProviderFamily, getProviderTransport, listProviderTransports, instantiateProviderTransport } = require('./core/dispatcher/provider-catalog');
  const { resolveGooseCommand } = require('./core/dispatcher/goose-command');
  const { getProviderModularRollout, providerModularModeForFamily } = require('./core/dispatcher/provider-modular-rollout');
  const modularRollout = getProviderModularRollout(db);
  const providerFactoryContext = {
    db,
    contextWindow: 20,
    getProviderConfig(transportId: string) {
      const family = getProviderTransport(transportId)?.family || '';
      const sessionPersistence = providerModularModeForFamily(modularRollout, family) === 'enabled'
        ? 'dispatcher' : 'transport';
      if (transportId === 'goose-cli' || transportId === 'goose-acp') return {
        binPath: resolveGooseCommand(),
        sessionPersistence,
      };
      if (transportId === 'hermes-http') return { ...hermesConfig, sessionPersistence };
      if (transportId === 'workbuddy-http') return { sessionPersistence };
      return { sessionPersistence };
    },
  };

  // ── OpenClaw WebSocket provider（连接/spawn 收敛在 provider 内） ──
  if (needsBackend('openclaw')) try {
    openclawHandler = instantiateProviderTransport(getProviderTransport('openclaw-ws'), providerFactoryContext);
    providers['openclaw-ws'] = openclawHandler;
    const status = openclawHandler.getStatus();
    if (!status.hasToken) console.warn(t('cli.index.gateway_token_needed'));
    console.error('[Lite] OpenClaw WebSocket 处理器已创建（CLI fallback 由 Dispatcher Catalog 管理）');
  } catch (err: any) {
    console.error('[Lite] OpenClaw 处理器创建失败:', err.message);
  }

  // ── Hermes provider（连接/spawn 收敛在 provider 内） ──
  if (needsBackend('hermes')) try {
    hermesHandler = instantiateProviderTransport(getProviderTransport('hermes-http'), providerFactoryContext);
    providers['hermes-http'] = hermesHandler;
    console.error(`[Lite] Hermes 处理器已创建 host=${hermesConfig.apiHost || '127.0.0.1'}:${hermesConfig.apiPort || 8642}`);
  } catch (err: any) {
    console.error('[Lite] Hermes 处理器创建失败:', err.message);
  }

  // CLI, ACP, HTTP and WebSocket transports are all constructed by the Catalog.
  const providerDefinitions = listProviderTransports().filter((definition: any) => !definition.testOnly && !['openclaw-ws', 'hermes-http'].includes(definition.id));
  for (const definition of providerDefinitions) {
    const family = getProviderFamily(definition.family);
    if (!family || !needsBackend(family.type, ...family.aliases)) continue;
    try {
      providers[definition.id] = instantiateProviderTransport(definition, providerFactoryContext);
    } catch (e: any) { console.error(`[Lite] ${definition.id} 注册失败:`, e.message); }
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
          openclawHandler = instantiateProviderTransport(getProviderTransport('openclaw-ws'), providerFactoryContext);
          additions['openclaw-ws'] = openclawHandler;
          (global as any).__openclawHandler = openclawHandler;
        }
        if (type === 'hermes' && !dispatcher.providers['hermes-http']) {
          hermesHandler = instantiateProviderTransport(getProviderTransport('hermes-http'), providerFactoryContext);
          additions['hermes-http'] = hermesHandler;
          (global as any).__hermesHandler = hermesHandler;
        }
        const family = getProviderFamily(type);
        for (const definition of family ? listProviderTransports(family.type).filter((item: any) => !item.testOnly) : []) {
          if (dispatcher.providers[definition.id] || additions[definition.id]) continue;
          additions[definition.id] = instantiateProviderTransport(definition, providerFactoryContext);
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
//  createLiteApp — 已废弃（Desktop/Electron 路径停用）
// ═══════════════════════════════════════════════
// 原 Desktop 程序化入口已停用。保留导出仅为向后兼容，调用方会收到明确错误。
// CLI 运行时请使用 `voko start`（startMcpServer 路径）。
async function createLiteApp(_options?: any): Promise<{ success: false; error: string }> {
  const err = 'createLiteApp 已废弃：Desktop/Electron 路径停用，请改用 `voko start`（CLI 路径）。';
  console.error('[VOKO Lite]', err);
  return { success: false, error: err };
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
  const BASE_URL = process.env.VOKO_E2E_API_BASE_URL || ENDPOINTS.im.baseUrl;

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
    if (isBeating) { console.error('[心跳] 上一轮未结束，跳过本次'); return; }
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
            const profileId = hermesHandler._profileForAgent?.(agent_id);
            if (!profileId) continue;
            try { await hermesHandler._ensureGatewayRunning(profileId); }
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
            backendType: agent.backend_type || null, configuredModes: [], automaticReadyModes: [],
            activeAutomaticMode: null, methods: [], automaticDeliveryReady: false, pullReady: true, pullOnly: false, lastDeliveredMode: null,
          };
        } catch (_) {
          deliveryStatus = {
            backendType: agent.backend_type || null, configuredModes: [], automaticReadyModes: [],
            activeAutomaticMode: null, methods: [], automaticDeliveryReady: false, pullReady: true, lastDeliveredMode: null,
          };
        }
        deliveryStatuses.set(agent.agent_id, deliveryStatus);
        const backendOk = !!deliveryStatus.automaticDeliveryReady;

        if (imOk) imOnline++;
        if (backendOk) backendOnline++;

        const agentName = agent.agent_name || agent.agent_id;
        if (!imOk) warnings.push({ type: 'agent-im-offline', message: `⚠️ ${agentName} IM 连接断开`, action: 'agent-detail', agentId: agent.agent_id });
        if (!backendOk) {
          warnings.push({ type: 'agent-backend-offline', message: `⚠️ ${agentName} 当前没有可用的消息接收方式`, action: 'agent-detail', agentId: agent.agent_id });
        } else {
          const failedConfigured = deliveryStatus.methods?.find((method: any) => method.configured && !method.available && method.status !== 'unknown');
          if (failedConfigured) {
            const activeLabel = deliveryStatus.activeAutomaticMode || 'MCP Pull（按需）';
            const fallbackLabel = deliveryStatus.activeAutomaticMode && deliveryStatus.activeAutomaticMode !== failedConfigured.mode
              ? `已降级到 ${activeLabel}`
              : `当前使用 ${activeLabel}`;
            warnings.push({ type: 'agent-backend-degraded', message: `⚠️ ${agentName} ${failedConfigured.mode} 不可用，${fallbackLabel}`, action: 'agent-detail', agentId: agent.agent_id });
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
      if (onWarnings) onWarnings(warnings);

      // 更新 runtime 标记（连接详情）
      try {
        const prev = db.prepare("SELECT data FROM config WHERE type = 'runtime'").get();
        const prevData = prev ? JSON.parse(prev.data) : {};
        const agentList = rows.map((a: any) => {
          const deliveryStatus = deliveryStatuses.get(a.agent_id) || {
            backendType: a.backend_type || null, configuredModes: [], automaticReadyModes: [],
            activeAutomaticMode: null, methods: [], automaticDeliveryReady: false, pullReady: true, pullOnly: false, lastDeliveredMode: null,
          };
          return {
            agentId: a.agent_id,
            agentName: a.agent_name || a.agent_id,
            imConnected: agentManager?.getStatus(a.agent_id)?.connected || false,
            automaticDeliveryReady: !!deliveryStatus.automaticDeliveryReady,
            automaticReadyModes: deliveryStatus.automaticReadyModes || [],
            activeAutomaticMode: deliveryStatus.activeAutomaticMode || null,
            pullReady: !!deliveryStatus.pullReady,
            pullOnly: !!deliveryStatus.pullOnly,
            lastDeliveredMode: deliveryStatus.lastDeliveredMode || null,
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
            agents: agentList.map((agent: any) => ({
              agentId: agent.agentId,
              imConnected: agent.imConnected,
              messageMode: agent.activeAutomaticMode
                || agent.automaticReadyModes?.[0]
                || (agent.pullReady ? 'pull' : null),
              messageModeDetected: true,
              activeAutomaticMode: agent.activeAutomaticMode || null,
              automaticReadyModes: agent.automaticReadyModes || [],
              pullReady: !!agent.pullReady,
              pullOnly: !!agent.pullOnly,
            })),
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
    '  voko doctor [--json]       Read-only runtime and configuration diagnosis\n' +
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
    '  voko probe --agent-id ID --visitor-id UID --confirm\n' +
    '                             Send one acknowledged real Provider/IM probe\n' +
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
    '  voko list_agents                              List registered agents\n' +
    '  voko send_message --agent X --toUid Y --content "hi"\n' +
    '  voko list_conversations --agent X\n' +
    '  voko --tools\n' +
    '\n' +
    t('cli.usage.tools_header') + '\n' +
    '  manage_agent_registration\n' +
    '  update_agent_profile  set_agent_status  get_status  get_agent_profile\n' +
    '  search_capabilities  declare_capabilities\n' +
    '  send_message  get_chat_history  fetch_new_messages\n' +
    '  get_visitor_profile  list_conversations  list_routing_conversations  mark_conversation_read\n' +
    '  upload_and_send_file  whoami  list_agents  start_worker  stop_worker\n' +
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

  // login is interactive by design, but --help must remain usable in CI,
  // SSH and other non-TTY environments without initializing the runtime.
  if (subcommand === 'login' && (args.help || args.h)) {
    console.log('Usage: voko login');
    console.log('Interactive login requires a TTY.');
    console.log('Headless login: voko manage_agent_registration --action start --registration-mode agent');
    return;
  }

  // CLI tool 身份：--agent <id> 或环境变量 VOKO_AGENT_ID（注入到需要 agentId 的工具）
  const cliAgent = args.agent || process.env.VOKO_AGENT_ID || null;
  // CLI tool 调用默认静默例行 DB 初始化日志；--verbose / --debug / VOKO_DEBUG 恢复
  const _systemCmds = new Set(['start', 'setup', 'doctor', 'probe', 'mcp', 'stop', 'uninstall', 'status', 'update', 'login', '--help', '-h', '--version', '-v']);
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

  // doctor — read-only local/runtime diagnosis; never initializes Core or workers.
  if (subcommand === 'doctor') {
    if (args.help || args.h) {
      console.log('Usage: voko doctor [--json] [--deep] [--fix-mcp] [--db PATH]');
      console.log('Diagnosis of Node.js, database, Agents, runtime, MCP/IM configuration and provider runtimes.');
      console.log('--fix-mcp migrates unambiguous legacy VOKO MCP entries to the voko mcp stdio command and creates backups.');
      return;
    }
    const { runDoctor, formatDoctor } = require('./core/doctor');
    const result = await runDoctor({
      dbPath: resolveDbPath(args, { silent: true, noCreate: true }),
      deep: !!args.deep,
      fixMcp: !!args['fix-mcp'] || !!args.fixMcp,
    });
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else console.log(formatDoctor(result));
    process.exitCode = result.exitCode;
    return;
  }

  if (subcommand === 'probe') {
    if (args.help || args.h) {
      console.log('Usage: voko probe --agent-id ID --visitor-id UID --confirm [--message TEXT] [--timeout SECONDS]');
      console.log('This invokes the configured Provider and may send one real IM reply.');
      return;
    }
    const result = await cli.runRuntimeProbe(args, resolveDbPath(args, { silent: true, noCreate: true }));
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

  // Registration is stateful and must always run inside the long-lived Lite instance.
  if (subcommand === 'manage_agent_registration') {
    const runtimeDbPath = resolveDbPath(args, { silent: true, noCreate: true });
    const interactive = args.interactive === true || args.interactive === 'true' || args.interactive === '1';
    if (interactive) {
      const { runInteractiveRegistration } = require('./cli-interactive');
      const manage = async (params: any) => {
        const routed = await cli.runRuntimeToolCommand(
          'manage_agent_registration', params, runtimeDbPath,
          { agentId: cliAgent, debug: verbose, print: false },
        );
        return routed?.result || routed;
      };
      await runInteractiveRegistration(null, { manage });
      return;
    }
    const result = await cli.runRuntimeToolCommand(
      'manage_agent_registration', args, runtimeDbPath,
      { agentId: cliAgent, debug: verbose },
    );
    if (!result.success) process.exitCode = 1;
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
    if (!(global as any).__vokoFileLoggerStarted) {
      (global as any).__vokoFileLoggerStarted = true;
      _initFileLogger();
    }
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

module.exports = { initCore, createContext, createLiteApp, createHandlers, createMessageHandler, createResumeOwnerIntervention, startHeartbeat, getCurrentUserEmail, hasGraphicalSession, interactiveStartEnabled, hasAgentForOwner, runHeadlessOnboarding, checkLiteRunning, formatVersionLine, withRuntimeTimestamp, syncOfflineMessages: require('./core/offline-sync').syncOfflineMessages, processPendingPaymentOrder: require('./core/payment').processPendingPaymentOrder, startPaymentPolling: require('./core/payment').startPaymentPolling, AgentWorkerManager };
