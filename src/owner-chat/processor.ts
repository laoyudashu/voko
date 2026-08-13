import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { signOwnerChatEnvelope } from './envelope';

interface ProcessorOptions {
  database: DatabaseSync;
  dispatcher: any;
  resolveAgentIdentity: (localAgentId: string) => { privateKey: crypto.KeyLike; keyId?: string; imUid: string } | null;
  now?: () => number;
}

class OwnerChatProcessor {
  constructor(private readonly options: ProcessorOptions) {}
  async process(messageId: string): Promise<{ status: string }> {
    const db = this.options.database; const now = this.options.now?.() ?? Date.now();
    const row = db.prepare('SELECT * FROM owner_chat_messages WHERE message_id=?').get(messageId) as any;
    if (!row || row.state !== 'persisted') return { status: row?.state || 'not_found' };
    const lease = `owner-chat-${crypto.randomUUID()}`;
    const claimed = db.prepare(`UPDATE owner_chat_messages SET state='leased',lease_owner=?,lease_expires_at=?,updated_at=?
      WHERE message_id=? AND state='persisted'`).run(lease,now+150000,now,messageId) as any;
    if (Number(claimed.changes || 0) !== 1) return { status: 'not_claimed' };
    const payload = JSON.parse(row.payload_json); const content = Number(row.content_type) === 1 ? String(payload.text || '')
      : `${Number(row.content_type) === 2 ? '[图片]' : '[附件]'} ${String(payload.name || 'attachment')} (${Number(payload.size || 0)} bytes, ${String(payload.mimeType || 'application/octet-stream')})\n${String(payload.downloadUrl || '')}${payload.text ? `\n${String(payload.text)}` : ''}`;
    const identity = this.options.resolveAgentIdentity(row.local_agent_id);
    if (!identity) { db.prepare("UPDATE owner_chat_messages SET state='failed_not_delivered',updated_at=? WHERE message_id=? AND lease_owner=?").run(now,messageId,lease); return { status: 'identity_missing' }; }
    const binding = db.prepare("SELECT * FROM owner_chat_bindings WHERE conversation_id=? AND status='active'").get(row.conversation_id) as any;
    try {
      const result = await this.options.dispatcher.executeIsolated({
        agentId: row.local_agent_id, taskId: row.message_id, contextId: row.conversation_id, content,
        binding: binding ? {
          id: `owner-chat:${row.conversation_id}`, bindingVersion: Number(binding.binding_version), providerType: binding.provider_type,
          providerInstanceId: binding.provider_instance_id || null, deliveryMode: binding.delivery_mode, adapterType: binding.adapter_type,
          nativeSessionId: binding.native_session_id, sessionOrigin: 'voko_managed', channelId: row.conversation_id,
          channelType: 1, sourceScope: 'trusted_owner', strictSessionRoute: true,
        } : null,
        sourceType: 'owner_chat', executionScope: 'owner_chat', timeoutMs: 120000,
      });
      const receipt = result.receipt?.deliveryReceipt || result.receipt || {}; const provider = result.receipt?.provider || {};
      if (!binding && receipt.nativeSessionId) {
        db.prepare(`INSERT INTO owner_chat_bindings(conversation_id,agent_id,provider_type,provider_instance_id,adapter_type,delivery_mode,native_session_id,binding_version,status,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,1,'active',?,?)`).run(row.conversation_id,row.local_agent_id,String(provider.providerType||''),String(receipt.providerInstanceId||''),
          String(provider.providerId||''),String(provider.deliveryMode||receipt.deliveryMode||''),String(receipt.nativeSessionId),now,now);
      }
      const eventId = `owchat_evt_${crypto.randomBytes(18).toString('base64url')}`; const created = new Date(now);
      const envelope = signOwnerChatEnvelope({ version:'voko.owner.chat/1',kind:'reply',messageId:eventId,clientMessageId:eventId,
        conversationId:row.conversation_id,ownerIdentityId:row.owner_identity_id,ownerImUid:row.owner_im_uid,agentId:row.agent_id,
        ownershipEpoch:Number(row.ownership_epoch),conversationEpoch:Number(row.conversation_epoch),sequence:Number(row.sequence),
        operation:'reply',contentType:1,payload:{ replyToMessageId:row.message_id,text:String(result.reply?.content||'') },
        keyId:String(identity.keyId||row.local_agent_id),createdAt:created.toISOString(),expiresAt:new Date(now+86400000).toISOString() },identity.privateKey);
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare("UPDATE owner_chat_messages SET state='replied',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE message_id=? AND lease_owner=?").run(now,messageId,lease);
        db.prepare(`INSERT INTO owner_chat_outbox(event_id,message_id,conversation_id,agent_id,local_agent_id,owner_im_uid,payload_json,status,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,'pending',?,?)`).run(eventId,messageId,row.conversation_id,row.agent_id,row.local_agent_id,row.owner_im_uid,JSON.stringify(envelope),now,now);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return { status: 'replied' };
    } catch (error: any) {
      const outcome = String(error?.deliveryOutcome || 'outcome_unknown');
      db.prepare('UPDATE owner_chat_messages SET state=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE message_id=? AND lease_owner=?')
        .run(outcome === 'not_delivered' ? 'failed_not_delivered' : 'outcome_unknown',Date.now(),messageId,lease);
      return { status: outcome };
    }
  }
}

export { OwnerChatProcessor };
