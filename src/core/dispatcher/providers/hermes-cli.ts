const { PushProvider } = require('../base-provider');
const { runCli, checkCliAvailable, sanitizeCmdArg } = require('../../adapters/cli-spawner');
import type { DatabaseLike } from '../../../types/database';
import type { AgentMeta, PushPayload } from '../types';

interface HermesCliOptions {
  contextWindow?: number;
  db?: Pick<DatabaseLike, 'prepare'> | null;
}

interface ContextMessage {
  content: string;
  is_me: number;
  timestamp: number;
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
 * - 上下文窗口（contextWindow 参数）
 */
class HermesCliProvider extends PushProvider {
  /**
   * @param {object} [options]
   * @param {number} [options.contextWindow=0] - 推送时附带的上下文条数
   * @param {object} [options.db] - better-sqlite3 实例
   */
  constructor(options: HermesCliOptions = {}) {
    super();
    this._contextWindow = options.contextWindow ?? 0;
    this._db = options.db || null;
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

  async push(payload: PushPayload): Promise<void> {
    const { agentId, fromUid, content } = payload;
    const turnId = String(payload.turnId || payload.messageId || `hermes-cli-${Date.now()}`);
    const sessionKey = `hermes:${agentId}:${fromUid}`;

    // 取上下文
    let contextMsgs: ContextMessage[] = [];
    if (payload.channelType !== 2 && this._contextWindow > 0 && this._db) {
      try {
        contextMsgs = (this._db.prepare(
          `SELECT content, is_me, timestamp FROM messages WHERE channel_id=? AND agent_id=? AND content_type!=11 ORDER BY timestamp DESC LIMIT ?`
        ).all(fromUid, agentId, this._contextWindow) as ContextMessage[]).reverse();
      } catch (_) {}
    }

    const notification = _buildNotification(agentId, fromUid, content, contextMsgs);
    // Windows 下 -z 经 cmd.exe 传多行/含元字符的 notification 会被截断或注入，净化为单行
    const safeNotification = process.platform === 'win32' ? sanitizeCmdArg(notification) : notification;
    console.error(`[HermesCli] push agent=${agentId} visitor=${fromUid} sessionKey=${sessionKey}`);

    try {
      const result = await runCli({
        cmd: 'hermes',
        args: ['--profile', agentId, '-z', safeNotification],
        tag: 'hermes-cli',
        timeout: 120000,
        onStderrLine: (line: string) => {
          if (line.startsWith("[agent/embedded] [trace:") || line.startsWith("[sessions/store]")) return;
          console.error(`[HermesCli] ${line}`);
        },
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
          console.error(`[HermesCli] push OK agent=${agentId}（无回复文本）`);
        }
      } else {
        console.error(`[HermesCli] push 失败 agent=${agentId}: exit code ${result.code}`);
      }
    } catch (err) {
      console.error(`[HermesCli] push 失败 agent=${agentId}: ${errorMessage(err)}`);
    }
  }

  async steer(agentId: string, visitorId: string, content: string, metadata?: { turnId?: string }): Promise<null> {
    const sessionKey = `hermes:${agentId}:${visitorId}`;
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
        args: ['--profile', agentId, '-z', notification],
        tag: 'hermes-cli',
        timeout: 120000,
        onStderrLine: (line: string) => {
          if (line.startsWith("[agent/embedded] [trace:") || line.startsWith("[sessions/store]")) return;
          console.error(`[HermesCli] ${line}`);
        },
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
  contextMsgs: ContextMessage[],
): string {
  let msg = `【访客消息】\n访客：${fromUid}\n消息：${content}`;

  if (contextMsgs && contextMsgs.length > 0) {
    msg += `\n\n【最近对话】\n${contextMsgs.map((m: ContextMessage, i: number) => {
      const role = m.is_me >= 1 ? '你' : '访客';
      return `[${i + 1}] ${role}: ${m.content}`;
    }).join('\n')}`;
  }

  msg += `\n\n当前 session: hermes:${agentId}:${fromUid}`;

  return msg;
}

module.exports = HermesCliProvider;
