const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { defaultAgentRuntimeResolver } = require('../runtime/agent-runtime-resolver');
let installedCommandCache: string | null | undefined;

function bundledCommand(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const cacheable = env === process.env && platform === process.platform;
  if (cacheable && installedCommandCache !== undefined) return installedCommandCache;
  if (platform === 'darwin') {
    const home = String(env.HOME || '').trim();
    const candidates = [
      ...(home ? [path.join(home, 'Applications', 'DuMate.app', 'Contents', 'Resources', 'extra-resource', 'opencode', 'bin', 'dumate-opencode')] : []),
      '/Applications/DuMate.app/Contents/Resources/extra-resource/opencode/bin/dumate-opencode',
    ];
    const found = candidates.find((candidate) => fs.existsSync(candidate)) || null;
    if (cacheable) installedCommandCache = found;
    return found;
  }
  if (platform !== 'win32') return null;
  const candidates = [
    path.join(String(env.ProgramFiles || 'C:\\Program Files'), 'DuMate', 'resources', 'extra-resource', 'opencode', 'bin', 'dumate-opencode.exe'),
    path.join(String(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'), 'DuMate', 'resources', 'extra-resource', 'opencode', 'bin', 'dumate-opencode.exe'),
  ];
  try {
    for (const hive of ['HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall']) {
      const result = spawnSync('reg.exe', ['query', hive, '/s', '/f', 'DuMate'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
      const install = String(result.stdout || '').match(/^\s*InstallLocation\s+REG_SZ\s+(.+)$/mi)?.[1]?.trim();
      if (install) candidates.push(path.join(install, 'resources', 'extra-resource', 'opencode', 'bin', 'dumate-opencode.exe'));
      const icon = String(result.stdout || '').match(/^\s*DisplayIcon\s+REG_SZ\s+(.+)$/mi)?.[1]?.trim()
        ?.replace(/^"|"$/g, '').replace(/,\d+$/, '');
      if (icon) candidates.push(path.join(path.dirname(icon), 'resources', 'extra-resource', 'opencode', 'bin', 'dumate-opencode.exe'));
    }
  } catch (_) {}
  const found = candidates.find((candidate) => fs.existsSync(candidate)) || null;
  if (cacheable) installedCommandCache = found;
  return found;
}

export function resolveDuMateCommand(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  return String(env.VOKO_DUMATE_CLI_BIN || '').trim() || bundledCommand(env, platform)
    || (platform === 'win32' ? 'dumate-opencode.exe' : platform === 'darwin' ? 'dumate-opencode' : '');
}

export function dumateRuntimeRequest(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, override?: string) {
  const command = override || resolveDuMateCommand(env, platform);
  if (!command) return { providerId: 'dumate-http', mode: 'http', candidates: [] };
  const absolute = platform === 'win32' ? path.win32.isAbsolute(command) : path.posix.isAbsolute(command);
  return { providerId: 'dumate-http', mode: 'http', candidates: absolute
    ? [{ kind: 'explicit', path: command }] : [{ kind: 'native', command }] };
}

export function resolveDuMateRuntime(resolver = defaultAgentRuntimeResolver, override?: string) {
  return resolver.resolve(dumateRuntimeRequest(process.env, process.platform, override));
}

export function isDuMateRuntimeAvailable(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  const command = resolveDuMateCommand(env, platform);
  const absolute = platform === 'win32' ? path.win32.isAbsolute(command) : path.posix.isAbsolute(command);
  if (absolute) return fs.existsSync(command);
  return resolveDuMateRuntime().available === true;
}

export function resolveDuMateBackendPort(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  options: { spawnSync?: typeof spawnSync } = {},
): string {
  const configured = String(env.DUMATE_BACK_END_PORT || '').trim();
  if (/^\d{1,5}$/.test(configured)) return configured;
  const run = options.spawnSync || spawnSync;
  if (platform === 'darwin') {
    try {
      const result = run('ps', ['-axo', 'command'], { encoding: 'utf8', timeout: 5000 });
      return String(result.stdout || '').match(/(?:^|[\/\s])dumate-main-server(?:\s|$)[^\n]*?--port(?:=|\s+)(\d{1,5})/mi)?.[1] || '';
    } catch (_) { return ''; }
  }
  if (platform !== 'win32') return '';
  try {
    const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "(Get-CimInstance Win32_Process -Filter \"Name='dumate-main-server.exe'\" | Select-Object -First 1 -ExpandProperty CommandLine)"],
    { encoding: 'utf8', timeout: 5000, windowsHide: true });
    return String(result.stdout || '').match(/--port=(\d{1,5})/)?.[1] || '';
  } catch (_) { return ''; }
}

module.exports = { resolveDuMateCommand, dumateRuntimeRequest, resolveDuMateRuntime, isDuMateRuntimeAvailable, resolveDuMateBackendPort };
