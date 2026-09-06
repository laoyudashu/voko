import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import type { ResolvedRuntime } from '../runtime/agent-runtime-resolver';
import { withRuntimePath } from '../runtime/agent-runtime-resolver';

export interface CodexCompatibility {
  runtimeVersion: string | null;
  callCompatibility: 'unverified' | 'parameters_checked' | 'unsupported';
  sandboxVerified: boolean;
  reason: string;
}

// Include the native payload behind npm's JS launcher, not just Node/the shim.
export function inspectCodexRuntime(runtime: ResolvedRuntime): ResolvedRuntime {
  const files = new Set<string>([process.execPath, runtime.executable, runtime.canonicalPath, ...runtime.argvPrefix]
    .filter((file): file is string => Boolean(file)));
  if (runtime.canonicalPath) files.add(path.join(path.dirname(runtime.canonicalPath), 'codex-code-mode-host'));
  for (const file of [...files]) {
    let dir = path.dirname(file);
    for (let depth = 0; depth < 3; depth++, dir = path.dirname(dir)) {
      const manifest = path.join(dir, 'package.json');
      try {
        if (JSON.parse(fs.readFileSync(manifest, 'utf8')).name !== '@openai/codex') continue;
        files.add(manifest);
        const walk = (root: string, remaining: number): void => {
          if (!remaining) return;
          try { for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
            const target = path.join(root, entry.name);
            if (entry.isDirectory()) walk(target, remaining - 1);
            else if (/^(codex(?:-code-mode-host)?(?:\.exe)?|(?:codex-)?package\.json)$/.test(entry.name)) files.add(target);
          } } catch (_) {}
        };
        walk(path.join(dir, 'vendor'), 5);
        walk(path.join(dir, 'node_modules', '@openai'), 7);
        break;
      } catch (_) {}
    }
  }
  const stamps = [...files].sort().map(file => {
    try { const st = fs.statSync(file); return [fs.realpathSync(file), st.size, st.mtimeMs, st.ctimeMs]; }
    catch (_) { return [file, 'missing']; }
  });
  return { ...runtime, fingerprint: crypto.createHash('sha256')
    .update(JSON.stringify([runtime.available, runtime.fingerprint, stamps, process.platform, process.arch])).digest('hex') };
}

export type CodexProbeRunner = (args: string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<{ code: number | null; stdout: string }>;

export function codexProbeRunner(runtime: ResolvedRuntime): CodexProbeRunner {
  return (args, cwd, env) => new Promise(resolve => {
    if (!runtime.available || !runtime.executable) return resolve({ code: null, stdout: '' });
    const child = execFile(runtime.executable, [...runtime.argvPrefix, ...args], {
      cwd, env: withRuntimePath(env, runtime), timeout: 3500, killSignal: 'SIGKILL',
      maxBuffer: 256 * 1024, encoding: 'utf8', windowsHide: true,
    }, (error, stdout) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : null) : 0,
      stdout: String(stdout || '') }));
    child.stdin?.end();
  });
}

export function codexContractSupported(root: string, exec: string, resume: string): boolean {
  return ['--sandbox', 'read-only', 'workspace-write', '--ask-for-approval', 'never', '--profile']
    .every(flag => root.includes(flag))
    && ['--json', '--sandbox', '--skip-git-repo-check'].every(flag => exec.includes(flag))
    && ['--json', '--skip-git-repo-check', '[SESSION_ID]'].every(flag => resume.includes(flag));
}

/** No model, credentials, user configuration, or visitor task is used by this probe. */
export async function probeCodexCompatibility(runtime: ResolvedRuntime,
  run = codexProbeRunner(runtime), platform: NodeJS.Platform = process.platform): Promise<CodexCompatibility> {
  const result: CodexCompatibility = { runtimeVersion: null, callCompatibility: 'unverified',
    sandboxVerified: false, reason: 'CODEX_RUNTIME_UNAVAILABLE' };
  if (!runtime.available) return result;
  // Outside the OS temp tree: workspace-write normally grants access to /tmp too.
  let dir: string;
  try { dir = fs.mkdtempSync(path.join(os.homedir(), '.voko-codex-probe-')); }
  catch (_) { return { ...result, reason: 'CODEX_PROBE_DIRECTORY_UNAVAILABLE' }; }
  try {
    const home = path.join(dir, 'home'), work = path.join(dir, 'work'), outside = path.join(dir, 'outside');
    for (const folder of [home, work, outside]) fs.mkdirSync(folder, { mode: 0o700 });
    const env: NodeJS.ProcessEnv = { CODEX_HOME: home };
    for (const key of ['PATH', 'Path', 'HOME', 'USERPROFILE', 'SystemRoot', 'SYSTEMROOT', 'WINDIR',
      'TMP', 'TMPDIR', 'TEMP', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'PATHEXT', 'COMSPEC', 'LOCALAPPDATA', 'APPDATA']) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    const version = await run(['--version'], work, env);
    if (version.code === 0) result.runtimeVersion = /^codex-cli\s+(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\s*$/m.exec(version.stdout)?.[1] || null;
    const root = await run(['--help'], work, env);
    const first = await run(['exec', '--help'], work, env);
    // This exact placement also checks the root options accepted by exec resume.
    const resume = await run(['--sandbox', 'read-only', '--ask-for-approval', 'never', 'exec', 'resume', '--help'], work, env);
    if ([root, first, resume].some(item => item.code !== 0)
      || !codexContractSupported(root.stdout, first.stdout, resume.stdout)) {
      return { ...result, callCompatibility: 'unsupported', reason: 'CODEX_CLI_CONTRACT_UNVERIFIED' };
    }
    result.callCompatibility = 'parameters_checked';
    // A newly downloaded macOS binary can exceed the first-launch time budget.
    // Retry metadata once after the help probes; never infer a version from PATH.
    if (!result.runtimeVersion) {
      const retry = await run(['--version'], work, env);
      if (retry.code === 0) result.runtimeVersion = /^codex-cli\s+(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\s*$/m.exec(retry.stdout)?.[1] || null;
    }
    const sandbox = await run(['sandbox', '--help'], work, env);
    if (sandbox.code !== 0) return { ...result, reason: 'CODEX_SANDBOX_PROBE_UNAVAILABLE' };
    const subcommand = platform === 'darwin' ? 'macos' : platform === 'linux' ? 'linux' : 'windows';
    const sandboxArgs = /Usage:\s+codex sandbox \[OPTIONS\] \[COMMAND\]\.\.\./.test(sandbox.stdout)
      ? ['sandbox'] : new RegExp(`\\b${subcommand}\\b`).test(sandbox.stdout) ? ['sandbox', subcommand] : null;
    if (!sandboxArgs) return { ...result, reason: 'CODEX_SANDBOX_PROBE_UNAVAILABLE' };
    const source = path.join(outside, 'read-canary');
    fs.writeFileSync(source, 'voko-canary');
    const program = `const fs=require('fs');const [read,inside,outside]=process.argv.slice(1);const write=p=>{try{fs.writeFileSync(p,'voko-canary');return 'allowed'}catch(e){return e.code}};console.log(JSON.stringify({read:fs.readFileSync(read,'utf8'),inside:write(inside),outside:write(outside)}));`;
    for (const mode of ['read-only', 'workspace-write']) {
      const insideFile = path.join(work, mode), outsideFile = path.join(outside, mode);
      const check = await run([...sandboxArgs, '-c', `sandbox_mode="${mode}"`, '--', process.execPath, '-e', program,
        source, insideFile, outsideFile], work, env);
      let observed: any = null;
      try { observed = JSON.parse(check.stdout.trim()); } catch (_) {}
      const denied = (value: unknown) => value === 'EPERM' || value === 'EACCES';
      if (check.code !== 0 || observed?.read !== 'voko-canary' || !denied(observed?.outside)
        || fs.existsSync(outsideFile) || (mode === 'read-only'
          ? !denied(observed?.inside) || fs.existsSync(insideFile)
          : observed?.inside !== 'allowed' || !fs.existsSync(insideFile))) {
        return { ...result, reason: 'CODEX_SANDBOX_CANARY_FAILED' };
      }
    }
    return { ...result, sandboxVerified: true, reason: 'CODEX_SANDBOX_CANARY_VERIFIED' };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
