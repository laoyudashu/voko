export {};

/** Resolve the OpenClaw executable and the child-process environment. */
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
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

const resolutionChecks = new WeakMap<object, { key: string; paths: string[]; stamp: string }>();
function fileStamp(files: string[]): string {
  return files.map(file => { try { const st = fs.statSync(file); return `${canonicalPath(file)}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`; }
    catch (_) { return `${file}:missing`; } }).join('\0');
}

function resolveOpenClawRuntime(
  mode: 'acp' | 'cli' = 'cli',
  resolver = defaultAgentRuntimeResolver,
) {
  const request = openClawRuntimeRequest(mode);
  // Resolve npm shims to the real Node entry where possible, including Windows.
  if (resolveOpenClawCommand() === 'openclaw') {
    request.candidates.unshift({ kind: 'node-package-bin', command: 'openclaw', packageName: 'openclaw' } as any);
  }
  const command = resolveOpenClawCommand();
  const key = JSON.stringify([mode, command, process.env.PATH, process.env.Path]);
  const previous = resolutionChecks.get(resolver);
  if (previous && (previous.key !== key || fileStamp(previous.paths) !== previous.stamp)) resolver.invalidate?.(request);
  const runtime = resolver.resolve(request);
  const paths = [...new Set<string>([
    ...(path.isAbsolute(command) ? [command] : String(process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean)
      .flatMap(dir => [dir, path.join(dir, command), path.join(dir, 'node_modules', 'openclaw', 'package.json')])),
    runtime.executable, runtime.canonicalPath, ...(runtime.argvPrefix || []),
    ...[runtime.canonicalPath, ...(runtime.argvPrefix || [])].filter(Boolean).map((file: string) => path.join(path.dirname(file), 'package.json')),
  ].filter(Boolean))];
  resolutionChecks.set(resolver, { key, paths, stamp: fileStamp(paths) });
  return runtime;
}

function runtimeSpawnOptions(runtime: any): { cmd: string; prefixArgs: string[]; env: NodeJS.ProcessEnv | undefined } {
  return {
    cmd: String(runtime?.executable || 'openclaw'),
    prefixArgs: Array.isArray(runtime?.argvPrefix) ? [...runtime.argvPrefix] : [],
    env: withRuntimePath(process.env, runtime),
  };
}

/** Resolve only the state/config selectors used by this invocation. */
function openClawPaths(env = process.env, home = os.homedir()): { stateDir: string; configPath: string } {
  home = String(env.OPENCLAW_HOME || '').trim() || home;
  const expand = (value: string) => path.resolve(value === '~' ? home : value.startsWith('~/') ? path.join(home, value.slice(2)) : value);
  const defaultDirs = [path.join(home, '.openclaw'), path.join(home, '.clawdbot')];
  const stateDir = env.OPENCLAW_STATE_DIR?.trim() ? expand(env.OPENCLAW_STATE_DIR.trim())
    : defaultDirs.find(dir => fs.existsSync(dir)) || defaultDirs[0];
  const candidates = [...new Set([stateDir, ...defaultDirs])].flatMap(dir => [path.join(dir, 'openclaw.json'), path.join(dir, 'clawdbot.json')]);
  const configPath = env.OPENCLAW_CONFIG_PATH?.trim() ? expand(env.OPENCLAW_CONFIG_PATH.trim())
    : candidates.find(file => fs.existsSync(file)) || path.join(stateDir, 'openclaw.json');
  return { stateDir, configPath };
}

function canonicalPath(file: string): string {
  try { return fs.realpathSync(file); } catch (_) {
    const parent = path.dirname(file);
    return parent === file ? file : path.join(canonicalPath(parent), path.basename(file));
  }
}

const manifestCache = new Map<string, { stamp: string; version: string | null }>();
function inspectOpenClawRuntime(runtime: any, instanceId = '', env = process.env): any {
  const files = [runtime?.executable, runtime?.canonicalPath, ...(runtime?.argvPrefix || [])]
    .filter((value: any) => typeof value === 'string' && path.isAbsolute(value));
  let version: string | null = null;
  const identities: string[] = [];
  for (const file of new Set<string>(files)) {
    const real = canonicalPath(file);
    try { const stat = fs.statSync(real); identities.push(`${real}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`); }
    catch (_) { identities.push(`${real}:missing`); }
    let dir = path.dirname(real);
    for (let i = 0; i < 3; i++, dir = path.dirname(dir)) {
      const manifest = path.join(dir, 'package.json');
      try {
        const stat = fs.statSync(manifest);
        const stamp = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
        let cached = manifestCache.get(manifest);
        if (!cached || cached.stamp !== stamp) {
          const data = JSON.parse(fs.readFileSync(manifest, 'utf8'));
          cached = { stamp, version: data.name === 'openclaw' && typeof data.version === 'string' ? data.version : null };
          if (manifestCache.size >= 32) manifestCache.delete(manifestCache.keys().next().value!);
          manifestCache.set(manifest, cached);
        }
        if (cached.version) { version = cached.version; identities.push(`${manifest}:${stamp}:${version}`); break; }
      } catch (_) {}
    }
  }
  const paths = openClawPaths(env);
  return { ...runtime, frameworkVersion: version, runtimeVersion: version,
    fingerprint: crypto.createHash('sha256').update(JSON.stringify([
      identities, canonicalPath(paths.stateDir), canonicalPath(paths.configPath), instanceId,
      process.platform, process.arch,
    ])).digest('hex') };
}

// Only serialize this process's local invocations. OpenClaw remains the owner
// of its cross-process lock; never remove or impersonate that lock.
const stateTails = new Map<string, Promise<void>>();
async function acquireOpenClawState(stateDir: string, signal: AbortSignal, waitMs = 120000): Promise<() => void> {
  const key = canonicalPath(stateDir);
  const previous = stateTails.get(key) || Promise.resolve();
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  stateTails.set(key, done);
  let released = false;
  const release = () => {
    if (released) return;
    released = true; finish();
    if (stateTails.get(key) === done) stateTails.delete(key);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    const fail = (code: string) => reject(Object.assign(new Error(code), { code, deliveryOutcome: 'not_delivered' }));
    abort = () => fail('OPENCLAW_LOCAL_QUEUE_CANCELLED');
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => fail('OPENCLAW_LOCAL_QUEUE_TIMEOUT'), waitMs);
    if (signal.aborted) abort();
  });
  try {
    await Promise.race([previous, cancelled]);
    if (signal.aborted) throw Object.assign(new Error('OPENCLAW_LOCAL_QUEUE_CANCELLED'), { deliveryOutcome: 'not_delivered' });
    return release;
  } catch (error) {
    // Later turns must still wait for the active predecessor.
    void previous.then(release);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

module.exports = {
  openClawPaths, inspectOpenClawRuntime, acquireOpenClawState,
  resolveOpenClawCommand,
  openClawRuntimeRequest,
  resolveOpenClawRuntime,
  runtimeSpawnOptions,
};
