const fs = require('fs');
const os = require('os');
const path = require('path');
export {};

function defaultTokenPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const root = process.platform === 'win32'
    ? (env.APPDATA || path.join(home, 'AppData', 'Roaming'))
    : (env.XDG_CONFIG_HOME || path.join(home, '.config'));
  return path.join(root, 'voko', 'credentials', 'zeroclaw-acp-token');
}

function configuredUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = String(env.ZEROCLAW_ACP_URL || 'ws://127.0.0.1:42617/acp').trim();
  try {
    const url = new URL(raw);
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
    if (!loopback || !['ws:', 'wss:'].includes(url.protocol) || url.username || url.password
      || url.search || url.hash) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function configuredToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = String(env.ZEROCLAW_ACP_TOKEN || '').trim();
  if (explicit) return /[\r\n]/.test(explicit) ? null : explicit;
  const tokenPath = path.resolve(String(env.ZEROCLAW_ACP_TOKEN_FILE || defaultTokenPath(env)));
  try {
    const stat = fs.statSync(tokenPath);
    if (!stat.isFile()) return null;
    // Bearer tokens are reusable credentials. On POSIX, fail closed when the
    // credential is readable by the group or other users.
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) return null;
    const token = String(fs.readFileSync(tokenPath, 'utf8')).trim();
    return token && !/[\r\n]/.test(token) ? token : null;
  } catch {
    return null;
  }
}

module.exports = { configuredUrl, configuredToken, defaultTokenPath };
