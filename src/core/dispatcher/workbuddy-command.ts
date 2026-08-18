const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

export interface WorkBuddyRuntime {
  command: string | null;
  argvPrefix: string[];
  source: 'configured' | 'path' | 'registry' | 'common_location' | 'unavailable';
  desktopVersion: string | null;
}

let cachedDefaultRuntime: WorkBuddyRuntime | null = null;

function existingFile(value: unknown): string | null {
  const candidate = String(value || '').trim().replace(/^"|"$/g, '');
  if (!candidate || candidate.includes('\0')) return null;
  try { return fs.statSync(candidate).isFile() ? path.resolve(candidate) : null; }
  catch { return null; }
}

function runtimeFor(command: string, source: WorkBuddyRuntime['source'], desktopVersion: string | null = null): WorkBuddyRuntime {
  const absolute = path.isAbsolute(command);
  return {
    command,
    argvPrefix: absolute && !/\.(?:exe|cmd|bat)$/i.test(command) ? [command] : [],
    source,
    desktopVersion,
  };
}

function fromInstallRoot(root: unknown, source: WorkBuddyRuntime['source'], desktopVersion: string | null = null): WorkBuddyRuntime | null {
  const base = String(root || '').trim().replace(/^"|"$/g, '');
  if (!base || base.includes('\0')) return null;
  const command = existingFile(path.join(base, 'resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy'));
  return command ? runtimeFor(command, source, desktopVersion) : null;
}

function resolveFromWindowsRegistry(): WorkBuddyRuntime | null {
  if (process.platform !== 'win32') return null;
  const roots = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  for (const root of roots) {
    let output = '';
    try {
      output = String(execFileSync('reg.exe', ['query', root, '/s', '/f', 'WorkBuddy'], {
        encoding: 'utf8', windowsHide: true, timeout: 2500, maxBuffer: 512 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      }));
    } catch (error: any) {
      output = String(error?.stdout || '');
    }
    const blocks = output.split(/\r?\n\r?\n/);
    for (const block of blocks) {
      const displayName = block.match(/^\s*DisplayName\s+REG_SZ\s+(WorkBuddy[^\r\n]*)$/im)?.[1]?.trim() || '';
      if (!/^WorkBuddy\b/i.test(displayName)) continue;
      const icon = block.match(/^\s*DisplayIcon\s+REG_SZ\s+(.+)$/im)?.[1]?.trim().replace(/,\d+$/, '');
      const install = block.match(/^\s*InstallLocation\s+REG_SZ\s+(.+)$/im)?.[1]?.trim();
      const version = block.match(/^\s*DisplayVersion\s+REG_SZ\s+(.+)$/im)?.[1]?.trim()
        || displayName.match(/\b(\d+\.\d+(?:\.\d+)?)\b/)?.[1] || null;
      const rootPath = install || (icon ? path.dirname(icon.replace(/^"|"$/g, '')) : '');
      const found = fromInstallRoot(rootPath, 'registry', version);
      if (found) return found;
    }
  }
  return null;
}

function resolveFromPath(): WorkBuddyRuntime | null {
  const finder = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    const output = String(execFileSync(finder, ['codebuddy'], {
      encoding: 'utf8', windowsHide: true, timeout: 1500, maxBuffer: 16 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
    const command = output.split(/\r?\n/).map((item: string) => item.trim()).find(Boolean);
    return command ? runtimeFor(command, 'path') : null;
  } catch { return null; }
}

export function resolveWorkBuddyRuntime(options: { configuredCommand?: string; env?: NodeJS.ProcessEnv } = {}): WorkBuddyRuntime {
  const env = options.env || process.env;
  const canCache = !options.configuredCommand && !options.env;
  if (canCache && cachedDefaultRuntime) return { ...cachedDefaultRuntime, argvPrefix: [...cachedDefaultRuntime.argvPrefix] };
  const configured = existingFile(options.configuredCommand || env.VOKO_WORKBUDDY_CLI);
  if (configured) return runtimeFor(configured, 'configured');

  const inPath = resolveFromPath();
  if (inPath) {
    if (canCache) cachedDefaultRuntime = inPath;
    return inPath;
  }

  const registry = resolveFromWindowsRegistry();
  if (registry) {
    if (canCache) cachedDefaultRuntime = registry;
    return registry;
  }

  const roots = process.platform === 'win32'
    ? [env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')]
    : ['/opt/WorkBuddy', '/opt/workbuddy', '/usr/local/lib/workbuddy'];
  for (const root of roots.filter(Boolean)) {
    const direct = fromInstallRoot(root, 'common_location');
    if (direct) {
      if (canCache) cachedDefaultRuntime = direct;
      return direct;
    }
    const nested = fromInstallRoot(path.join(String(root), 'WorkBuddy'), 'common_location');
    if (nested) {
      if (canCache) cachedDefaultRuntime = nested;
      return nested;
    }
  }
  const unavailable: WorkBuddyRuntime = { command: null, argvPrefix: [], source: 'unavailable', desktopVersion: null };
  if (canCache) cachedDefaultRuntime = unavailable;
  return unavailable;
}

export function workBuddySpawnCommand(runtime: WorkBuddyRuntime): { command: string; argsPrefix: string[] } | null {
  if (!runtime.command) return null;
  return runtime.argvPrefix.length > 0
    ? { command: process.execPath, argsPrefix: runtime.argvPrefix }
    : { command: runtime.command, argsPrefix: [] };
}

export function probeWorkBuddyCliVersion(runtime: WorkBuddyRuntime): string | null {
  const launch = workBuddySpawnCommand(runtime);
  if (!launch) return null;
  try {
    const output = String(execFileSync(launch.command, [...launch.argsPrefix, '--version'], {
      encoding: 'utf8', windowsHide: true, timeout: 2500, maxBuffer: 16 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
    return output.match(/\bv?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)\b/)?.[1] || null;
  } catch { return null; }
}

module.exports = { resolveWorkBuddyRuntime, workBuddySpawnCommand, probeWorkBuddyCliVersion };
