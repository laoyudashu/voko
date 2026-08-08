export {};

type UnknownRecord = Record<string, unknown>;

interface ChannelRecord extends UnknownRecord {
  enabled?: boolean;
  config?: UnknownRecord;
}

interface ChannelConfigField {
  key: string;
  label: string;
  type: string;
  required?: boolean;
}

interface ChannelDefinition {
  name: string;
  displayName: string;
  configFields: ChannelConfigField[];
  handlerClass: string;
  extractConfig(channel: ChannelRecord): UnknownRecord;
}

interface ChannelHandler {
  start(): Promise<unknown>;
  stop?(): unknown;
}

type ChannelHandlerConstructor = new (
  config: UnknownRecord,
  callbacks: Record<string, unknown>,
) => ChannelHandler;

interface OwnerIntervention {
  id: string;
  visitorId: string;
  sessionKey?: string | null;
  problem?: string | null;
  askTime?: number | string | Date | null;
  replyTime?: number | string | Date | null;
  agentId?: string | null;
}

interface OwnerReplyUpdateResult {
  success?: boolean;
  contentChanged?: boolean;
}

interface ChannelDatabaseApi {
  getEnabledChannel?(name: string): ChannelRecord | null | undefined;
  updateOwnerInterventionReply(
    id: string,
    content: string,
    replyTime: number,
    channelName: string,
  ): OwnerReplyUpdateResult;
  markAgentNotified(id: string): unknown;
  updateOwnerInterventionStatus(id: string, status: string, resolvedAt: number | null): unknown;
  getOwnerInterventionByParentMsgId(messageId: string): unknown;
  getLatestPendingIntervention(): unknown;
  getPendingByAgentAndVisitor(agentId: string, visitorId: string): unknown;
}

interface DatabaseStatement {
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}

interface RegistryDatabase {
  prepare(sql: string): DatabaseStatement;
}

interface ProviderConnection {
  connected?: boolean;
  sendToSession?(sessionKey: string, message: string): Promise<unknown>;
  steer?(sessionKey: string, message: string): Promise<{ output?: string }>;
}

interface ResumeResult {
  success?: boolean;
  deliveryOutcome?: 'delivered' | 'not_delivered' | 'outcome_unknown' | 'rejected';
  output?: unknown;
}

interface ChannelRegistryDeps {
  databaseAPI: ChannelDatabaseApi;
  db?: RegistryDatabase;
  openclawHandler?: ProviderConnection | null;
  hermesHandler?: ProviderConnection | null;
  getEnabledChannel?: (name: string) => ChannelRecord | null | undefined;
  buildOwnerReplyPrompt?: (intervention: OwnerIntervention, ownerReply: string) => string;
  autoApproveWhitelistIfFriendRequest?: (
    intervention: OwnerIntervention,
    content: string,
  ) => unknown;
  resumeOwnerIntervention?: (
    intervention: OwnerIntervention,
    message: string,
  ) => ResumeResult | Promise<ResumeResult>;
  agentEmailApi?: unknown;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function backendTypeFromRow(row: unknown): string | undefined {
  if (!row || typeof row !== 'object' || !('backend_type' in row)) return undefined;
  const backendType = (row as { backend_type?: unknown }).backend_type;
  return typeof backendType === 'string' ? backendType : undefined;
}

/**
 * 渠道注册表 — 统一管理所有渠道的初始化、回调、运行时访问
 *
 * 新增渠道步骤：
 *   1. 写 handler class 在 src/server/
 *   2. 写元信息文件在 src/channels/
 *   3. 在 REGISTERED 数组中注册
 */

const channels: Record<string, unknown> = {};
const bus = require('../core/lite-bus');
const { settleOwnerForward } = require('../core/owner-intervention-forward');

/**
 * 构建主人回复提示词（默认实现）
 */
function buildOwnerReplyPrompt(intervention: OwnerIntervention, ownerReply: string): string {
  const askTime = intervention.askTime
    ? new Date(intervention.askTime).toLocaleString('zh-CN', { hour12: false })
    : '未知时间';
  const replyTime = intervention.replyTime
    ? new Date(intervention.replyTime).toLocaleString('zh-CN', { hour12: false })
    : new Date().toLocaleString('zh-CN', { hour12: false });
  return `[Owner Reply]\n针对 ${intervention.visitorId} 在 ${askTime} 提出的：${intervention.problem}，主人的答复如下：${ownerReply}\n请直接面向原会话对象输出最终回复。不要描述主人回复、介入流程、关闭请求或回复群聊等内部步骤；不要在正文手写 @姓名，系统会通过 mention 元数据定向提醒。`;
}

const CHANNEL_FILES: Record<string, string> = { 'voko-email': 'voko-email' };

function loadDef(name: string): ChannelDefinition | null {
  try {
    return require(`./${CHANNEL_FILES[name] || name}`) as ChannelDefinition;
  } catch (e: unknown) {
    console.error(`[Registry] 加载渠道元信息失败: ${name}`, errorMessage(e));
    return null;
  }
}
const REGISTERED = ['voko-email'];

const handlers: Record<string, ChannelHandler> = {};

/**
 * 创建统一的 onOwnerReply 回调
 */
function createOnOwnerReply(channelName: string, deps: ChannelRegistryDeps) {
  const { databaseAPI, openclawHandler, hermesHandler, db } = deps;

  return (intervention: OwnerIntervention, content: string, replyMessageId?: string | null) => {
    const logTag = channelName.charAt(0).toUpperCase() + channelName.slice(1);
    console.log(`[${logTag}] ================== 主人回复流程 ==================`);

    let isTestReply = false;
    if (intervention.visitorId && intervention.visitorId.startsWith('system_test:')) {
      const testId = intervention.visitorId.replace('system_test:', '');
      console.log(`[${logTag}] 收到渠道测试回复, testId:`, testId);
      isTestReply = true;
      bus.emit('channels:test-success', {
        testId: testId,
        replyContent: content
      });
    }

    const sessionKeyForForward = intervention.sessionKey;
    const updateResult = databaseAPI.updateOwnerInterventionReply(intervention.id, content, Date.now(), channelName);
    console.log(`[${logTag}] 数据库更新结果: id=${intervention.id} contentChanged=${updateResult.contentChanged}${isTestReply ? ' (测试消息)' : ''}`);

    // 好友申请仅在收到新回复时自动审批，避免重复轮询反复触发。
    if (!isTestReply && updateResult.contentChanged && deps.autoApproveWhitelistIfFriendRequest) {
      deps.autoApproveWhitelistIfFriendRequest(intervention, content);
    }

    if (!isTestReply && updateResult.contentChanged && sessionKeyForForward) {
      const promptBuilder = deps.buildOwnerReplyPrompt || buildOwnerReplyPrompt;
      const forwardMsg = promptBuilder(intervention, content);
      const settle = (result: unknown) => settleOwnerForward(databaseAPI, intervention.id, result);
      const reportOutcome = (outcome: string) => {
        if (outcome === 'delivered') {
          console.log(`[${logTag}] 主人回复已入库并成功转发`);
        } else if (outcome === 'outcome_unknown' || outcome === 'rejected') {
          console.warn(`[${logTag}] 主人回复已入库，自动转发结果未知，保留 Pull`);
        } else {
          console.log(`[${logTag}] 主人回复已入库，通道确认未投递，等待重试`);
        }
      };
      if (typeof deps.resumeOwnerIntervention === 'function') {
        Promise.resolve(deps.resumeOwnerIntervention(intervention, forwardMsg))
          .then((result: ResumeResult) => {
            const outcome = settle(result);
            reportOutcome(outcome);
          })
          .catch((err: unknown) => {
            const outcome = settle(err);
            reportOutcome(outcome);
            console.error(`[${logTag}] resume owner intervention failed:`, errorMessage(err));
          });
      } else if (intervention.agentId) {
        const backendRow = db ? db.prepare('SELECT backend_type FROM agents WHERE agent_id = ?').get(intervention.agentId) : null;
        const agentBackend = backendTypeFromRow(backendRow);
        if (agentBackend === 'hermes' && hermesHandler?.connected && hermesHandler.steer) {
          const hermesSessionKey = 'hermes:' + intervention.agentId + ':' + intervention.visitorId;
          hermesHandler.steer(hermesSessionKey, forwardMsg).then((result) => {
            reportOutcome(settle(result));
            const output = result?.output || '';
            if (output && db) {
              const ts = Math.floor(Date.now() / 1000);
              const msgId = 'steer-' + intervention.agentId + '-' + intervention.visitorId + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
              try {
                db.prepare("INSERT INTO messages (id, from_uid, to_uid, content, channel_id, channel_type, agent_id, timestamp, is_me, status, message_seq, client_msg_no, no_persist, red_dot, sync_once, content_type) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 1, 'sent', ?, ?, ?, ?, ?, ?)").run(msgId, '', intervention.visitorId, output, intervention.visitorId, intervention.agentId, ts, null, null, 0, 0, 0, 1);
              } catch (_e: unknown) { /* ignore */ }
              console.log(`[${logTag}] agent 回复已入库, visitorId=${intervention.visitorId}`);
            }
          }).catch((err: unknown) => {
            reportOutcome(settle(err));
            console.error(`[${logTag}] 通知 Hermes agent 失败:`, errorMessage(err));
          });
        } else if (agentBackend === 'openclaw' && openclawHandler?.connected && openclawHandler.sendToSession) {
          openclawHandler.sendToSession(sessionKeyForForward, forwardMsg).then((result) => {
            reportOutcome(settle(result));
          }).catch((err: unknown) => {
            reportOutcome(settle(err));
            console.error(`[${logTag}] 通知 agent 失败:`, errorMessage(err));
          });
        } else {
          console.log(`[${logTag}] -> 后端类型 ${agentBackend} 不支持主动转发，agent 可通过 check_human_replies 自行读取`);
        }
      } else {
        console.log(`[${logTag}] -> 无可用连接，跳过转发`);
      }
    } else if (sessionKeyForForward && !updateResult.contentChanged) {
      console.log(`[${logTag}] -> 回复内容无变化，跳过通知 agent`);
    } else if (sessionKeyForForward) {
      console.log(`[${logTag}] -> 无可用连接，跳过转发`);
    }

    bus.emit('owner-reply', {
      channelName,
      visitorId: intervention.visitorId,
      content,
      sessionKey: sessionKeyForForward,
      replyMessageId
    });

    console.log(`[${logTag}] ================== 流程结束 ==================`);
  };
}

/**
 * 统一初始化所有已启用的渠道
 */
function initializeAllChannels(deps: ChannelRegistryDeps) {
  const { databaseAPI } = deps;
  const result: Record<string, ChannelHandler> = {};
  // 如果未传 getEnabledChannel，使用 databaseAPI.getEnabledChannel
  const getEnabledChannel = deps.getEnabledChannel || (databaseAPI?.getEnabledChannel || (() => null));
  // 构建包含必要回调的上下文集，供 createOnOwnerReply / reinitializeChannel 使用
  const ctx = { ...deps, getEnabledChannel };

  for (const name of REGISTERED) {
    const def = loadDef(name);
    if (!def) continue;

    const channel = getEnabledChannel(name);
    if (!channel || !channel.enabled) {
      console.log(`[${def.displayName}] 渠道未启用或未配置，跳过初始化`);
      continue;
    }

    const config = def.extractConfig(channel);
    const missingField = def.configFields.find((field) => field.required && !config[field.key]);
    if (missingField) {
      console.log(`[${def.displayName}] 配置不完整（缺少 ${missingField.label}），跳过初始化`);
      continue;
    }

    if (name !== 'voko-email') console.log(`[${def.displayName}] 初始化中...`);

    try {
      const HandlerClass = require(def.handlerClass) as ChannelHandlerConstructor;

      const callbacks: Record<string, unknown> = {
        onOwnerReply: createOnOwnerReply(name, ctx),
        getInterventionByParentMsgId: (msgId: string) => databaseAPI.getOwnerInterventionByParentMsgId(msgId),
        isEnabled: () => {
          const ch = getEnabledChannel(name);
          return ch && ch.enabled;
        }
      };

      if (name === 'wecom') {
        callbacks.getLatestPendingIntervention = () => databaseAPI.getLatestPendingIntervention();
      }
      if (name === 'email') {
        callbacks.getPendingByAgentAndVisitor = (agentId: string, visitorId: string) => databaseAPI.getPendingByAgentAndVisitor(agentId, visitorId);
      }
      if (name === 'wecom') {
        callbacks.onSessionExpired = () => {
          console.log('[Wechat] 会话已过期，请重新扫码登录');
          bus.emit('wechat:session-expired');
        };
      }
      if (name === 'voko-email') {
        callbacks.agentEmailApi = deps.agentEmailApi;
        callbacks.db = deps.db;
      }

      const handler = new HandlerClass(config, callbacks);
      result[`${name}Handler`] = handler;
      handlers[name] = handler;

      // Email 渠道始终启动 IMAP（IDLE + 30秒轮询），无记录时轮询会快速返回
      {
        handler.start().then(() => {
          if (name !== 'voko-email') {
            console.log(`[${def.displayName}] ✅ ${def.displayName} 处理器已启动 at`, new Date().toISOString());
          }
      }).catch((err: unknown) => {
        console.error(`[${def.displayName}] ❌ 启动失败:`, errorMessage(err));
      });
      }

    } catch (err: unknown) {
      console.error(`[${def.displayName}] ❌ 初始化失败:`, errorMessage(err));
    }
  }

  return result;
}

function getChannelDef(name: string): ChannelDefinition | null {
  return loadDef(name);
}

function reinitializeChannel(name: string, deps: ChannelRegistryDeps): ChannelHandler | null {
  // 停止旧 handler
  const old = handlers[name];
  if (old && typeof old.stop === 'function') {
    old.stop();
  }
  delete handlers[name];

  // 只初始化这一个渠道
  const def = loadDef(name);
  if (!def) return null;

  const { databaseAPI } = deps;
  const getEnabledChannel = deps.getEnabledChannel || (databaseAPI?.getEnabledChannel || (() => null));
  const ctx = { ...deps, getEnabledChannel };

  const channel = getEnabledChannel(name);
  if (!channel || !channel.enabled) {
    console.log(`[${def.displayName}] 渠道未启用，跳过`);
    return null;
  }

  const config = def.extractConfig(channel);
  const missingField = def.configFields.find((field) => field.required && !config[field.key]);
  if (missingField) {
    console.log(`[${def.displayName}] 配置不完整，跳过`);
    return null;
  }

  try {
    const HandlerClass = require(def.handlerClass) as ChannelHandlerConstructor;
    const callbacks: Record<string, unknown> = {
      onOwnerReply: createOnOwnerReply(name, ctx),
      getInterventionByParentMsgId: (msgId: string) => databaseAPI.getOwnerInterventionByParentMsgId(msgId),
      isEnabled: () => { const ch = getEnabledChannel(name); return ch && ch.enabled; }
    };

    if (name === 'wecom') {
      callbacks.getLatestPendingIntervention = () => databaseAPI.getLatestPendingIntervention();
    }
    if (name === 'email') {
      callbacks.getPendingByAgentAndVisitor = (agentId: string, visitorId: string) => databaseAPI.getPendingByAgentAndVisitor(agentId, visitorId);
    }
    if (name === 'wecom') {
      callbacks.onSessionExpired = () => {
        bus.emit('wechat:session-expired');
      };
    }
    if (name === 'voko-email') {
      callbacks.agentEmailApi = deps.agentEmailApi;
      callbacks.db = deps.db;
    }

    const handler = new HandlerClass(config, callbacks);
    handlers[name] = handler;

    handler.start().then(() => {
      console.log(`[${def.displayName}] ✅ 已启动`);
    }).catch((err: unknown) => {
      console.error(`[${def.displayName}] ❌ 启动失败:`, errorMessage(err));
    });

    return handler;
  } catch (err: unknown) {
    console.error(`[${def.displayName}] ❌ 初始化失败:`, errorMessage(err));
    return null;
  }
}

function getRegisteredNames() {
  return REGISTERED;
}

function getHandler(name: string): ChannelHandler | null {
  return handlers[name] || null;
}

function getAllHandlers() {
  return { ...handlers };
}

module.exports = {
  initializeAllChannels,
  createOnOwnerReply,
  buildOwnerReplyPrompt,
  getChannelDef,
  getRegisteredNames,
  getHandler,
  getAllHandlers,
  reinitializeChannel
};
