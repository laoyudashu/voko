export {};

/**
 * Lite MCP context 工厂
 *
 * 填实所有 stub，与 Desktop 共用同一套 core 模块。
 * 本文件在 Step 3 切换为 @voko/core 包引用。
 */

const { searchCapabilitiesByDid, searchCapabilitiesByUserToken } = require('./core/search-capabilities');
const { updateAgentProfile } = require('./core/update-agent-profile');
const { setAgentStatus } = require('./core/set-agent-status');
const { publishAgent, unpublishAgent } = require('./core/publish-agent');
const { toggleWhitelistMode: coreToggleWhitelistMode } = require('./core/access-control');
const { registerCapabilitiesForAgent } = require('./core/register-capabilities');
const { generateOSSSignature } = require('./server/oss');
const { AgentEmailApi } = require('./server/agent-email-api');
const { getUserAccessToken, getPrimaryOwnerEmail } = require('./core/database');
const ENDPOINTS = require('./endpoints.json');
const { createSendMessage, createDeliver } = require('./core/send-message');
const { signDidRequest } = require('./core/did-auth');
const { createBugReportClient } = require('./core/bug-report');
import type { DatabaseLike } from './types/database';

const pkg = require('../package.json');

type SqlParam = string | number | bigint | Uint8Array | null;
type UnknownRecord = Record<string, unknown>;
type Query = <T extends UnknownRecord = UnknownRecord>(sql: string, params?: SqlParam[]) => T[];
type Exec = (sql: string, params?: SqlParam[]) => { changes?: number | bigint };
type Deliver = (...args: unknown[]) => Promise<UnknownRecord>;
type SendMessage = (...args: unknown[]) => Promise<UnknownRecord>;

interface DatabaseApiLike {
  getPaymentAuth(agentId: string): unknown;
  getAgentImUid(agentId: string): string;
  savePaymentOrder(order: UnknownRecord): unknown;
  getEnabledChannel?(): UnknownRecord | null;
}

interface AgentManagerLike {
  workers?: Map<string, unknown>;
  start(agentId: string, config?: unknown, appPaths?: unknown): unknown;
  stop(agentId: string): Promise<unknown> | unknown;
  getStatus(agentId: string): {
    connected?: boolean;
    status?: string;
    uid?: string;
  };
  sendSystemMessage?(...args: unknown[]): unknown;
}

interface RuntimeAgent {
  agentId: string;
  agentName?: string;
  imConnected?: boolean;
  backendConnected?: boolean;
}

interface ConfigRow {
  data: string;
}

interface BackendTypeRow {
  backend_type: string | null;
}

interface DispatcherLike {
  resolveProvider?(agentId: string): {
    isAvailable(agentId: string): boolean;
  } | null;
}

interface ContextDependencies {
  db: DatabaseLike;
  databaseAPI: DatabaseApiLike;
  agentRegistration?: UnknownRecord;
  agentManager?: AgentManagerLike;
  agentEmailApi?: UnknownRecord;
  wukongimSender?: UnknownRecord;
  deliver?: Deliver;
  sendMessage?: SendMessage;
  enqueueOwnerIntervention?: (record: UnknownRecord) => unknown;
}

interface AgentOperationParams extends UnknownRecord {
  agentId?: string;
}

interface CapabilitySearchParams {
  agentId?: string;
  agent_id?: string;
  keyword?: string;
  page?: number;
  limit?: number;
}

declare global {
  var __dispatcher: DispatcherLike | undefined;
  var __openclawHandler: { getStatus?(): { connected?: boolean } } | undefined;
  var __hermesHandler: { connectedAgents?: Set<string> } | undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createContext({
  db,
  databaseAPI,
  agentRegistration,
  agentManager,
  agentEmailApi,
  wukongimSender: passedSender,
  deliver: passedDeliver,
  sendMessage: passedSendMessage,
  enqueueOwnerIntervention,
}: ContextDependencies) {
  // 统一 IM 投递：优先用 initCore 注入的，未传则自建（CLI 等独立调用兼容）
  const wukongimSender = passedSender || agentManager;
  const deliver = passedDeliver || createDeliver({ transportManager: agentManager });

  // sendMessage 内部投递统一走共享 IM Hub。
  const sendMessage = passedSendMessage || createSendMessage({
    db,
    deliver,
    agentWorkers: agentManager?.workers || new Map(),
    mainWindow: null,
  });
  const bugReport = createBugReportClient({
    apiBaseUrl: (ENDPOINTS.api && ENDPOINTS.api.baseUrl) || '',
    db,
  });

  return {
    db,
    wukongimSender,  // 暴露给 CLI 等场景直接使用
    deliver,         // 暴露统一 Hub 投递器
    query: (<T extends UnknownRecord = UnknownRecord>(sql: string, params?: SqlParam[]): T[] => {
      try {
        const stmt = db.prepare(sql);
        return params ? stmt.all<T>(...params) : stmt.all<T>();
      } catch (error: unknown) {
        console.error('[Lite:query]', errorMessage(error));
        return [];
      }
    }) as Query,
    exec: ((sql: string, params?: SqlParam[]) => {
      try {
        const stmt = db.prepare(sql);
        return params ? stmt.run(...params) : stmt.run();
      } catch (error: unknown) {
        console.error('[Lite:exec]', errorMessage(error));
        return { changes: 0 };
      }
    }) as Exec,
    databaseAPI,
    getEnabledChannel: () => databaseAPI.getEnabledChannel?.() || null,
    enqueueOwnerIntervention,

    // ── 消息 ──
    sendMessage: (agentId: string, toUid: string, content: string, fromUid?: string, messageType?: string, channelType?: number, mentions?: unknown) => {
      return sendMessage(agentId, toUid, content, fromUid, messageType, channelType, mentions);
    },

    // 系统消息（is_me=2 样式区分），用于黑白名单等状态变更通知访客
    sendSystemMessage: (...args: unknown[]) => {
      if (agentManager?.sendSystemMessage) agentManager.sendSystemMessage(...args);
    },

    // 收消息通道是否就绪（供 send_message tool 提示 agent 是否需改用 pull）
    checkReceiveChannel: (agentId: string) => {
      const dispatcher = global.__dispatcher;
      if (!dispatcher) return { ok: false, suggest: 'voko_fetch_new_messages' };
      const provider = dispatcher.resolveProvider ? dispatcher.resolveProvider(agentId) : null;
      const ok = provider ? provider.isAvailable(agentId) : false;
      return { ok, suggest: ok ? null : 'voko_fetch_new_messages' };
    },

    // ── Worker 管理 ──
    startAgentWorker: (agentId: string, config?: unknown, appPaths?: unknown) => {
      if (!agentManager) {
        console.error('[Lite] agentManager 未初始化');
        return;
      }
      return agentManager.start(agentId, config, appPaths);
    },

    stopAgentWorker: async (agentId: string) => {
      if (!agentManager) return;
      await agentManager.stop(agentId);
    },

    getAgentStatus: (agentId: string) => {
      // 优先从 runtime 标记读取（支持 UI-only 模式）
      try {
        const row = db.prepare("SELECT data FROM config WHERE type = 'runtime'").get<ConfigRow>();
        if (row) {
          const rt = JSON.parse(row.data) as { agents?: RuntimeAgent[] };
          if (rt.agents) {
            const a = rt.agents.find((agent) => agent.agentId === agentId);
            if (a) {
              return { imConnected: a.imConnected, imStatus: a.imConnected ? 'connected' : 'disconnected', backendConnected: !!a.backendConnected, uid: '', agentName: a.agentName };
            }
          }
        }
      } catch (_: unknown) {}

      // 兜底：实时查询该 Agent 的 IM Hub 客户端
      if (!agentManager) return { imConnected: false, imStatus: 'unknown', backendConnected: false };
      const status = agentManager.getStatus(agentId);
      // 实时查 DB 获取 backend_type，决定后端状态（不依赖 runtime）
      let backendConnected = false;
      try {
        const row = db.prepare("SELECT backend_type FROM agents WHERE agent_id = ?").get<BackendTypeRow>(agentId);
        if (row && row.backend_type === 'openclaw') {
          backendConnected = !!global.__openclawHandler?.getStatus?.()?.connected;
        } else if (row && row.backend_type === 'hermes') {
          backendConnected = !!global.__hermesHandler?.connectedAgents?.has(agentId);
        }
      } catch (_: unknown) {}
      return {
        imConnected: status.connected,
        imStatus: status.status || 'unknown',
        backendConnected,
        uid: status.uid,
      };
    },

    // ── 能力注册 ──
    registerCapabilities: async (agentId: string) => {
      try {
        return await registerCapabilitiesForAgent({ db, agentId });
      } catch (error: unknown) {
        console.error('[Lite] registerCapabilities 失败:', errorMessage(error));
        return { success: false, error: errorMessage(error) };
      }
    },

    // ── Agent 资料 ──
    updateAgentProfile: (params: AgentOperationParams) => updateAgentProfile({ db, ...params }),
    setAgentStatus: (params: AgentOperationParams) => setAgentStatus({ db, ...params }),

    // ── 访问控制 ──
    toggleWhitelistMode: async ({ agentId, enabled }: { agentId: string; enabled: boolean }) => coreToggleWhitelistMode({
      db, agentId, enabled,
      setAgentStatus: (params: AgentOperationParams) => setAgentStatus({ db, ...params }),
    }),

    // ── 发布/下架 ──
    publishAgent: (params: AgentOperationParams) => publishAgent({
      db, ...params,
      registerCapabilities: (aid: string) => registerCapabilitiesForAgent({ db, agentId: aid }),
      updateAgentProfile: (profile: AgentOperationParams) => updateAgentProfile({ db, ...profile }),
      setAgentStatus: (status: AgentOperationParams) => setAgentStatus({ db, ...status }),
      startAgentWorker: (aid: string, config?: unknown) => agentManager?.start(aid, config),
      stopAgentWorker: (aid: string) => agentManager?.stop(aid),
    }),

    unpublishAgent: (params: AgentOperationParams) => unpublishAgent({
      db, ...params,
      setAgentStatus: (status: AgentOperationParams) => setAgentStatus({ db, ...status }),
      stopAgentWorker: (aid: string) => agentManager?.stop(aid),
    }),

    // ── 能力搜索 ──
    searchCapabilities: async (params: CapabilitySearchParams = {}) => {
      try {
        const { agentId, agent_id, keyword, page, limit } = params || {};
        const searchAgentId = agentId || agent_id;
        const searchOpts = { db, agentId: searchAgentId, keyword, page, limit };
        let didError: unknown;
        try { return await searchCapabilitiesByDid(searchOpts); } catch (error: unknown) { didError = error; }
        const ownerEmail = getPrimaryOwnerEmail(db);
        const token = ownerEmail ? getUserAccessToken(db, ownerEmail) : null;
        if (token) return await searchCapabilitiesByUserToken({ token, keyword, page, limit });
        throw didError || new Error('未找到当前用户的访问令牌，请重新登录');
      } catch (error: unknown) {
        return { success: false, error: errorMessage(error) };
      }
    },

    // ── OSS ──
    generateOSSSignature: (filename: string, _dir?: string, contentType?: string, maxSize?: number) => {
      try {
        return generateOSSSignature(filename, contentType, maxSize);
      } catch (error: unknown) {
        console.error('[Lite] OSS 签名失败:', errorMessage(error));
        return { uploadUrl: null, fileUrl: null, error: errorMessage(error) };
      }
    },
    uploadFileToOSS: async (filePath: string, objectName: string, mimeType?: string) => {
      const { uploadToOSS, initOSSFromConfig } = require('./server/oss');
      // 惰性从 DB 加载 OSS 凭证（CLI 模式启动时未 initOSSFromConfig）
      try {
        const row = db.prepare("SELECT data FROM config WHERE type='oss_config'").get<ConfigRow>();
        if (row) initOSSFromConfig({ oss_config: JSON.parse(row.data) });
      } catch (_: unknown) {}
      const fs = require('fs');
      const buffer = fs.readFileSync(filePath);
      return await uploadToOSS(objectName, buffer, mimeType);
    },

    // ── 邮件（未注入时惰性创建，从 DB 读 owner token）──
    agentEmailApi: agentEmailApi || new AgentEmailApi({
      apiBaseUrl: (ENDPOINTS && ENDPOINTS.api && ENDPOINTS.api.baseUrl) || '',
      getUserAccessToken: () => {
        try {
          const email = getPrimaryOwnerEmail(db);
          if (!email) return null;
          return getUserAccessToken(db, email);
        } catch (_: unknown) { return null; }
      },
    }),

    // ── 注册 ──
    agentRegistration,
    bugReport,

    // ── 支付 ──
    getPaymentAuth: (agentId: string) => {
      try { return databaseAPI.getPaymentAuth(agentId); } catch (_: unknown) { return null; }
    },
    getUserAccessToken: (email: string) => {
      try { return getUserAccessToken(db, email); } catch (_: unknown) { return null; }
    },
    VOKO_API_URL: (ENDPOINTS.api && ENDPOINTS.api.baseUrl) || '',
    signDidRequest,
    getAgentImUid: (agentId: string) => {
      try { return databaseAPI.getAgentImUid(agentId); } catch (_: unknown) { return ''; }
    },
    savePaymentOrder: (order: UnknownRecord) => {
      try { return databaseAPI.savePaymentOrder(order); } catch (_: unknown) {}
    },

    // ── WuKongIM ──
    wukongim: {
      getCurrentUid: (agentId: string) => {
        try { return databaseAPI.getAgentImUid(agentId); } catch (_: unknown) { return ''; }
      },
    },

    version: pkg.version,
  };
}

export type LiteContext = ReturnType<typeof createContext>;
module.exports = { createContext };
