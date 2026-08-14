import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { signOwnerChatEnvelope } from './envelope';
import { createOwnerExecutionContext, transitionOwnerExecution } from './execution';
import { readOwnerChatPolicy } from './policy';
import { appendOwnerChatIoEvent } from './database';

interface ProcessorOptions {
  database: DatabaseSync;
  dispatcher: any;
  resolveAgentIdentity: (localAgentId: string) => { privateKey: crypto.KeyLike; keyId?: string; imUid: string } | null;
  now?: () => number;
}

class OwnerChatProcessor {
  private readonly queues = new Map<string, Promise<{status:string}>>();
  constructor(private readonly options: ProcessorOptions) {}
  async process(messageId: string): Promise<{ status: string }> {
    const row=this.options.database.prepare('SELECT conversation_id FROM owner_chat_messages WHERE message_id=?').get(messageId) as any;
    if(!row?.conversation_id)return {status:'not_found'};
    const key=String(row.conversation_id);const previous=this.queues.get(key)||Promise.resolve({status:'idle'});
    const current=previous.catch(()=>({status:'failed'})).then(()=>this.processOne(messageId));
    this.queues.set(key,current);try{return await current;}finally{if(this.queues.get(key)===current)this.queues.delete(key);}
  }
  private async processOne(messageId: string): Promise<{ status: string }> {
    const db = this.options.database; const now = this.options.now?.() ?? Date.now();
    const row = db.prepare('SELECT * FROM owner_chat_messages WHERE message_id=?').get(messageId) as any;
    if (!row || row.execution_state !== 'PERSISTED') return { status: row?.state || 'not_found' };
    const policy = readOwnerChatPolicy(db);
    if (!policy.ownerChatEnabled) { transitionOwnerExecution(db, { messageId, from: 'PERSISTED', to: 'REVOKED',
      reasonCode: 'OWNER_CHAT_DISABLED' }); return { status: 'revoked' }; }
    if (Number(row.content_type) !== 1) { transitionOwnerExecution(db, { messageId, from: 'PERSISTED',
      to: 'FAILED_NOT_DELIVERED', reasonCode: 'OWNER_ATTACHMENT_EXECUTION_DISABLED' }); return { status: 'attachment_disabled' }; }
    const lease = `owner-chat-${crypto.randomUUID()}`;
    if (!transitionOwnerExecution(db, { messageId, from: 'PERSISTED', to: 'DISPATCH_RESERVED', at: now,
      leaseOwner: lease, leaseExpiresAt: now + 150000 })) return { status: 'not_claimed' };
    const payload = JSON.parse(row.payload_json); const content = Number(row.content_type) === 1 ? String(payload.text || '')
      : `${Number(row.content_type) === 2 ? '[图片]' : '[附件]'} ${String(payload.name || 'attachment')} (${Number(payload.size || 0)} bytes, ${String(payload.mimeType || 'application/octet-stream')})\n${String(payload.downloadUrl || '')}${payload.text ? `\n${String(payload.text)}` : ''}`;
    const identity = this.options.resolveAgentIdentity(row.local_agent_id);
    if (!identity) { transitionOwnerExecution(db, { messageId, from: 'DISPATCH_RESERVED', to: 'FAILED_NOT_DELIVERED',
      at: now, reasonCode: 'OWNER_IDENTITY_MISSING' }); return { status: 'identity_missing' }; }
    const renewLease = () => {
      const renewedAt = Date.now();
      db.prepare(`UPDATE owner_chat_messages SET lease_expires_at=?,updated_at=?
        WHERE message_id=? AND execution_state='DISPATCH_RESERVED' AND lease_owner=?`).run(renewedAt+150000,renewedAt,messageId,lease);
    };
    const leaseTimer = setInterval(renewLease, 30000); leaseTimer.unref?.();
    const binding = db.prepare("SELECT * FROM owner_chat_bindings WHERE conversation_id=? AND status='active'").get(row.conversation_id) as any;
    const unsubscribeIo = this.options.dispatcher.subscribeOwnerIoEvents?.((event: Record<string, any>) => {
      if (event.messageId !== row.message_id || event.conversationId !== row.conversation_id) return;
      const localSequence=appendOwnerChatIoEvent(db,event);
      const eventId=`owchat_evt_${crypto.randomBytes(18).toString('base64url')}`;const at=Number(event.occurredAt||Date.now());
      const operation=event.type==='turn.started'?'accepted':event.type==='turn.failed'?'failed':'working';
      const source=event.payload&&typeof event.payload==='object'?event.payload:{};
      const payload:any={replyToMessageId:row.message_id,eventType:String(event.type||'status'),eventSequence:localSequence};
      if(event.turnId)payload.turnId=String(event.turnId).slice(0,128);
      if(typeof source.delta==='string')payload.delta=source.delta.slice(0,4000);
      for(const key of ['status','approvalId','kind','command','cwd','reason','decision','itemId'])if(source[key]!=null)payload[key]=String(source[key]).slice(0,1000);
      if(Array.isArray(source.availableDecisions))payload.availableDecisions=source.availableDecisions.map(String).slice(0,8);
      if(source.item&&typeof source.item==='object')payload.item={id:String(source.item.id||'').slice(0,128),type:String(source.item.type||'').slice(0,64),status:String(source.item.status||'').slice(0,64)};
      const envelope=signOwnerChatEnvelope({version:'voko.owner.chat/1',kind:'event',messageId:eventId,clientMessageId:eventId,
        conversationId:row.conversation_id,ownerIdentityId:row.owner_identity_id,ownerImUid:row.owner_im_uid,agentId:row.agent_id,
        ownershipEpoch:Number(row.ownership_epoch),conversationEpoch:Number(row.conversation_epoch),sequence:localSequence,
        operation,contentType:1,payload,keyId:String(identity.keyId||row.local_agent_id),createdAt:new Date(at).toISOString(),
        expiresAt:new Date(at+86400000).toISOString()},identity.privateKey);
      db.prepare(`INSERT INTO owner_chat_outbox(event_id,message_id,conversation_id,agent_id,local_agent_id,owner_im_uid,payload_json,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,'pending',?,?)`).run(eventId,row.message_id,row.conversation_id,row.agent_id,row.local_agent_id,row.owner_im_uid,JSON.stringify(envelope),at,at);
    }) || (() => {});
    try {
      const transport = this.options.dispatcher.getOwnerTransportStatus(row.local_agent_id);
      if (!transport?.available) { const error: any = new Error(String(transport?.code || 'OWNER_RUNTIME_UNSUPPORTED'));
        error.deliveryOutcome='not_delivered';error.code=String(transport?.code||'OWNER_RUNTIME_UNSUPPORTED');throw error; }
      if (transport.execution === 'workspace_write' && !policy.remoteExecutionEnabled) { const error:any=new Error('OWNER_REMOTE_EXECUTION_DISABLED');
        error.deliveryOutcome='not_delivered';error.code='OWNER_REMOTE_EXECUTION_DISABLED';throw error; }
      const ownerExecutionContext = createOwnerExecutionContext({ conversationId:row.conversation_id,messageId:row.message_id,
        ownershipEpoch:Number(row.ownership_epoch),conversationEpoch:Number(row.conversation_epoch),policyEpoch:policy.policyEpoch,
        providerId:String(transport.providerId),providerInstanceId:transport.providerInstanceId||null,
        isolation:transport.isolation,config:{providerId:transport.providerId,providerType:transport.providerType,
          providerInstanceId:transport.providerInstanceId||null,deliveryMode:transport.deliveryMode,execution:transport.execution,
          isolation:transport.isolation,platform:transport.platform} });
      if (ownerExecutionContext.configDigest !== transport.configDigest) throw new Error('OWNER_POLICY_DIGEST_MISMATCH');
      db.prepare(`UPDATE owner_chat_messages SET execution_context_json=?,policy_epoch=?,updated_at=?
        WHERE message_id=? AND execution_state='DISPATCH_RESERVED' AND lease_owner=?`)
        .run(JSON.stringify(ownerExecutionContext),policy.policyEpoch,Date.now(),messageId,lease);
      const result = await this.options.dispatcher.executeOwner({
        agentId: row.local_agent_id, taskId: row.message_id, contextId: row.conversation_id, content,
        binding: binding ? {
          id: `owner-chat:${row.conversation_id}`, bindingVersion: Number(binding.binding_version), providerType: binding.provider_type,
          providerInstanceId: binding.provider_instance_id || null, deliveryMode: binding.delivery_mode, adapterType: binding.adapter_type,
          nativeSessionId: binding.native_session_id, sessionOrigin: 'voko_managed', channelId: row.conversation_id,
          channelType: 1, sourceScope: 'trusted_owner', strictSessionRoute: true,
        } : null,
        sourceType: 'owner_chat', executionScope: 'owner_chat', ownerExecutionContext, timeoutMs: 600000,
        onProviderAccepted: () => transitionOwnerExecution(db, { messageId, from: 'DISPATCH_RESERVED',
          to: 'PROVIDER_ACCEPTED', leaseOwner: lease, leaseExpiresAt: Date.now() + 150000 }),
      });
      const receipt = result.receipt?.deliveryReceipt || result.receipt || {}; const provider = result.receipt?.provider || {};
      if (!binding && receipt.nativeSessionId) {
        db.prepare(`INSERT INTO owner_chat_bindings(conversation_id,agent_id,provider_type,provider_instance_id,adapter_type,delivery_mode,native_session_id,binding_version,status,authority_scope,policy_digest,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,1,'active','verified_owner_conversation',?,?,?)`).run(row.conversation_id,row.local_agent_id,String(provider.providerType||''),String(receipt.providerInstanceId||''),
          String(provider.providerId||''),String(provider.deliveryMode||receipt.deliveryMode||''),String(receipt.nativeSessionId),ownerExecutionContext.configDigest,now,now);
      } else if (binding && receipt.nativeSessionId) {
        const updated = db.prepare(`UPDATE owner_chat_bindings SET provider_type=?,provider_instance_id=?,adapter_type=?,delivery_mode=?,
          native_session_id=?,binding_version=binding_version+1,policy_digest=?,updated_at=?
          WHERE conversation_id=? AND binding_version=? AND status='active'`).run(String(provider.providerType||binding.provider_type),
          String(receipt.providerInstanceId||''),String(provider.providerId||receipt.adapterType||binding.adapter_type),
          String(provider.deliveryMode||receipt.deliveryMode||binding.delivery_mode),String(receipt.nativeSessionId),
          ownerExecutionContext.configDigest,Date.now(),row.conversation_id,Number(binding.binding_version));
        if (Number(updated.changes||0)!==1) throw new Error('OWNER_BINDING_UPDATE_CONFLICT');
      }
      const eventId = `owchat_evt_${crypto.randomBytes(18).toString('base64url')}`; const created = new Date(now);
      const envelope = signOwnerChatEnvelope({ version:'voko.owner.chat/1',kind:'reply',messageId:eventId,clientMessageId:eventId,
        conversationId:row.conversation_id,ownerIdentityId:row.owner_identity_id,ownerImUid:row.owner_im_uid,agentId:row.agent_id,
        ownershipEpoch:Number(row.ownership_epoch),conversationEpoch:Number(row.conversation_epoch),sequence:Number(row.sequence),
        operation:'reply',contentType:1,payload:{ replyToMessageId:row.message_id,text:String(result.reply?.content||'') },
        keyId:String(identity.keyId||row.local_agent_id),createdAt:created.toISOString(),expiresAt:new Date(now+86400000).toISOString() },identity.privateKey);
      if (!transitionOwnerExecution(db, { messageId, from: 'PROVIDER_ACCEPTED', to: 'COMPLETED', at: now,
        afterTransition: () => {
        db.prepare(`INSERT INTO owner_chat_outbox(event_id,message_id,conversation_id,agent_id,local_agent_id,owner_im_uid,payload_json,status,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,'pending',?,?)`).run(eventId,messageId,row.conversation_id,row.agent_id,row.local_agent_id,row.owner_im_uid,JSON.stringify(envelope),now,now);
        } })) throw new Error('OWNER_EXECUTION_COMPLETION_CONFLICT');
      return { status: 'replied' };
    } catch (error: any) {
      const outcome = String(error?.deliveryOutcome || 'outcome_unknown');
      const current = db.prepare('SELECT execution_state FROM owner_chat_messages WHERE message_id=?').get(messageId) as any;
      const from = current?.execution_state === 'PROVIDER_ACCEPTED' ? 'PROVIDER_ACCEPTED' : 'DISPATCH_RESERVED';
      const code=String(error?.code||'');
      const to = code==='OWNER_TURN_CANCELED' ? 'CANCELED'
        : outcome === 'not_delivered' ? 'FAILED_NOT_DELIVERED'
          : outcome === 'rejected' && from === 'PROVIDER_ACCEPTED' ? 'FAILED' : 'OUTCOME_UNKNOWN';
      transitionOwnerExecution(db, { messageId, from, to, reasonCode: String(error?.code || outcome) });
      return { status: outcome };
    } finally { unsubscribeIo(); clearInterval(leaseTimer); }
  }
}

export { OwnerChatProcessor };
