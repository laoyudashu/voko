const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

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
      path.join(hermesRoot, 'hermes-agent', 'venv', 'bin', 'hermes'),
      path.join(hermesRoot, '.venv', 'bin', 'hermes'),
      path.join(home, 'AppData', 'Local', 'voko-tools', 'hermes-agent', 'Scripts', 'hermes.exe'),
      // The bare launcher uses whichever `python3` a background service happens
      // to inherit. Prefer it only after every managed virtualenv location.
      path.join(hermesRoot, 'hermes-agent', 'hermes'),
    );
    const localAppData = String(env.LOCALAPPDATA || '').trim();
    if (localAppData) candidates.push(
      path.join(localAppData, 'voko-tools', 'hermes-agent', 'Scripts', 'hermes.exe'),
      path.join(localAppData, 'hermes', 'hermes-agent', '.venv', 'Scripts', 'hermes.exe'),
      path.join(localAppData, 'hermes', 'hermes-agent', 'venv', 'Scripts', 'hermes.exe'),
    );
  }
  const installed = candidates.find(candidate => {
    try { return fs.statSync(candidate).isFile(); } catch (_) { return false; }
  });
  if (installed) return installed;
  if (checkCliAvailable('hermes')) return 'hermes';
  return process.platform === 'win32' ? 'hermes.exe' : 'hermes';
}

function isHermesRuntimeAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return checkCliAvailable(resolveHermesCommand(env));
}

const reasoningFlagCache = new Map<string, boolean>();
function hermesSupportsReasoningFlag(command: string): boolean {
  const cached = reasoningFlagCache.get(command);
  if (cached !== undefined) return cached;
  const result = spawnSync(command, ['chat', '--help'], {
    encoding: 'utf8', timeout: 5_000, windowsHide: true,
    env: { ...process.env }, maxBuffer: 512 * 1024,
  });
  const supported = !result.error && /(?:^|\s)--reasoning(?:\s|[,=]|$)/m.test(`${result.stdout || ''}\n${result.stderr || ''}`);
  reasoningFlagCache.set(command, supported);
  return supported;
}

module.exports = { resolveHermesCommand, isHermesRuntimeAvailable, hermesSupportsReasoningFlag };
