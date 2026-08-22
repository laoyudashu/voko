import { spawn } from 'node:child_process';
import path from 'node:path';

export const PENDING_OWNER_SWITCH_CONFIG = 'pending_owner_switch';
export const OWNER_SWITCH_RESTART_NOTICE_CONFIG = 'owner_switch_restart_notice';
const PENDING_OWNER_SWITCH_TTL_MS = 2 * 60 * 1000;

type DatabaseLike = {
  exec(sql: string): void;
  prepare(sql: string): { get(...values: unknown[]): any; run(...values: unknown[]): any };
};

interface PendingOwnerSwitch {
  email: string;
  user_access_token: string;
  updated_at: number;
}

interface OwnerSwitchRestartNotice {
  created_at: number;
  previous_instance_id: string;
}

const LAUNCH_MODE_ENV = 'VOKO_LITE_LAUNCH_MODE';

function resolveForegroundLaunch(
  explicit: boolean | undefined,
  env: NodeJS.ProcessEnv,
  terminal: { stdin?: boolean; stdout?: boolean; stderr?: boolean },
): boolean {
  if (typeof explicit === 'boolean') return explicit;
  const inherited = String(env[LAUNCH_MODE_ENV] || '').trim().toLowerCase();
  if (inherited === 'foreground') return true;
  const attachedTerminal = Boolean(terminal.stdout || terminal.stderr || terminal.stdin);
  if (attachedTerminal) return true;
  if (inherited === 'background') return false;
  return false;
}

function normalizeEmail(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

function readConfig(db: DatabaseLike, type: string): any {
  const row = db.prepare('SELECT data FROM config WHERE type=?').get(type);
  if (!row?.data) return null;
  try { return JSON.parse(row.data); } catch { return null; }
}

export function readPendingOwnerSwitch(db: DatabaseLike): PendingOwnerSwitch | null {
  const value = readConfig(db, PENDING_OWNER_SWITCH_CONFIG);
  const email = normalizeEmail(value?.email);
  const token = String(value?.user_access_token || '').trim();
  if (!email || !token) return null;
  return { email, user_access_token: token, updated_at: Number(value?.updated_at) || 0 };
}

export function stagePendingOwnerSwitch(db: DatabaseLike, email: unknown, token: unknown): PendingOwnerSwitch {
  const pending = {
    email: normalizeEmail(email),
    user_access_token: String(token || '').trim(),
    updated_at: Date.now(),
  };
  if (!pending.email || !pending.user_access_token) throw new Error('Owner switch credentials are incomplete');
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = readPendingOwnerSwitch(db);
    if (existing && existing.email !== pending.email
        && pending.updated_at - existing.updated_at <= PENDING_OWNER_SWITCH_TTL_MS) {
      const error = new Error('账号切换正在进行');
      (error as Error & { code?: string; status?: number }).code = 'OWNER_SWITCH_IN_PROGRESS';
      (error as Error & { code?: string; status?: number }).status = 409;
      throw error;
    }
    db.prepare('INSERT OR REPLACE INTO config(type,data,updated_at) VALUES(?,?,?)')
      .run(PENDING_OWNER_SWITCH_CONFIG, JSON.stringify(pending), pending.updated_at);
    db.exec('COMMIT');
    return pending;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

export function activatePendingOwnerSwitch(db: DatabaseLike, options: { previousInstanceId?: string } = {}): {
  activated: boolean;
  ownerChanged: boolean;
  tokenChanged: boolean;
} {
  const pending = readPendingOwnerSwitch(db);
  if (!pending) return { activated: false, ownerChanged: false, tokenChanged: false };
  const selected = normalizeEmail(readConfig(db, 'current_user_email'));
  const tokenMap = readConfig(db, 'user_access_token') || {};
  const currentToken = String(tokenMap?.[selected]?.user_access_token || '').trim();
  const ownerChanged = selected !== pending.email;
  const tokenChanged = currentToken !== pending.user_access_token;

  db.exec('BEGIN IMMEDIATE');
  try {
    const now = Date.now();
    db.prepare('INSERT OR REPLACE INTO config(type,data,updated_at) VALUES(?,?,?)').run(
      'user_access_token',
      JSON.stringify({ [pending.email]: { user_access_token: pending.user_access_token, updated_at: now } }),
      now,
    );
    db.prepare('INSERT OR REPLACE INTO config(type,data,updated_at) VALUES(?,?,?)')
      .run('current_user_email', JSON.stringify(pending.email), now);
    db.prepare('DELETE FROM config WHERE type=?').run(PENDING_OWNER_SWITCH_CONFIG);
    if (ownerChanged || tokenChanged) {
      db.prepare('INSERT OR REPLACE INTO config(type,data,updated_at) VALUES(?,?,?)')
        .run(OWNER_SWITCH_RESTART_NOTICE_CONFIG, JSON.stringify({
          created_at: now,
          previous_instance_id: String(options.previousInstanceId || '').trim(),
        }), now);
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
  return { activated: true, ownerChanged, tokenChanged };
}

export function restartNoticeForInstance(
  db: DatabaseLike,
  instanceId: unknown,
): OwnerSwitchRestartNotice | null {
  const notice = readConfig(db, OWNER_SWITCH_RESTART_NOTICE_CONFIG);
  const previousInstanceId = String(notice?.previous_instance_id || '').trim();
  const currentInstanceId = String(instanceId || '').trim();
  if (!previousInstanceId || !currentInstanceId || previousInstanceId === currentInstanceId) return null;
  return {
    created_at: Number(notice.created_at) || 0,
    previous_instance_id: previousInstanceId,
  };
}

export function clearRestartNotice(db: DatabaseLike): void {
  db.prepare('DELETE FROM config WHERE type=?').run(OWNER_SWITCH_RESTART_NOTICE_CONFIG);
}

export function buildReplacementArgs(argv: string[]): string[] {
  const args = argv.slice(2).filter((arg) => arg !== '--open');
  if (!args.includes('--no-open')) args.push('--no-open');
  if (!args.includes('--no-interactive')) args.push('--no-interactive');
  return args;
}

function resolveLaunchPath(value: string): string {
  // Keep an explicitly Windows-qualified path intact when the helper is
  // exercised from a non-Windows test runner.  `path.resolve()` on Unix would
  // otherwise turn `C:\\runtime\\node.exe` into a bogus repository path.
  if (/^[A-Za-z]:[\\/]/.test(value)) return value;
  return path.resolve(value);
}

export function spawnReplacementProcess(options: {
  argv?: string[];
  execPath?: string;
  entryPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  foreground?: boolean;
  terminal?: { stdin?: boolean; stdout?: boolean; stderr?: boolean };
  spawnImpl?: typeof spawn;
} = {}): { pid: number | null; foreground: boolean } {
  const execPath = resolveLaunchPath(options.execPath || process.execPath);
  const entryPath = resolveLaunchPath(options.entryPath || path.join(__dirname, '..', 'index.js'));
  const baseEnv = options.env || process.env;
  const foreground = resolveForegroundLaunch(options.foreground, baseEnv, options.terminal || {
    stdin: process.stdin.isTTY,
    stdout: process.stdout.isTTY,
    stderr: process.stderr.isTTY,
  });
  const childEnv = {
    ...baseEnv,
    [LAUNCH_MODE_ENV]: foreground ? 'foreground' : 'background',
  };
  const child = (options.spawnImpl || spawn)(execPath, [entryPath, ...buildReplacementArgs(options.argv || process.argv)], {
    cwd: options.cwd || process.cwd(),
    env: childEnv,
    detached: true,
    stdio: foreground ? 'inherit' : 'ignore',
    windowsHide: true,
  });
  child.unref();
  return { pid: child.pid || null, foreground };
}
