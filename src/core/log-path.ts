const path = require('path');
const os = require('os');

function resolveVokoLogDirectory(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir(),
): string {
  const override = String(env.VOKO_LOG_DIR || '').trim();
  if (override) return path.resolve(override);
  if (platform === 'win32' && env.APPDATA) return path.win32.join(env.APPDATA, 'voko');
  if (platform === 'darwin') return path.posix.join(homeDir, 'Library', 'Application Support', 'voko');
  return path.posix.join(env.XDG_CONFIG_HOME || path.posix.join(homeDir, '.config'), 'voko');
}

module.exports = { resolveVokoLogDirectory };
export {};
