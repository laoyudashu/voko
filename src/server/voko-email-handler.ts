export {};

interface AgentEmailResult {
  message_id: string;
  external_id?: string | null;
}

interface AgentEmailApiLike {
  send(
    agentDid: string,
    content: string,
    options: {
      subject: string;
      external_id: string;
      context: {
        visitor_id: string;
        snippet: string;
      };
    },
  ): Promise<AgentEmailResult>;
}

interface AgentIdentityRow {
  did: string | null;
  agent_name: string | null;
}

interface DatabaseStatement {
  get(agentId: string): unknown;
}

interface DatabaseLike {
  prepare(sql: string): DatabaseStatement;
}

interface VokoEmailCallbacks {
  agentEmailApi?: AgentEmailApiLike | null;
  db: DatabaseLike;
  isEnabled?: () => boolean;
}

interface MessageTrackingResult {
  messageId: string;
  sentMessageId: string;
}

function isAgentIdentityRow(value: unknown): value is AgentIdentityRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (typeof row.did === 'string' || row.did === null)
    && (typeof row.agent_name === 'string' || row.agent_name === null);
}

/**
 * voko-email-handler.js — VOKO 内置邮件渠道处理器
 *
 * 通过服务端 API 发送通知邮件，不走 SMTP。
 * 在 registry 中注册为标准渠道，走统一的 sendMessageToOwnerWithTracking 接口。
 */

const { logEvent } = require('../core/event-log');
const { t, getLocale } = require('../core/i18n');

class VokoEmailHandler {
  agentEmailApi: AgentEmailApiLike | null;
  db: DatabaseLike;
  _isEnabled: () => boolean;
  enabled: boolean;
  /**
   * @param {object} config - 空对象（voko-email 无配置项）
   * @param {object} callbacks
   * @param {object} callbacks.agentEmailApi - AgentEmailApi 实例
   * @param {object} callbacks.db - better-sqlite3 实例
   * @param {Function} callbacks.isEnabled - () => boolean
   */
  constructor(_config: Record<string, never>, callbacks: VokoEmailCallbacks) {
    this.agentEmailApi = callbacks.agentEmailApi || null;
    this.db = callbacks.db;
    this._isEnabled = callbacks.isEnabled || (() => true);
    this.enabled = true;
  }

  async start(): Promise<void> {
    // voko-email 无需持久连接，无操作
  }

  async stop(): Promise<void> {
    this.enabled = false;
  }

  /**
   * 发送通知邮件给主人
   * @param {string} content - 消息内容
   * @param {string} visitorId - 访客 ID
   * @param {string} sessionKey - 会话 key
   * @param {string} agentId - Agent ID
   * @returns {Promise<{ messageId: string, sentMessageId: string }>}
   */
  async sendMessageToOwnerWithTracking(
    content: string,
    visitorId: string,
    _sessionKey: string | null | undefined,
    agentId?: string,
  ): Promise<MessageTrackingResult> {
    const locale = getLocale();
    if (!this.agentEmailApi || !agentId) {
      throw new Error(t('errors.email.no_api_or_agent', {}, locale));
    }

    const rawAgentRow = this.db.prepare('SELECT did, agent_name FROM agents WHERE agent_id = ?').get(agentId);
    const agentRow = isAgentIdentityRow(rawAgentRow) ? rawAgentRow : null;
    if (!agentRow?.did) {
      throw new Error(t('errors.email.agent_did_missing', { agentId }, locale));
    }

    const name = agentRow.agent_name || agentId;
    const subjectKey = 'errors.email.subject_voko_intervention';
    const visitorRow = this.db.prepare('SELECT nickname FROM user_cache WHERE uid = ?').get(visitorId) as { nickname?: string } | undefined;
    const visitorLabel = String(visitorRow?.nickname || '').trim()
      ? `${String(visitorRow?.nickname).trim()}（${visitorId}）`
      : visitorId;
    const subject = t(subjectKey, { agent_name: name, visitor_id: visitorLabel }, locale);
    const emailBody = content;

    const result = await this.agentEmailApi.send(agentRow.did, emailBody, {
      subject,
      external_id: `${Date.now()}`,
      context: { visitor_id: visitorId, snippet: (content || '').substring(0, 100) },
    });

    if (result?.message_id) {
      console.log(`[VokoEmailHandler] 服务端邮件已发送, agent=${agentId}, visitor=${visitorId}, message_id=${result.message_id}`);
      logEvent('email.sent', { id: result.message_id, agentId, visitorId, data: { messageId: result.message_id } });
      return { messageId: result.message_id, sentMessageId: result.message_id };
    }

    throw new Error('邮件发送失败，未返回 message_id');
  }
}

module.exports = VokoEmailHandler;
