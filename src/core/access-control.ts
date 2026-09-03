/**
 * 访问控制（黑白名单 / 访客访问模式）核心逻辑
 *
 * access_mode（public/private）仅表示本地访客白名单模式；
 * 服务端 Agent 展现范围由独立的 visibility_type（0/1/2）维护。
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
  access_mode?: 'public' | 'private' | null;
  visibility_type?: number | null;
}

interface StatusParams {
  agentId: string;
  status: number;
  visibility: 0 | 1 | 2;
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
    const row = db.prepare(`SELECT publish_status, access_mode, visibility_type FROM agents WHERE agent_id = ?`).get(agentId) as AgentPublishRow | undefined;
    const newMode = enabled ? 'private' : 'public';
    // Do not derive remote Agent visibility from the visitor whitelist mode.
    // Legacy databases without visibility_type keep their historical mapping
    // until the schema migration has run.
    const visibility = row && (row.visibility_type === 0 || row.visibility_type === 1 || row.visibility_type === 2)
      ? row.visibility_type as 0 | 1 | 2
      : (row?.access_mode === 'public' ? 1 : 0);
    const published = row?.publish_status === 'published';
    const serverStatus = published ? 1 : 0;
    const now = Date.now();

    db.prepare(`UPDATE agents SET access_mode = ?, updated_at = ? WHERE agent_id = ?`).run(newMode, now, agentId);
    console.log(`[toggleWhitelistMode] Agent ${agentId} access_mode → ${newMode}`);
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
