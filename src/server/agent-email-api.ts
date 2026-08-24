export {};

interface AgentEmailApiOptions {
  apiBaseUrl: string;
  getUserAccessToken?: () => string | null;
}

interface SendEmailOptions {
  subject?: string;
  external_id?: string;
  context?: {
    visitor_id?: string;
    session_id?: string;
    snippet?: string;
  };
  reply_enabled?: boolean;
  to?: string;
}

interface SendEmailBody {
  agentDid: string;
  template_data: {
    CONTENT: string;
    TITLE: string;
  };
  reply_enabled: boolean;
  subject?: string;
  external_id?: string;
  context?: SendEmailOptions['context'];
  to?: string;
}

interface SendEmailResult {
  message_id: string;
  external_id: string | null;
}

interface EmailReplyResult {
  has_reply: boolean;
  raw_text: string | null;
  status: string | null;
  replied_at: string | null;
  actor_email: string | null;
  expires_at: string | null;
  terminal?: 'not_found';
}

interface EmailReplyEvent {
  event_id: string;
  message_id: string;
  external_id: string | null;
  status: string;
  raw_text: string | null;
  actor_email: string | null;
  replied_at: string | null;
}

interface EmailReplyPage {
  events: EmailReplyEvent[];
  next_cursor: string;
  has_more: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function responseError(value: unknown, status: number): string {
  if (!isRecord(value)) return `HTTP ${status}`;
  if (typeof value.message === 'string') return value.message;
  if (typeof value.msg === 'string') return value.msg;
  return `HTTP ${status}`;
}

function parseSendResult(
  value: unknown,
  fallbackExternalId?: string,
): SendEmailResult | null {
  if (!isRecord(value) || value.success !== true || !isRecord(value.data)) return null;
  if (typeof value.data.message_id !== 'string') return null;
  return {
    message_id: value.data.message_id,
    external_id: typeof value.data.external_id === 'string'
      ? value.data.external_id
      : fallbackExternalId || null,
  };
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parseReplyResult(value: unknown): EmailReplyResult | null {
  if (!isRecord(value) || value.success !== true || !isRecord(value.data)) return null;
  const data = value.data;
  return {
    has_reply: data.has_reply === true,
    raw_text: nullableString(data.raw_text),
    status: nullableString(data.status),
    replied_at: nullableString(data.replied_at),
    actor_email: nullableString(data.actor_email),
    expires_at: nullableString(data.expires_at),
  };
}

function unsignedIntegerString(value: unknown): string | null {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) return null;
  try {
    return BigInt(value) <= 18446744073709551615n ? value : null;
  } catch (_) {
    return null;
  }
}

function parseReplyPage(value: unknown): EmailReplyPage | null {
  if (!isRecord(value) || value.success !== true || !isRecord(value.data)) return null;
  const cursor = unsignedIntegerString(value.data.next_cursor);
  if (!cursor || !Array.isArray(value.data.events) || typeof value.data.has_more !== 'boolean') return null;
  const events: EmailReplyEvent[] = [];
  for (const item of value.data.events) {
    if (!isRecord(item)) return null;
    const eventId = unsignedIntegerString(item.event_id);
    if (!eventId || typeof item.message_id !== 'string' || typeof item.status !== 'string') return null;
    events.push({
      event_id: eventId,
      message_id: item.message_id,
      external_id: nullableString(item.external_id),
      status: item.status,
      raw_text: nullableString(item.raw_text),
      actor_email: nullableString(item.actor_email),
      replied_at: nullableString(item.replied_at),
    });
  }
  return { events, next_cursor: cursor, has_more: value.data.has_more };
}

/**
 * Agent Email API — 服务端交互邮件 API 客户端
 *
 * 封装两个端点：
 *   POST /api/external/v1/email/send         — 发信
 *   POST /api/external/v1/email/reply/query  — 查回复
 *   POST /api/external/v1/email/replies/poll — 按游标拉取主人邮箱回复事件
 *
 * 使用方式：
 *   const api = new AgentEmailApi({ apiBaseUrl, getUserAccessToken });
 *   const result = await api.send(agentDid, content, { subject, external_id, context });
 *   const reply = await api.queryReply({ message_id });
 */

const { logEvent } = require('../core/event-log');
const { t, getLocale } = require('../core/i18n');

class AgentEmailApi {
  apiBaseUrl: string;
  getUserAccessToken: () => string | null;
  lastQueryWarningKey = '';
  lastQueryWarningAt = 0;

  /**
   * @param {Object} opts
   * @param {string} opts.apiBaseUrl — VOKO_API_URL
   * @param {Function} opts.getUserAccessToken — () => string | null，返回 User Access Token
   */
  constructor({ apiBaseUrl, getUserAccessToken }: AgentEmailApiOptions) {
    this.apiBaseUrl = (apiBaseUrl || '').replace(/\/+$/, '');
    this.getUserAccessToken = getUserAccessToken || (() => null);
  }

  warnQueryOnce(key: string, message: string): void {
    const now = Date.now();
    if (key === this.lastQueryWarningKey && now - this.lastQueryWarningAt < 5 * 60 * 1000) return;
    this.lastQueryWarningKey = key;
    this.lastQueryWarningAt = now;
    console.warn('[AgentEmailApi] queryReply 异常:', message);
  }

  /**
   * 发交互邮件
   * @param {string} agentDid — Agent DID
   * @param {string} content — 邮件正文（template_data.CONTENT）
   * @param {Object} [opts]
   * @param {string} [opts.subject] — 邮件标题
   * @param {string} [opts.external_id] — 外部关联 ID
   * @param {Object} [opts.context] — { visitor_id?, session_id?, snippet? }
   * @returns {Promise<{message_id:string, external_id:string}>}
   * @throws {Error} 失败时抛出，message 含具体原因（无 token / 服务端拒绝 / 网络异常等），
   *                 不再返回 null——调用方据此透传真实失败原因，而非笼统的"未返回 message_id"。
   */
  async send(
    agentDid: string,
    content: string,
    opts: SendEmailOptions = {},
  ): Promise<SendEmailResult> {
    try {
      return await this._send(agentDid, content, opts);
    } catch (err: unknown) {
      logEvent('email.send_failed', { level: 'error', agentId: agentDid, data: { reason: errorMessage(err) } });
      throw err;
    }
  }

  async _send(
    agentDid: string,
    content: string,
    opts: SendEmailOptions = {},
  ): Promise<SendEmailResult> {
    const token = this.getUserAccessToken();
    const locale = getLocale();
    if (!token) throw new Error(t('errors.email.no_token', {}, locale));
    if (!this.apiBaseUrl) throw new Error(t('errors.email.no_api_url', {}, locale));
    if (!agentDid) throw new Error(t('errors.email.no_agent_did', {}, locale));
    if (!content) throw new Error(t('errors.email.no_content', {}, locale));

    const body: SendEmailBody = {
      agentDid,
      template_data: {
        CONTENT: content,
        TITLE: opts.subject || t('errors.email.default_subject', {}, locale),
      },
      reply_enabled: opts.reply_enabled !== false,
    };

    if (opts.subject) body.subject = opts.subject;
    if (opts.external_id) body.external_id = opts.external_id;
    if (opts.context) body.context = opts.context;
    if (opts.to) body.to = opts.to;

    let resp: Response;
    try {
      resp = await fetch(`${this.apiBaseUrl}/api/external/v1/email/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
    } catch (error: unknown) {
      throw new Error(t('errors.email.network_error', { message: errorMessage(error) }, locale));
    }

    let json: unknown;
    try {
      json = await resp.json() as unknown;
    } catch (_error: unknown) {
      throw new Error(t('errors.email.invalid_response', { status: resp.status }, locale));
    }

    const result = parseSendResult(json, opts.external_id);
    if (!result) {
      throw new Error(t('errors.email.server_rejected', { message: responseError(json, resp.status) }, locale));
    }
    return result;
  }

  /**
   * 查回复
   * @param {Object} opts
   * @param {string} opts.message_id — 发信返回的 message_id
   * @returns {Promise<{has_reply:boolean, raw_text:string, status:string, replied_at:string, expires_at:string}|null>}
   */
  async queryReply(
    { message_id }: { message_id?: string } = {},
  ): Promise<EmailReplyResult | null> {
    const token = this.getUserAccessToken();
    if (!token || !this.apiBaseUrl || !message_id) {
      return null;
    }

    try {
      const resp = await fetch(`${this.apiBaseUrl}/api/external/v1/email/reply/query`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ message_id }),
      });
      const text = await resp.text();
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        this.warnQueryOnce(
          `non-json:${resp.status}`,
          `HTTP ${resp.status} 返回非 JSON 响应`,
        );
        return null;
      }
      if (!resp.ok) {
        this.warnQueryOnce(
          `http:${resp.status}`,
          responseError(payload, resp.status),
        );
        if (resp.status === 404) {
          return {
            has_reply: false,
            raw_text: null,
            status: null,
            replied_at: null,
            actor_email: null,
            expires_at: null,
            terminal: 'not_found',
          };
        }
        return null;
      }
      return parseReplyResult(payload);
    } catch (error: unknown) {
      this.warnQueryOnce(`network:${errorMessage(error)}`, errorMessage(error));
      return null;
    }
  }

  async pollReplies(
    { cursor = '0', limit = 100 }: { cursor?: string; limit?: number } = {},
  ): Promise<EmailReplyPage | null> {
    const token = this.getUserAccessToken();
    if (!token || !this.apiBaseUrl || !unsignedIntegerString(cursor)
      || !Number.isInteger(limit) || limit < 1 || limit > 100) return null;
    try {
      const resp = await fetch(`${this.apiBaseUrl}/api/external/v1/email/replies/poll`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ cursor, limit }),
      });
      const text = await resp.text();
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        this.warnQueryOnce(`poll-non-json:${resp.status}`, `HTTP ${resp.status} 返回非 JSON 响应`);
        return null;
      }
      if (!resp.ok) {
        const compatibility = resp.status === 404 || resp.status === 405
          ? '服务端版本不支持邮箱回复事件轮询'
          : responseError(payload, resp.status);
        this.warnQueryOnce(`poll-http:${resp.status}`, compatibility);
        return null;
      }
      const page = parseReplyPage(payload);
      if (!page) this.warnQueryOnce('poll-invalid-payload', '邮箱回复事件响应格式无效');
      return page;
    } catch (error: unknown) {
      this.warnQueryOnce(`poll-network:${errorMessage(error)}`, errorMessage(error));
      return null;
    }
  }
}

module.exports = { AgentEmailApi };
