import type { ChildProcess } from 'child_process';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

export interface ProcessIdentity {
  pid: number;
  parentPid: number | null;
  creationId: string;
  executablePath: string;
  commandLine: string;
}

export interface InstanceMetadata extends ProcessIdentity {
  version: 1;
  /**
   * The supervisor identity is intentionally kept in the ephemeral owner
   * record.  On Unix a killed supervisor can leave the runtime child alive
   * after it is re-parented; the child must no longer count as this instance.
   * Older owner records do not have this field and remain PID-compatible.
   */
  parentCreationId?: string | null;
  instanceId: string;
  mcpToken: string;
  dbPath: string;
  entryPath: string;
  port: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface WorkerMetadata extends ProcessIdentity {
  version: 1;
  instanceId: string;
  workerToken: string;
  agentId: string;
  workerPath: string;
  parentCreationId: string;
  createdAt: number;
}

export interface InstanceLock {
  metadata: InstanceMetadata;
  lockDir: string;
  ownerFile: string;
  updatePort(port: number): void;
  release(): void;
}

export interface AcquireInstanceResult {
  acquired: boolean;
  lock?: InstanceLock;
  existing?: InstanceMetadata;
}

interface ProcessLifecycleDeps {
  inspectProcess?: (pid: number) => ProcessIdentity | null;
  sleep?: (ms: number) => Promise<void>;
  securePath?: (filePath: string, isDirectory: boolean) => void;
}

const LOCK_INIT_GRACE_MS = 5000;
const WORKER_EXIT_CONFIRM_TIMEOUT_MS = 2000;
const PROCESS_POLL_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function normalizePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function canonicalDbPath(dbPath: string): string {
  const resolved = path.resolve(dbPath);
  try {
    const parent = fs.realpathSync.native(path.dirname(resolved));
    return normalizePath(path.join(parent, path.basename(resolved)));
  } catch {
    return normalizePath(resolved);
  }
}

function getRuntimePaths(dbPath: string): {
  runtimeDir: string;
  lockDir: string;
  ownerFile: string;
  workersDir: string;
} {
  const canonical = canonicalDbPath(dbPath);
  const hash = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 20);
  const runtimeDir = path.join(path.dirname(canonical), '.voko-runtime');
  const lockDir = path.join(runtimeDir, `lite-${hash}.lock`);
  return {
    runtimeDir,
    lockDir,
    ownerFile: path.join(lockDir, 'owner.json'),
    workersDir: path.join(runtimeDir, `workers-${hash}`),
  };
}

function secureWindowsPathForCurrentUser(filePath: string, isDirectory: boolean): void {
  const encodedPath = Buffer.from(path.resolve(filePath), 'utf8').toString('base64');
  const inheritance = isDirectory
    ? '[System.Security.AccessControl.InheritanceFlags]"ContainerInherit, ObjectInherit"'
    : '[System.Security.AccessControl.InheritanceFlags]::None';
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))`,
    '$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User',
    '& icacls.exe $path /inheritance:r | Out-Null',
    'if ($LASTEXITCODE -ne 0) { throw "Unable to disable ACL inheritance" }',
    `$item = ${isDirectory ? '[IO.DirectoryInfo]::new($path)' : '[IO.FileInfo]::new($path)'}`,
    '$acl = $item.GetAccessControl()',
    '$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))',
    'foreach ($rule in $rules) {',
    '  if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }',
    '  $ruleSid = $rule.IdentityReference.Value',
    '  if ($ruleSid -eq $sid.Value) { continue }',
    '  & icacls.exe $path /remove:g ("*" + $ruleSid) | Out-Null',
    '  if ($LASTEXITCODE -ne 0) { throw "Unable to remove a foreign ACL grant" }',
    '}',
    `$grant = "*" + $sid.Value + ":" + ${isDirectory ? "'(OI)(CI)F'" : "'F'"}`,
    '& icacls.exe $path /grant:r $grant | Out-Null',
    'if ($LASTEXITCODE -ne 0) { throw "Unable to grant the current user runtime access" }',
    '$verified = $item.GetAccessControl()',
    'if (-not $verified.AreAccessRulesProtected) { throw "ACL inheritance is still enabled" }',
    '$allow = @($verified.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object { $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $_.FileSystemRights -ne 0 })',
    '$foreign = @($allow | Where-Object { $_.IdentityReference.Value -ne $sid.Value })',
    'if ($foreign.Count -ne 0) { throw "ACL grants access to another identity" }',
    '$mine = @($allow | Where-Object { $_.IdentityReference.Value -eq $sid.Value -and (($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl) })',
    'if ($mine.Count -eq 0) { throw "Current user lacks FullControl" }',
  ].join('; ');
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error(`Unable to protect VOKO runtime path for the current Windows user: ${String(result.error?.message || result.stderr || result.status)}`);
  }
}

function securePrivatePath(filePath: string, isDirectory: boolean): void {
  if (process.platform === 'win32') {
    secureWindowsPathForCurrentUser(filePath, isDirectory);
    return;
  }
  fs.chmodSync(filePath, isDirectory ? 0o700 : 0o600);
}

function atomicWriteJson(filePath: string, value: unknown): void {
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  try {
    fs.renameSync(tempPath, filePath);
    securePrivatePath(filePath, false);
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }); } catch {}
    throw error;
  }
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function inspectWindowsProcess(pid: number): ProcessIdentity | null {
  const script = [
    `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue;`,
    'if($p){',
    '$o=[ordered]@{pid=[int]$p.ProcessId;parentPid=[int]$p.ParentProcessId;',
    'creationId=($p.CreationDate.ToUniversalTime().Ticks.ToString());',
    'executablePath=[string]$p.ExecutablePath;commandLine=[string]$p.CommandLine};',
    '$o|ConvertTo-Json -Compress',
    '}',
  ].join('');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  if (result.status !== 0 || !String(result.stdout || '').trim()) return null;
  try {
    const value = JSON.parse(String(result.stdout).trim());
    return {
      pid: Number(value.pid),
      parentPid: Number(value.parentPid) || null,
      creationId: String(value.creationId || ''),
      executablePath: String(value.executablePath || ''),
      commandLine: String(value.commandLine || ''),
    };
  } catch {
    return null;
  }
}

function inspectWindowsProcesses(pids: number[]): Map<number, ProcessIdentity> {
  const identities = new Map<number, ProcessIdentity>();
  const validPids = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (validPids.length === 0) return identities;
  const filter = validPids.map((pid) => `ProcessId=${pid}`).join(' OR ');
  const script = [
    `$ps=Get-CimInstance Win32_Process -Filter "${filter}" -ErrorAction SilentlyContinue;`,
    '$out=@($ps|ForEach-Object{[ordered]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;',
    'creationId=($_.CreationDate.ToUniversalTime().Ticks.ToString());',
    'executablePath=[string]$_.ExecutablePath;commandLine=[string]$_.CommandLine}});',
    '$out|ConvertTo-Json -Compress',
  ].join('');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  if (result.status !== 0 || !String(result.stdout || '').trim()) return identities;
  try {
    const parsed = JSON.parse(String(result.stdout).trim());
    const values = Array.isArray(parsed) ? parsed : [parsed];
    for (const value of values) {
      const identity = {
        pid: Number(value.pid),
        parentPid: Number(value.parentPid) || null,
        creationId: String(value.creationId || ''),
        executablePath: String(value.executablePath || ''),
        commandLine: String(value.commandLine || ''),
      };
      if (identity.pid > 0) identities.set(identity.pid, identity);
    }
  } catch {}
  return identities;
}

function parseLinuxProcessStat(stat: string): { parentPid: number | null; creationId: string } | null {
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const fields = stat.slice(close + 2).trim().split(/\s+/);
  if (fields[0] === 'Z') return null;
  return {
    parentPid: Number(fields[1]) || null,
    creationId: String(fields[19] || ''),
  };
}

function inspectLinuxProcess(pid: number): ProcessIdentity | null {
  try {
    const parsed = parseLinuxProcessStat(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
    if (!parsed) return null;
    const executablePath = fs.readlinkSync(`/proc/${pid}/exe`);
    const commandLine = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
    return { pid, ...parsed, executablePath, commandLine };
  } catch {
    return null;
  }
}

function parsePsProcessOutput(pid: number, rawOutput: string): ProcessIdentity | null {
  const output = rawOutput.trim();
  if (!output) return null;
  const match = output.match(
    /^(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+([\s\S]+)$/,
  );
  if (!match) return null;
  return {
    pid,
    parentPid: Number(match[1]) || null,
    creationId: match[2].replace(/\s+/g, ' '),
    executablePath: '',
    commandLine: match[3],
  };
}

function inspectPsProcess(pid: number): ProcessIdentity | null {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'ppid=', '-o', 'lstart=', '-o', 'command='], {
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  });
  if (result.status !== 0) return null;
  return parsePsProcessOutput(pid, String(result.stdout || ''));
}

export function inspectProcess(pid: number): ProcessIdentity | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'win32') return inspectWindowsProcess(pid);
  if (process.platform === 'linux') return inspectLinuxProcess(pid);
  return inspectPsProcess(pid);
}

function samePath(left: string, right: string): boolean {
  if (!left || !right) return false;
  return normalizePath(left) === normalizePath(right);
}

export function matchesInstanceProcess(
  metadata: InstanceMetadata,
  identity: ProcessIdentity | null,
): boolean {
  if (!identity || identity.pid !== metadata.pid) return false;
  if (!metadata.creationId || identity.creationId !== metadata.creationId) return false;
  if (metadata.executablePath && identity.executablePath
    && !samePath(metadata.executablePath, identity.executablePath)) return false;
  if (metadata.commandLine && identity.commandLine !== metadata.commandLine) return false;
  const expectedEntry = normalizePath(metadata.entryPath);
  const actualCommand = process.platform === 'win32'
    ? identity.commandLine.toLowerCase()
    : identity.commandLine;
  if (expectedEntry && actualCommand.includes(expectedEntry)) return true;
  return actualCommand.includes(path.basename(expectedEntry));
}

export function matchesWorkerProcess(
  metadata: WorkerMetadata,
  identity: ProcessIdentity | null,
): boolean {
  if (!identity || identity.pid !== metadata.pid) return false;
  if (!metadata.creationId || identity.creationId !== metadata.creationId) return false;
  if (metadata.executablePath && identity.executablePath
    && !samePath(metadata.executablePath, identity.executablePath)) return false;
  const command = process.platform === 'win32'
    ? identity.commandLine.toLowerCase()
    : identity.commandLine;
  const workerPath = normalizePath(metadata.workerPath);
  return command.includes(workerPath)
    && command.includes(`--voko-worker-token=${metadata.workerToken}`)
    && command.includes(`--voko-instance-id=${metadata.instanceId}`);
}

function buildInstanceMetadata(dbPath: string, entryPath: string): InstanceMetadata {
  const identity = inspectProcess(process.pid);
  if (!identity) throw new Error(`无法读取当前 Lite 进程身份（PID ${process.pid}）`);
  const parent = identity.parentPid ? inspectProcess(identity.parentPid) : null;
  const now = Date.now();
  return {
    version: 1,
    ...identity,
    parentCreationId: parent?.creationId || null,
    instanceId: crypto.randomUUID(),
    mcpToken: crypto.randomBytes(32).toString('base64url'),
    dbPath: canonicalDbPath(dbPath),
    entryPath: normalizePath(entryPath),
    port: null,
    createdAt: now,
    updatedAt: now,
  };
}

function createLockHandle(
  metadata: InstanceMetadata,
  lockDir: string,
  ownerFile: string,
): InstanceLock {
  let released = false;
  const write = () => atomicWriteJson(ownerFile, metadata);
  return {
    metadata,
    lockDir,
    ownerFile,
    updatePort(port: number) {
      if (released) return;
      const current = readJson<InstanceMetadata>(ownerFile);
      if (!current || current.instanceId !== metadata.instanceId) return;
      metadata.port = port;
      metadata.updatedAt = Date.now();
      write();
    },
    release() {
      if (released) return;
      released = true;
      const current = readJson<InstanceMetadata>(ownerFile);
      if (!current || current.instanceId !== metadata.instanceId) return;
      try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {}
    },
  };
}

export async function acquireInstanceLock(
  dbPath: string,
  entryPath: string,
  deps: ProcessLifecycleDeps = {},
): Promise<AcquireInstanceResult> {
  const paths = getRuntimePaths(dbPath);
  const inspect = deps.inspectProcess || inspectProcess;
  const sleep = deps.sleep || ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
  const securePath = deps.securePath || securePrivatePath;
  fs.mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
  securePath(paths.runtimeDir, true);

  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      fs.mkdirSync(paths.lockDir, { mode: 0o700 });
      try {
        securePath(paths.lockDir, true);
        const metadata = buildInstanceMetadata(dbPath, entryPath);
        atomicWriteJson(paths.ownerFile, metadata);
        return { acquired: true, lock: createLockHandle(metadata, paths.lockDir, paths.ownerFile) };
      } catch (error) {
        try { fs.rmSync(paths.lockDir, { recursive: true, force: true }); } catch {}
        throw error;
      }
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
    }

    const existing = readJson<InstanceMetadata>(paths.ownerFile);
    if (existing && isInstanceAlive(existing, inspect)) {
      return { acquired: false, existing };
    }

    let age = Number.POSITIVE_INFINITY;
    try { age = Date.now() - fs.statSync(paths.lockDir).birthtimeMs; } catch {}
    const ownerFileExists = fs.existsSync(paths.ownerFile);
    if (!existing && !ownerFileExists && age < LOCK_INIT_GRACE_MS) {
      await sleep(100);
      continue;
    }

    const stalePath = `${paths.lockDir}.stale-${process.pid}-${crypto.randomUUID()}`;
    try {
      fs.renameSync(paths.lockDir, stalePath);
      try { fs.rmSync(stalePath, { recursive: true, force: true }); } catch {}
    } catch (error: any) {
      if (error?.code !== 'ENOENT') await sleep(50);
    }
  }
  throw new Error('获取 Lite 单实例锁超时');
}

export function readInstanceMetadata(dbPath: string): InstanceMetadata | null {
  return readJson<InstanceMetadata>(getRuntimePaths(dbPath).ownerFile);
}

export function removeInstanceLock(dbPath: string, instanceId: string): boolean {
  const paths = getRuntimePaths(dbPath);
  const current = readJson<InstanceMetadata>(paths.ownerFile);
  if (!current || current.instanceId !== instanceId) return false;
  try {
    fs.rmSync(paths.lockDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export function isInstanceAlive(
  metadata: InstanceMetadata,
  inspector: (pid: number) => ProcessIdentity | null = inspectProcess,
): boolean {
  const identity = inspector(metadata.pid);
  if (!matchesInstanceProcess(metadata, identity)) return false;

  // A normal Lite process is supervised.  If that supervisor was killed,
  // Unix reparents the child (usually to PID 1); the child may still match
  // its own PID/command line but no longer owns this runtime lock.  Treat it
  // as stale.  Records written before parentCreationId was introduced keep
  // the parent-PID check for backwards compatibility.
  if (!metadata.parentPid || metadata.parentPid <= 0) return true;
  if (identity?.parentPid !== metadata.parentPid) return false;
  const parent = inspector(metadata.parentPid);
  if (!parent) return false;
  return !metadata.parentCreationId || parent.creationId === metadata.parentCreationId;
}

export async function waitForProcessExit(
  pid: number,
  timeoutMs: number,
  inspector: (pid: number) => ProcessIdentity | null = inspectProcess,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!inspector(pid)) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return !inspector(pid);
}

export async function terminateInstance(
  metadata: InstanceMetadata,
  inspector: (pid: number) => ProcessIdentity | null = inspectProcess,
): Promise<boolean> {
  // The process may finish naturally between the graceful wait and this
  // fallback. In that case the target instance is already stopped; reporting
  // failure creates a contradictory "exited / still alive" result.
  if (!matchesInstanceProcess(metadata, inspector(metadata.pid))) return true;
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill.exe', ['/PID', String(metadata.pid), '/T', '/F'], {
      stdio: 'ignore',
      timeout: 10000,
      windowsHide: true,
    });
    if (result.error && !matchesInstanceProcess(metadata, inspector(metadata.pid))) return true;
  } else {
    try { process.kill(metadata.pid, 'SIGTERM'); } catch {}
    if (!await waitForProcessExit(metadata.pid, 3000, inspector)
      && matchesInstanceProcess(metadata, inspector(metadata.pid))) {
      try { process.kill(metadata.pid, 'SIGKILL'); } catch {}
    }
  }
  return waitForProcessExit(metadata.pid, 5000, inspector);
}

function workerFile(dbPath: string, token: string): string {
  return path.join(getRuntimePaths(dbPath).workersDir, `${token}.json`);
}

export function registerWorker(
  dbPath: string,
  instance: InstanceMetadata,
  agentId: string,
  workerPath: string,
  workerToken: string,
  worker: ChildProcess,
): WorkerMetadata | null {
  if (!worker.pid) return null;
  const identity = inspectProcess(worker.pid);
  if (!identity) return null;
  const metadata: WorkerMetadata = {
    version: 1,
    ...identity,
    instanceId: instance.instanceId,
    workerToken,
    agentId,
    workerPath: normalizePath(workerPath),
    parentCreationId: instance.creationId,
    createdAt: Date.now(),
  };
  const filePath = workerFile(dbPath, workerToken);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  securePrivatePath(path.dirname(filePath), true);
  atomicWriteJson(filePath, metadata);
  return metadata;
}

export function registerWorkers(
  dbPath: string,
  instance: InstanceMetadata,
  workers: Array<{
    agentId: string;
    workerPath: string;
    workerToken: string;
    worker: ChildProcess;
  }>,
): Map<string, WorkerMetadata> {
  const result = new Map<string, WorkerMetadata>();
  const active = workers.filter((item) => item.worker.pid);
  const identities = process.platform === 'win32'
    ? inspectWindowsProcesses(active.map((item) => item.worker.pid as number))
    : new Map(active.map((item) => {
      const identity = inspectProcess(item.worker.pid as number);
      return [item.worker.pid as number, identity] as const;
    }).filter((entry): entry is [number, ProcessIdentity] => !!entry[1]));

  for (const item of active) {
    const pid = item.worker.pid as number;
    const identity = identities.get(pid) || inspectProcess(pid);
    if (!identity) continue;
    const metadata: WorkerMetadata = {
      version: 1,
      ...identity,
      instanceId: instance.instanceId,
      workerToken: item.workerToken,
      agentId: item.agentId,
      workerPath: normalizePath(item.workerPath),
      parentCreationId: instance.creationId,
      createdAt: Date.now(),
    };
    const filePath = workerFile(dbPath, item.workerToken);
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    securePrivatePath(path.dirname(filePath), true);
    atomicWriteJson(filePath, metadata);
    result.set(item.workerToken, metadata);
  }
  return result;
}

export function unregisterWorker(dbPath: string, workerToken: string): void {
  try { fs.rmSync(workerFile(dbPath, workerToken), { force: true }); } catch {}
}

export function cleanupOrphanedWorkers(
  dbPath: string,
  inspector: (pid: number) => ProcessIdentity | null = inspectProcess,
): { killed: number[]; skipped: number[] } {
  const workersDir = getRuntimePaths(dbPath).workersDir;
  const killed: number[] = [];
  const skipped: number[] = [];
  let files: string[] = [];
  try { files = fs.readdirSync(workersDir).filter((name: string) => name.endsWith('.json')); } catch {}
  for (const name of files) {
    const filePath = path.join(workersDir, name);
    const metadata = readJson<WorkerMetadata>(filePath);
    if (!metadata) {
      skipped.push(0);
      continue;
    }
    const parent = inspector(metadata.parentPid || 0);
    const parentStillOwnsWorker = Boolean(parent && parent.creationId === metadata.parentCreationId);
    const worker = inspector(metadata.pid);
    if (parentStillOwnsWorker || !matchesWorkerProcess(metadata, worker)) {
      if (!worker) {
        try { fs.rmSync(filePath, { force: true }); } catch {}
      } else {
        skipped.push(metadata.pid);
      }
      continue;
    }
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill.exe', ['/PID', String(metadata.pid), '/T', '/F'], {
          stdio: 'ignore', timeout: 5000, windowsHide: true,
        });
      } else {
        process.kill(metadata.pid, 'SIGKILL');
      }
    } catch {}
    const deadline = Date.now() + WORKER_EXIT_CONFIRM_TIMEOUT_MS;
    while (matchesWorkerProcess(metadata, inspector(metadata.pid)) && Date.now() < deadline) {
      Atomics.wait(PROCESS_POLL_BUFFER, 0, 0, 10);
    }
    if (!matchesWorkerProcess(metadata, inspector(metadata.pid))) {
      killed.push(metadata.pid);
      try { fs.rmSync(filePath, { force: true }); } catch {}
    } else {
      skipped.push(metadata.pid);
    }
  }
  return { killed, skipped };
}

export const _test = {
  canonicalDbPath,
  getRuntimePaths,
  parseLinuxProcessStat,
  parsePsProcessOutput,
  readJson,
};
