/**
 * Resolve the QwenWork/Qwen Office headless runtime.
 *
 * QwenWork's desktop application is an MCP client.  Its Windows bundle also
 * ships `qoderclicn`, which is the local headless runtime used by the VOKO
 * Push transport.  The bundle is an implementation detail, so the resolver
 * accepts an explicit override and otherwise only discovers the installed
 * binary; it never launches the desktop GUI or a shell shim.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { defaultAgentRuntimeResolver } = require('../runtime/agent-runtime-resolver');

const STATUS_CACHE_TTL_MS = 10_000;
const statusCache = new Map<string, { value: QwenOfficeReadiness; expiresAt: number }>();

export interface QwenOfficeReadiness {
  executable: boolean;
  loggedIn: boolean;
  ready: boolean;
  reason: 'ready' | 'not_found' | 'cli_not_logged_in' | 'status_failed';
  version?: string;
}

function localAppDataRoot(env: NodeJS.ProcessEnv): string {
  const configured = String(env.LOCALAPPDATA || '').trim();
  if (configured) return configured;
  const userProfile = String(env.USERPROFILE || '').trim();
  return userProfile ? path.join(userProfile, 'AppData', 'Local') : '';
}

function findBundledQwenCli(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  if (platform === 'darwin') {
    const home = String(env.HOME || '').trim();
    const appNames = ['QwenWorkCN.app', '千问办公.app'];
    const candidates = [
      ...(home ? appNames.map((appName) => path.join(home, 'Applications', appName, 'Contents', 'Resources', 'bin', 'qoderclicn')) : []),
      ...appNames.map((appName) => path.join('/Applications', appName, 'Contents', 'Resources', 'bin', 'qoderclicn')),
    ];
    return candidates.find(candidate => {
      try { return fs.statSync(candidate).isFile(); } catch (_) { return false; }
    }) || null;
  }
  if (platform !== 'win32') return null;
  const localRoot = localAppDataRoot(env);
  const versionsRoots = [
    ...(localRoot ? [path.join(localRoot, 'Programs', 'QwenWorkCN')] : []),
    ...[env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)']]
      .map(value => String(value || '').trim())
      .filter(Boolean)
      .map(root => path.join(root, 'QwenWorkCN')),
  ].filter((root, index, roots) => roots.indexOf(root) === index);
  for (const versionsRoot of versionsRoots) {
    try {
      const versions = fs.readdirSync(versionsRoot, { withFileTypes: true })
        .filter((entry: any) => entry.isDirectory())
        .map((entry: any) => entry.name)
        .sort((a: string, b: string) => b.localeCompare(a, undefined, { numeric: true }));
      for (const version of versions) {
        const candidate = path.join(versionsRoot, version, 'resources', 'bin', 'qoderclicn.exe');
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      }
    } catch (_) { /* this installation root may be absent or partially removed */ }
  }
  return null;
}

function resolveQwenOfficeCommand(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const configured = String(env.VOKO_QWENWORK_CLI_BIN || '').trim();
  if (configured) return configured;
  return findBundledQwenCli(env, platform)
    || (platform === 'win32' ? 'qoderclicn.exe' : platform === 'darwin' ? 'qoderclicn' : '');
}

function qwenOfficeLoginCommand(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const command = resolveQwenOfficeCommand(env, platform);
  if (!command) return '';
  if (!/\s/.test(command)) return `${command} login`;
  if (platform === 'win32') return `& '${command.replace(/'/g, "''")}' login`;
  return `'${command.replace(/'/g, "'\\''")}' login`;
}

function qwenOfficeRuntimeRequest(
  mode: 'cli' = 'cli',
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  overrideCommand?: string,
) {
  const command = overrideCommand || resolveQwenOfficeCommand(env, platform);
  if (!command) return { providerId: 'qwen-office-cli', mode, candidates: [] };
  const isAbsolute = platform === 'win32' ? path.win32.isAbsolute(command) : path.posix.isAbsolute(command);
  return {
    providerId: 'qwen-office-cli',
    mode,
    candidates: isAbsolute
      ? [{ kind: 'explicit', path: command }]
      : [{ kind: 'native', command }],
  };
}

function resolveQwenOfficeRuntime(
  resolver = defaultAgentRuntimeResolver,
  overrideCommand?: string,
) {
  return resolver.resolve(qwenOfficeRuntimeRequest('cli', process.env, process.platform, overrideCommand));
}

function isQwenOfficeRuntimeAvailable(): boolean {
  return !!resolveQwenOfficeRuntime().available;
}

/**
 * Read the CLI account state without starting a model session.  The desktop
 * QwenWork login and qoderclicn login are not assumed to share credentials.
 */
function getQwenOfficeReadiness(command?: string): QwenOfficeReadiness {
  const resolvedCommand = command || resolveQwenOfficeCommand();
  const cached = statusCache.get(resolvedCommand);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;

  const runtime = resolveQwenOfficeRuntime(defaultAgentRuntimeResolver, resolvedCommand);
  if (!runtime.available || !runtime.executable) {
    const value: QwenOfficeReadiness = {
      executable: false, loggedIn: false, ready: false, reason: 'not_found',
    };
    statusCache.set(resolvedCommand, { value, expiresAt: now + STATUS_CACHE_TTL_MS });
    return value;
  }

  try {
    const result = spawnSync(runtime.executable, [...runtime.argvPrefix, 'status', '--output', 'json'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = String(result.stdout || '').trim();
    const start = output.indexOf('{');
    const end = output.lastIndexOf('}');
    const parsed = start >= 0 && end > start ? JSON.parse(output.slice(start, end + 1)) : null;
    const loggedIn = parsed?.logged_in === true;
    const value: QwenOfficeReadiness = {
      executable: true,
      loggedIn,
      ready: loggedIn,
      reason: loggedIn ? 'ready' : 'cli_not_logged_in',
      ...(typeof parsed?.version === 'string' ? { version: parsed.version } : {}),
    };
    statusCache.set(resolvedCommand, { value, expiresAt: now + STATUS_CACHE_TTL_MS });
    return value;
  } catch (_) {
    const value: QwenOfficeReadiness = {
      executable: true, loggedIn: false, ready: false, reason: 'status_failed',
    };
    statusCache.set(resolvedCommand, { value, expiresAt: now + STATUS_CACHE_TTL_MS });
    return value;
  }
}

function isQwenOfficeRuntimeReady(command?: string): boolean {
  return getQwenOfficeReadiness(command).ready;
}

function invalidateQwenOfficeReadiness(command?: string): void {
  if (command) statusCache.delete(command);
  else statusCache.clear();
}

module.exports = {
  findBundledQwenCli,
  resolveQwenOfficeCommand,
  qwenOfficeLoginCommand,
  qwenOfficeRuntimeRequest,
  resolveQwenOfficeRuntime,
  isQwenOfficeRuntimeAvailable,
  getQwenOfficeReadiness,
  isQwenOfficeRuntimeReady,
  invalidateQwenOfficeReadiness,
};

export {};
