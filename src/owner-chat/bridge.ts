import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { parseOwnerChatEnvelope, verifyOwnerChatEnvelope } from './envelope';
import { createOwnerExecutionContext } from './execution';

interface BridgeOptions { database: DatabaseSync; resolvePublicKey: (keyId: string) => crypto.KeyLike|null;
  matchesAgentId: (localAgentId: string, remoteAgentId: string) => boolean; onMessage?: (messageId: string) => unknown;
  onControl?: (control: { localAgentId: string; conversationId: string; operation: string; payload: Record<string,unknown> }) => unknown; now?: () => number; }

class OwnerChatBridge {
  private handler: ((messageId: string) => unknown) | null;
  private controlHandler: BridgeOptions['onControl'] | null;
  constructor(private readonly options: BridgeOptions) { this.handler = options.onMessage || null; this.controlHandler=options.onControl||null; }
  setMessageHandler(handler: ((messageId: string) => unknown) | null): void { this.handler = handler; }
  setControlHandler(handler: BridgeOptions['onControl'] | null): void { this.controlHandler=handler; }
  handle(localAgentId: string, message: any): { handled: boolean; accepted?: boolean; code?: string } {
    const fromUid = String(message?.fromUid || '');
    if (!fromUid.startsWith('owner_')) return { handled: false };
    try {
      if (JSON.parse(String(message?.content || '')).version !== 'voko.owner.chat/1') return { handled: false };
    } catch (_) { return { handled: false }; }
    let envelope: any = null; const now = this.options.now?.() ?? Date.now();
    try {
      envelope = parseOwnerChatEnvelope(String(message?.content || ''), now);
      if (!['message','control'].includes(envelope.kind)) throw new Error('OWNER_CHAT_DIRECTION_INVALID');
      if (envelope.ownerImUid !== fromUid || !this.options.matchesAgentId(localAgentId, envelope.agentId)) throw new Error('OWNER_CHAT_BINDING_INVALID');
      if (message.clientMsgNo && message.clientMsgNo !== envelope.messageId) throw new Error('OWNER_CHAT_TRANSPORT_ID_INVALID');
      if (!verifyOwnerChatEnvelope(envelope, this.options.resolvePublicKey, now)) throw new Error('OWNER_CHAT_SIGNATURE_INVALID');
      if (envelope.kind === 'control') {
        const existing = this.options.database.prepare('SELECT message_id,payload_digest FROM owner_chat_control_events WHERE message_id=? OR (conversation_id=? AND sequence=?) LIMIT 1')
          .get(envelope.messageId,envelope.conversationId,envelope.sequence) as any;
        if (existing) {
          if (existing.message_id!==envelope.messageId||existing.payload_digest!==envelope.payloadDigest) throw new Error('OWNER_CHAT_REPLAY_CONFLICT');
          return {handled:true,accepted:true};
        }
        this.options.database.prepare(`INSERT INTO owner_chat_control_events
          (message_id,conversation_id,owner_im_uid,local_agent_id,sequence,operation,payload_json,payload_digest,created_at)
          VALUES(?,?,?,?,?,?,?,?,?)`).run(envelope.messageId,envelope.conversationId,envelope.ownerImUid,localAgentId,
          envelope.sequence,envelope.operation,JSON.stringify(envelope.payload),envelope.payloadDigest,now);
        queueMicrotask(()=>void Promise.resolve(this.controlHandler?.({localAgentId,conversationId:envelope.conversationId,
          operation:envelope.operation,payload:envelope.payload})).catch(()=>{}));
        return {handled:true,accepted:true};
      }
      const existing = this.options.database.prepare(`SELECT message_id,payload_digest FROM owner_chat_messages
        WHERE message_id=? OR (conversation_id=? AND (sequence=? OR client_message_id=?)) LIMIT 1`)
        .get(envelope.messageId,envelope.conversationId,envelope.sequence,envelope.clientMessageId) as any;
      if (existing) {
        if (existing.message_id !== envelope.messageId || existing.payload_digest !== envelope.payloadDigest) throw new Error('OWNER_CHAT_REPLAY_CONFLICT');
        const conversation = envelope.conversationId.length > 12 ? `${envelope.conversationId.slice(0, 12)}...` : envelope.conversationId;
        const messageId = envelope.messageId.length > 12 ? `${envelope.messageId.slice(0, 12)}...` : envelope.messageId;
        console.log(`[Owner Chat] 收到消息: Agent=${localAgentId} Conversation=${conversation} Message=${messageId} Type=${envelope.contentType} Sequence=${envelope.sequence} Status=duplicate`);
        return { handled: true, accepted: true };
      }
      const executionContext = createOwnerExecutionContext({ conversationId: envelope.conversationId,
        messageId: envelope.messageId, ownershipEpoch: envelope.ownershipEpoch,
        conversationEpoch: envelope.conversationEpoch,
        config: { remoteAgentId: envelope.agentId, localAgentId } });
      this.options.database.exec('BEGIN IMMEDIATE');
      try {
      this.options.database.prepare(`INSERT INTO owner_chat_messages
        (message_id,client_message_id,conversation_id,owner_identity_id,owner_im_uid,agent_id,local_agent_id,
         ownership_epoch,conversation_epoch,sequence,content_type,payload_json,payload_digest,state,execution_state,
         execution_context_json,policy_epoch,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'persisted','PERSISTED',?,1,?,?)`).run(envelope.messageId,envelope.clientMessageId,envelope.conversationId,
        envelope.ownerIdentityId,envelope.ownerImUid,envelope.agentId,localAgentId,envelope.ownershipEpoch,envelope.conversationEpoch,
        envelope.sequence,envelope.contentType,JSON.stringify(envelope.payload),envelope.payloadDigest,JSON.stringify(executionContext),now,now);
      const event = (from: string|null, to: string, suffix: string) => this.options.database.prepare(`INSERT INTO owner_chat_execution_events
        (event_id,message_id,from_state,to_state,created_at) VALUES(?,?,?,?,?)`)
        .run(`owexec_${envelope.messageId}_${suffix}`,envelope.messageId,from,to,now);
      event(null,'RECEIVED','received'); event('RECEIVED','VERIFIED','verified'); event('VERIFIED','PERSISTED','persisted');
      this.options.database.exec('COMMIT');
      } catch (error) { this.options.database.exec('ROLLBACK'); throw error; }
      const conversation = envelope.conversationId.length > 12 ? `${envelope.conversationId.slice(0, 12)}...` : envelope.conversationId;
      const messageId = envelope.messageId.length > 12 ? `${envelope.messageId.slice(0, 12)}...` : envelope.messageId;
      console.log(`[Owner Chat] 收到消息: Agent=${localAgentId} Conversation=${conversation} Message=${messageId} Type=${envelope.contentType} Sequence=${envelope.sequence} Status=accepted`);
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
