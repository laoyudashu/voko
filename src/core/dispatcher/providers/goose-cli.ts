const path = require('path');
const { PushProvider } = require('../base-provider');
const { runCli, checkCliAvailable } = require('../../adapters/cli-spawner');
const { resolveGooseCommand } = require('../goose-command');
import type { DatabaseLike } from '../../../types/database';
import type { AgentMeta, PushPayload } from '../types';

export interface GooseCliOptions {
  binPath?: string;
  db?: Pick<DatabaseLike, 'prepare'> | null;
  contextWindow?: number;
}

interface ContextMessage {
  content: string;
  is_me: number;
  timestamp: number;
}

interface GooseContent {
  type?: string;
  text?: string;
}

interface GooseMessage {
  role?: string;
  content?: GooseContent[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class GooseCliProvider extends PushProvider {
  constructor(options: GooseCliOptions = {}) {
    super();
    this._available = null;
    this._binPath = options.binPath || resolveGooseCommand();
    this._db = options.db || null;
    this._contextWindow = options.contextWindow ?? 0;
  }

  get priority() { return 1; }

  match(_agentId: string, meta?: AgentMeta | null): boolean {
    const bt = meta?.backend_type;
    return bt === 'goose' || bt === 'goose-ai' || bt === 'goose-acp';
  }

  isAvailable(_agentId: string): boolean {
    if (this._available !== null) return this._available;
    this._available = checkCliAvailable(this._binPath);
    return this._available;
  }

  async push(payload: PushPayload): Promise<void> {
    const { agentId, fromUid, content } = payload;
    const turnId = String(payload.turnId || payload.messageId || `goose-cli-${Date.now()}`);
    const sessionKey = `goose:${agentId}:${fromUid}`;
    const sessionName = `goose:${agentId}:${fromUid}`;

    // 取上下文
    let contextMsgs: ContextMessage[] = [];
    if (payload.channelType !== 2 && this._contextWindow > 0 && this._db) {
      try {
        contextMsgs = (this._db.prepare(
          `SELECT content, is_me, timestamp FROM messages WHERE channel_id=? AND agent_id=? AND content_type!=11 ORDER BY timestamp DESC LIMIT ?`
        ).all(fromUid, agentId, this._contextWindow) as ContextMessage[]).reverse();
      } catch (_) {}
    }

    let notification = `session: goose:${agentId}:${fromUid}\n\n【访客最新消息】\n${content}`;
    if (contextMsgs && contextMsgs.length > 0) {
      notification += `\n\n【最近对话】\n${contextMsgs.map((m: ContextMessage, i: number) => {
        const role = m.is_me >= 1 ? 'Agent' : '访客';
        return `[${i + 1}] ${role}: ${m.content}`;
      }).join('\n')}`;
    }
    const hasSession = this._db ? !!this._db.prepare(
      `SELECT 1 FROM agent_session_handles WHERE agent_id=? AND visitor_id=? AND adapter_type='goose'`
    ).get(agentId, fromUid) : false;

    const args = ['run', '-i', '-', '--name', sessionName, '--quiet', '--output-format', 'json'];
    if (hasSession) args.push('--resume');

    console.error(`[GooseCli] push agent=${agentId} visitor=${fromUid} ${hasSession ? 'resume' : 'new'}`);
    try {
      const result = await runCli({
        cmd: this._binPath,
        args,
        stdinInput: notification,
        tag: 'goose-cli',
        timeout: 180000,
        onStderrLine: (line: string) => console.error(`[GooseCli] ${line}`),
      });

      if (!hasSession && this._db && result.code === 0) {
        try {
          this._db.prepare(
            `INSERT OR REPLACE INTO agent_session_handles (agent_id, visitor_id, adapter_type, session_handle, updated_at) VALUES (?, ?, 'goose', ?, ?)`
          ).run(agentId, fromUid, sessionName, Date.now());
        } catch {}
      }

      const replyText = _extractReply(result.stdout);
      if (replyText) {
        this.emit('agent.reply', {
          agentId, visitorId: fromUid,
          content: replyText, done: true,
          sessionKey,
          turnId, replyId: turnId,
        });
        console.error(`[GooseCli] push OK agent=${agentId} reply=${replyText.length}chars`);
      } else {
        console.error(`[GooseCli] push OK agent=${agentId}（无回复文本）`);
      }
    } catch (err) {
      console.error(`[GooseCli] push 失败 agent=${agentId}: ${errorMessage(err)}`);
    }
  }

  async steer(agentId: string, visitorId: string, content: string, metadata?: { turnId?: string }): Promise<void> {
    const messageId = metadata?.turnId || `steer-${Date.now()}`;
    return this.push({ agentId, fromUid: visitorId, content, messageId, turnId: messageId, timestamp: Date.now() });
  }

  start() { this._available = null; }
  stop() {}
  healthCheck() { this._available = null; }
}

function _extractReply(stdout: string): string | null {
  if (!stdout) return null;
  try {
    const parsed = JSON.parse(stdout) as { messages?: GooseMessage[] };
    const msgs = parsed.messages || [];
    // 从最后一条 assistant 消息提取文本
    const assistants = msgs.filter((m: GooseMessage) => m.role === 'assistant');
    const last = assistants[assistants.length - 1];
    if (last && Array.isArray(last.content)) {
      const texts = last.content
        .filter((c: GooseContent) => c.type === 'text')
        .map((c: GooseContent) => c.text)
        .filter((text): text is string => Boolean(text));
      if (texts.length > 0) return texts.join('\n').trim();
    }
  } catch {}
  return null;
}

module.exports = GooseCliProvider;
