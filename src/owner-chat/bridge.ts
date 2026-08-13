import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { parseOwnerChatEnvelope, verifyOwnerChatEnvelope } from './envelope';

interface BridgeOptions { database: DatabaseSync; resolvePublicKey: (keyId: string) => crypto.KeyLike|null;
  matchesAgentId: (localAgentId: string, remoteAgentId: string) => boolean; onMessage?: (messageId: string) => unknown; now?: () => number; }

class OwnerChatBridge {
  private handler: ((messageId: string) => unknown) | null;
  constructor(private readonly options: BridgeOptions) { this.handler = options.onMessage || null; }
  setMessageHandler(handler: ((messageId: string) => unknown) | null): void { this.handler = handler; }
  handle(localAgentId: string, message: any): { handled: boolean; accepted?: boolean; code?: string } {
    const fromUid = String(message?.fromUid || '');
    if (!fromUid.startsWith('owner_')) return { handled: false };
    try {
      if (JSON.parse(String(message?.content || '')).version !== 'voko.owner.chat/1') return { handled: false };
    } catch (_) { return { handled: false }; }
    let envelope: any = null; const now = this.options.now?.() ?? Date.now();
    try {
      envelope = parseOwnerChatEnvelope(String(message?.content || ''), now);
      if (envelope.kind !== 'message' || envelope.operation !== 'message') throw new Error('OWNER_CHAT_DIRECTION_INVALID');
      if (envelope.ownerImUid !== fromUid || !this.options.matchesAgentId(localAgentId, envelope.agentId)) throw new Error('OWNER_CHAT_BINDING_INVALID');
      if (message.clientMsgNo && message.clientMsgNo !== envelope.messageId) throw new Error('OWNER_CHAT_TRANSPORT_ID_INVALID');
      if (!verifyOwnerChatEnvelope(envelope, this.options.resolvePublicKey, now)) throw new Error('OWNER_CHAT_SIGNATURE_INVALID');
      const existing = this.options.database.prepare(`SELECT message_id,payload_digest FROM owner_chat_messages
        WHERE message_id=? OR (conversation_id=? AND (sequence=? OR client_message_id=?)) LIMIT 1`)
        .get(envelope.messageId,envelope.conversationId,envelope.sequence,envelope.clientMessageId) as any;
      if (existing) {
        if (existing.message_id !== envelope.messageId || existing.payload_digest !== envelope.payloadDigest) throw new Error('OWNER_CHAT_REPLAY_CONFLICT');
        return { handled: true, accepted: true };
      }
      this.options.database.prepare(`INSERT INTO owner_chat_messages
        (message_id,client_message_id,conversation_id,owner_identity_id,owner_im_uid,agent_id,local_agent_id,
         ownership_epoch,conversation_epoch,sequence,content_type,payload_json,payload_digest,state,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'persisted',?,?)`).run(envelope.messageId,envelope.clientMessageId,envelope.conversationId,
        envelope.ownerIdentityId,envelope.ownerImUid,envelope.agentId,localAgentId,envelope.ownershipEpoch,envelope.conversationEpoch,
        envelope.sequence,envelope.contentType,JSON.stringify(envelope.payload),envelope.payloadDigest,now,now);
      queueMicrotask(() => void Promise.resolve(this.handler?.(envelope.messageId)).catch(() => {}));
      return { handled: true, accepted: true };
    } catch (error: any) {
      const code = /^OWNER_CHAT_[A-Z0-9_]+$/.test(String(error?.message)) ? error.message : 'OWNER_CHAT_REJECTED';
      this.options.database.prepare(`INSERT INTO owner_chat_security_events(code,message_id,conversation_id,agent_id,created_at) VALUES(?,?,?,?,?)`)
        .run(code,envelope?.messageId||null,envelope?.conversationId||null,localAgentId,now);
      return { handled: true, accepted: false, code };
    }
  }
}

export { OwnerChatBridge };
