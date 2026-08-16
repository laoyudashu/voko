import os from 'node:os';
import path from 'node:path';

interface A2APathOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
}

function resolveA2ADataDirectory(options: A2APathOptions = {}): string {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const homeDir = options.homeDir || os.homedir();
  // The platform option is also used by Doctor/tests to inspect another
  // platform from the current process. Use that platform's path semantics
  // instead of the host process semantics in that case.
  const pathApi = platform === 'win32' ? path.win32 : path.posix;

  if (platform === 'win32') {
    return pathApi.join(env.APPDATA || pathApi.join(homeDir, 'AppData', 'Roaming'), 'voko');
  }
  if (platform === 'darwin') {
    return pathApi.join(homeDir, 'Library', 'Application Support', 'voko');
  }
  return pathApi.join(env.XDG_CONFIG_HOME || pathApi.join(homeDir, '.config'), 'voko');
}

function resolveA2ADatabasePath(options: A2APathOptions = {}): string {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const explicitPath = String(env.VOKO_A2A_DB_PATH || '').trim();
  if (explicitPath) return pathApi.resolve(explicitPath);
  return pathApi.join(resolveA2ADataDirectory(options), 'voko-a2a.db');
}

export { resolveA2ADataDirectory, resolveA2ADatabasePath };
export type { A2APathOptions };
