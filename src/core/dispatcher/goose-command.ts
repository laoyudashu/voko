/**
 * Resolve the Goose executable without assuming a developer-machine path.
 *
 * An explicit VOKO_GOOSE_BIN may point to a platform-specific executable.
 * Otherwise child_process resolves the native executable from PATH.
 * Windows uses `goose.exe` explicitly so the generic CLI runner never routes
 * untrusted Goose input through `cmd.exe`.
 */
function resolveGooseCommand(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const configured = env.VOKO_GOOSE_BIN?.trim();
  return configured || (platform === 'win32' ? 'goose.exe' : 'goose');
}

function gooseRuntimeRequest(
  mode: 'acp' | 'cli',
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  overrideCommand?: string,
) {
  const command = overrideCommand || resolveGooseCommand(env, platform);
  return {
    providerId: 'goose',
    mode,
    candidates: require('path').isAbsolute(command)
      ? [{ kind: 'explicit', path: command }]
      : [{ kind: 'native', command }],
  };
}

function resolveGooseRuntime(
  mode: 'acp' | 'cli',
  resolver = require('../runtime/agent-runtime-resolver').defaultAgentRuntimeResolver,
) {
  return resolver.resolve(gooseRuntimeRequest(mode));
}

function isGooseRuntimeAvailable(mode: 'acp' | 'cli' = 'cli'): boolean {
  return !!resolveGooseRuntime(mode).available;
}

module.exports = { resolveGooseCommand, gooseRuntimeRequest, resolveGooseRuntime, isGooseRuntimeAvailable };
