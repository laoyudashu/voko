export {};

/** Resolve the OpenClaw executable and the child-process environment. */
const path = require('path');
const { checkCliAvailable } = require('../adapters/cli-spawner');
const { defaultAgentRuntimeResolver, withRuntimePath } = require('../runtime/agent-runtime-resolver');

function resolveOpenClawCommand(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const configured = String(env.VOKO_OPENCLAW_BIN || '').trim();
  if (configured) return configured;
  return platform === 'win32' ? 'openclaw' : 'openclaw';
}

function openClawRuntimeRequest(
  mode: 'acp' | 'cli' = 'cli',
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
) {
  const command = resolveOpenClawCommand(env, platform);
  return {
    providerId: 'openclaw',
    mode,
    candidates: path.isAbsolute(command)
      ? [{ kind: 'explicit', path: command }]
      : [{ kind: 'native', command }],
  };
}

function resolveOpenClawRuntime(
  mode: 'acp' | 'cli' = 'cli',
  resolver = defaultAgentRuntimeResolver,
) {
  // Windows npm installations commonly expose only .cmd; retain the legacy
  // PATH check there. Unix runtimes use the resolver so Linux bins are placed
  // ahead of mounted Windows shims in WSL/non-interactive services.
  if (process.platform === 'win32' && !String(process.env.VOKO_OPENCLAW_BIN || '').trim()) {
    return { available: checkCliAvailable('openclaw'), executable: 'openclaw', argvPrefix: [], pathEntries: [] };
  }
  return resolver.resolve(openClawRuntimeRequest(mode));
}

function runtimeSpawnOptions(runtime: any): { cmd: string; prefixArgs: string[]; env: NodeJS.ProcessEnv | undefined } {
  return {
    cmd: String(runtime?.executable || 'openclaw'),
    prefixArgs: Array.isArray(runtime?.argvPrefix) ? [...runtime.argvPrefix] : [],
    env: withRuntimePath(process.env, runtime),
  };
}

module.exports = {
  resolveOpenClawCommand,
  openClawRuntimeRequest,
  resolveOpenClawRuntime,
  runtimeSpawnOptions,
};
