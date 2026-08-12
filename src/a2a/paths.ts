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

  if (platform === 'win32') {
    return path.join(env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), 'voko');
  }
  if (platform === 'darwin') {
    return path.join(homeDir, 'Library', 'Application Support', 'voko');
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(homeDir, '.config'), 'voko');
}

function resolveA2ADatabasePath(options: A2APathOptions = {}): string {
  const env = options.env || process.env;
  const explicitPath = String(env.VOKO_A2A_DB_PATH || '').trim();
  if (explicitPath) return path.resolve(explicitPath);
  return path.join(resolveA2ADataDirectory(options), 'voko-a2a.db');
}

export { resolveA2ADataDirectory, resolveA2ADatabasePath };
export type { A2APathOptions };
