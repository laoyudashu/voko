const fs = require('fs');
const path = require('path');

export type RuntimeMode = 'acp' | 'cli';
export type RuntimeKind = 'native' | 'node-script';
export type RuntimeCandidate =
  | { kind: 'explicit'; path: string; interpreter?: 'node' }
  | { kind: 'native'; command: string }
  | { kind: 'node-package-bin'; command: string; packageName: string; binName?: string };

export interface RuntimeRequest {
  providerId: string;
  providerInstanceId?: string;
  mode: RuntimeMode;
  candidates: RuntimeCandidate[];
  configRevision?: string;
}

export interface ResolvedRuntime {
  available: boolean;
  executable?: string;
  argvPrefix: readonly string[];
  runtimeKind?: RuntimeKind;
  canonicalPath?: string;
  fingerprint?: string;
  reasonCode?: 'not_found' | 'invalid_target' | 'permission_denied';
  resolvedAt: number;
}

interface ResolverOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  nodePath?: string;
  now?: () => number;
  positiveTtlMs?: number;
  negativeTtlMs?: number;
}

function canonicalFile(filePath: string): string | null {
  try {
    if (!fs.statSync(filePath).isFile()) return null;
    return fs.realpathSync(filePath);
  } catch (_) { return null; }
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export class AgentRuntimeResolver {
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly nodePath: string;
  private readonly now: () => number;
  private readonly positiveTtlMs: number;
  private readonly negativeTtlMs: number;
  private readonly cache = new Map<string, { value: ResolvedRuntime; expiresAt: number }>();

  constructor(options: ResolverOptions = {}) {
    this.platform = options.platform || process.platform;
    this.env = options.env || process.env;
    this.nodePath = options.nodePath || process.execPath;
    this.now = options.now || Date.now;
    this.positiveTtlMs = options.positiveTtlMs ?? 30000;
    this.negativeTtlMs = options.negativeTtlMs ?? 5000;
  }

  resolve(request: RuntimeRequest): ResolvedRuntime {
    const key = this.cacheKey(request);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.value;
    let value: ResolvedRuntime | null = null;
    for (const candidate of request.candidates) {
      value = this.resolveCandidate(candidate);
      if (value?.available) break;
    }
    value ||= { available: false, argvPrefix: [], reasonCode: 'not_found', resolvedAt: this.now() };
    this.cache.set(key, { value, expiresAt: this.now() + (value.available ? this.positiveTtlMs : this.negativeTtlMs) });
    return value;
  }

  invalidate(request?: RuntimeRequest): void {
    if (!request) this.cache.clear();
    else this.cache.delete(this.cacheKey(request));
  }

  private cacheKey(request: RuntimeRequest): string {
    return JSON.stringify([
      request.providerId, request.providerInstanceId || '', request.mode, request.configRevision || '',
      request.candidates, this.platform, this.nodePath,
      String(this.env.PATH || this.env.Path || ''), String(this.env.PATHEXT || ''),
    ]);
  }

  private resolveCandidate(candidate: RuntimeCandidate): ResolvedRuntime | null {
    if (candidate.kind === 'explicit') {
      const target = canonicalFile(candidate.path);
      if (!target) return null;
      return this.result(candidate.interpreter === 'node' ? this.nodePath : target,
        candidate.interpreter === 'node' ? [target] : [], candidate.interpreter === 'node' ? 'node-script' : 'native', target);
    }
    if (candidate.kind === 'node-package-bin') return this.resolvePackageBin(candidate);
    const target = this.findOnPath(candidate.command, true);
    return target ? this.result(target, [], 'native', target) : null;
  }

  private resolvePackageBin(candidate: Extract<RuntimeCandidate, { kind: 'node-package-bin' }>): ResolvedRuntime | null {
    const shim = this.findOnPath(candidate.command, false);
    if (!shim) return null;
    const packageRoot = path.join(path.dirname(shim), 'node_modules', ...candidate.packageName.split('/'));
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
      const relativeBin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[candidate.binName || candidate.command];
      if (typeof relativeBin !== 'string') return null;
      const rootReal = fs.realpathSync(packageRoot);
      const target = canonicalFile(path.resolve(packageRoot, relativeBin));
      if (!target || !isInside(rootReal, target)) return null;
      return this.result(this.nodePath, [target], 'node-script', target);
    } catch (_) { return null; }
  }

  private findOnPath(command: string, nativeOnly: boolean): string | null {
    if (path.isAbsolute(command) || command.includes('/') || command.includes('\\')) return canonicalFile(command);
    const directories = String(this.env.PATH || this.env.Path || '').split(path.delimiter).filter(Boolean);
    const names = this.platform === 'win32'
      ? (nativeOnly ? ['.exe'] : ['.exe', '.cmd', '']).map(extension => `${command}${extension}`)
      : [command];
    for (const directory of directories) {
      for (const name of names) {
        const target = canonicalFile(path.join(directory.replace(/^"|"$/g, ''), name));
        if (target) return target;
      }
    }
    return null;
  }

  private result(executable: string, argvPrefix: string[], runtimeKind: RuntimeKind, canonicalPath: string): ResolvedRuntime {
    const stat = fs.statSync(canonicalPath);
    return {
      available: true, executable, argvPrefix: Object.freeze([...argvPrefix]), runtimeKind, canonicalPath,
      fingerprint: `${canonicalPath}:${stat.size}:${stat.mtimeMs}`, resolvedAt: this.now(),
    };
  }
}

export const defaultAgentRuntimeResolver = new AgentRuntimeResolver();
module.exports = { AgentRuntimeResolver, defaultAgentRuntimeResolver };
