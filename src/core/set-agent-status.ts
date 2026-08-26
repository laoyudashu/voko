/**
 * Agent 上下架 / 公开私密隐藏状态设置
 *
 * 通过 DID 认证 Ed25519 签名调用服务端接口。
 * 供主进程 IPC 和 MCP 工具共享。
 */

const { VOKO_API_URL } = require('./api-signature');
const { signDidRequest } = require('./did-auth');
const { fetchWithDidClockRetry } = require('./did-auth-client');
const { t } = require('./i18n');
export {};

type BinaryFlag = 0 | 1;
type VisibilityType = 0 | 1 | 2;

interface Statement {
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}

interface DatabaseLike {
  prepare(sql: string): Statement;
}

interface AgentCredentialRow {
  did?: string | null;
  private_key?: string | null;
  access_mode?: 'public' | 'private' | null;
}

interface SetAgentStatusOptions {
  db?: DatabaseLike;
  agentId?: string;
  status?: BinaryFlag;
  visibility?: VisibilityType;
}

interface SetAgentStatusResult {
  success: boolean;
  publishStatus?: 'published' | 'unpublished';
  accessMode?: 'public' | 'private';
  error?: string;
}

interface StatusApiResult {
  success: boolean;
  message?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isStatusApiResult(value: unknown): value is StatusApiResult {
  if (!value || typeof value !== 'object' || typeof (value as StatusApiResult).success !== 'boolean') {
    return false;
  }
  const { message } = value as StatusApiResult;
  return message === undefined || typeof message === 'string';
}

async function readStatusApiResult(response: Response): Promise<StatusApiResult | string> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    return t('errors.external_api.invalid_json');
  }
  if (!isStatusApiResult(value)) return t('errors.external_api.invalid_response');
  if (response.ok === false) {
    return value.message || t('errors.external_api.http_error', { status: response.status });
  }
  return value;
}

function isBinaryFlag(value: unknown): value is BinaryFlag {
  return value === 0 || value === 1;
}

function isVisibilityType(value: unknown): value is VisibilityType {
  return value === 0 || value === 1 || value === 2;
}

/**
 * 设置 Agent 上下架和公开、私密、隐藏状态
 * @param {Object} opts
 * @param {Object} opts.db - better-sqlite3 Database 实例
 * @param {string} opts.agentId
 * @param {number} opts.status - 0=下架, 1=上架
 * @param {number} opts.visibility - 0=私密, 1=公开, 2=隐藏
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function setAgentStatus(opts?: SetAgentStatusOptions): Promise<SetAgentStatusResult> {
  const { db, agentId, status, visibility } = opts || {};

  if (!db) return { success: false, error: 'db is required' };
  if (!agentId) return { success: false, error: 'agentId is required' };
  if (status === undefined || visibility === undefined) {
    return { success: false, error: t('errors.agent_status.missing_values') };
  }
  if (!isBinaryFlag(status) || !isVisibilityType(visibility)) {
    return { success: false, error: t('errors.agent_status.invalid_values') };
  }

  try {
    const row = db.prepare(`SELECT did, private_key, access_mode FROM agents WHERE agent_id = ?`).get(agentId) as AgentCredentialRow | undefined;
    if (!row?.did || !row?.private_key) {
      console.warn(`[setAgentStatus] Agent ${agentId} 无 DID，跳过状态同步`);
      return { success: false, error: 'Agent has no DID' };
    }

    const businessFields = { status, visibility };
    console.log(`[setAgentStatus] Agent ${agentId}: status=${status}, visibility=${visibility}`);

    const response = await fetchWithDidClockRetry(
      `${VOKO_API_URL}/api/did-auth/set-agent-status`,
      async (timestamp: number) => {
        const signed = await signDidRequest(row.did, row.private_key, businessFields, { timestamp });
        return {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...signed, ...businessFields })
        };
      },
    );
    const result = await readStatusApiResult(response);
    if (typeof result === 'string') return { success: false, error: result };
    if (result.success) {
      // 同步本地 agents 表状态
      const publishStatus = status === 1 ? 'published' : 'unpublished';
      const accessMode = row.access_mode === 'public' ? 'public' : 'private';
      db.prepare(`UPDATE agents SET publish_status=?, visibility_type=?, updated_at=? WHERE agent_id=?`)
        .run(publishStatus, visibility, Date.now(), agentId);
      console.log(`[setAgentStatus] Agent ${agentId} 成功 -> publish_status=${publishStatus}, visibility_type=${visibility}`);
      return { success: true, publishStatus, accessMode };
    }
    console.warn(`[setAgentStatus] Agent ${agentId} 失败:`, result.message);
    return { success: false, error: result.message || '设置状态失败' };
  } catch (e: unknown) {
    console.error(`[setAgentStatus] Agent ${agentId} error:`, e);
    return { success: false, error: errorMessage(e) };
  }
}

module.exports = { setAgentStatus };
