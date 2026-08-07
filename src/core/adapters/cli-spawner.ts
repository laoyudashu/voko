/**
 * cli-spawner.js — 通用 CLI 子进程管理器
 *
 * 封装 spawn/kill/timer/stdout 采集逻辑，消除 openclaw-cli/hermes-cli 等
 * provider 中的重复代码。
 */

const { execFileSync } = require('child_process');
const spawn = require('cross-spawn');
const os = require('os');
const path = require('path');
const fs = require('fs');
import type { ChildProcess, SpawnOptions, StdioOptions } from 'child_process';

export interface RunCliOptions {
  cmd: string;
  args?: string[];
  timeout?: number;
  env?: NodeJS.ProcessEnv;
  /** Environment variable names to remove after merging the parent env. */
  envUnset?: string[];
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  tag?: string;
  windowsHide?: boolean;
  stdinInput?: string;
  cwd?: string;
  maxOutputBytes?: number;
  logOutput?: boolean;
}

export interface RunCliResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

// ── 日志 ─────────────────────────────────────────────────────────────

const _logDir = os.tmpdir();

function _makeLogger(tag: string): (message: string) => void {
  const logFile = path.join(_logDir, `voko-cli-${tag}.log`);
  return (msg: string) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    try { fs.appendFileSync(logFile, line); } catch (_) {}
    console.error(msg);
  };
}

// ── 工具 ─────────────────────────────────────────────────────────────

/** 跨平台进程树 kill（Windows taskkill / Unix 独立进程组） */
function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', timeout: 3000 });
    } else {
      // runCli/OpenCode 在 Unix 下以 detached 创建独立进程组；负 PID 可一次终止整个树。
      try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} }
    }
  } catch (_) {}
}

/** 检查 CLI 命令是否在 PATH 或指定路径存在 */
function checkCliAvailable(cli?: string | null): boolean {
  if (!cli) return false;
  // 绝对路径直接检查文件存在
  if (path.isAbsolute(cli)) return fs.existsSync(cli);
  // 命令名 — 用 where/which 检测
  try {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    execFileSync(whichCmd, [cli], { stdio: 'ignore', timeout: 3000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function windowsUserPath(): string {
  if (process.platform !== 'win32') return '';
  try {
    const output = String(execFileSync('reg.exe', ['query', 'HKCU\\Environment', '/v', 'Path'], {
      encoding: 'utf8', windowsHide: true, timeout: 3000,
    }));
    const match = output.match(/\bREG_(?:EXPAND_)?SZ\s+([^\r\n]+)/i);
    return match ? match[1].replace(/%([^%]+)%/g, (_: string, key: string) => process.env[key] || '').trim() : '';
  } catch (_) { return ''; }
}

function childEnv(extra?: NodeJS.ProcessEnv, unset: string[] = []): NodeJS.ProcessEnv {
  const merged = { ...process.env, ...(extra || {}) };
  for (const key of unset) delete merged[key];
  const userPath = windowsUserPath();
  if (userPath) {
    const current = String(merged.PATH || merged.Path || '');
    const key = process.platform === 'win32' ? 'Path' : 'PATH';
    merged[key] = [current, userPath].filter(Boolean).join(path.delimiter);
    if (key === 'Path') merged.PATH = merged[key];
  }
  return merged;
}

/**
 * 运行 CLI 命令，返回 stdout 全文 + exit code。
 *
 * @param {object} opts
 * @param {string}   opts.cmd                 - 命令或路径
 * @param {string[]} [opts.args]              - 参数
 * @param {number}   [opts.timeout=120000]    - 超时 ms
 * @param {object}   [opts.env]               - 额外环境变量
 * @param {function} [opts.onStdoutLine]      - 每行 stdout 回调（行尾换行符已去除）
 * @param {function} [opts.onStderrLine]      - 每行 stderr 回调
 * @param {string}   [opts.tag]               - 日志 tag
 * @param {boolean}  [opts.windowsHide=true]  - Windows 隐藏窗口
 * @param {string}   [opts.stdinInput]        - 经 stdin 传入的内容（避开命令行参数长度/换行/转义限制）
 * @param {string}   [opts.cwd]               - 子进程工作目录
 * @returns {Promise<{stdout:string,stderr:string,code:number|null,signal:string|null}>}
 */
function runCli(opts: RunCliOptions = {} as RunCliOptions): Promise<RunCliResult> {
  const {
    cmd,
    args = [],
    timeout = 120000,
    env,
    envUnset = [],
    onStdoutLine,
    onStderrLine,
    tag = 'cli',
    windowsHide = true,
    stdinInput,
    cwd,
    maxOutputBytes = 8 * 1024 * 1024,
    logOutput = true,
  } = opts;

  const log = _makeLogger(tag);
  const useStdin = stdinInput != null;
  const stdio: StdioOptions = useStdin ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'];

  return new Promise<RunCliResult>((resolve, reject) => {
    let child: ChildProcess;
    const isWin = process.platform === 'win32';
    const spawnOpts: SpawnOptions = {
      stdio,
      windowsHide,
      detached: !isWin,
      cwd: cwd || undefined,
      env: childEnv(env, envUnset),
    };

    // .js/.exe 等直接 spawn；无扩展名的命令名交给系统 PATH
    child = spawn(cmd, args, spawnOpts);

    if (useStdin) {
      child.stdin!.on('error', () => {}); // EPIPE 等忽略
      child.stdin!.end(stdinInput);
    }

    let stdout = '', stderr = '';
    let stdoutBytes = 0, stderrBytes = 0;
    let settled = false;
    let _lineBuffer = ''; // 跨 data chunk 的不完整行累积

    const timer = setTimeout(() => {
      if (settled) return;
      log(`[${tag}] 超时 (${timeout}ms) — kill pid=${child.pid}`);
      if (child.pid !== undefined) killTree(child.pid);
      settled = true;
      reject(new Error(`cli 超时 (${timeout}ms)`));
    }, timeout);

    const rejectOversizedOutput = (stream: 'stdout' | 'stderr'): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.pid !== undefined) killTree(child.pid);
      reject(new Error(`cli ${stream} 输出超过安全上限 (${maxOutputBytes} bytes)`));
    };

    child.stdout!.on('data', (d: Buffer) => {
      if (settled) return;
      stdoutBytes += d.length;
      if (stdoutBytes > maxOutputBytes) return rejectOversizedOutput('stdout');
      const text = d.toString();
      stdout += text;
      if (onStdoutLine) {
        _lineBuffer += text;
        const lines = _lineBuffer.split('\n');
        // 最后一段可能是未完成的行，保留在 buffer 中
        _lineBuffer = lines.pop() || '';
        for (let i = 0; i < lines.length; i++) {
          try { onStdoutLine(lines[i]!); } catch {}
        }
      }
    });

    child.stderr!.on('data', (d: Buffer) => {
      if (settled) return;
      stderrBytes += d.length;
      if (stderrBytes > maxOutputBytes) return rejectOversizedOutput('stderr');
      const text = d.toString();
      stderr += text;
      if (onStderrLine) {
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (line) try { onStderrLine(line); } catch {}
        }
      }
    });

    child.on('error', (err: Error) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      log(`[${tag}] spawn error: ${err.message}`);
      reject(err);
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      // flush 最后的不完整行
      if (_lineBuffer && onStdoutLine) {
        try { onStdoutLine(_lineBuffer); } catch {}
      }
      if (logOutput && stdout) {
        if (stdout.length > 500) {
          log(`[${tag}] stdout(${stdout.length}chars):\n${stdout.slice(0, 200)}...${stdout.slice(-100)}`);
        } else {
          log(`[${tag}] stdout:\n${stdout}`);
        }
      }
      if (logOutput && stderr) log(`[${tag}] stderr(尾3000):\n${stderr.slice(-3000)}`);
      resolve({ stdout, stderr, code, signal });
    });
  });
}

/** Windows cmd.exe 命令行参数安全净化：访客消息等不可信内容经命令行参数传入时调用。
 *  防 " 断裂 cmd 引号（命令注入主向量）、&|<> 命令分隔/重定向、%VAR% 展开、换行截断命令行。
 *  Unix 直接 exec 无 shell 重解析，调用方按需仅在 win32 使用。 */
function sanitizeCmdArg(p: string): string;
function sanitizeCmdArg(p: null): null;
function sanitizeCmdArg(p: undefined): undefined;
function sanitizeCmdArg(p: unknown): string | null | undefined;
function sanitizeCmdArg(p: unknown): string | null | undefined {
  if (p == null) return p;
  return String(p)
    .replace(/"/g, "'")
    .replace(/[&|<>()%^`]/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

module.exports = { runCli, killTree, checkCliAvailable, sanitizeCmdArg, _makeLogger };
