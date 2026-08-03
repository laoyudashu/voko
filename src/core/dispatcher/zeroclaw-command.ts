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

module.exports = { resolveZeroClawCommand };
