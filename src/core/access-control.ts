/**
 * 访问控制（黑白名单 / 公有私有）核心逻辑
 *
 * access_mode（public/private）= 服务端 visibility；私有 = 白名单模式。
 * 供主进程 IPC 和 MCP 工具共享。
 */

/**
 * 切换公有 / 私有（白名单）模式
 * @param {Object} opts
 * @param {Object} opts.db - better-sqlite3 Database 实例
 * @param {string} opts.agentId
 * @param {boolean} opts.enabled - true=private, false=public
 * @param {Function} [opts.registerCapabilities] - (agentId, options?) => Promise
 * @param {Function} [opts.setAgentStatus] - (params) => Promise
 * @returns {Promise<{success: boolean, accessMode?: string, error?: string}>}
 */
export {};
const { t } = require('./i18n');

interface Statement {
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}

interface DatabaseLike {
  prepare(sql: string): Statement;
}

interface AgentPublishRow {
  publish_status?: string | null;
}

interface StatusParams {
  agentId: string;
  status: number;
  visibility: number;
}

interface ToggleWhitelistOptions {
  db?: DatabaseLike;
  agentId?: string;
  enabled?: boolean;
  setAgentStatus?: (params: StatusParams) => Promise<unknown>;
}

interface ToggleWhitelistResult {
  success: boolean;
  accessMode?: 'public' | 'private';
  localUpdated?: boolean;
  capabilitySynced?: boolean;
  statusSynced?: boolean;
  syncWarnings?: string[];
  error?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function operationFailure(value: unknown): string | null {
  if (!value || typeof value !== 'object' || (value as { success?: unknown }).success !== false) {
    return null;
  }
  const error = (value as { error?: unknown }).error;
  return typeof error === 'string' && error ? error : t('common.action.failed');
}

async function toggleWhitelistMode(opts?: ToggleWhitelistOptions): Promise<ToggleWhitelistResult> {
  const { db, agentId, enabled, setAgentStatus } = opts || {};

  if (!db) return { success: false, error: 'db is required' };
  if (!agentId) return { success: false, error: 'agentId is required' };

  try {
    const row = db.prepare(`SELECT publish_status FROM agents WHERE agent_id = ?`).get(agentId) as AgentPublishRow | undefined;
    const newMode = enabled ? 'private' : 'public';
    const visibility = newMode === 'public' ? 1 : 0;
    const published = row?.publish_status === 'published';
    const serverStatus = published ? 1 : 0;
    const now = Date.now();

    db.prepare(`UPDATE agents SET access_mode = ?, updated_at = ? WHERE agent_id = ?`).run(newMode, now, agentId);
    console.error(`[toggleWhitelistMode] Agent ${agentId} access_mode → ${newMode}`);
    let statusSynced = true;
    const syncWarnings: string[] = [];

    if (setAgentStatus) {
      try {
        const result = await setAgentStatus({ agentId, status: serverStatus, visibility });
        const failure = operationFailure(result);
        if (failure) {
          statusSynced = false;
          syncWarnings.push(t('errors.access_sync.status_failed', { reason: failure }));
        }
      } catch (e: unknown) {
        const failure = errorMessage(e);
        statusSynced = false;
        syncWarnings.push(t('errors.access_sync.status_failed', { reason: failure }));
        console.warn(`[toggleWhitelistMode] setAgentStatus failed:`, failure);
      }
    }

    return {
      success: true,
      accessMode: newMode,
      localUpdated: true,
      // 能力注册不负责公开/私有；该字段为兼容既有返回结构，恒为 true。
      capabilitySynced: true,
      statusSynced,
      syncWarnings,
    };
  } catch (e: unknown) {
    console.error('[toggleWhitelistMode] error:', e);
    return { success: false, error: errorMessage(e) };
  }
}

module.exports = { toggleWhitelistMode };
