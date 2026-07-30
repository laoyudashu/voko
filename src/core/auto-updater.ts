/**
 * auto-updater.js — Lite 后台自动升级（纯 OSS 源）
 *
 * 机制：
 *   运行中：checkAndStageUpdate() 定时拉 OSS manifest → 下载 tgz 到暂存区 → 写 pending.json
 *           全程不触碰全局包文件。
 *   下次启动：applyPendingUpgrade() 读 pending → npm install -g <本地 tgz> → 返回 true
 *            调用方 process.exit(0)；desktop 场景由 lite-launcher 自动重启，
 *            裸 voko 场景打日志提示用户重跑。
 *
 * 只对全局安装的 voko（混淆 dist）生效；开发态 node src/index.js 不受影响（预期）。
 *
 * OSS manifest（updates/lite/lite-latest.json）：
 *   { version, tarball, integrity("sha512-<base64>"), minNodeVersion, publishedAt }
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ENDPOINTS = require('../endpoints.json');
const pkg = require('../../package.json');
const { t } = require('./i18n');
export {};

interface UpdateManifest {
  version: string;
  tarball: string;
  integrity: string;
  minNodeVersion?: string;
  publishedAt?: string;
}

interface PendingUpdate {
  targetVersion: string;
  tarballPath: string;
  integrity: string;
  minNodeVersion?: string;
  packageName?: string;
  downloadedAt?: number;
}

interface PendingValidation {
  ok: boolean;
  pending?: PendingUpdate;
  reason?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveNpmCommand(platform = process.platform): string {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

const UPDATE_BASE = String((ENDPOINTS.update && ENDPOINTS.update.baseUrl) || '').replace(/\/$/, '');
const MANIFEST_REL = (ENDPOINTS.update && ENDPOINTS.update.liteManifest) || 'lite/lite-latest.json';
const MANIFEST_URL = `${UPDATE_BASE}/${MANIFEST_REL}`;
// 更新源合法 host：manifest 的 tarball 字段不可信（HTTP + 可能被 MitM），下载前校验最终 URL 落在本 host
let UPDATE_HOST = '';
try { if (UPDATE_BASE) UPDATE_HOST = new URL(UPDATE_BASE).host; } catch (_) {}

const DEFAULT_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 小时
const FIRST_CHECK_DELAY_MS = 60 * 1000;          // 启动 60s 后首检，避开启动高峰

/** voko 数据目录（与 index.js _initFileLogger 同款逻辑） */
function getVokoDataDir(): string {
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'voko');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'voko');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'voko');
}

function getStagedDir(): string {
  const dir = path.join(getVokoDataDir(), 'staged-update');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

function pendingFilePath(): string {
  return path.join(getStagedDir(), 'pending.json');
}

/** 语义版本比较：a<b → -1，a==b → 0，a>b → 1（按点分段数字比） */
function compareVersions(a: unknown, b: unknown): -1 | 0 | 1 {
  const pa = String(a || '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '').split('.').map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

/** SRI 校验：integrity 形如 "sha512-<base64>" */
function verifyIntegrity(buffer: Buffer, integrity: unknown): boolean {
  if (!integrity || typeof integrity !== 'string') return false;
  const m = integrity.match(/^(sha512)-(.+)$/);
  if (!m) return false;
  const hash = crypto.createHash(m[1]).update(buffer).digest('base64');
  return hash === m[2];
}

function isVersionString(value: unknown): value is string {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);
}

function validateManifest(value: unknown): value is UpdateManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const manifest = value as Record<string, unknown>;
  return isVersionString(manifest.version)
    && typeof manifest.tarball === 'string'
    && manifest.tarball.length > 0
    && typeof manifest.integrity === 'string'
    && /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(manifest.integrity)
    && (manifest.minNodeVersion === undefined || isVersionString(manifest.minNodeVersion));
}

function validatePendingUpgrade(
  value: unknown,
  stagedDir = getStagedDir(),
  nodeVersion = process.versions.node,
): PendingValidation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'invalid-pending' };
  }
  const pending = value as Record<string, unknown>;
  if (!isVersionString(pending.targetVersion)
    || typeof pending.tarballPath !== 'string'
    || typeof pending.integrity !== 'string') {
    return { ok: false, reason: 'invalid-pending' };
  }
  if (pending.packageName !== undefined && pending.packageName !== pkg.name) {
    return { ok: false, reason: 'package-mismatch' };
  }
  if (pending.minNodeVersion !== undefined) {
    if (!isVersionString(pending.minNodeVersion)) return { ok: false, reason: 'invalid-node-version' };
    if (compareVersions(nodeVersion, pending.minNodeVersion) < 0) {
      return { ok: false, reason: 'node-version-too-old' };
    }
  }
  if (compareVersions(pending.targetVersion, pkg.version) <= 0) {
    return { ok: false, reason: 'version-not-newer' };
  }

  const root = path.resolve(stagedDir);
  const candidate = path.resolve(pending.tarballPath);
  if (path.dirname(candidate) !== root || path.extname(candidate).toLowerCase() !== '.tgz') {
    return { ok: false, reason: 'path-outside-staged-dir' };
  }
  try {
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) return { ok: false, reason: 'invalid-tarball-file' };
    const realRoot = fs.realpathSync(root);
    const realCandidate = fs.realpathSync(candidate);
    if (path.dirname(realCandidate) !== realRoot) {
      return { ok: false, reason: 'path-outside-staged-dir' };
    }
    if (!verifyIntegrity(fs.readFileSync(realCandidate), pending.integrity)) {
      return { ok: false, reason: 'integrity-mismatch' };
    }
  } catch {
    return { ok: false, reason: 'tarball-unreadable' };
  }

  return { ok: true, pending: pending as unknown as PendingUpdate };
}

/** 原子写 JSON（.tmp → rename，防半截） */
function atomicWriteJSON(filePath: string, obj: unknown): void {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
}

function readPending(): PendingUpdate | null {
  try {
    const f = pendingFilePath();
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, 'utf-8')) as PendingUpdate;
  } catch { return null; }
}

function writePending(obj: PendingUpdate): boolean {
  try { atomicWriteJSON(pendingFilePath(), obj); return true; }
  catch (e: unknown) { console.error(t('cli.autoupdate.write_pending_failed', { msg: errorMessage(e) })); return false; }
}

function clearPending(): void {
  try { fs.unlinkSync(pendingFilePath()); } catch {}
}

/**
 * 是否全局安装的 @voko/lite（混淆 dist）。
 * 开发态（项目源码 / npm link 指向源码）返回 false —— 开发态不自动升级：
 * 否则 npm install -g @voko/lite 会与开发态 voko link 的同名 bin 冲突 (EEXIST)，
 * 每次启动 install 失败、pending 不清、循环重试。
 */
function isGlobalInstall(): boolean {
  return __dirname.toLowerCase().includes(path.join('node_modules', '@voko', 'lite').toLowerCase());
}

/** 拉 OSS manifest */
async function fetchManifest(): Promise<UpdateManifest | null> {
  // 用 AbortController + 手动 clearTimeout，而非 AbortSignal.timeout：
  // 后者的定时器在 fetch 完成后不会自动清理，process.exit 时残留触发
  // libuv 在 Windows 的 UV_HANDLE_CLOSING 断言。
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(MANIFEST_URL, { signal: ctrl.signal, redirect: 'error' });
    if (!res.ok) return null;
    return await res.json() as UpdateManifest;
  } finally {
    clearTimeout(timer);
  }
}

/** 下载 tarball 到暂存区 + SRI 校验。返回本地 tgz 绝对路径 */
async function downloadTarball(tarballRel: string, integrity: string): Promise<string> {
  const url = `${UPDATE_BASE}/${tarballRel}`;
  // host 白名单：manifest 的 tarball 字段不可信，最终 URL 必须落在更新源 host（防重定向到攻击者主机）
  try {
    const u = new URL(url);
    if (UPDATE_HOST && u.host !== UPDATE_HOST) throw new Error(t('cli.autoupdate.illegal_host', { host: u.host }));
  } catch (e: unknown) { throw new Error(t('cli.autoupdate.url_check_failed', { msg: errorMessage(e) })); }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'error' });
    if (!res.ok) throw new Error(t('cli.autoupdate.download_status', { status: res.status, url }));
    const buf = Buffer.from(await res.arrayBuffer());
    if (!verifyIntegrity(buf, integrity)) {
      throw new Error(t('cli.autoupdate.integrity_failed'));
    }
    const fileName = String(tarballRel).split('/').pop() || 'voko-lite.tgz';
    const tarballPath = path.join(getStagedDir(), fileName);
    fs.writeFileSync(tarballPath, buf);
    return tarballPath;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 定时检查 + 暂存：发现新版且无 pending → 下载到暂存区并落盘 pending.json。
 * @returns {Promise<boolean>} true 表示本次新暂存了一个升级
 */
async function checkAndStageUpdate(): Promise<boolean> {
  if (!isGlobalInstall()) return false; // 开发态不检查/下载
  try {
    const manifest = await fetchManifest();
    if (!validateManifest(manifest)) return false;
    if (manifest.minNodeVersion && compareVersions(process.versions.node, manifest.minNodeVersion) < 0) {
      console.warn(t('cli.autoupdate.node_too_old', {
        current: process.versions.node,
        required: manifest.minNodeVersion,
      }));
      return false;
    }

    const pending = readPending();
    if (pending && pending.targetVersion === manifest.version) return false; // 已暂存同版本
    if (compareVersions(manifest.version, pkg.version) <= 0) return false;   // 无新版

    console.error(t('cli.autoupdate.found_new', { version: manifest.version, current: pkg.version }));
    const tarballPath = await downloadTarball(manifest.tarball, manifest.integrity);
    writePending({
      targetVersion: manifest.version,
      tarballPath,
      integrity: manifest.integrity,
      minNodeVersion: manifest.minNodeVersion,
      packageName: pkg.name,
      downloadedAt: Date.now(),
    });
    console.error(t('cli.autoupdate.staged', { version: manifest.version }));
    return true;
  } catch (e: unknown) {
    console.warn(t('cli.autoupdate.check_failed', { msg: errorMessage(e) }));
    return false;
  }
}

/**
 * 启动早期应用已暂存的升级：npm install -g <本地 tgz>。
 * 成功返回 true（调用方应 process.exit(0)）；失败返回 false（不阻塞启动，pending 保留下次重试）。
 */
function applyPendingUpgradeInternal(options: {
  globalInstall?: boolean;
  spawn?: typeof spawnSync;
  stagedDir?: string;
  nodeVersion?: string;
  platform?: NodeJS.Platform;
} = {}): boolean {
  const globalInstall = options.globalInstall ?? isGlobalInstall();
  if (!globalInstall) {
    // 开发态运行：不应用升级（避免与开发态 voko bin 冲突 EEXIST 循环失败）。顺手清残留 pending。
    if (readPending()) { clearPending(); console.warn(t('cli.autoupdate.dev_skip')); }
    return false;
  }
  const rawPending = readPending();
  if (!rawPending) return false;
  const validation = validatePendingUpgrade(
    rawPending,
    options.stagedDir || getStagedDir(),
    options.nodeVersion || process.versions.node,
  );
  if (!validation.ok || !validation.pending) {
    console.warn(t('cli.autoupdate.invalid_pending', { reason: validation.reason || 'unknown' }));
    clearPending();
    return false;
  }
  const pending = validation.pending;
  console.error(t('cli.autoupdate.applying', { version: pending.targetVersion }));
  try {
    // --ignore-scripts：禁止执行 tgz 内 preinstall/install/postinstall 脚本（防 MitM 投毒包经安装脚本 RCE）
    const spawn = options.spawn || spawnSync;
    const r = spawn(resolveNpmCommand(options.platform), ['install', '-g', '--ignore-scripts', pending.tarballPath], {
      stdio: 'inherit',
      windowsHide: true,
    });
    if (r.error) throw new Error(t('cli.autoupdate.spawn_failed', { msg: r.error.message }));
    if (r.status !== 0) throw new Error(t('cli.autoupdate.npm_exit', { status: r.status }));
    try { fs.unlinkSync(pending.tarballPath); } catch {}
    clearPending();
    console.error(t('cli.autoupdate.upgraded', { version: pending.targetVersion }));
    return true;
  } catch (e: unknown) {
    console.error(t('cli.autoupdate.apply_failed', { msg: errorMessage(e) }));
    return false;
  }
}

function applyPendingUpgrade(): boolean {
  return applyPendingUpgradeInternal();
}

/**
 * 启动后台定时检查。VOKO_AUTO_UPDATE_INTERVAL_MS 环境变量可覆盖周期（便于测试）。
 * 多次调用只生效一次（checkVersion 在不同启动分支可能各调一次）。
 */
let _started = false;
function startAutoUpdater(opts: { intervalMs?: number } = {}): void {
  if (_started) return;
  _started = true;
  const intervalMs = parseInt(String(process.env.VOKO_AUTO_UPDATE_INTERVAL_MS), 10) || opts.intervalMs || DEFAULT_INTERVAL_MS;
  const check = () => checkAndStageUpdate().catch((e: unknown) => console.warn(t('cli.autoupdate.timer_exception', { msg: errorMessage(e) })));
  setTimeout(check, FIRST_CHECK_DELAY_MS);
  setInterval(check, intervalMs);
  console.log(t('cli.autoupdate.enabled', { first: FIRST_CHECK_DELAY_MS / 1000, interval: Math.round(intervalMs / 1000 / 60) }));
}

module.exports = {
  compareVersions,
  fetchManifest,
  checkAndStageUpdate,
  applyPendingUpgrade,
  startAutoUpdater,
  // 暴露给测试/调试
  getStagedDir,
  readPending,
  verifyIntegrity,
  MANIFEST_URL,
  _test: {
    validateManifest,
    validatePendingUpgrade,
    applyPendingUpgradeInternal,
    resolveNpmCommand,
  },
};
