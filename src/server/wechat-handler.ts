export {};

interface WechatConfig {
  baseUrl?: string;
  botToken?: string;
  ownerUserId?: string;
  pollInterval?: number;
  pollIntervalMs?: number;
}

interface OwnerIntervention {
  id: string;
  [key: string]: unknown;
}

interface WechatHandlerOptions {
  onOwnerReply?: (
    intervention: OwnerIntervention,
    content: string,
    replyMessageId?: string,
  ) => unknown | Promise<unknown>;
  getInterventionByParentMsgId?: (messageId: string) => OwnerIntervention | null;
  getLatestPendingIntervention?: () => OwnerIntervention | null;
  getPendingWechatCount?: () => number;
  isEnabled?: () => boolean;
  onSessionExpired?: () => unknown | Promise<unknown>;
}

interface WechatTextItem {
  type?: number;
  text_item?: { text?: string };
}

interface WechatMessage {
  message_type?: number;
  from_user_id?: string;
  message_id?: string | number;
  context_token?: string;
  item_list?: WechatTextItem[];
}

interface MessageTrackingResult {
  messageId: string;
  sentMessageId: string;
}

interface QrCodeStatusResult {
  status: string;
  bot_token?: string;
  owner_user_id?: string;
  account_id?: string;
  [key: string]: unknown;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isWechatTextItem(value: unknown): value is WechatTextItem {
  if (!isRecord(value)) return false;
  if (value.type !== undefined && typeof value.type !== 'number') return false;
  if (value.text_item === undefined) return true;
  return isRecord(value.text_item)
    && (value.text_item.text === undefined || typeof value.text_item.text === 'string');
}

function isWechatMessage(value: unknown): value is WechatMessage {
  if (!isRecord(value)) return false;
  if (value.message_type !== undefined && typeof value.message_type !== 'number') return false;
  if (value.from_user_id !== undefined && typeof value.from_user_id !== 'string') return false;
  if (
    value.message_id !== undefined
    && typeof value.message_id !== 'string'
    && typeof value.message_id !== 'number'
  ) return false;
  if (value.context_token !== undefined && typeof value.context_token !== 'string') return false;
  if (
    value.item_list !== undefined
    && (!Array.isArray(value.item_list) || !value.item_list.every(isWechatTextItem))
  ) return false;
  return true;
}

function parseResponse(data: string): Record<string, unknown> {
  const value: unknown = JSON.parse(data);
  if (!isRecord(value)) throw new Error('Invalid WeChat response');
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * VOKO Desktop - WeChat (iLink) 消息处理器
 * 通过长轮询接收 WeChat 消息事件
 *
 * 用途：
 * - 当 agent 需要主人介入时，通过微信通知主人
 * - 主人回复后，将消息转发给对应 agent 的 session
 */

const https: typeof import('node:https') = require('https');

class WechatHandler {
  baseUrl: string;
  botToken: string | undefined;
  ownerUserId: string | undefined;
  pollInterval: number;
  onOwnerReply: WechatHandlerOptions['onOwnerReply'] | null;
  getInterventionByParentMsgId:
    | WechatHandlerOptions['getInterventionByParentMsgId']
    | null;
  getLatestPendingIntervention:
    | WechatHandlerOptions['getLatestPendingIntervention']
    | null;
  getPendingWechatCount: WechatHandlerOptions['getPendingWechatCount'] | null;
  isEnabled: () => boolean;
  onSessionExpired: WechatHandlerOptions['onSessionExpired'] | null;
  getUpdatesBuf: string;
  pollTimer: NodeJS.Timeout | null;
  isPolling: boolean;
  enabled: boolean;
  pollIntervalMs: number;
  qrCode: string | null;
  qrCodeToken: string | null;
  qrCodeStatus: string | null;
  accountId: string | null;
  _currentReq: import('node:http').ClientRequest | null;

  constructor(config: WechatConfig = {}, options: WechatHandlerOptions = {}) {
    // iLink 配置
    this.baseUrl = config.baseUrl || 'https://ilinkai.weixin.qq.com';
    this.botToken = config.botToken;
    this.ownerUserId = config.ownerUserId;  // 主人微信 user_id
    this.pollInterval = config.pollInterval || 35000;  // 长轮询超时 35秒

    // 回调函数
    this.onOwnerReply = options.onOwnerReply || null;
    this.getInterventionByParentMsgId = options.getInterventionByParentMsgId || null;
    this.getLatestPendingIntervention = options.getLatestPendingIntervention || null;
    this.getPendingWechatCount = options.getPendingWechatCount || null;
    this.isEnabled = options.isEnabled || (() => true);
    this.onSessionExpired = options.onSessionExpired || null;

    // 轮询状态
    this.getUpdatesBuf = '';
    this.pollTimer = null;
    this.isPolling = false;
    this.enabled = false;
    this.pollIntervalMs = config.pollIntervalMs || 1000;  // 默认1秒

    // 扫码登录状态
    this.qrCode = null;
    this.qrCodeToken = null;  // 保存 token 用于轮询
    this.qrCodeStatus = null;
    this.accountId = null;
    this._currentReq = null;
  }

  async start(): Promise<void> {
    if (this.enabled) {
      console.log('[Wechat] 已经启动');
      return;
    }

    if (!this.botToken || !this.ownerUserId) {
      console.log('[Wechat] 缺少 botToken 或 ownerUserId，跳过启动');
      return;
    }

    this.enabled = true;
    console.log('[Wechat] 启动长轮询，超时', this.pollInterval, 'ms');
    this.scheduleNextPoll();
  }

  scheduleNextPoll(): void {
    if (!this.enabled) return;

    this.pollTimer = setTimeout(async () => {
      await this.pollOnce();
      this.scheduleNextPoll();
    }, this.pollIntervalMs);  // 使用配置的时间间隔
  }

  async pollOnce(): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }

    const pendingCount = this.getPendingWechatCount ? this.getPendingWechatCount() : 1;
    if (pendingCount === 0) {
      return;
    }

    try {
      this.isPolling = true;
      await this.fetchUpdates();
    } catch (err: unknown) {
      console.error('[Wechat] 长轮询错误:', errorMessage(err));
    } finally {
      this.isPolling = false;
    }
  }

  async fetchUpdates(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let expectedAbort = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        if (this._currentReq === req) this._currentReq = null;
        if (error) reject(error);
        else resolve();
      };
      const postData = JSON.stringify({
        get_updates_buf: this.getUpdatesBuf || '',
        base_info: {
          channel_version: '1.0.2'
        }
      });

      const url = new URL(`${this.baseUrl}/ilink/bot/getupdates`);
      const options = {
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.botToken}`,
          'AuthorizationType': 'ilink_bot_token',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer | string) => data += chunk.toString());
        res.on('end', async () => {
          console.log('[Wechat] getupdates response length:', data.length);
          try {
            const json = parseResponse(data);
            // 如果没有 ret 字段，检查是否有 msgs 或 sync_buf（iLink 成功响应）
            if (json.ret === 0 || (json.ret === undefined && (json.msgs || json.sync_buf))) {
              if (json.msgs !== undefined && !Array.isArray(json.msgs)) {
                throw new Error('Invalid WeChat updates response');
              }
              if (Array.isArray(json.msgs) && !json.msgs.every(isWechatMessage)) {
                throw new Error('Invalid WeChat message payload');
              }
              const messages = Array.isArray(json.msgs) ? json.msgs : [];
              if (messages.length > 0) {
                console.log('[Wechat] 收到消息, msgs count:', messages.length);
                this.getUpdatesBuf = optionalString(json.get_updates_buf) || '';
                await this.processUpdates(messages);
              } else {
                // 更新游标，即使没有消息
                this.getUpdatesBuf = optionalString(json.get_updates_buf) || this.getUpdatesBuf;
              }
              finish();
            } else if (json.ret == null) {
              // ret 为空、undefined、null 都视为心跳/空响应，继续轮询
              console.log('[Wechat] 长轮询空响应或心跳，继续轮询');
              finish();
            } else if (json.ret === -14 || json.ret === -2) {
              console.log('[Wechat] 会话过期或无效，准备重新登录, ret:', json.ret, 'errmsg:', json.errmsg);
              if (this.onSessionExpired) {
                await this.onSessionExpired();
              }
              finish();  // 不拒绝，继续下一次轮询
            } else {
              console.error('[Wechat] 长轮询 API 错误, ret:', json.ret, 'errmsg:', json.errmsg);
              finish();  // 其他错误也继续轮询
            }
          } catch (error: unknown) {
            finish(error);
          }
        });
      });
      this._currentReq = req;

      req.on('error', (err: NodeJS.ErrnoException) => {
        if (expectedAbort || (!this.enabled && err.code === 'ECONNRESET')) {
          finish();
          return;
        }
        console.error('[Wechat] 长轮询请求失败:', errorMessage(err));
        finish(err);
      });

      // 设置超时，避免长时间挂起
      req.setTimeout(40000, () => {
        expectedAbort = true;
        req.destroy();
        console.log('[Wechat] 长轮询超时，40秒');
        finish();  // 超时不算错误，继续下一次轮询
      });

      req.write(postData);
      req.end();
    });
  }

  // 检查是否是会话过期错误（需要重新登录）
  isSessionExpiredError(ret: unknown, errmsg: unknown): boolean {
    // -14 = session expired, -2 = 也可能是会话问题
    return ret === -14 || (ret === -2 && errmsg === 'unknown error');
  }

  async processUpdates(msgs: WechatMessage[]): Promise<void> {
    for (const msg of msgs) {
      if (msg.message_type === 1) {  // USER 消息
        await this.handleMessage(msg);
      }
    }
  }

  async handleMessage(msg: WechatMessage): Promise<void> {
    const fromUserId = msg.from_user_id;
    const messageId = msg.message_id?.toString();
    const text = this.extractText(msg);
    const contextToken = msg.context_token;

    console.log('[Wechat] 收到消息', {
      hasContextToken: !!contextToken,
      hasMessageId: !!messageId,
      senderIsOwner: fromUserId === this.ownerUserId,
      textLength: text.length,
    });

    // 只处理来自主人的消息
    if (fromUserId !== this.ownerUserId) {
      return;
    }

    if (contextToken) {
      await this.handleReply(contextToken, text, messageId);
    } else {
      console.log('[Wechat] 消息无 context_token，跳过处理');
    }
  }

  extractText(msg: WechatMessage): string {
    if (!msg.item_list) return '';
    for (const item of msg.item_list) {
      if (item.type === 1 && item.text_item) {
        return item.text_item.text || '';
      }
    }
    return '';
  }

  async handleReply(
    contextToken: string,
    content: string,
    replyMessageId?: string,
  ): Promise<void> {
    if (this.getInterventionByParentMsgId) {
      // 1. 优先尝试 context_token 精确匹配
      let intervention = this.getInterventionByParentMsgId(contextToken);
      if (intervention) {
        console.log('[Wechat] context_token 精确匹配到干预记录:', intervention.id);
        if (this.onOwnerReply) {
          await this.onOwnerReply(intervention, content, replyMessageId);
        }
        return;
      }

      // 2. Fallback: ownerUserId + 最新 pending 记录匹配
      // iLink 的 context_token 是服务器生成的，与我们的 client_id 不同
      // 因此无法精确匹配时，使用 fallback 机制
      console.log('[Wechat] context_token 未匹配，尝试 fallback 匹配');
      if (this.getLatestPendingIntervention) {
        intervention = this.getLatestPendingIntervention();
        if (intervention) {
          console.log('[Wechat] fallback 匹配到最新 pending 记录:', intervention.id);
          if (this.onOwnerReply) {
            await this.onOwnerReply(intervention, content, replyMessageId);
          }
          return;
        }
        console.log('[Wechat] 无 pending 记录，跳过');
      } else {
        console.log('[Wechat] getLatestPendingIntervention 未提供，跳过');
      }
    }
  }

  /**
   * 发送消息给微信用户（带记录，用于后续匹配）
   */
  async sendMessageToOwnerWithTracking(
    content: string,
    _visitorId?: string,
    _sessionKey?: string,
  ): Promise<MessageTrackingResult> {
    return new Promise<MessageTrackingResult>((resolve, reject) => {
      const clientId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      const postData = JSON.stringify({
        msg: {
          from_user_id: '',
          to_user_id: this.ownerUserId,
          client_id: clientId,
          message_type: 2,  // BOT
          message_state: 2,  // FINISH
          context_token: '',  // 主动推送时为空
          item_list: [
            { type: 1, text_item: { text: content } }
          ]
        },
        base_info: {
          channel_version: '1.0.2'
        }
      });

      const url = new URL(`${this.baseUrl}/ilink/bot/sendmessage`);
      const options = {
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.botToken}`,
          'AuthorizationType': 'ilink_bot_token',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer | string) => data += chunk.toString());
        res.on('end', () => {
          try {
            const json = parseResponse(data);
            if (json.ret === 0) {
              console.log('[Wechat] 发送消息给主人成功, clientId:', clientId);
              resolve({ messageId: clientId, sentMessageId: clientId });
            } else if (json.ret === -2) {
              // 会话过期/无效，标记为永久失败，不重试
              console.error('[Wechat] 发送消息失败, ret:', json.ret, 'errmsg:', json.errmsg, '(会话过期，不重试)');
              reject(new Error('SESSION_EXPIRED: ' + (optionalString(json.errmsg) || 'session expired')));
            } else {
              console.error('[Wechat] 发送消息失败, ret:', json.ret, 'errmsg:', json.errmsg);
              reject(new Error(optionalString(json.errmsg) || 'Wechat API error'));
            }
          } catch (error: unknown) {
            reject(error);
          }
        });
      });

      req.on('error', (err: Error) => {
        console.error('[Wechat] 发送请求失败:', errorMessage(err));
        reject(new Error('请求失败: ' + errorMessage(err)));
      });
      req.write(postData);
      req.end();
    });
  }

  /**
   * 获取登录二维码
   */
  async fetchQrCode(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const url = new URL(`${this.baseUrl}/ilink/bot/get_bot_qrcode`);
      url.searchParams.set('bot_type', '3');

      const postData = JSON.stringify({
        local_token_list: this.botToken ? [this.botToken] : []
      });

      const options = {
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.botToken || ''}`,
          'AuthorizationType': 'ilink_bot_token',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer | string) => data += chunk.toString());
        res.on('end', () => {
          try {
            const json = parseResponse(data);
            // qrcode_img_content 是实际的图片 URL 或 base64 数据
            // qrcode 只是 token，不是图片
            const qrCodeToken = optionalString(json.qrcode);
            const qrCodeImage = optionalString(json.qrcode_img_content);
            if (json.ret === 0 && (qrCodeImage || qrCodeToken)) {
              this.qrCodeToken = qrCodeToken || null;  // 保存 token
              this.qrCode = qrCodeImage || qrCodeToken || null;  // 返回 URL 或 token
              if (!this.qrCode) throw new Error('Invalid WeChat QR code response');
              resolve(this.qrCode);
            } else {
              reject(new Error(optionalString(json.errmsg) || '获取二维码失败'));
            }
          } catch (error: unknown) {
            reject(error);
          }
        });
      });

      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }

  /**
   * 轮询扫码状态
   */
  async pollQrCodeStatus(): Promise<QrCodeStatusResult> {
    const qrCodeToken = this.qrCodeToken;
    if (!qrCodeToken) {
      return { status: 'expired' };
    }

    return new Promise<QrCodeStatusResult>((resolve, reject) => {
      const url = new URL(`${this.baseUrl}/ilink/bot/get_qrcode_status`);
      url.searchParams.set('qrcode', qrCodeToken);

      const options = {
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.botToken || ''}`,
          'AuthorizationType': 'ilink_bot_token'
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer | string) => data += chunk.toString());
        res.on('end', () => {
          try {
            const json = parseResponse(data);
            if (json.ret === 0) {
              const status = optionalString(json.status);
              if (!status) throw new Error('Invalid WeChat QR status response');
              this.qrCodeStatus = status;
              const botToken = optionalString(json.bot_token);
              const accountId = optionalString(json.ilink_bot_id);
              const ownerUserId = optionalString(json.ilink_user_id);
              if (status === 'confirmed' && botToken) {
                this.botToken = botToken;
                this.accountId = accountId || this.accountId;
                this.ownerUserId = ownerUserId || this.ownerUserId;
                resolve({
                  status: 'confirmed',
                  bot_token: botToken,
                  owner_user_id: ownerUserId,
                  account_id: accountId
                });
              } else {
                resolve({ ...json, status });
              }
            } else {
              resolve({ status: 'expired' });
            }
          } catch (error: unknown) {
            reject(error);
          }
        });
      });

      req.on('error', reject);
      req.end();
    });
  }

  stop(): void {
    this.enabled = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this._currentReq) {
      const request = this._currentReq;
      this._currentReq = null;
      request.destroy();
    }
    console.log('[Wechat] 轮询已停止');
  }

  updateConfig(config: WechatConfig): void {
    if (config.baseUrl) this.baseUrl = config.baseUrl;
    if (config.botToken) this.botToken = config.botToken;
    if (config.ownerUserId) this.ownerUserId = config.ownerUserId;
    if (config.pollInterval) this.pollInterval = config.pollInterval;
    console.log('[Wechat] 配置已更新');
  }
}

module.exports = WechatHandler;
