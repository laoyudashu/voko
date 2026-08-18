const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { defaultAgentRuntimeResolver } = require('../runtime/agent-runtime-resolver');

function resolveCodeBuddyCommand(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const configured = String(env.VOKO_CODEBUDDY_CLI_BIN || '').trim();
  return configured || (platform === 'win32' ? 'codebuddy.exe' : 'codebuddy');
}

function isNodeScript(filePath: string): boolean {
  if (['.js', '.cjs', '.mjs'].includes(path.extname(filePath).toLowerCase())) return true;
  try {
    const handle = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(128);
    const length = fs.readSync(handle, buffer, 0, buffer.length, 0);
    fs.closeSync(handle);
    return /^#!.*\bnode\b/i.test(buffer.subarray(0, length).toString('utf8').split(/\r?\n/, 1)[0]);
  } catch { return false; }
}

function codeBuddyRuntimeRequest(
  mode: 'acp' | 'cli' = 'acp',
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  overrideCommand?: string,
) {
  const configured = String(overrideCommand || env.VOKO_CODEBUDDY_CLI_BIN || '').trim();
  if (configured && (path.win32.isAbsolute(configured) || path.posix.isAbsolute(configured))) {
    return {
      providerId: 'codebuddy-acp', mode,
      candidates: [{ kind: 'explicit', path: configured,
        ...(isNodeScript(configured) ? { interpreter: 'node' } : {}) }],
    };
  }
  return {
    providerId: 'codebuddy-acp', mode,
    candidates: [
      { kind: 'node-package-bin', command: 'codebuddy', packageName: '@tencent-ai/codebuddy-code', binName: 'codebuddy' },
      { kind: 'node-package-bin', command: 'cbc', packageName: '@tencent-ai/codebuddy-code', binName: 'cbc' },
      { kind: 'native', command: platform === 'win32' ? 'codebuddy.exe' : 'codebuddy' },
    ],
  };
}

function resolveCodeBuddyRuntime(
  mode: 'acp' | 'cli' = 'acp',
  resolver = defaultAgentRuntimeResolver,
) {
  return resolver.resolve(codeBuddyRuntimeRequest(mode));
}

function isCodeBuddyAvailable(mode: 'acp' | 'cli' = 'acp'): boolean {
  return !!resolveCodeBuddyRuntime(mode).available;
}

function probeCodeBuddyCliVersion(resolver = defaultAgentRuntimeResolver): string | null {
  const runtime = resolveCodeBuddyRuntime('acp', resolver);
  if (!runtime.available || !runtime.executable) return null;
  try {
    const output = String(execFileSync(runtime.executable, [...runtime.argvPrefix, '--version'], {
      encoding: 'utf8', windowsHide: true, timeout: 2500, maxBuffer: 16 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
    return output.match(/\bv?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)\b/)?.[1] || null;
  } catch { return null; }
}

module.exports = {
  resolveCodeBuddyCommand,
  codeBuddyRuntimeRequest,
  resolveCodeBuddyRuntime,
  isCodeBuddyAvailable,
  probeCodeBuddyCliVersion,
};

export {};
