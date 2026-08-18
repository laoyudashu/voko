const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { defaultAgentRuntimeResolver } = require('../runtime/agent-runtime-resolver');

function discoverGlobalCodeBuddyBin(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  let prefix = String(env.NPM_CONFIG_PREFIX || env.npm_config_prefix || '').trim();
  if (!prefix) {
    try {
      const executable = platform === 'win32' ? String(env.ComSpec || env.COMSPEC || 'cmd.exe') : 'npm';
      const args = platform === 'win32'
        ? ['/d', '/s', '/c', 'npm.cmd config get prefix']
        : ['config', 'get', 'prefix'];
      prefix = String(execFileSync(executable, args, {
        encoding: 'utf8', windowsHide: true, timeout: 2500, maxBuffer: 16 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'], env,
      })).trim();
    } catch { return null; }
  }
  if (!prefix || prefix === 'undefined' || prefix === 'null') return null;
  try {
    const packageRoot = path.join(prefix, 'node_modules', '@tencent-ai', 'codebuddy-code');
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    const relativeBin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.codebuddy;
    if (typeof relativeBin !== 'string') return null;
    const rootReal = fs.realpathSync(packageRoot);
    const target = fs.realpathSync(path.resolve(packageRoot, relativeBin));
    const relative = path.relative(rootReal, target);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
      || !fs.statSync(target).isFile()) return null;
    return target;
  } catch { return null; }
}

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
  const globalPackageBin = discoverGlobalCodeBuddyBin(env, platform);
  return {
    providerId: 'codebuddy-acp', mode,
    candidates: [
      { kind: 'node-package-bin', command: 'codebuddy', packageName: '@tencent-ai/codebuddy-code', binName: 'codebuddy' },
      { kind: 'node-package-bin', command: 'cbc', packageName: '@tencent-ai/codebuddy-code', binName: 'cbc' },
      ...(globalPackageBin ? [{ kind: 'explicit' as const, path: globalPackageBin, interpreter: 'node' as const }] : []),
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
  discoverGlobalCodeBuddyBin,
};

export {};
