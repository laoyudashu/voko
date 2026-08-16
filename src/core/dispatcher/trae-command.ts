/**
 * Resolve the separate Trae CLI runtime.
 *
 * The desktop `trae` launcher is an Electron/IDE entry point and is not an
 * ACP server.  Headless ACP is provided by the separately installed
 * `traecli` command.  Keep the command override explicit so a service account
 * can use a fixed installation without invoking a shell.
 */
const path = require('path');
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
  return {
    providerId: 'traecli-acp',
    mode,
    candidates: isAbsolute
      ? [{ kind: 'explicit', path: command }]
      : [{ kind: 'native', command }],
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

module.exports = {
  resolveTraeCliCommand,
  traeCliRuntimeRequest,
  resolveTraeCliRuntime,
  isTraeCliAvailable,
};

export {};
