import crypto from 'node:crypto';
import fs from 'node:fs';
import { isTransientE2eeDirectoryError, type E2eeV2DirectoryClient } from './v2-directory-client';
import { encryptE2eeV2Attachment } from './v2-attachment';
import { encodeE2eeAttachmentPayload, encodeE2eeTextPayload, normalizeE2eeRouteContext } from './v2-payload';
import type { E2eeV2Runtime } from './v2-runtime';
import type { E2eeV2ConversationRow, E2eeV2OutboundEnvelopeRow, E2eeV2Store } from './v2-store';

type RawDeliver=(agentId:string,channelId:string,content:string,messageType?:string,channelType?:number,
  mentions?:unknown,localMsgId?:string|null,metadata?:unknown)=>Promise<any>;
type EncryptedDeliver=(agentId:string,channelId:string,envelope:string,transportMessageId:string)=>Promise<any>;

type Recipient={deviceId:string;generation:number;keyId:string;publicBundle:any};
type Resolution={peerKind:'guest'|'agent';peerScopeId:string;
  peerAgentDid?:string;
  capability:'supported'|'unsupported'|'temporarily_unavailable';protocolConversationId:string|null;
  revision:string;expiresAt:number;recipients:Recipient[]};
type CachedResolution={expiresAt:number;value:Resolution};
type RouteContext={routingConversationId:string;wireConversationKey:string;metadata?:Record<string,unknown>};
type PrivateDecision={mode:'e2ee';route:RouteContext;resolved:Resolution}
  |{mode:'plaintext';reason:string}|{mode:'blocked';error:string;securityMode:'e2ee'|'plaintext';reason:string};

export interface SecureOutboundResult {
  success:boolean;via?:string;messageId?:string;serverMessageId?:string;clientMsgNo?:string;
  messageSeq?:number;error?:string;securityMode:'e2ee'|'plaintext';securityReason:string;
  encryptedDeviceCount:number;deliveryState:'delivered'|'queued'|'partial';outcomeUnknown?:boolean;
  [key:string]:unknown;
}

function errorCode(error:unknown):string{
  const candidate=String((error as any)?.code||(error as any)?.message||'E2EE_V2_DIRECTORY_UNAVAILABLE');
  return /^[A-Z0-9_:-]{1,96}$/.test(candidate)?candidate:'E2EE_V2_DIRECTORY_UNAVAILABLE';
}

function transportId(businessMessageId:string,deviceId:string,keyId:string):string{
  return `e2ee-t-${crypto.createHash('sha256').update('VOKO-E2EE-V2-TRANSPORT\0').update(businessMessageId)
    .update('\0').update(deviceId).update('\0').update(keyId).digest('base64url')}`;
}

function plaintextDigest(content:string):string{
  return crypto.createHash('sha256').update('VOKO-E2EE-V2-PLAINTEXT\0').update(content).digest('base64url');
}

export class SecureOutboundRouter {
  private readonly cache=new Map<string,CachedResolution>();
  private readonly failureCache=new Map<string,{expiresAt:number;code:string}>();
  private readonly inflight=new Map<string,Promise<Resolution>>();
  private readonly pendingProjectionMarks=new Set<string>();
  private projectionTimer:ReturnType<typeof setTimeout>|null=null;

  constructor(private readonly options:{store:E2eeV2Store;directory:E2eeV2DirectoryClient;runtime:E2eeV2Runtime;
    rawDeliver:RawDeliver;deliverEncrypted:EncryptedDeliver;
    resolveAgent:(localAgentId:string)=>{serverAgentId:string;agentDid:string;imUid:string}|null;
    resolveRouteContext?:(agentId:string,channelId:string,metadata:unknown)=>{
      routingConversationId?:string;wireConversationKey?:string}|null;
    uploadCiphertext?:(input:{agentId:string;channelId:string;businessMessageId:string;ciphertext:Buffer})=>
      Promise<{uploadId:string;url:string}>;
    onBusinessDelivered?:(agentId:string,businessMessageId:string)=>void;
    enabled?:()=>boolean;agentPeerEnabled?:()=>boolean;attachmentsEnabled?:()=>boolean}){}

  private routeContext(agentId:string,channelId:string,metadata:unknown):{
    routingConversationId:string;wireConversationKey:string;metadata?:Record<string,unknown>}{
    const raw=(metadata&&typeof metadata==='object'&&!Array.isArray(metadata))?(metadata as any)._voko:undefined;
    const normalized=normalizeE2eeRouteContext(raw);
    const resolved=this.options.resolveRouteContext?.(agentId,channelId,metadata)||null;
    const wire=String(resolved?.wireConversationKey||normalized?.canonicalConversationKey
      ||normalized?.conversationKey||'');
    return{routingConversationId:String(resolved?.routingConversationId||wire||''),wireConversationKey:wire,
      ...(normalized?{metadata:normalized}:{})};
  }

  private cacheKey(agentId:string,channelId:string,routingConversationId:string):string{
    return `${agentId}\0${channelId}\0${routingConversationId}`;
  }

  private existingConversation(agentId:string,channelId:string,routingConversationId:string):E2eeV2ConversationRow|null{
    const exact=this.options.store.conversation(agentId,channelId,routingConversationId);
    if(exact||routingConversationId)return exact;
    const candidates=this.options.store.conversationsForChannel(agentId,channelId)
      .filter(row=>row.mode==='e2ee_active'||row.mode==='locked');
    return candidates.length===1?candidates[0]:null;
  }

  private async resolve(agentId:string,channelId:string,routingConversationId:string,
    wireConversationKey:string,force=false):Promise<Resolution>{
    const key=this.cacheKey(agentId,channelId,routingConversationId);
    const cached=this.cache.get(key);
    if(!force&&cached&&cached.expiresAt>Date.now())return cached.value;
    const failed=this.failureCache.get(key);
    if(!force&&failed&&failed.expiresAt>Date.now()){
      throw Object.assign(new Error(failed.code),{code:failed.code});
    }
    const pending=this.inflight.get(key);
    if(pending)return pending;
    const request=(async()=>{try{
      const agent=this.options.resolveAgent(agentId);
      if(!agent)throw Object.assign(new Error('E2EE_V2_AGENT_IDENTITY_UNAVAILABLE'),{code:'E2EE_V2_AGENT_IDENTITY_UNAVAILABLE'});
      const row=await this.options.directory.resolveRecipients({senderAgentId:agent.serverAgentId,
        targetImUid:channelId,...(wireConversationKey?{conversationKey:wireConversationKey}:{})});
      if(row.capability==='supported'&&(!row.protocolConversationId||!row.recipients.length)){
        throw Object.assign(new Error('E2EE_V2_RECIPIENT_SET_INVALID'),{code:'E2EE_V2_RECIPIENT_SET_INVALID'});
      }
      if(row.recipients.length>16)throw Object.assign(new Error('E2EE_RECIPIENT_DEVICE_LIMIT'),{code:'E2EE_RECIPIENT_DEVICE_LIMIT'});
      const ttl=row.capability==='supported'?5*60_000:row.capability==='unsupported'?60_000:10_000;
      const value={...row,expiresAt:Math.min(Number(row.expiresAt)||Date.now()+ttl,Date.now()+ttl)} as Resolution;
      this.cache.set(key,{expiresAt:value.expiresAt,value});
      this.failureCache.delete(key);
      if(value.capability==='supported')this.options.store.saveRecipientSnapshot({localAgentId:agentId,
        channelId,peerScopeId:value.peerScopeId,peerKind:value.peerKind,revision:value.revision,
        expiresAt:value.expiresAt,recipients:value.recipients});
      return value;
    }catch(error){
      this.failureCache.set(key,{expiresAt:Date.now()+10_000,code:errorCode(error)});
      throw error;
    }
    })().finally(()=>this.inflight.delete(key));
    this.inflight.set(key,request);
    return request;
  }

  private async deliverPlaintext(args:any[],reason:string):Promise<SecureOutboundResult>{
    const result=await (this.options.rawDeliver as any)(...args);
    return{...(result||{}),success:result?.success!==false,securityMode:'plaintext',securityReason:reason,
      encryptedDeviceCount:0,deliveryState:result?.success===false?'queued':'delivered'};
  }

  private encryptionFailure(agentId:string,channelId:string,businessMessageId:string,metadata:unknown,
    error:unknown,reason:string):SecureOutboundResult{
    const code=errorCode(error);
    try{
      const route=this.routeContext(agentId,channelId,metadata);
      const existing=this.existingConversation(agentId,channelId,route.routingConversationId);
      if(existing?.mode==='e2ee_active')this.options.store.lockConversation(agentId,channelId,
        existing.routing_conversation_id,code);
    }catch{}
    return{success:false,error:code,messageId:businessMessageId,securityMode:'e2ee',securityReason:reason,
      encryptedDeviceCount:0,deliveryState:'queued'};
  }

  private envelopeRoute(agentId:string,channelId:string,resolved:Resolution):{channelId:string;targetAgentDid?:string}{
    if(resolved.peerKind!=='agent')return{channelId};
    const local=this.options.resolveAgent(agentId);
    if(!local?.imUid||!resolved.peerAgentDid)throw new Error('E2EE_V2_AGENT_ROUTE_UNAVAILABLE');
    return{channelId:local.imUid,targetAgentDid:resolved.peerAgentDid};
  }

  private replyRecipients(agentId:string,channelId:string,resolved:Resolution,
    sourceReceiptMessageId?:string):Recipient[]{
    if(resolved.peerKind!=='guest'||resolved.recipients.length<=1)return resolved.recipients;
    const receipt=sourceReceiptMessageId
      ?this.options.store.receipt(sourceReceiptMessageId)
      :this.options.store.latestReceipt(agentId,channelId,String(resolved.protocolConversationId||''));
    if(!receipt&&!sourceReceiptMessageId)return resolved.recipients;
    if(!receipt||receipt.local_agent_id!==agentId||receipt.channel_id!==channelId
        ||receipt.conversation_id!==resolved.protocolConversationId){
      throw new Error('E2EE_V2_REPLY_RECIPIENT_AMBIGUOUS');
    }
    let envelope:any;
    try{envelope=JSON.parse(receipt.envelope_json);}catch{throw new Error('E2EE_V2_REPLY_RECIPIENT_INVALID');}
    const recipient=resolved.recipients.find(row=>row.deviceId===envelope.senderDeviceId
      &&row.keyId===envelope.senderKeyId);
    if(!recipient)throw new Error('E2EE_V2_REPLY_RECIPIENT_UNAVAILABLE');
    return[recipient];
  }

  private async privateDecision(agentId:string,channelId:string,metadata:unknown,
    trustedRoute?:{routingConversationId:string;wireConversationKey:string}):Promise<PrivateDecision>{
    let route:RouteContext;
    let trustedMetadata:Record<string,unknown>|undefined;
    let trustedMetadataError:unknown;
    try{
      if(trustedRoute){
        const raw=(metadata&&typeof metadata==='object'&&!Array.isArray(metadata))?(metadata as any)._voko:undefined;
        try{trustedMetadata=normalizeE2eeRouteContext(raw);}catch(error){trustedMetadataError=error;}
        route={...trustedRoute};
      }else route=this.routeContext(agentId,channelId,metadata);
    }catch(error){
      return{mode:'blocked',error:errorCode(error),securityMode:'plaintext',reason:'invalid_route_context'};
    }
    let existing=this.existingConversation(agentId,channelId,route.routingConversationId);
    if(existing&&!route.routingConversationId){
      route={...route,routingConversationId:existing.routing_conversation_id,
        wireConversationKey:existing.wire_conversation_key};
    }
    if(this.options.enabled?.()===false&&existing?.mode!=='e2ee_active'&&existing?.mode!=='locked'){
      return{mode:'plaintext',reason:'e2ee_upgrade_disabled'};
    }
    let resolved:Resolution;
    try{resolved=await this.resolve(agentId,channelId,route.routingConversationId,route.wireConversationKey,
      existing?.mode==='locked');}catch(error){
      const code=errorCode(error);
      if(existing?.mode==='e2ee_active'){
        if(!isTransientE2eeDirectoryError(error))this.options.store.lockConversation(agentId,channelId,
          existing.routing_conversation_id,code);
        return{mode:'blocked',error:code,securityMode:'e2ee',reason:'active_directory_unavailable'};
      }
      if(existing?.mode==='locked')return{mode:'blocked',error:existing.lock_reason||code,
        securityMode:'e2ee',reason:'active_conversation_locked'};
      if(code==='E2EE_RECIPIENT_DEVICE_LIMIT')return{mode:'blocked',error:code,securityMode:'plaintext',
        reason:'recipient_policy_error'};
      return{mode:'plaintext',reason:'capability_unknown_fallback'};
    }
    if(resolved.capability!=='supported'){
      if(existing?.mode==='e2ee_active'){
        const code=resolved.capability==='unsupported'?'E2EE_V2_RECIPIENT_REVOKED':'E2EE_V2_DIRECTORY_UNAVAILABLE';
        if(resolved.capability==='unsupported')this.options.store.lockConversation(agentId,channelId,
          existing.routing_conversation_id,code);
        return{mode:'blocked',error:code,securityMode:'e2ee',reason:'active_recipient_unavailable'};
      }
      if(existing?.mode==='locked')return{mode:'blocked',error:existing.lock_reason||'E2EE_V2_CONVERSATION_LOCKED',
        securityMode:'e2ee',reason:'active_conversation_locked'};
      return{mode:'plaintext',reason:resolved.capability==='unsupported'
        ?'recipient_unsupported':'capability_unknown_fallback'};
    }
    if(resolved.peerKind==='guest'){
      if(trustedMetadataError)return{mode:'blocked',error:errorCode(trustedMetadataError),securityMode:'plaintext',
        reason:'invalid_route_context'};
      if(trustedMetadata)route={...route,metadata:trustedMetadata};
    }
    if(resolved.peerKind==='agent'){
      const stableContext=String(resolved.protocolConversationId||'');
      if(!stableContext)return{mode:'blocked',error:'E2EE_V2_AGENT_CONTEXT_REQUIRED',securityMode:'plaintext',
        reason:'agent_context_unavailable'};
      route={...route,routingConversationId:stableContext,wireConversationKey:stableContext};
      // Historical sender-local routing ids are not authoritative Agent-peer
      // contexts. Only the server-resolved protocol context may control reuse
      // or locking, so stale duplicate rows cannot poison a valid context.
      existing=this.existingConversation(agentId,channelId,stableContext);
    }
    if(existing?.mode==='locked'){
      const reason=existing.lock_reason||'E2EE_V2_CONVERSATION_LOCKED';
      const identityMatches=existing.peer_scope_id===resolved.peerScopeId&&existing.peer_kind===resolved.peerKind
        &&existing.protocol_conversation_id===String(resolved.protocolConversationId);
      if(!isTransientE2eeDirectoryError(reason)||!identityMatches
          ||!this.options.store.reactivateConversation({localAgentId:agentId,channelId,
            routingConversationId:existing.routing_conversation_id,expectedLockReason:reason,
            protocolConversationId:String(resolved.protocolConversationId),peerScopeId:resolved.peerScopeId,
            peerKind:resolved.peerKind,recipientRevision:resolved.revision})){
        if(isTransientE2eeDirectoryError(reason)&&!identityMatches)this.options.store.lockConversation(agentId,channelId,
          existing.routing_conversation_id,'E2EE_V2_PEER_IDENTITY_CHANGED');
        return{mode:'blocked',error:identityMatches?reason:'E2EE_V2_PEER_IDENTITY_CHANGED',
          securityMode:'e2ee',reason:'active_conversation_locked'};
      }
      existing=this.options.store.conversation(agentId,channelId,existing.routing_conversation_id);
    }
    if(existing?.mode==='e2ee_active'&&(existing.peer_scope_id!==resolved.peerScopeId
        ||existing.peer_kind!==resolved.peerKind
        ||existing.protocol_conversation_id!==String(resolved.protocolConversationId))){
      const code='E2EE_V2_PEER_IDENTITY_CHANGED';
      this.options.store.lockConversation(agentId,channelId,existing.routing_conversation_id,code);
      return{mode:'blocked',error:code,securityMode:'e2ee',reason:'active_peer_identity_changed'};
    }
    if(resolved.peerKind==='agent'&&this.options.agentPeerEnabled?.()===false&&existing?.mode!=='e2ee_active'){
      return{mode:'plaintext',reason:'agent_peer_e2ee_disabled'};
    }
    return{mode:'e2ee',route,resolved};
  }

  async prepare(agentId:string,channelId:string,channelType=1,metadata:unknown=null,
    purpose:'text'|'attachment'='text'):Promise<{
    success:boolean;securityMode:'e2ee'|'plaintext';securityReason:string;error?:string;encryptedDeviceCount:number}>{
    if(channelType!==1||String(channelId).startsWith('owner_')){
      return{success:true,securityMode:'plaintext',securityReason:'scope_not_e2ee',encryptedDeviceCount:0};
    }
    const decision=await this.privateDecision(agentId,channelId,metadata);
    if(purpose==='attachment'&&!this.options.attachmentsEnabled?.()){
      if(decision.mode==='e2ee'){
        const existing=this.existingConversation(agentId,channelId,decision.route.routingConversationId);
        if(existing?.mode==='e2ee_active')return{success:false,securityMode:'e2ee',
          securityReason:'active_attachment_e2ee_disabled',error:'E2EE_V2_ATTACHMENT_DISABLED',encryptedDeviceCount:0};
        return{success:true,securityMode:'plaintext',securityReason:'attachment_e2ee_disabled',encryptedDeviceCount:0};
      }
      if(decision.mode==='blocked')return{success:false,securityMode:decision.securityMode,
        securityReason:decision.reason,error:decision.error,encryptedDeviceCount:0};
      return{success:true,securityMode:'plaintext',securityReason:'attachment_e2ee_disabled',encryptedDeviceCount:0};
    }
    if(decision.mode==='e2ee')return{success:true,securityMode:'e2ee',securityReason:'recipient_supported',
      encryptedDeviceCount:decision.resolved.recipients.length};
    if(decision.mode==='plaintext')return{success:true,securityMode:'plaintext',securityReason:decision.reason,
      encryptedDeviceCount:0};
    return{success:false,securityMode:decision.securityMode,securityReason:decision.reason,error:decision.error,
      encryptedDeviceCount:0};
  }

  private async deliverAttachment(agentId:string,channelId:string,content:string,messageType:string,
    channelType:number,localMsgId:string,metadata:any):Promise<SecureOutboundResult>{
    const decision=await this.privateDecision(agentId,channelId,metadata);
    if(decision.mode!=='e2ee')return{success:false,error:decision.mode==='blocked'?decision.error:'E2EE_V2_ATTACHMENT_MODE_CHANGED',
      messageId:localMsgId,securityMode:decision.mode==='blocked'?decision.securityMode:'plaintext',
      securityReason:decision.reason,encryptedDeviceCount:0,deliveryState:'queued'};
    if(!this.options.uploadCiphertext)throw new Error('E2EE_V2_ATTACHMENT_UPLOAD_UNAVAILABLE');
    const source=metadata?._e2eeAttachment;
    const filePath=String(source?.filePath||'');
    const fileName=String(source?.fileName||'attachment');
    const mediaType=String(source?.mediaType||'application/octet-stream');
    const openFlags=fs.constants.O_RDONLY|(process.platform==='win32'?0:fs.constants.O_NOFOLLOW);
    const handle=fs.openSync(filePath,openFlags);
    let bytes:Buffer;
    try{
      const stat=fs.fstatSync(handle);
      if(!stat.isFile()||stat.size<=0||stat.size>25*1024*1024)throw new Error('E2EE_V2_ATTACHMENT_SOURCE_INVALID');
      bytes=fs.readFileSync(handle);
      const after=fs.fstatSync(handle);
      if(after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||bytes.length!==stat.size){
        bytes.fill(0);throw new Error('E2EE_V2_ATTACHMENT_SOURCE_CHANGED');
      }
    }finally{
      fs.closeSync(handle);
    }
    const encrypted=encryptE2eeV2Attachment(bytes,{messageId:localMsgId,
      kind:messageType==='image'?'image':'file',fileName,mediaType});
    bytes.fill(0);
    try{
      const uploaded=await this.options.uploadCiphertext({agentId,channelId,businessMessageId:localMsgId,
        ciphertext:encrypted.ciphertext});
      const manifest={...encrypted.manifest,uploadId:uploaded.uploadId,url:uploaded.url};
      const payload=encodeE2eeAttachmentPayload(manifest,decision.route.metadata);
      const protocolConversationId=String(decision.resolved.protocolConversationId);
      const envelopeRoute=this.envelopeRoute(agentId,channelId,decision.resolved);
      const envelopes=decision.resolved.recipients.map(recipient=>({recipientDeviceId:recipient.deviceId,
        recipientKeyId:recipient.keyId,transportMessageId:transportId(localMsgId,recipient.deviceId,recipient.keyId),
        fixedEnvelopeJson:this.options.runtime.sealOutbound(agentId,{messageId:localMsgId,
          conversationId:protocolConversationId,channelId:envelopeRoute.channelId,
          targetAgentDid:envelopeRoute.targetAgentDid,contentKind:'attachment_manifest',
          recipientDeviceId:recipient.deviceId,recipientKeyId:recipient.keyId,
          recipientBundle:recipient.publicBundle,plaintext:payload})}));
      const initialLeaseOwner=`e2ee-out-${crypto.randomUUID()}`;
      this.options.store.createOutbound({businessMessageId:localMsgId,localAgentId:agentId,channelId,
        routingConversationId:decision.route.routingConversationId,protocolConversationId,
        contentKind:'attachment_manifest',recipientRevision:decision.resolved.revision,
        plaintextDigest:encrypted.manifest.plaintextSha256,envelopes,initialLeaseOwner,conversation:{
          wireConversationKey:decision.route.wireConversationKey,peerScopeId:decision.resolved.peerScopeId,
          peerKind:decision.resolved.peerKind},attachment:{uploadId:uploaded.uploadId,
          manifestJson:JSON.stringify(manifest),ciphertextSha256:crypto.createHash('sha256')
            .update(encrypted.ciphertext).digest('base64url'),ciphertextSize:encrypted.ciphertext.length,
          mediaMetadata:{kind:manifest.kind,mediaType:manifest.mediaType}}});
      return this.deliverBusiness(localMsgId,initialLeaseOwner);
    }finally{encrypted.ciphertext.fill(0);}
  }

  async deliver(agentId:string,channelId:string,content:string,messageType='text',channelType=1,
    mentions:unknown=null,localMsgId:string|null=null,metadata:unknown=null,
    internal?:{sourceReceiptMessageId?:string;protocolConversationId?:string}):Promise<SecureOutboundResult>{
    const args=[agentId,channelId,content,messageType,channelType,mentions,localMsgId,metadata];
    if(channelType!==1||String(channelId).startsWith('owner_')){
      return this.deliverPlaintext(args,'scope_not_e2ee');
    }
    if(messageType!=='text'){
      const attachmentSource=metadata&&typeof metadata==='object'&&(metadata as any)._e2eeAttachment;
      if(attachmentSource&&!this.options.attachmentsEnabled?.()){
        return{success:false,error:'E2EE_V2_ATTACHMENT_DISABLED',messageId:localMsgId||undefined,
          securityMode:'plaintext',securityReason:'attachment_e2ee_disabled',encryptedDeviceCount:0,
          deliveryState:'queued'};
      }
      if(attachmentSource){
        const attachmentBusinessId=localMsgId||`msg-${agentId}-${channelId}-${Date.now()}`;
        try{return await this.deliverAttachment(agentId,channelId,content,messageType,channelType,
          attachmentBusinessId,metadata);}catch(error){
          return this.encryptionFailure(agentId,channelId,attachmentBusinessId,metadata,error,
            'attachment_encryption_failed');
        }
      }
      return this.deliverPlaintext(args,'attachment_router_pending');
    }
    const businessMessageId=localMsgId||`msg-${agentId}-${channelId}-${Date.now()}`;
    const trustedRoute=internal?.protocolConversationId
      ?{routingConversationId:internal.protocolConversationId,wireConversationKey:internal.protocolConversationId}
      :undefined;
    const decision=await this.privateDecision(agentId,channelId,metadata,trustedRoute);
    if(decision.mode==='plaintext')return this.deliverPlaintext(args,decision.reason);
    if(decision.mode==='blocked')return{success:false,error:decision.error,messageId:businessMessageId,
      securityMode:decision.securityMode,securityReason:decision.reason,encryptedDeviceCount:0,deliveryState:'queued'};
    try{
      const payload=encodeE2eeTextPayload(content,decision.route.metadata);
      const protocolConversationId=String(decision.resolved.protocolConversationId);
      const envelopeRoute=this.envelopeRoute(agentId,channelId,decision.resolved);
      const recipients=this.replyRecipients(agentId,channelId,decision.resolved,internal?.sourceReceiptMessageId);
      const envelopes=recipients.map(recipient=>({recipientDeviceId:recipient.deviceId,
        recipientKeyId:recipient.keyId,transportMessageId:transportId(businessMessageId,recipient.deviceId,recipient.keyId),
        fixedEnvelopeJson:this.options.runtime.sealOutbound(agentId,{messageId:businessMessageId,
          conversationId:protocolConversationId,channelId:envelopeRoute.channelId,
          targetAgentDid:envelopeRoute.targetAgentDid,contentKind:'text',recipientDeviceId:recipient.deviceId,
          recipientKeyId:recipient.keyId,recipientBundle:recipient.publicBundle,plaintext:payload})}));
      const initialLeaseOwner=`e2ee-out-${crypto.randomUUID()}`;
      this.options.store.createOutbound({businessMessageId,localAgentId:agentId,channelId,
        routingConversationId:decision.route.routingConversationId,protocolConversationId,contentKind:'text',
        recipientRevision:decision.resolved.revision,plaintextDigest:plaintextDigest(content),envelopes,initialLeaseOwner,
        conversation:{wireConversationKey:decision.route.wireConversationKey,peerScopeId:decision.resolved.peerScopeId,
          peerKind:decision.resolved.peerKind},sourceReceiptMessageId:internal?.sourceReceiptMessageId});
      return this.deliverBusiness(businessMessageId,initialLeaseOwner);
    }catch(error){return this.encryptionFailure(agentId,channelId,businessMessageId,metadata,error,'encryption_failed');}
  }

  private async deliverStored(row:E2eeV2OutboundEnvelopeRow):Promise<boolean>{
    if(row.state==='sent')return true;
    const owner=`e2ee-out-${crypto.randomUUID()}`;
    if(!this.options.store.claimOutbound(row.transport_message_id,owner))return false;
    try{
      const message=this.options.store.outboundEnvelopes(row.business_message_id)
        .find(candidate=>candidate.transport_message_id===row.transport_message_id)||row;
      const parent=this.options.store.outboundMessage(row.business_message_id);
      if(!parent)throw new Error('E2EE_V2_OUTBOUND_MESSAGE_MISSING');
      const result=await this.options.deliverEncrypted(parent.local_agent_id,parent.channel_id,
        message.fixed_envelope_json,message.transport_message_id);
      if(result?.success===false)throw Object.assign(new Error(String(result?.error||'E2EE_V2_NOT_DELIVERED')),
        {outcomeUnknown:Boolean(result?.outcomeUnknown)});
      this.options.store.finishOutbound(row.transport_message_id,owner,'sent');
      await this.projectDelivered(row.business_message_id);
      return true;
    }catch(error:any){
      this.options.store.finishOutbound(row.transport_message_id,owner,error?.outcomeUnknown?'outcome_unknown':'pending',
        errorCode(error));
      return false;
    }
  }

  private async projectDelivered(businessMessageId:string):Promise<void>{
    const completed=this.options.store.outboundMessage(businessMessageId);
    if(completed?.state!=='sent'||completed.projected_at||this.pendingProjectionMarks.has(businessMessageId))return;
    this.options.onBusinessDelivered?.(completed.local_agent_id,businessMessageId);
    this.pendingProjectionMarks.add(businessMessageId);
    if(!this.projectionTimer){
      this.projectionTimer=setTimeout(()=>{
        this.projectionTimer=null;
        try{this.flushProjectionMarks();}catch{}
      },25);
      this.projectionTimer.unref?.();
    }
  }

  private flushProjectionMarks():void{
    const ids=[...this.pendingProjectionMarks];
    if(!ids.length)return;
    this.options.store.markOutboundsProjected(ids);
    for(const id of ids)this.pendingProjectionMarks.delete(id);
  }

  private async deliverBusiness(businessMessageId:string,initialLeaseOwner?:string):Promise<SecureOutboundResult>{
    const before=this.options.store.outboundEnvelopes(businessMessageId);
    const initiallyClaimed=initialLeaseOwner
      ?before.filter(row=>row.state==='sending'&&row.lease_owner===initialLeaseOwner):[];
    if(initiallyClaimed.length){
      const owner=initialLeaseOwner!;
      const parent=this.options.store.outboundMessage(businessMessageId);
      if(!parent)throw new Error('E2EE_V2_OUTBOUND_MESSAGE_MISSING');
      const results=await Promise.all(initiallyClaimed.map(async row=>{
        try{
          const result=await this.options.deliverEncrypted(parent.local_agent_id,parent.channel_id,
            row.fixed_envelope_json,row.transport_message_id);
          if(result?.success===false)throw Object.assign(new Error(String(result?.error||'E2EE_V2_NOT_DELIVERED')),
            {outcomeUnknown:Boolean(result?.outcomeUnknown)});
          return{transportMessageId:row.transport_message_id,owner,state:'sent' as const};
        }catch(error:any){
          return{transportMessageId:row.transport_message_id,owner,
            state:(error?.outcomeUnknown?'outcome_unknown':'pending') as 'outcome_unknown'|'pending',
            error:errorCode(error)};
        }
      }));
      this.options.store.finishOutbounds(results);
    }
    const claimedIds=new Set(initiallyClaimed.map(row=>row.transport_message_id));
    await Promise.all(before.filter(row=>!claimedIds.has(row.transport_message_id)).map(row=>this.deliverStored(row)));
    await this.projectDelivered(businessMessageId).catch(()=>undefined);
    const rows=this.options.store.outboundEnvelopes(businessMessageId);
    const sent=rows.filter(row=>row.state==='sent').length;
    const deliveryState=sent===rows.length?'delivered':sent>0?'partial':'queued';
    return{success:true,via:'e2ee',messageId:businessMessageId,securityMode:'e2ee',
      securityReason:'recipient_supported',encryptedDeviceCount:rows.length,deliveryState};
  }

  async recover(limit=100):Promise<void>{
    for(const row of this.options.store.recoverableOutbound(limit))await this.deliverStored(row);
    for(const row of this.options.store.deliveredUnprojected(limit)){
      await this.projectDelivered(row.business_message_id).catch(()=>undefined);
    }
    this.flushProjectionMarks();
  }

  async refreshActive(limit=500):Promise<void>{
    const rows=[...this.options.store.activeConversations(limit),
      ...this.options.store.transientLockedConversations(limit)];
    for(const row of rows){
      if(Date.now()-row.last_verified_at<50_000+Math.floor(Math.random()*20_000))continue;
      try{
        const resolved=await this.resolve(row.local_agent_id,row.channel_id,row.routing_conversation_id,
          row.wire_conversation_key,true);
        if(resolved.capability==='unsupported')this.options.store.lockConversation(row.local_agent_id,row.channel_id,
          row.routing_conversation_id,'E2EE_V2_RECIPIENT_REVOKED');
        else if(resolved.capability==='supported'){
          const identityMatches=row.peer_scope_id===resolved.peerScopeId&&row.peer_kind===resolved.peerKind
            &&row.protocol_conversation_id===String(resolved.protocolConversationId);
          if(!identityMatches)this.options.store.lockConversation(row.local_agent_id,row.channel_id,
            row.routing_conversation_id,'E2EE_V2_PEER_IDENTITY_CHANGED');
          else if(row.mode==='locked')this.options.store.reactivateConversation({localAgentId:row.local_agent_id,
            channelId:row.channel_id,routingConversationId:row.routing_conversation_id,
            expectedLockReason:String(row.lock_reason),protocolConversationId:String(resolved.protocolConversationId),
            peerScopeId:resolved.peerScopeId,peerKind:resolved.peerKind,recipientRevision:resolved.revision});
          else this.options.store.saveConversation({localAgentId:row.local_agent_id,channelId:row.channel_id,
            routingConversationId:row.routing_conversation_id,wireConversationKey:row.wire_conversation_key,
            protocolConversationId:String(resolved.protocolConversationId),peerScopeId:resolved.peerScopeId,
            peerKind:resolved.peerKind,mode:'e2ee_active',recipientRevision:resolved.revision});
        }
      }catch(error){if(!isTransientE2eeDirectoryError(error))this.options.store.lockConversation(row.local_agent_id,
        row.channel_id,row.routing_conversation_id,errorCode(error));}
    }
  }
}

module.exports={SecureOutboundRouter};
