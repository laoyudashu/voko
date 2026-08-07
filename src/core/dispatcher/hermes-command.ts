const fs = require('fs');
const os = require('os');
const path = require('path');

export {};
const { checkCliAvailable } = require('../adapters/cli-spawner');

/**
 * Resolve the Hermes launcher on PATH or in the official Linux/macOS install
 * layout.  Hermes' installer keeps the executable inside its own virtualenv,
 * which is commonly not exported by non-interactive services.
 */
function resolveHermesCommand(env: NodeJS.ProcessEnv = process.env): string {
  const configured = String(env.VOKO_HERMES_BIN || '').trim();
  if (configured) return configured;
  if (checkCliAvailable('hermes')) return 'hermes';

  const homes = [...new Set([
    env.HOME,
    env.USERPROFILE,
    os.homedir(),
  ].map(value => String(value || '').trim()).filter(Boolean))];
  const candidates: string[] = [];
  for (const home of homes) {
    const hermesRoot = path.join(home, '.hermes');
    candidates.push(
      path.join(hermesRoot, 'hermes-agent', '.venv', 'bin', 'hermes'),
      path.join(hermesRoot, 'hermes-agent', 'hermes'),
      path.join(hermesRoot, 'hermes-agent', 'venv', 'bin', 'hermes'),
      path.join(hermesRoot, '.venv', 'bin', 'hermes'),
    );
    if (process.platform === 'win32') {
      const localAppData = String(env.LOCALAPPDATA || '').trim();
      if (localAppData) candidates.push(
        path.join(localAppData, 'hermes', 'hermes-agent', '.venv', 'Scripts', 'hermes.exe'),
        path.join(localAppData, 'hermes', 'hermes-agent', 'venv', 'Scripts', 'hermes.exe'),
      );
    }
  }
  return candidates.find(candidate => {
    try { return fs.statSync(candidate).isFile(); } catch (_) { return false; }
  }) || (process.platform === 'win32' ? 'hermes.exe' : 'hermes');
}

function isHermesRuntimeAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return checkCliAvailable(resolveHermesCommand(env));
}

module.exports = { resolveHermesCommand, isHermesRuntimeAvailable };
