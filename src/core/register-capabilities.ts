/**
 * VOKO Agent 能力注册共享逻辑
 *
 * 供桌面端主进程（src/main.js）的 IPC handler、MCP 工具、下架流程等共同调用。
 * 使用 DID + Ed25519 签名调用 /api/did-auth/register-capabilities。
 */

const { VOKO_API_URL } = require('./api-signature');
const { signDidRequest } = require('./did-auth');
const { fetchWithDidClockRetry, calibratedNowMs } = require('./did-auth-client');
const { defaultRegistry, getAgentSkills } = require('./skills');
const { t } = require('./i18n');
import type { DatabaseLike } from '../types/database';

interface RegisterOptions {
  db: DatabaseLike;
  agentId: string;
}

interface AgentCapabilityRow {
  did?: string | null;
  private_key?: string | null;
  ability?: string | null;
  capability?: string | null;
}

interface Capability {
  name?: string;
  [key: string]: unknown;
}

interface ApiResult {
  success: boolean;
  message?: string;
  [key: string]: unknown;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isApiResult(value: unknown): value is ApiResult {
  if (!value || typeof value !== 'object' || typeof (value as ApiResult).success !== 'boolean') {
    return false;
  }
  const { message } = value as ApiResult;
  return message === undefined || typeof message === 'string';
}

async function readApiResult(response: Response): Promise<ApiResult | string> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    return t('errors.external_api.invalid_json');
  }
  if (!isApiResult(value)) return t('errors.external_api.invalid_response');
  if (response.ok === false) {
    return value.message || t('errors.external_api.http_error', { status: response.status });
  }
  return value;
}

/**
 * 注册能力到服务器
 * @param {object} params
 * @param {object} params.db - better-sqlite3 数据库实例
 * @param {string} params.agentId - Agent 标识 ID
 * @returns {Promise<{success: boolean, message?: string, error?: string, detail?: object}>}
 */
async function registerCapabilitiesForAgent({ db, agentId }: RegisterOptions) {
  try {
    const stmt = db.prepare(`SELECT did, private_key, ability, capability, publish_status, access_mode FROM agents WHERE agent_id = ?`);
    const row = stmt.get<AgentCapabilityRow>(agentId);
    if (!row) return { success: false, error: 'Agent not found' };
    if (!row.did) return { success: false, error: 'Agent has no DID, please register first' };
    if (!row.private_key) return { success: false, error: 'Agent has no private key, please register first' };

    // 普通模式能力（来自 agents.ability 列，UI 编辑）
    let normalCapabilities: unknown[] = [];
    if (row.ability) {
      try {
        normalCapabilities = JSON.parse(row.ability);
        if (!Array.isArray(normalCapabilities)) normalCapabilities = [];
      } catch (e) {
        normalCapabilities = [];
      }
    }

    // 开发者模式能力（来自 agents.capability 列，MCP declare_capabilities）
    let capabilities: Capability[] = [];
    if (row.capability) {
      try {
        const parsed = JSON.parse(row.capability);
        if (parsed && parsed.skills) {
          capabilities = parsed.skills as Capability[];
        } else if (Array.isArray(parsed)) {
          capabilities = parsed as Capability[];
        }
      } catch (e) {
        capabilities = [];
      }
    }

    // 从 agent_skills 表加载技能定义，追加到 capabilities
    try {
      defaultRegistry.init();
      const assigned = getAgentSkills(db, agentId);
      for (const row of assigned) {
        if (!row.enabled) continue;
        const def = defaultRegistry.get(row.skill_name);
        if (def) {
          // 不重复添加同名技能
          if (!capabilities.some(c => c.name === def.name)) {
            capabilities.push({ name: def.name, description: def.description, command: def.command, version: def.version });
          }
        }
      }
    } catch (_) {}

    console.log(`[registerCapabilities] Agent ${agentId}: sending capabilities...`);
    const businessFields = { capabilities, normalCapabilities };
    const requestUrl = `${VOKO_API_URL}/api/did-auth/register-capabilities`;
    const response = await fetchWithDidClockRetry(
      requestUrl,
      async (timestamp: number) => {
        const signed = await signDidRequest(row.did, row.private_key, businessFields, { timestamp });
        return {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...signed, ...businessFields })
        };
      },
    );

    const result = await readApiResult(response);
    if (typeof result === 'string') {
      db.prepare(`UPDATE agents SET cap_error = ?, updated_at = ? WHERE agent_id = ?`).run(result, calibratedNowMs(requestUrl), agentId);
      return { success: false, error: result };
    }
    console.log('[registerCapabilities] Agent response:', agentId, result);
    if (result.success) {
      db.prepare(`UPDATE agents SET cap_error = NULL, updated_at = ? WHERE agent_id = ?`).run(calibratedNowMs(requestUrl), agentId);
      return { success: true, message: '能力已注册到服务器' };
    }
    const errMsg = result.message || '注册失败';
    db.prepare(`UPDATE agents SET cap_error = ?, updated_at = ? WHERE agent_id = ?`).run(errMsg, calibratedNowMs(requestUrl), agentId);
    return { success: false, error: errMsg, detail: result };
  } catch (e: unknown) {
    console.error('[registerCapabilities] Agent error:', agentId, e);
    const message = errorMessage(e);
    db.prepare(`UPDATE agents SET cap_error = ?, updated_at = ? WHERE agent_id = ?`).run(message, calibratedNowMs(`${VOKO_API_URL}/api/did-auth/register-capabilities`), agentId);
    return { success: false, error: message };
  }
}

module.exports = { registerCapabilitiesForAgent };
