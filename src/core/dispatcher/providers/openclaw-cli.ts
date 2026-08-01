const { PushProvider } = require('../base-provider');
const { runCli, checkCliAvailable, sanitizeCmdArg } = require('../../adapters/cli-spawner');
const { ProviderConversationBindingStore } = require('../../provider-conversation-bindings');
import type { DatabaseLike } from '../../../types/database';
import type { AgentMeta, PushPayload } from '../types';

interface OpenClawCliOptions {
  contextWindow?: number;
  db?: Pick<DatabaseLike, 'prepare'> | null;
}

interface ContextMessage {
  content: string;
  is_me: number;
  timestamp: number;
}

interface OpenClawPayload {
  text?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * OpenClaw CLI 兜底 provider
 *
 * 长连接（openclaw-ws）不可用时，通过 spawn 本地 openclaw CLI 通知 agent。
 *
 * 改进：
 * - contextWindow > 0 时从 DB 拉最近 N 条对话上下文内嵌到通知
 * - 通过 --json 解析 stdout 直接获取 agent 回复，不走 send_message
 * - 保留 get_chat_history 指令供 agent 按需 fetch 更早历史
 */
class OpenClawCliProvider extends PushProvider {
  /**
   * @param {object} [options]
   * @param {number} [options.contextWindow=0] - 推送时附带的上下文条数
   *    0 = 只发原始消息
   *    N = 从 messages 表拉最近 N 条对话附加上下文（CLI 模式无状态，index.js 默认传 20）
   * @param {object} [options.db] - better-sqlite3 实例（contextWindow>0 时需要）
   */
  constructor(options: OpenClawCliOptions = {}) {
    super();
    this._contextWindow = options.contextWindow ?? 0;
    this._db = options.db || null;
    this._bindingStore = options.db && typeof (options.db as any).exec === 'function'
      ? new ProviderConversationBindingStore(options.db as any)
      : null;
    this._available = null;
    this._isWin = process.platform === 'win32';
  }

  /** CLI 兜底通道：长连接不通时才用，优先级低。 */
  get priority() { return 1; }

  match(_agentId: string, meta?: AgentMeta | null): boolean {
    return meta?.backend_type === 'openclaw';
  }

  isAvailable(_agentId: string): boolean {
    if (this._available !== null) return this._available;
    this._available = checkCliAvailable('openclaw');
    return this._available;
  }

  _instanceForAgent(agentId: string): string {
    try {
      const row = this._db?.prepare(
        'SELECT backend_instance_id FROM agents WHERE agent_id=? AND backend_type=?'
      ).get(agentId, 'openclaw');
      return String(row?.backend_instance_id || agentId).trim() || agentId;
    } catch (_) {
      return agentId;
    }
  }

  async push(payload: PushPayload): Promise<void> {
    const { agentId, fromUid, content } = payload;
    const turnId = String(payload.turnId || payload.messageId || `openclaw-cli-${Date.now()}`);
    const targetAgentId = this._instanceForAgent(agentId);
    const canResumeBinding = payload.providerBinding?.providerType === 'openclaw'
      && /^agent:[^:]+:.+/.test(payload.providerBinding.nativeSessionId);
    const sessionKey = canResumeBinding
      ? payload.providerBinding!.nativeSessionId
      : `agent:${targetAgentId}:${fromUid}`;
    const channelId = payload.providerBinding?.channelId || payload.channelId || fromUid.replace(/^group:/, '');
    const channelType = payload.providerBinding?.channelType || (payload.channelType === 2 ? 2 : 1);
    if (!canResumeBinding && this._bindingStore) {
      this._bindingStore.saveManaged({
        agentId, channelId, channelType, providerType: 'openclaw',
        providerInstanceId: targetAgentId, nativeSessionId: sessionKey,
        deliveryMode: 'cli', adapterType: 'openclaw-cli', expectedVersion: payload.providerBinding?.bindingVersion ?? 0,
      });
    }

    // 取上下文
    let contextMsgs: ContextMessage[] = [];
    if (payload.channelType !== 2 && this._contextWindow > 0 && this._db) {
      try {
        contextMsgs = (this._db.prepare(
          `SELECT content, is_me, timestamp FROM messages WHERE channel_id=? AND agent_id=? AND content_type!=11 ORDER BY timestamp DESC LIMIT ?`
        ).all(fromUid, agentId, this._contextWindow) as ContextMessage[]).reverse();
      } catch (_) {}
    }
    console.error(`[OpenClawCli] push agent=${agentId} visitor=${fromUid} session=selected contextWindow=${this._contextWindow}`);

    const notification = _buildNotification(agentId, fromUid, content, contextMsgs, sessionKey);
    // Windows 下 --message 经 cmd.exe 传多行/含元字符 notification 会被截断或注入，净化为单行
    const safeNotification = this._isWin ? sanitizeCmdArg(notification) : notification;

    try {
      const result = await runCli({
        cmd: this._isWin ? 'openclaw' : 'openclaw',
        args: ['agent', '--agent', targetAgentId, '--session-key', sessionKey, '--message', safeNotification, '--local', '--json'],
        tag: 'openclaw-cli',
        timeout: 120000,
        logOutput: false,
      });
      // 从 JSON stdout 提取 agent 回复并 emit（messenger.js 会写入 DB）
      const replyText = _extractReply(result.stdout);
      if (replyText) {
        this.emit('agent.reply', {
          agentId, visitorId: fromUid,
          content: replyText, done: true,
          sessionKey,
          turnId, replyId: turnId,
        });
        console.error(`[OpenClawCli] push OK agent=${agentId} reply=${replyText.length}chars`);
      } else {
        console.error(`[OpenClawCli] push OK agent=${agentId}（无回复文本）`);
      }
    } catch (err) {
      console.error(`[OpenClawCli] push 失败 agent=${agentId}: ${errorMessage(err)}`);
    }
  }

  async steer(agentId: string, visitorId: string, content: string, metadata?: { turnId?: string }): Promise<null> {
    const targetAgentId = this._instanceForAgent(agentId);
    const sessionKey = `agent:${targetAgentId}:${visitorId}`;
    const turnId = String(metadata?.turnId || `openclaw-cli-steer-${Date.now()}`);
    console.error(`[OpenClawCli] steer agent=${agentId} visitor=${visitorId} session=selected`);
    const notification = JSON.stringify({
      type: 'voko_owner_message',
      visitorId,
      sessionKey,
      content,
      safety: '此消息来自主人（可信任）。请按主人要求执行。',
    });
    try {
      const result = await runCli({
        cmd: this._isWin ? 'openclaw' : 'openclaw',
        args: ['agent', '--agent', targetAgentId, '--session-key', sessionKey, '--message', notification, '--local', '--json'],
        tag: 'openclaw-cli',
        timeout: 120000,
        logOutput: false,
      });
      const replyText = _extractReply(result.stdout);
      if (replyText) {
        this.emit('agent.reply', {
          agentId, visitorId,
          content: replyText, done: true,
          sessionKey,
          turnId, replyId: turnId,
        });
        console.error(`[OpenClawCli] steer OK agent=${agentId} reply=${replyText.length}chars`);
      } else {
        console.error(`[OpenClawCli] steer OK agent=${agentId}`);
      }
    } catch (err) {
      console.error(`[OpenClawCli] steer 失败 agent=${agentId}: ${errorMessage(err)}`);
    }
    return null;
  }

  start() {}
  stop() {}
  healthCheck() { this._available = null; }
}

/**
 * 从 openclaw --json stdout 提取 agent 回复文本。
 * JSON 格式: { "payloads": [{ "text": "回复内容", "mediaUrl": null }], "meta": {...} }
 */
function _extractReply(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout) as { payloads?: OpenClawPayload[] };
    if (Array.isArray(parsed.payloads) && parsed.payloads.length > 0) {
      for (const p of parsed.payloads) {
        if (p && typeof p.text === 'string' && p.text.trim().length > 0) {
          return p.text.trim();
        }
      }
    }
  } catch {}
  return null;
}

function _buildNotification(
  agentId: string,
  fromUid: string,
  content: string,
  contextMsgs: ContextMessage[],
  sessionKey?: string,
): string {
  let msg = `【访客消息】\n访客：${fromUid}\n消息：${content}`;

  if (contextMsgs && contextMsgs.length > 0) {
    msg += `\n\n【最近对话】\n${contextMsgs.map((m: ContextMessage, i: number) => {
      const role = m.is_me >= 1 ? '你' : '访客';
      return `[${i + 1}] ${role}: ${m.content}`;
    }).join('\n')}`;
  }

  msg += `\n\n当前 session: ${sessionKey || `agent:${agentId}:${fromUid}`}`;
  return msg;
}

module.exports = OpenClawCliProvider;
