import os from 'node:os';
import path from 'node:path';

interface OwnerLinkPathOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
}

function resolveOwnerLinkDataDirectory(options: OwnerLinkPathOptions = {}): string {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const homeDir = options.homeDir || os.homedir();
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'win32') {
    return pathApi.join(env.APPDATA || pathApi.join(homeDir, 'AppData', 'Roaming'), 'voko');
  }
  if (platform === 'darwin') {
    return pathApi.join(homeDir, 'Library', 'Application Support', 'voko');
  }
  return pathApi.join(env.XDG_CONFIG_HOME || pathApi.join(homeDir, '.config'), 'voko');
}

function resolveOwnerLinkDatabasePath(options: OwnerLinkPathOptions = {}): string {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const configured = String(env.VOKO_OWNER_LINK_DB_PATH || '').trim();
  if (configured) return pathApi.resolve(configured);
  return pathApi.join(resolveOwnerLinkDataDirectory(options), 'voko-owner.db');
}

export { resolveOwnerLinkDataDirectory, resolveOwnerLinkDatabasePath };
export type { OwnerLinkPathOptions };
