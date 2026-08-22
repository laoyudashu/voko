/**
 * Resolve the separate Trae CLI runtime.
 *
 * The desktop `trae` launcher is an Electron/IDE entry point and is not an
 * ACP server.  Headless ACP is provided by the separately installed
 * `traecli` command.  Keep the command override explicit so a service account
 * can use a fixed installation without invoking a shell.
 */
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { defaultAgentRuntimeResolver } = require('../runtime/agent-runtime-resolver');

function resolveTraeCliCommand(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const configured = String(env.VOKO_TRAECLI_BIN || '').trim();
  return configured || (platform === 'win32' ? 'traecli.exe' : 'traecli');
}

function traeCliRuntimeRequest(
  mode: 'acp' | 'cli' = 'acp',
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  overrideCommand?: string,
) {
  const command = overrideCommand || resolveTraeCliCommand(env, platform);
  const isAbsolute = platform === 'win32' ? path.win32.isAbsolute(command) : path.posix.isAbsolute(command);
  const localAppData = String(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')).trim();
  const windowsInstallCandidates = platform === 'win32' && !isAbsolute ? [
    'traecli.exe', 'trae-cli.exe', 'trae-agent.exe',
  ].map(name => ({ kind: 'explicit' as const, path: path.win32.join(localAppData, 'trae-cli', 'bin', name) })) : [];
  return {
    providerId: 'traecli-acp',
    mode,
    candidates: isAbsolute
      ? [{ kind: 'explicit', path: command }]
      : [...windowsInstallCandidates, { kind: 'native', command }],
  };
}

function resolveTraeCliRuntime(
  mode: 'acp' | 'cli' = 'acp',
  resolver = defaultAgentRuntimeResolver,
) {
  return resolver.resolve(traeCliRuntimeRequest(mode));
}

function isTraeCliAvailable(mode: 'acp' | 'cli' = 'acp'): boolean {
  return !!resolveTraeCliRuntime(mode).available;
}

function getTraeCliReadiness(
  resolver = defaultAgentRuntimeResolver,
  run = spawnSync,
): { executable: boolean; ready: boolean; reason: string } {
  const runtime = resolveTraeCliRuntime('acp', resolver);
  if (!runtime.available || !runtime.executable) return { executable: false, ready: false, reason: 'not_found' };
  const result = run(runtime.executable, [...runtime.argvPrefix, 'doctor'], {
    encoding: 'utf8', timeout: 10000, windowsHide: true, shell: false,
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (result.status === 0) return { executable: true, ready: true, reason: 'ready' };
  if (/no effective model configured/i.test(output)) return { executable: true, ready: false, reason: 'model_not_configured' };
  return { executable: true, ready: false, reason: 'doctor_failed' };
}

function isTraeCliReady(): boolean {
  return getTraeCliReadiness().ready;
}

module.exports = {
  resolveTraeCliCommand,
  traeCliRuntimeRequest,
  resolveTraeCliRuntime,
  isTraeCliAvailable,
  getTraeCliReadiness,
  isTraeCliReady,
};

export {};
