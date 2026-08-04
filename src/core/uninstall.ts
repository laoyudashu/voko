const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { stopVoko } = require('./stop-voko');

const CONFIRMATION = 'DELETE VOKO DATA';

export function defaultDataDirectory(platform = process.platform, env = process.env, home = os.homedir()): string {
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'voko');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'voko');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'voko');
}

export function validatePurgeTarget(target: string, expected: string, home = os.homedir()): { safe: boolean; reason?: string } {
  const resolved = path.resolve(target);
  const expectedResolved = path.resolve(expected);
  const root = path.parse(resolved).root;
  if (resolved !== expectedResolved) return { safe: false, reason: 'custom_path' };
  if (resolved === root || resolved === path.resolve(home)) return { safe: false, reason: 'broad_path' };
  try {
    if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) return { safe: false, reason: 'link' };
    if (process.platform === 'win32' && fs.existsSync(resolved)) {
      const stat = fs.lstatSync(resolved);
      if (typeof stat.isSymbolicLink === 'function' && stat.isSymbolicLink()) return { safe: false, reason: 'link' };
    }
  } catch { return { safe: false, reason: 'unreadable' }; }
  return { safe: true };
}

function packageRemoval(entryPath: string) {
  const normalized = path.resolve(entryPath).replace(/\\/g, '/');
  if (/\/node_modules\/@voko\/lite\/build\/index\.js$/i.test(normalized)) {
    const globalMarkers = ['/AppData/Roaming/npm/node_modules/', '/usr/local/lib/node_modules/', '/usr/lib/node_modules/', '/lib/node_modules/'];
    const global = globalMarkers.some((marker) => normalized.includes(marker));
    return { scope: global ? 'global' : 'local', removeCommand: global ? 'npm uninstall --global @voko/lite' : 'npm uninstall @voko/lite' };
  }
  return { scope: 'unknown', removeCommand: null };
}

function safeConfigMatch(filePath: string, entryName: string, kind = 'mcp') {
  return { kind, path: filePath, entryName, action: kind === 'mcp' ? 'remove_manually' : 'review_manually' };
}

function inspectJsonMcp(filePath: string): any[] {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > 2 * 1024 * 1024) return [];
    const value = JSON.parse(raw);
    const servers = value?.mcpServers || value?.mcp?.servers;
    if (!servers || typeof servers !== 'object') return [];
    return Object.entries(servers).flatMap(([name, config]: [string, any]) => {
      const command = [config?.command, ...(Array.isArray(config?.args) ? config.args : [])].join(' ');
      return name.toLowerCase() === 'voko' || /(?:^|[\s/\\])voko(?:\.cmd|\.exe)?(?:\s|$)|@voko[\\/]lite/i.test(command)
        ? [safeConfigMatch(filePath, name)] : [];
    });
  } catch { return []; }
}

export function inspectIntegrations(home = os.homedir(), env = process.env) {
  const candidates = [
    path.join(home, '.claude.json'), path.join(home, '.claude', 'settings.json'),
    path.join(home, '.codex', 'config.json'), path.join(home, '.cursor', 'mcp.json'),
    path.join(home, '.config', 'opencode', 'opencode.json'), path.join(home, '.kiro', 'settings', 'mcp.json'),
    ...(env.APPDATA ? [path.join(env.APPDATA, 'Claude', 'claude_desktop_config.json'), path.join(env.APPDATA, 'Cursor', 'User', 'globalStorage', 'mcp.json')] : []),
  ];
  const mcp = candidates.flatMap(inspectJsonMcp);
  const providers: any[] = [];
  const openClaw = path.join(home, '.openclaw', 'openclaw.json');
  if (fs.existsSync(openClaw)) providers.push(safeConfigMatch(openClaw, 'OpenClaw gateway', 'provider'));
  const hermesRoots = [path.join(home, '.hermes'), path.join(home, '.config', 'hermes')];
  for (const root of hermesRoots) {
    if (fs.existsSync(root)) providers.push(safeConfigMatch(root, 'Hermes profiles', 'provider'));
  }
  return { mcp, providers };
}

async function confirmPurge(input = process.stdin, output = process.stderr): Promise<boolean> {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(`Type ${CONFIRMATION} to continue: `, resolve));
    return answer === CONFIRMATION;
  } finally { rl.close(); }
}

export async function runUninstall(options: any = {}) {
  const dataPath = path.resolve(options.dataPath || defaultDataDirectory());
  const dbPath = path.resolve(options.dbPath || path.join(dataPath, 'voko.db'));
  const packageInfo = packageRemoval(options.entryPath || process.argv[1]);
  const integrations = inspectIntegrations(options.home, options.env);
  const result: any = {
    success: true,
    phase: options.dryRun ? 'preview' : 'prepared',
    lite: { wasRunning: false, stopped: options.dryRun ? null : true, remainingPids: [] },
    package: packageInfo,
    data: { path: dataPath, preserved: !options.purge, purged: false },
    integrations,
    warnings: ['Remote AgentDID accounts, Agents and server data are not removed.'],
    nextAction: packageInfo.removeCommand ? { type: 'remove_package', command: packageInfo.removeCommand } : { type: 'remove_package_manually' },
  };
  if (packageInfo.scope === 'unknown') result.warnings.push('Unable to determine the npm installation scope.');
  if (options.dryRun) return result;

  result.lite = await (options.stop || stopVoko)(dbPath, options.onGraceful);
  if (!result.lite.stopped) {
    return { ...result, success: false, phase: 'stop_failed', code: 'UNINSTALL_STOP_FAILED' };
  }
  if (!options.purge) return result;

  const defaultPath = path.resolve(options.defaultDataPath || defaultDataDirectory());
  const customDb = dbPath !== path.join(defaultPath, 'voko.db');
  if (customDb) return { ...result, success: false, phase: 'purge_refused', code: 'PURGE_CUSTOM_PATH_UNSUPPORTED' };
  const validation = validatePurgeTarget(dataPath, defaultPath, options.home);
  if (!validation.safe) return { ...result, success: false, phase: 'purge_refused', code: 'PURGE_TARGET_UNSAFE' };

  if (!options.yes) {
    if (options.json || !process.stdin.isTTY || !process.stderr.isTTY) {
      return { ...result, success: false, phase: 'confirmation_required', code: 'PURGE_CONFIRMATION_REQUIRED' };
    }
    if (!await (options.confirm || confirmPurge)()) {
      return { ...result, success: false, phase: 'confirmation_required', code: 'PURGE_CONFIRMATION_REQUIRED' };
    }
  }
  try {
    if (fs.existsSync(dataPath)) fs.rmSync(dataPath, { recursive: true, force: false });
    if (fs.existsSync(dataPath)) throw new Error('target still exists');
  } catch (error: any) {
    return { ...result, success: false, phase: 'purge_failed', code: 'PURGE_DELETE_FAILED', error: error.message };
  }
  result.phase = 'purged';
  result.data = { path: dataPath, preserved: false, purged: true };
  return result;
}

export function formatUninstall(result: any, locale = 'en'): string {
  const zh = locale.startsWith('zh');
  const ja = locale.startsWith('ja');
  const words = zh ? {
    title: 'VOKO 卸载准备', stopped: 'VOKO 已彻底停止', preview: '预览模式：未停止进程或删除数据', preserved: '本机数据已保留', purged: '本机数据已删除', config: '检测到需手动清理的配置', next: '下一步运行', cloud: '云端账号、Agent 和服务端数据不会被删除', failed: '卸载准备失败',
  } : ja ? {
    title: 'VOKO アンインストール準備', stopped: 'VOKO は完全に停止しました', preview: 'プレビュー：プロセス停止・データ削除は未実行', preserved: 'ローカルデータを保持しました', purged: 'ローカルデータを削除しました', config: '手動削除が必要な設定', next: '次に実行', cloud: 'クラウドのアカウント、Agent、サーバーデータは削除されません', failed: 'アンインストール準備に失敗しました',
  } : {
    title: 'VOKO uninstall preparation', stopped: 'VOKO is fully stopped', preview: 'Preview only: no process stopped and no data deleted', preserved: 'Local data was preserved', purged: 'Local data was deleted', config: 'Configuration entries requiring manual cleanup', next: 'Run next', cloud: 'Cloud accounts, Agents and server data are not removed', failed: 'Uninstall preparation failed',
  };
  const lines = [words.title, result.success ? (result.phase === 'preview' ? words.preview : words.stopped) : `${words.failed}: ${result.code}`];
  lines.push(result.data.purged ? words.purged : `${words.preserved}: ${result.data.path}`);
  const configs = [...result.integrations.mcp, ...result.integrations.providers];
  if (configs.length) {
    lines.push(`${words.config}:`);
    for (const item of configs) lines.push(`  - ${item.entryName}: ${item.path}`);
  }
  lines.push(words.cloud);
  if (result.package.removeCommand) lines.push(`${words.next}: ${result.package.removeCommand}`);
  return lines.join('\n');
}

module.exports = { defaultDataDirectory, validatePurgeTarget, inspectIntegrations, runUninstall, formatUninstall, CONFIRMATION };
