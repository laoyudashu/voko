const { checkCliAvailable } = require('../adapters/cli-spawner');
const { execFileSync } = require('child_process');
export {};

let cachedCommand: string | null = null;
let cachedAvailable: boolean | null = null;

function isCursorCommandAvailable(): boolean {
  if (cachedAvailable !== null) return cachedAvailable;
  if (checkCliAvailable('cursor-agent')) {
    cachedCommand = 'cursor-agent';
    cachedAvailable = true;
    return true;
  }
  if (checkCliAvailable('agent')) {
    try {
      const version = String(execFileSync('agent', ['--version'], {
        encoding: 'utf8', windowsHide: true, timeout: 3000,
      }));
      if (/\bcursor\b/i.test(version)) {
        cachedCommand = 'agent';
        cachedAvailable = true;
        return true;
      }
    } catch (_) {}
  }
  cachedAvailable = false;
  return false;
}

function resolveCursorCommand(): string {
  if (cachedCommand) return cachedCommand;
  isCursorCommandAvailable();
  if (!cachedCommand) cachedCommand = 'cursor-agent';
  return cachedCommand;
}

module.exports = { isCursorCommandAvailable, resolveCursorCommand };
