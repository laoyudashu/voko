const { PushProvider } = require('../base-provider');
const { runCli, checkCliAvailable, sanitizeCmdArg } = require('../../adapters/cli-spawner');
const { ProviderConversationBindingStore } = require('../../provider-conversation-bindings');
const { buildConversationDeliveryPrompt } = require('../conversation-context');
import type { DatabaseLike } from '../../../types/database';
import type { AgentMeta, PushPayload } from '../types';

interface HermesCliOptions {
  contextWindow?: number;
  db?: Pick<DatabaseLike, 'prepare'> | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Hermes CLI provider — 通过 spawn 本地 hermes CLI 通知 agent 并捕获回复。
 *
 * 改进：
 * - JSON 格式 push（type/content/visitorId/safety/sessionKey）
 * - 解析 stdout 直接获取 agent 回复，不走 HTTP API
 * - 仅在原生 session 不可恢复时使用 contextWindow 恢复历史
 */
class HermesCliProvider extends PushProvider {
  /**
   * @param {object} [options]
   * @param {number} [options.contextWindow=0] - session 恢复失败时注入的历史条数
   * @param {object} [options.db] - better-sqlite3 实例
   */
  constructor(options: HermesCliOptions = {}) {
    super();
    this._contextWindow = options.contextWindow ?? 0;
    this._db = options.db || null;
    this._bindingStore = options.db && typeof (options.db as any).exec === 'function'
      ? new ProviderConversationBindingStore(options.db as any)
      : null;
    this._available = null;
  }

  get priority() { return 1; }

  match(_agentId: string, meta?: AgentMeta | null): boolean {
    return meta?.backend_type === 'hermes';
  }

  isAvailable(_agentId: string): boolean {
    if (this._available !== null) return this._available;
    this._available = checkCliAvailable('hermes');
    return this._available;
  }

  _instanceForAgent(agentId: string): string {
    try {
      const row = this._db?.prepare(
        'SELECT backend_instance_id FROM agents WHERE agent_id=? AND backend_type=?'
      ).get(agentId, 'hermes');
      return String(row?.backend_instance_id || agentId).trim() || agentId;
    } catch (_) {
      return agentId;
    }
  }

  async push(payload: PushPayload): Promise<void> {
    const { agentId, fromUid, content } = payload;
    const turnId = String(payload.turnId || payload.messageId || `hermes-cli-${Date.now()}`);
    const canResumeBinding = payload.providerBinding?.providerType === 'hermes'
      && /^hermes:[^:]+:.+/.test(payload.providerBinding.nativeSessionId);
    const sessionKey = canResumeBinding
      ? payload.providerBinding!.nativeSessionId
      : `hermes:${agentId}:${fromUid}`;
    const profileId = this._instanceForAgent(agentId);
    const channelId = payload.providerBinding?.channelId || payload.channelId || fromUid.replace(/^group:/, '');
    const channelType = payload.providerBinding?.channelType || (payload.channelType === 2 ? 2 : 1);
    if (!canResumeBinding && this._bindingStore) {
      this._bindingStore.saveManaged({
        agentId, channelId, channelType, providerType: 'hermes',
        providerInstanceId: profileId, nativeSessionId: sessionKey,
        deliveryMode: 'cli', adapterType: 'hermes-cli', expectedVersion: payload.providerBinding?.bindingVersion ?? 0,
      });
    }

    const deliveryContent = buildConversationDeliveryPrompt(
      this._db, payload, canResumeBinding, this._contextWindow,
    );
    const notification = _buildNotification(agentId, fromUid, deliveryContent);
    // Windows 下 -z 经 cmd.exe 传多行/含元字符的 notification 会被截断或注入，净化为单行
    const safeNotification = process.platform === 'win32' ? sanitizeCmdArg(notification) : notification;
    console.error(`[HermesCli] push agent=${agentId} visitor=${fromUid} session=selected`);

    try {
      const result = await runCli({
        cmd: 'hermes',
        args: ['--profile', profileId, '-z', safeNotification],
        tag: 'hermes-cli',
        timeout: 120000,
        logOutput: false,
      });

      if (result.code === 0) {
        const replyText = _extractReply(result.stdout);
        if (replyText) {
          this.emit('agent.reply', {
            agentId, visitorId: fromUid,
            content: replyText, done: true,
            sessionKey,
            turnId, replyId: turnId,
          });
          console.error(`[HermesCli] push OK agent=${agentId} reply=${replyText.length}chars`);
        } else {
          throw new Error('Hermes returned no reply text');
        }
      } else {
        throw new Error(`Hermes exited with code ${result.code}`);
      }
    } catch (err) {
      console.error(`[HermesCli] push 失败 agent=${agentId}: ${errorMessage(err)}`);
      throw err;
    }
  }

  async steer(agentId: string, visitorId: string, content: string, metadata?: { turnId?: string }): Promise<null> {
    const sessionKey = `hermes:${agentId}:${visitorId}`;
    const profileId = this._instanceForAgent(agentId);
    const turnId = String(metadata?.turnId || `hermes-cli-steer-${Date.now()}`);
    console.error(`[HermesCli] steer agent=${agentId} visitor=${visitorId}`);
    const notification = JSON.stringify({
      type: 'voko_owner_message',
      visitorId,
      sessionKey,
      content,
      safety: '此消息来自主人（可信任）。请按主人要求执行。',
    });
    try {
      const result = await runCli({
        cmd: 'hermes',
        args: ['--profile', profileId, '-z', notification],
        tag: 'hermes-cli',
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
        console.error(`[HermesCli] steer OK agent=${agentId} reply=${replyText.length}chars`);
      } else {
        console.error(`[HermesCli] steer OK agent=${agentId}`);
      }
    } catch (err) {
      console.error(`[HermesCli] steer 失败 agent=${agentId}: ${errorMessage(err)}`);
    }
    return null;
  }

  start() {}
  stop() {}
  healthCheck() { this._available = null; }
}

/**
 * 从 hermes CLI stdout 提取 agent 回复文本。
 * Hermes 的 stdout 可能包含日志头，取第一个非空的正文段落作为回复。
 */
function _extractReply(stdout: string): string | null {
  if (!stdout) return null;
  const lines = stdout.split('\n').map((line: string) => line.trim()).filter(Boolean);
  // 跳过明显的日志/元数据行
  const contentLines = lines.filter((line: string) =>
    !line.startsWith('[') &&
    !line.startsWith('{') &&
    !line.startsWith('收到') &&
    !line.startsWith('---') &&
    line.length > 2
  );
  if (contentLines.length > 0) return contentLines.join('\n').trim();
  // 兜底：取全部非空行的前 500 字
  return lines.join('\n').trim().slice(0, 500);
}

function _buildNotification(
  agentId: string,
  fromUid: string,
  content: string,
): string {
  let msg = `【访客消息】\n访客：${fromUid}\n消息：${content}`;
  msg += `\n\n当前 session: hermes:${agentId}:${fromUid}`;

  return msg;
}

module.exports = HermesCliProvider;
