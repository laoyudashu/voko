/**
 * Agent 发布/下架核心逻辑
 *
 * 把原来 main.js 中 agent-wukongim:connect / disconnect 的业务逻辑抽取出来，
 * 供主进程 IPC 和 MCP 工具共享。
 *
 * 注意：本模块零 Electron 依赖，所有副作用（启动/停止 IM 连接、能力注册、通知 UI 等）
 * 都通过 opts 注入。
 */

/**
 * 发布 Agent：连接 IM、注册能力、同步资料、同步服务端状态
 * @param {Object} opts
 * @param {Object} opts.db - better-sqlite3 Database 实例
 * @param {string} opts.agentId
 * @param {Function} opts.startAgentWorker - 兼容名称；启动指定 Agent 的 IM 连接
 * @param {Function} opts.stopAgentWorker - (agentId) => Promise|void
 * @param {Function} opts.registerCapabilities - (agentId, options?) => Promise
 * @param {Function} opts.updateAgentProfile - (params) => Promise
 * @param {Function} opts.setAgentStatus - (params) => Promise
 * @param {Object} [opts.endpoints] - 端点配置，用于 chatroom_url
 * @returns {Promise<{success: boolean, error?: string}>}
 */
import type { DatabaseLike } from '../types/database';

interface AgentRow {
  agent_id?: string;
  imUid?: string | null;
  imToken?: string | null;
  im_server_url?: string | null;
  owner_email?: string | null;
  agent_name?: string | null;
  category?: string | null;
  category_label?: string | null;
  backend_type?: string | null;
  access_mode?: 'public' | 'private' | null;
  description?: string | null;
  short_description?: string | null;
  address?: string | null;
  contact_phone?: string | null;
  tags?: string | null;
  icon_url?: string | null;
}

interface PublishResult {
  success: boolean;
  publishStatus?: 'published' | 'unpublished';
  accessMode?: 'public' | 'private';
  error?: string;
}

interface StatusParams {
  agentId: string;
  status: 0 | 1;
  visibility: 0 | 1;
}

type AsyncOperation = (...args: any[]) => Promise<unknown> | unknown; // Injected JS service boundary.

interface PublishOptions {
  db?: DatabaseLike;
  agentId?: string;
  startAgentWorker?: AsyncOperation;
  stopAgentWorker?: AsyncOperation;
  registerCapabilities?: AsyncOperation;
  updateAgentProfile?: AsyncOperation;
  setAgentStatus?: (params: StatusParams) => Promise<unknown>;
  endpoints?: { im?: { baseUrl?: string } };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function publishAgent(opts?: PublishOptions): Promise<PublishResult> {
  const { db, agentId, startAgentWorker, stopAgentWorker, registerCapabilities, updateAgentProfile, setAgentStatus, endpoints } = opts || {};

  if (!db) return { success: false, error: 'db is required' };
  if (!agentId) return { success: false, error: 'agentId is required' };

  try {
    const row = db.prepare(`SELECT * FROM agents WHERE agent_id = ?`).get<AgentRow>(agentId);
    if (!row) return { success: false, error: 'Agent not found' };
    if (!row.imUid || !row.imToken || !row.im_server_url) {
      return { success: false, error: 'Agent 缺少 IM 绑定信息' };
    }

    const { imUid: uid, imToken: token, im_server_url: serverUrl } = row;

    // 该 uid 已绑定其他 agent → 拒绝发布，提示用户（避免抢占导致幽灵 agent / 身份串台）
    const existingStmt = db.prepare(`SELECT agent_id FROM agents WHERE imUid = ? AND agent_id != ?`);
    const existing = existingStmt.get<{ agent_id: string }>(uid, agentId);
    if (existing) {
      return { success: false, error: `WuKongIM 账号(${uid})已被 agent「${existing.agent_id}」占用，请先下架该 agent 或更换绑定` };
    }

    // 启动指定 Agent 的共享 Hub IM 客户端（公开回调名保持兼容）
    if (startAgentWorker) {
      const imStatus = await startAgentWorker(agentId, { uid, token, serverUrl }) as { error?: string; status?: string } | undefined;
      if (imStatus?.error || imStatus?.status === 'connect_fail') {
        return { success: false, error: imStatus.error || 'Agent IM 连接失败' };
      }
    }

    const now = Date.now();
    const imBaseUrl = endpoints?.im?.baseUrl || '';
    const chatroomUrl = uid && imBaseUrl ? imBaseUrl + '/#/chat?peer=' + uid : '';
    const backend = row.backend_type || 'openclaw';
    const accessMode = row.access_mode || 'private';
    const visibility = accessMode === 'public' ? 1 : 0;

    db.prepare(`
      INSERT INTO agents (id, agent_id, imUid, imToken, im_server_url, owner_email, chatroom_url, agent_name, category, category_label, publish_status, access_mode, backend_type, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        imUid = excluded.imUid,
        imToken = excluded.imToken,
        im_server_url = excluded.im_server_url,
        owner_email = excluded.owner_email,
        chatroom_url = excluded.chatroom_url,
        agent_name = excluded.agent_name,
        category = excluded.category,
        category_label = excluded.category_label,
        publish_status = 'published',
        backend_type = excluded.backend_type,
        updated_at = excluded.updated_at
    `).run(`agent-${agentId}`, agentId, uid, token, serverUrl, row.owner_email || null, chatroomUrl, row.agent_name || null, row.category || null, row.category_label || null, accessMode, backend, now, now);

    // 注册能力到服务端
    if (registerCapabilities) {
      try { await registerCapabilities(agentId); } catch (e: unknown) {
        console.warn(`[publishAgent] Agent ${agentId} 注册能力失败:`, errorMessage(e));
      }
    }

    // 同步本地已有资料字段到服务端
    if (updateAgentProfile) {
      try {
        const fresh = db.prepare(`SELECT * FROM agents WHERE agent_id = ?`).get<AgentRow>(agentId);
        const fields: Record<string, string> = {};
        if (fresh?.description) fields.description = fresh.description;
        if (fresh?.short_description) fields.short_description = fresh.short_description;
        if (fresh?.address) fields.address = fresh.address;
        if (fresh?.contact_phone) fields.contact_phone = fresh.contact_phone;
        if (fresh?.tags) fields.tags = fresh.tags;
        if (fresh?.category) fields.category = fresh.category;
        if (fresh?.icon_url) fields.icon_url = fresh.icon_url;
        if (Object.keys(fields).length) {
          await updateAgentProfile({ agentId, ...fields });
        }
      } catch (e: unknown) {
        console.warn(`[publishAgent] Agent ${agentId} 同步资料失败:`, errorMessage(e));
      }
    }

    // 同步上下架状态到服务端（保持当前 access_mode 对应的 visibility）
    if (setAgentStatus) {
      await setAgentStatus({ agentId, status: 1, visibility }).catch(() => {});
    }

    return { success: true, publishStatus: 'published', accessMode };
  } catch (e: unknown) {
    console.error(`[publishAgent] Agent ${agentId} error:`, e);
    return { success: false, error: errorMessage(e) };
  }
}

/**
 * 下架 Agent：停止 Worker、更新本地状态、通过 set-agent-status 同步服务端状态
 * @param {Object} opts
 * @param {Object} opts.db - better-sqlite3 Database 实例
 * @param {string} opts.agentId
 * @param {Function} opts.stopAgentWorker - (agentId) => Promise|void
 * @param {Function} opts.setAgentStatus - (params) => Promise
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function unpublishAgent(opts?: PublishOptions): Promise<PublishResult> {
  const { db, agentId, stopAgentWorker, setAgentStatus } = opts || {};

  if (!db) return { success: false, error: 'db is required' };
  if (!agentId) return { success: false, error: 'agentId is required' };

  try {
    const row = db.prepare(`SELECT access_mode FROM agents WHERE agent_id = ?`).get<AgentRow>(agentId);
    const visibility = row?.access_mode === 'public' ? 1 : 0;

    // 同步上下架状态到服务端（visibility 跟随 access_mode，不随下架清零）
    if (setAgentStatus) {
      await setAgentStatus({ agentId, status: 0, visibility }).catch(() => {});
    }

    // 停止 Worker
    if (stopAgentWorker) {
      try { await stopAgentWorker(agentId); } catch (_) {}
    }

    // 更新本地 DB（只改 publish_status，保留 access_mode）
    db.prepare(`UPDATE agents SET publish_status = 'unpublished', updated_at = ? WHERE agent_id = ?`).run(Date.now(), agentId);

    return { success: true, publishStatus: 'unpublished' };
  } catch (e: unknown) {
    console.error(`[unpublishAgent] Agent ${agentId} error:`, e);
    return { success: false, error: errorMessage(e) };
  }
}

module.exports = { publishAgent, unpublishAgent };
