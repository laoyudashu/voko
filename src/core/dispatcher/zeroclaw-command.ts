const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkCliAvailable } = require('../adapters/cli-spawner');
export {};

function findCommandOnPath(command: string): string | null {
  for (const directory of String(process.env.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (_) {}
  }
  return null;
}

function resolveZeroClawCommand(): string {
  const explicit = String(process.env.VOKO_ZEROCLAW_BIN || '').trim();
  if (explicit && fs.existsSync(explicit)) return explicit;
  if (checkCliAvailable('zeroclaw')) return findCommandOnPath('zeroclaw') || 'zeroclaw';
  if (process.platform === 'win32') {
    const candidate = path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
      'Programs',
      'ZeroClaw',
      'zeroclaw.exe',
    );
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'zeroclaw';
}

function resolveZeroClawConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(String(env.VOKO_ZEROCLAW_CONFIG_DIR || path.join(env.HOME || env.USERPROFILE || os.homedir(), '.zeroclaw')));
}

function isZeroClawAgentDispatchable(alias: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(alias)) return false;
  try {
    const source = fs.readFileSync(path.join(resolveZeroClawConfigDir(env), 'config.toml'), 'utf8');
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = source.match(new RegExp(`(?:^|\\n)\\[agents\\.${escaped}\\]\\s*\\n([\\s\\S]*?)(?=\\n\\[|$)`));
    if (!match) return false;
    const scalar = (name: string): string => {
      const found = match[1].match(new RegExp(`^\\s*${name}\\s*=\\s*["']([^"']+)["']\\s*(?:#.*)?$`, 'm'));
      return String(found?.[1] || '').trim();
    };
    const disabled = /^\s*enabled\s*=\s*false\s*(?:#.*)?$/im.test(match[1]);
    return !disabled && Boolean(scalar('model_provider') && scalar('risk_profile') && scalar('runtime_profile'));
  } catch {
    return false;
  }
}

module.exports = { resolveZeroClawCommand, resolveZeroClawConfigDir, isZeroClawAgentDispatchable };
