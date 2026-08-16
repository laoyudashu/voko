import type { DatabaseSync } from 'node:sqlite';

type Direction = 'owner' | 'agent';

interface OwnerChatViewMessage {
  id: string;
  sequence: number;
  direction: Direction;
  contentType: number;
  payload: Record<string, unknown>;
  state: string;
  createdAt: number;
}

interface OwnerChatSummary {
  conversationId: string;
  messageCount: number;
  lastMessage: string;
  lastDirection: Direction;
  status: string;
  lastActivityAt: number;
}

function safeObject(value: unknown): Record<string, unknown> | null {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch (_) { return null; }
}

function safePayload(value: unknown): Record<string, unknown> {
  const payload = safeObject(value) || {};
  const result: Record<string, unknown> = {};
  if (typeof payload.text === 'string') result.text = payload.text;
  if (typeof payload.name === 'string') result.name = payload.name;
  if (typeof payload.mimeType === 'string') result.mimeType = payload.mimeType;
  if (Number.isFinite(Number(payload.size))) result.size = Number(payload.size);
  if (typeof payload.expiresAt === 'string') result.expiresAt = payload.expiresAt;
  if (typeof payload.downloadUrl === 'string') {
    try {
      const url = new URL(payload.downloadUrl);
      if (url.protocol === 'https:') result.downloadUrl = url.toString();
    } catch (_) {}
  }
  return result;
}

function parseReply(row: any): OwnerChatViewMessage | null {
  const envelope = safeObject(row.payload_json);
  if (!envelope || envelope.kind !== 'reply' || envelope.operation !== 'reply') return null;
  const payload = safePayload(envelope.payload);
  return {
    id: String(row.event_id || ''), sequence: Number(envelope.sequence) || 0, direction: 'agent',
    contentType: Number(envelope.contentType) || 1, payload, state: String(row.status || 'pending'),
    createdAt: Number(row.created_at) || 0,
  };
}

function preview(message: OwnerChatViewMessage): string {
  const text = String(message.payload.text || '').trim();
  if (text) return text;
  if (message.contentType === 2) return '[图片]';
  if (message.contentType === 3) return `[附件] ${String(message.payload.name || '')}`.trim();
  return '[消息]';
}

function statusFor(inboundState: string, replyState?: string): string {
  if (replyState === 'sent') return 'replied';
  if (replyState === 'outcome_unknown' || inboundState === 'outcome_unknown') return 'outcome_unknown';
  if (inboundState === 'failed_not_delivered') return 'failed';
  if (replyState === 'pending' || replyState === 'leased' || inboundState === 'persisted' || inboundState === 'leased' || inboundState === 'replied') return 'processing';
  return inboundState || 'processing';
}

class OwnerChatReadStore {
  constructor(private readonly db: DatabaseSync) {}

  countForAgent(localAgentId: string): number {
    const row = this.db.prepare('SELECT COUNT(DISTINCT conversation_id) AS count FROM owner_chat_messages WHERE local_agent_id=?').get(localAgentId) as any;
    return Number(row?.count) || 0;
  }

  listForAgent(localAgentId: string, limit = 10, offset = 0): OwnerChatSummary[] {
    const rows = this.db.prepare(`SELECT conversation_id,COUNT(*) AS message_count,MAX(updated_at) AS last_activity_at
      FROM owner_chat_messages WHERE local_agent_id=? GROUP BY conversation_id ORDER BY last_activity_at DESC LIMIT ? OFFSET ?`)
      .all(localAgentId,Math.max(1,Math.min(100,limit)),Math.max(0,offset)) as any[];
    return rows.map(row => {
      const messages = this.getTranscript(localAgentId,String(row.conversation_id));
      const last = messages[messages.length - 1];
      const inbound = [...messages].reverse().find(item => item.direction === 'owner');
      const reply = [...messages].reverse().find(item => item.direction === 'agent');
      return {
        conversationId: String(row.conversation_id), messageCount: messages.length,
        lastMessage: last ? preview(last) : '', lastDirection: last?.direction || 'owner',
        status: statusFor(inbound?.state || '',reply?.state),
        lastActivityAt: Math.max(Number(row.last_activity_at)||0,last?.createdAt||0),
      };
    }).sort((a,b)=>b.lastActivityAt-a.lastActivityAt);
  }

  getTranscript(localAgentId: string, conversationId: string): OwnerChatViewMessage[] {
    const inbound = this.db.prepare(`SELECT message_id,sequence,content_type,payload_json,state,created_at
      FROM owner_chat_messages WHERE local_agent_id=? AND conversation_id=? ORDER BY sequence,created_at,message_id`)
      .all(localAgentId,conversationId) as any[];
    if (!inbound.length) return [];
    const replies = this.db.prepare(`SELECT event_id,payload_json,status,created_at FROM owner_chat_outbox
      WHERE local_agent_id=? AND conversation_id=? ORDER BY created_at,event_id`).all(localAgentId,conversationId) as any[];
    const result: OwnerChatViewMessage[] = inbound.map(row => ({
      id:String(row.message_id),sequence:Number(row.sequence)||0,direction:'owner',contentType:Number(row.content_type)||1,
      payload:safePayload(row.payload_json),state:String(row.state||'persisted'),createdAt:Number(row.created_at)||0,
    }));
    for (const row of replies) { const reply=parseReply(row); if(reply)result.push(reply); }
    return result.sort((a,b)=>a.sequence-b.sequence||(a.direction===b.direction?0:a.direction==='owner'?-1:1)||a.createdAt-b.createdAt||a.id.localeCompare(b.id));
  }
}

export { OwnerChatReadStore };
export type { OwnerChatSummary, OwnerChatViewMessage };
