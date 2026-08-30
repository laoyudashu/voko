import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type E2eeV2ReceiptState = 'received'|'processing'|'provider_accepted'|'reply_ready'|
  'completed'|'outcome_unknown'|'failed';

export interface E2eeV2KeyRow {
  local_agent_id: string;
  server_agent_id: string;
  agent_did: string;
  device_id: string;
  generation: number;
  public_bundle_json: string;
  encrypted_private_bundle: string;
}

export interface E2eeV2ReceiptRow {
  message_id: string;
  cipher_digest: string;
  envelope_json: string;
  local_agent_id: string;
  channel_id: string;
  conversation_id: string;
  state: E2eeV2ReceiptState;
  reply_message_id: string|null;
  reply_envelope_json: string|null;
  error_code: string|null;
  lease_owner: string|null;
  lease_expires_at: number|null;
  delivery_attempts: number;
  created_at: number;
  updated_at: number;
}

export interface E2eeV2AttachmentRow {
  message_id:string;upload_id:string;local_agent_id:string;channel_id:string;file_name:string;
  media_type:string;size:number;sha256:string;local_path:string;created_at:number;
}

export type E2eeV2ConversationMode = 'plaintext'|'e2ee_active'|'locked';
export type E2eeV2OutboundState = 'pending'|'sending'|'sent'|'outcome_unknown'|'failed';

export interface E2eeV2RemoteDeviceRow {
  local_agent_id:string;channel_id:string;peer_scope_id:string;peer_kind:'guest'|'agent';
  device_id:string;generation:number;key_id:string;public_bundle_json:string;revision:string;
  status:'active'|'stale'|'revoked';verified_at:number;expires_at:number;
}

export interface E2eeV2ConversationRow {
  local_agent_id:string;channel_id:string;routing_conversation_id:string;wire_conversation_key:string;
  protocol_conversation_id:string;peer_scope_id:string;peer_kind:'guest'|'agent';
  mode:E2eeV2ConversationMode;recipient_revision:string;activated_at:number|null;
  last_verified_at:number;lock_reason:string|null;created_at:number;updated_at:number;
}

export interface E2eeV2OutboundEnvelopeRow {
  business_message_id:string;recipient_device_id:string;recipient_key_id:string;transport_message_id:string;
  fixed_envelope_json:string;state:E2eeV2OutboundState;lease_owner:string|null;lease_expires_at:number|null;
  attempts:number;last_error:string|null;created_at:number;updated_at:number;
}

export interface E2eeV2OutboundAttachmentRow {
  business_message_id:string;upload_id:string;manifest_json:string;cek:string;
  ciphertext_sha256:string;ciphertext_size:number;media_metadata_json:string;created_at:number;updated_at:number;
}

function ensureColumn(db:any,table:string,column:string,definition:string):void{
  const columns=db.prepare(`PRAGMA table_info(${table})`).all() as Array<{name?:string}>;
  if(!columns.some(row=>row.name===column))db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function keyFile(databasePath: string): string {
  return path.join(path.dirname(databasePath),'voko-e2ee-v2.key');
}

function loadOrCreateWrappingKey(databasePath: string): Buffer {
  const file = keyFile(databasePath);
  try {
    const current = fs.readFileSync(file);
    if (current.length !== 32) throw new Error('E2EE_V2_WRAPPING_KEY_INVALID');
    return current;
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const handle = fs.openSync(file,'wx',0o600);
  try { fs.writeFileSync(handle,key); } finally { fs.closeSync(handle); }
  try { fs.chmodSync(file,0o600); } catch {}
  return key;
}

function encryptBundle(key: Buffer, plaintext: string): string {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm',key,nonce);
  cipher.setAAD(Buffer.from('VOKO-E2EE-V2-LOCAL-KEY\0','utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext,'utf8'),cipher.final()]);
  return JSON.stringify({v:1,n:nonce.toString('base64url'),c:ciphertext.toString('base64url'),t:cipher.getAuthTag().toString('base64url')});
}

function decryptBundle(key: Buffer, value: string): string {
  const row = JSON.parse(value);
  if (row?.v !== 1) throw new Error('E2EE_V2_PRIVATE_BUNDLE_INVALID');
  const decipher = crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(String(row.n),'base64url'));
  decipher.setAAD(Buffer.from('VOKO-E2EE-V2-LOCAL-KEY\0','utf8'));
  decipher.setAuthTag(Buffer.from(String(row.t),'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(String(row.c),'base64url')),decipher.final()]).toString('utf8');
}

export class E2eeV2Store {
  private readonly wrappingKey: Buffer;
  constructor(private readonly db: any, private readonly databasePath: string) {
    this.wrappingKey = loadOrCreateWrappingKey(databasePath);
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS e2ee_v2_agent_keys (
        local_agent_id TEXT PRIMARY KEY,
        server_agent_id TEXT NOT NULL,
        agent_did TEXT NOT NULL,
        device_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        public_bundle_json TEXT NOT NULL,
        encrypted_private_bundle TEXT NOT NULL,
        registered_key_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS e2ee_v2_receipts (
        message_id TEXT PRIMARY KEY,
        cipher_digest TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        local_agent_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        state TEXT NOT NULL,
        reply_message_id TEXT,
        reply_envelope_json TEXT,
        error_code TEXT,
        lease_owner TEXT,
        lease_expires_at INTEGER,
        delivery_attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_e2ee_v2_receipts_recovery
        ON e2ee_v2_receipts(state,updated_at);
      CREATE TABLE IF NOT EXISTS e2ee_v2_attachments (
        message_id TEXT PRIMARY KEY,
        upload_id TEXT NOT NULL UNIQUE,
        local_agent_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        file_name TEXT NOT NULL,
        media_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        local_path TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS e2ee_v2_remote_devices (
        local_agent_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        peer_scope_id TEXT NOT NULL,
        peer_kind TEXT NOT NULL CHECK(peer_kind IN ('guest','agent')),
        device_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        key_id TEXT NOT NULL,
        public_bundle_json TEXT NOT NULL,
        revision TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active','stale','revoked')),
        verified_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY(local_agent_id,channel_id,device_id)
      );
      CREATE INDEX IF NOT EXISTS idx_e2ee_v2_remote_devices_lookup
        ON e2ee_v2_remote_devices(local_agent_id,channel_id,status,expires_at);
      CREATE TABLE IF NOT EXISTS e2ee_v2_conversations (
        local_agent_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        routing_conversation_id TEXT NOT NULL DEFAULT '',
        wire_conversation_key TEXT NOT NULL DEFAULT '',
        protocol_conversation_id TEXT NOT NULL,
        peer_scope_id TEXT NOT NULL,
        peer_kind TEXT NOT NULL CHECK(peer_kind IN ('guest','agent')),
        mode TEXT NOT NULL CHECK(mode IN ('plaintext','e2ee_active','locked')),
        recipient_revision TEXT NOT NULL DEFAULT '',
        activated_at INTEGER,
        last_verified_at INTEGER NOT NULL,
        lock_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(local_agent_id,channel_id,routing_conversation_id)
      );
      CREATE INDEX IF NOT EXISTS idx_e2ee_v2_conversations_protocol
        ON e2ee_v2_conversations(local_agent_id,channel_id,protocol_conversation_id);
      CREATE TABLE IF NOT EXISTS e2ee_v2_outbound_messages (
        business_message_id TEXT PRIMARY KEY,
        local_agent_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        routing_conversation_id TEXT NOT NULL DEFAULT '',
        protocol_conversation_id TEXT NOT NULL,
        content_kind TEXT NOT NULL,
        security_mode TEXT NOT NULL CHECK(security_mode IN ('e2ee','plaintext')),
        recipient_revision TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL CHECK(state IN ('pending','sending','sent','outcome_unknown','failed')),
        plaintext_digest TEXT NOT NULL,
        projected_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_e2ee_v2_outbound_messages_recovery
        ON e2ee_v2_outbound_messages(state,updated_at);
      CREATE TABLE IF NOT EXISTS e2ee_v2_outbound_envelopes (
        business_message_id TEXT NOT NULL,
        recipient_device_id TEXT NOT NULL,
        recipient_key_id TEXT NOT NULL,
        transport_message_id TEXT NOT NULL UNIQUE,
        fixed_envelope_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','sending','sent','outcome_unknown','failed')),
        lease_owner TEXT,
        lease_expires_at INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(business_message_id,recipient_device_id,recipient_key_id),
        FOREIGN KEY(business_message_id) REFERENCES e2ee_v2_outbound_messages(business_message_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_e2ee_v2_outbound_envelopes_recovery
        ON e2ee_v2_outbound_envelopes(state,lease_expires_at,updated_at);
      CREATE TABLE IF NOT EXISTS e2ee_v2_outbound_attachments (
        business_message_id TEXT PRIMARY KEY,
        upload_id TEXT NOT NULL,
        encrypted_manifest TEXT NOT NULL,
        encrypted_cek TEXT NOT NULL,
        ciphertext_sha256 TEXT NOT NULL,
        ciphertext_size INTEGER NOT NULL,
        media_metadata_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(business_message_id) REFERENCES e2ee_v2_outbound_messages(business_message_id) ON DELETE CASCADE
      );
    `);
    ensureColumn(db,'e2ee_v2_outbound_messages','projected_at','INTEGER');
  }

  key(localAgentId: string): (E2eeV2KeyRow & {private_bundle_json:string})|null {
    const row = this.db.prepare('SELECT * FROM e2ee_v2_agent_keys WHERE local_agent_id=?').get(localAgentId) as E2eeV2KeyRow|undefined;
    return row ? { ...row,private_bundle_json:decryptBundle(this.wrappingKey,row.encrypted_private_bundle) } : null;
  }

  saveKey(input: Omit<E2eeV2KeyRow,'encrypted_private_bundle'> & {privateBundleJson:string}): void {
    const now = Date.now();
    this.db.prepare(`INSERT INTO e2ee_v2_agent_keys(local_agent_id,server_agent_id,agent_did,device_id,generation,
      public_bundle_json,encrypted_private_bundle,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(local_agent_id) DO UPDATE SET server_agent_id=excluded.server_agent_id,
      agent_did=excluded.agent_did,device_id=excluded.device_id,generation=excluded.generation,
      public_bundle_json=excluded.public_bundle_json,encrypted_private_bundle=excluded.encrypted_private_bundle,
      registered_key_id=NULL,updated_at=excluded.updated_at`).run(
        input.local_agent_id,input.server_agent_id,input.agent_did,input.device_id,input.generation,
        input.public_bundle_json,encryptBundle(this.wrappingKey,input.privateBundleJson),now,now,
      );
  }

  markRegistered(localAgentId: string, keyId: string): void {
    this.db.prepare('UPDATE e2ee_v2_agent_keys SET registered_key_id=?,updated_at=? WHERE local_agent_id=?')
      .run(keyId,Date.now(),localAgentId);
  }

  reserve(input: { messageId:string;digest:string;envelopeJson:string;localAgentId:string;channelId:string;conversationId:string }): 'new'|'duplicate' {
    const existing = this.receipt(input.messageId);
    if (existing) {
      if (existing.cipher_digest !== input.digest) throw new Error('E2EE_V2_MESSAGE_ID_CONFLICT');
      return 'duplicate';
    }
    const now=Date.now();
    this.db.prepare(`INSERT INTO e2ee_v2_receipts(message_id,cipher_digest,envelope_json,local_agent_id,channel_id,
      conversation_id,state,created_at,updated_at) VALUES(?,?,?,?,?,?,'received',?,?)`)
      .run(input.messageId,input.digest,input.envelopeJson,input.localAgentId,input.channelId,input.conversationId,now,now);
    return 'new';
  }

  receipt(messageId: string): E2eeV2ReceiptRow|null {
    return (this.db.prepare('SELECT * FROM e2ee_v2_receipts WHERE message_id=?').get(messageId) as E2eeV2ReceiptRow|undefined) || null;
  }

  latestReceipt(localAgentId:string,channelId:string,conversationId:string):E2eeV2ReceiptRow|null{
    const row=this.db.prepare(`SELECT * FROM e2ee_v2_receipts WHERE local_agent_id=? AND channel_id=?
      AND conversation_id=? ORDER BY created_at DESC LIMIT 1`).get(localAgentId,channelId,conversationId) as E2eeV2ReceiptRow|undefined;
    return row||null;
  }

  claim(messageId: string, owner: string, leaseMs = 180_000): boolean {
    const now=Date.now();
    return this.db.prepare(`UPDATE e2ee_v2_receipts SET state='processing',lease_owner=?,lease_expires_at=?,updated_at=?
      WHERE message_id=? AND state='received'`).run(owner,now+leaseMs,now,messageId).changes === 1;
  }

  transition(messageId: string, from: E2eeV2ReceiptState[], to: E2eeV2ReceiptState, errorCode?: string|null): boolean {
    const placeholders=from.map(()=>'?').join(',');
    const result=this.db.prepare(`UPDATE e2ee_v2_receipts SET state=?,error_code=?,lease_owner=NULL,
      lease_expires_at=NULL,updated_at=? WHERE message_id=? AND state IN (${placeholders})`)
      .run(to,errorCode || null,Date.now(),messageId,...from);
    return result.changes === 1;
  }

  commitReply(messageId: string, replyMessageId: string, envelopeJson: string): void {
    const result=this.db.prepare(`UPDATE e2ee_v2_receipts SET state='reply_ready',reply_message_id=?,reply_envelope_json=?,
      lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE message_id=? AND state='provider_accepted'`)
      .run(replyMessageId,envelopeJson,Date.now(),messageId);
    if (result.changes !== 1) throw new Error('E2EE_V2_REPLY_STATE_CONFLICT');
  }

  claimReply(messageId: string, owner: string, leaseMs=60_000): boolean {
    const now=Date.now();
    return this.db.prepare(`UPDATE e2ee_v2_receipts SET lease_owner=?,lease_expires_at=?,delivery_attempts=delivery_attempts+1,
      updated_at=? WHERE message_id=? AND state IN ('reply_ready','outcome_unknown')
      AND reply_envelope_json IS NOT NULL AND (lease_expires_at IS NULL OR lease_expires_at<?)`)
      .run(owner,now+leaseMs,now,messageId,now).changes === 1;
  }

  finishReply(messageId: string, owner: string, delivered: boolean): boolean {
    const result=this.db.prepare(`UPDATE e2ee_v2_receipts SET state=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=?
      WHERE message_id=? AND lease_owner=?`).run(delivered?'completed':'outcome_unknown',Date.now(),messageId,owner);
    return result.changes === 1;
  }

  recoverable(limit=50): E2eeV2ReceiptRow[] {
    return this.db.prepare(`SELECT * FROM e2ee_v2_receipts WHERE state='received'
      OR (state IN ('reply_ready','outcome_unknown') AND reply_envelope_json IS NOT NULL)
      ORDER BY created_at LIMIT ?`).all(limit) as E2eeV2ReceiptRow[];
  }

  failedReceipts(limit=50): E2eeV2ReceiptRow[] {
    return this.db.prepare(`SELECT * FROM e2ee_v2_receipts WHERE state='failed' AND (
      error_code IN ('ETIMEDOUT','ECONNRESET','ECONNREFUSED','ENETUNREACH','EHOSTUNREACH','ABORT_ERR',
        'E2EE_V2_DIRECTORY_UNAVAILABLE','E2EE_V2_DIRECTORY_HTTP_408','E2EE_V2_DIRECTORY_HTTP_425',
        'E2EE_V2_DIRECTORY_HTTP_429','E2EE_V2_CONVERSATION_LOCKED','ERR_INVALID_ARG_TYPE')
      OR error_code LIKE 'E2EE_V2_DIRECTORY_HTTP_5%')
      ORDER BY updated_at LIMIT ?`).all(limit) as E2eeV2ReceiptRow[];
  }

  hasChannel(localAgentId:string,channelId:string):boolean{
    return Boolean(this.db.prepare(`SELECT 1 FROM e2ee_v2_conversations
      WHERE local_agent_id=? AND channel_id=? AND mode IN ('e2ee_active','locked') LIMIT 1`)
      .get(localAgentId,channelId)
      ||this.db.prepare(`SELECT 1 FROM e2ee_v2_receipts WHERE local_agent_id=? AND channel_id=? LIMIT 1`)
        .get(localAgentId,channelId));
  }

  conversation(localAgentId:string,channelId:string,routingConversationId=''):E2eeV2ConversationRow|null{
    return(this.db.prepare(`SELECT * FROM e2ee_v2_conversations
      WHERE local_agent_id=? AND channel_id=? AND routing_conversation_id=?`)
      .get(localAgentId,channelId,routingConversationId) as E2eeV2ConversationRow|undefined)||null;
  }

  conversationsForChannel(localAgentId:string,channelId:string):E2eeV2ConversationRow[]{
    return this.db.prepare(`SELECT * FROM e2ee_v2_conversations WHERE local_agent_id=? AND channel_id=?
      ORDER BY updated_at DESC`).all(localAgentId,channelId) as E2eeV2ConversationRow[];
  }

  conversationByProtocolId(localAgentId:string,channelId:string,protocolConversationId:string):E2eeV2ConversationRow|null{
    const row=(this.db.prepare(`SELECT * FROM e2ee_v2_conversations
      WHERE local_agent_id=? AND channel_id=? AND protocol_conversation_id=?
      ORDER BY CASE WHEN routing_conversation_id=? THEN 0 ELSE 1 END,updated_at DESC LIMIT 1`)
      .get(localAgentId,channelId,protocolConversationId,protocolConversationId)) as E2eeV2ConversationRow|undefined;
    return row||null;
  }

  activeConversations(limit=500):E2eeV2ConversationRow[]{
    return this.db.prepare(`SELECT * FROM e2ee_v2_conversations WHERE mode='e2ee_active'
      ORDER BY last_verified_at ASC LIMIT ?`).all(limit) as E2eeV2ConversationRow[];
  }

  transientLockedConversationCount():number{
    const row=this.db.prepare(`SELECT COUNT(*) AS count FROM e2ee_v2_conversations WHERE mode='locked' AND (
      lock_reason IN ('ETIMEDOUT','ECONNRESET','ECONNREFUSED','ENETUNREACH','EHOSTUNREACH','ABORT_ERR',
        'E2EE_V2_DIRECTORY_UNAVAILABLE','E2EE_V2_DIRECTORY_HTTP_408','E2EE_V2_DIRECTORY_HTTP_425',
        'E2EE_V2_DIRECTORY_HTTP_429','E2EE_V2_DIRECTORY_HTTP_404')
        OR lock_reason LIKE 'E2EE_V2_DIRECTORY_HTTP_5%')`).get() as {count?:number}|undefined;
    return Number(row?.count||0);
  }

  transientLockedConversations(limit=500,offset=0):E2eeV2ConversationRow[]{
    return this.db.prepare(`SELECT * FROM e2ee_v2_conversations WHERE mode='locked' AND (
      lock_reason IN ('ETIMEDOUT','ECONNRESET','ECONNREFUSED','ENETUNREACH','EHOSTUNREACH','ABORT_ERR',
        'E2EE_V2_DIRECTORY_UNAVAILABLE','E2EE_V2_DIRECTORY_HTTP_408','E2EE_V2_DIRECTORY_HTTP_425',
        'E2EE_V2_DIRECTORY_HTTP_429','E2EE_V2_DIRECTORY_HTTP_404')
        OR lock_reason LIKE 'E2EE_V2_DIRECTORY_HTTP_5%')
      ORDER BY updated_at ASC,local_agent_id ASC,channel_id ASC,routing_conversation_id ASC LIMIT ? OFFSET ?`)
      .all(limit,offset) as E2eeV2ConversationRow[];
  }

  saveConversation(input:{localAgentId:string;channelId:string;routingConversationId?:string;
    wireConversationKey?:string;protocolConversationId:string;peerScopeId:string;peerKind:'guest'|'agent';
    mode:E2eeV2ConversationMode;recipientRevision?:string;lockReason?:string|null}):E2eeV2ConversationRow{
    const now=Date.now();
    const routingConversationId=input.routingConversationId||'';
    const existing=this.conversation(input.localAgentId,input.channelId,routingConversationId);
    if(existing?.mode==='locked'&&input.mode!=='locked')throw new Error('E2EE_V2_CONVERSATION_LOCKED');
    if(existing?.mode==='e2ee_active'&&input.mode==='plaintext')throw new Error('E2EE_V2_DOWNGRADE_FORBIDDEN');
    const activatedAt=input.mode==='e2ee_active'?(existing?.activated_at||now):existing?.activated_at||null;
    this.db.prepare(`INSERT INTO e2ee_v2_conversations(local_agent_id,channel_id,routing_conversation_id,
      wire_conversation_key,protocol_conversation_id,peer_scope_id,peer_kind,mode,recipient_revision,
      activated_at,last_verified_at,lock_reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(local_agent_id,channel_id,routing_conversation_id) DO UPDATE SET
      wire_conversation_key=excluded.wire_conversation_key,protocol_conversation_id=excluded.protocol_conversation_id,
      peer_scope_id=excluded.peer_scope_id,peer_kind=excluded.peer_kind,mode=excluded.mode,
      recipient_revision=excluded.recipient_revision,activated_at=excluded.activated_at,
      last_verified_at=excluded.last_verified_at,lock_reason=excluded.lock_reason,updated_at=excluded.updated_at`)
      .run(input.localAgentId,input.channelId,routingConversationId,input.wireConversationKey||'',
        input.protocolConversationId,input.peerScopeId,input.peerKind,input.mode,input.recipientRevision||'',
        activatedAt,now,input.lockReason||null,existing?.created_at||now,now);
    return this.conversation(input.localAgentId,input.channelId,routingConversationId)!;
  }

  lockConversation(localAgentId:string,channelId:string,routingConversationId:string,reason:string):void{
    this.db.prepare(`UPDATE e2ee_v2_conversations SET mode='locked',lock_reason=?,updated_at=?
      WHERE local_agent_id=? AND channel_id=? AND routing_conversation_id=? AND mode IN ('e2ee_active','locked')`)
      .run(reason,Date.now(),localAgentId,channelId,routingConversationId||'');
  }

  reactivateConversation(input:{localAgentId:string;channelId:string;routingConversationId:string;
    expectedLockReason:string;protocolConversationId:string;peerScopeId:string;peerKind:'guest'|'agent';
    recipientRevision?:string}):boolean{
    const result=this.db.prepare(`UPDATE e2ee_v2_conversations SET mode='e2ee_active',lock_reason=NULL,
      recipient_revision=?,last_verified_at=?,updated_at=? WHERE local_agent_id=? AND channel_id=?
      AND routing_conversation_id=? AND mode='locked' AND lock_reason=? AND protocol_conversation_id=?
      AND peer_scope_id=? AND peer_kind=?`).run(input.recipientRevision||'',Date.now(),Date.now(),
        input.localAgentId,input.channelId,input.routingConversationId||'',input.expectedLockReason,
        input.protocolConversationId,input.peerScopeId,input.peerKind);
    return result.changes===1;
  }

  saveRecipientSnapshot(input:{localAgentId:string;channelId:string;peerScopeId:string;peerKind:'guest'|'agent';
    revision:string;expiresAt:number;recipients:Array<{deviceId:string;generation:number;keyId:string;publicBundle:unknown}>}):void{
    const now=Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try{
      this.db.prepare(`UPDATE e2ee_v2_remote_devices SET status='stale',verified_at=?
        WHERE local_agent_id=? AND channel_id=?`).run(now,input.localAgentId,input.channelId);
      const upsert=this.db.prepare(`INSERT INTO e2ee_v2_remote_devices(local_agent_id,channel_id,peer_scope_id,
        peer_kind,device_id,generation,key_id,public_bundle_json,revision,status,verified_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?,'active',?,?) ON CONFLICT(local_agent_id,channel_id,device_id) DO UPDATE SET
        peer_scope_id=excluded.peer_scope_id,peer_kind=excluded.peer_kind,generation=excluded.generation,
        key_id=excluded.key_id,public_bundle_json=excluded.public_bundle_json,revision=excluded.revision,
        status='active',verified_at=excluded.verified_at,expires_at=excluded.expires_at`);
      for(const recipient of input.recipients)upsert.run(input.localAgentId,input.channelId,input.peerScopeId,
        input.peerKind,recipient.deviceId,recipient.generation,recipient.keyId,JSON.stringify(recipient.publicBundle),
        input.revision,now,input.expiresAt);
      this.db.exec('COMMIT');
    }catch(error){try{this.db.exec('ROLLBACK');}catch{}throw error;}
  }

  activeRecipients(localAgentId:string,channelId:string,now=Date.now()):E2eeV2RemoteDeviceRow[]{
    return this.db.prepare(`SELECT * FROM e2ee_v2_remote_devices WHERE local_agent_id=? AND channel_id=?
      AND status='active' AND expires_at>? ORDER BY device_id`).all(localAgentId,channelId,now) as E2eeV2RemoteDeviceRow[];
  }

  createOutbound(input:{businessMessageId:string;localAgentId:string;channelId:string;routingConversationId?:string;
    protocolConversationId:string;contentKind:string;recipientRevision:string;plaintextDigest:string;
    envelopes:Array<{recipientDeviceId:string;recipientKeyId:string;transportMessageId:string;fixedEnvelopeJson:string}>;
    conversation:{wireConversationKey?:string;peerScopeId:string;peerKind:'guest'|'agent'};
    initialLeaseOwner?:string;
    attachment?:{uploadId:string;manifestJson:string;ciphertextSha256:string;ciphertextSize:number;
      mediaMetadata:Record<string,unknown>};
    sourceReceiptMessageId?:string}):void{
    const existing=this.db.prepare('SELECT plaintext_digest FROM e2ee_v2_outbound_messages WHERE business_message_id=?')
      .get(input.businessMessageId) as {plaintext_digest?:string}|undefined;
    if(existing){
      if(existing.plaintext_digest!==input.plaintextDigest)throw new Error('E2EE_V2_OUTBOUND_ID_CONFLICT');
      this.saveConversation({localAgentId:input.localAgentId,channelId:input.channelId,
        routingConversationId:input.routingConversationId,wireConversationKey:input.conversation.wireConversationKey,
        protocolConversationId:input.protocolConversationId,peerScopeId:input.conversation.peerScopeId,
        peerKind:input.conversation.peerKind,mode:'e2ee_active',recipientRevision:input.recipientRevision});
      if(input.sourceReceiptMessageId)this.completeReceiptWithOutbound(input.sourceReceiptMessageId,input.businessMessageId);
      return;
    }
    const now=Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try{
      this.db.prepare(`INSERT INTO e2ee_v2_outbound_messages(business_message_id,local_agent_id,channel_id,
        routing_conversation_id,protocol_conversation_id,content_kind,security_mode,recipient_revision,state,
        plaintext_digest,created_at,updated_at) VALUES(?,?,?,?,?,?,'e2ee',?,'pending',?,?,?)`)
        .run(input.businessMessageId,input.localAgentId,input.channelId,input.routingConversationId||'',
          input.protocolConversationId,input.contentKind,input.recipientRevision,input.plaintextDigest,now,now);
      const insert=this.db.prepare(`INSERT INTO e2ee_v2_outbound_envelopes(business_message_id,
        recipient_device_id,recipient_key_id,transport_message_id,fixed_envelope_json,state,lease_owner,
        lease_expires_at,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
      const initialState=input.initialLeaseOwner?'sending':'pending';
      for(const envelope of input.envelopes)insert.run(input.businessMessageId,envelope.recipientDeviceId,
        envelope.recipientKeyId,envelope.transportMessageId,envelope.fixedEnvelopeJson,initialState,
        input.initialLeaseOwner||null,input.initialLeaseOwner?now+60_000:null,input.initialLeaseOwner?1:0,now,now);
      if(input.attachment){
        const manifest=JSON.parse(input.attachment.manifestJson);
        if(typeof manifest?.cek!=='string')throw new Error('E2EE_V2_ATTACHMENT_MANIFEST_INVALID');
        this.db.prepare(`INSERT INTO e2ee_v2_outbound_attachments(business_message_id,upload_id,
          encrypted_manifest,encrypted_cek,ciphertext_sha256,ciphertext_size,media_metadata_json,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?)`).run(input.businessMessageId,input.attachment.uploadId,
          encryptBundle(this.wrappingKey,input.attachment.manifestJson),encryptBundle(this.wrappingKey,manifest.cek),
          input.attachment.ciphertextSha256,input.attachment.ciphertextSize,
          JSON.stringify(input.attachment.mediaMetadata),now,now);
      }
      this.saveConversation({localAgentId:input.localAgentId,channelId:input.channelId,
        routingConversationId:input.routingConversationId,wireConversationKey:input.conversation.wireConversationKey,
        protocolConversationId:input.protocolConversationId,peerScopeId:input.conversation.peerScopeId,
        peerKind:input.conversation.peerKind,mode:'e2ee_active',recipientRevision:input.recipientRevision});
      if(input.sourceReceiptMessageId){
        const completed=this.db.prepare(`UPDATE e2ee_v2_receipts SET state='completed',reply_message_id=?,
          reply_envelope_json=NULL,error_code=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=?
          WHERE message_id=? AND state='provider_accepted'`)
          .run(input.businessMessageId,now,input.sourceReceiptMessageId);
        if(completed.changes!==1)throw new Error('E2EE_V2_PROVIDER_STATE_CONFLICT');
      }
      this.db.exec('COMMIT');
    }catch(error){try{this.db.exec('ROLLBACK');}catch{}throw error;}
  }

  private completeReceiptWithOutbound(messageId:string,businessMessageId:string):void{
    const existing=this.receipt(messageId);
    if(existing?.state==='completed'&&existing.reply_message_id===businessMessageId)return;
    const result=this.db.prepare(`UPDATE e2ee_v2_receipts SET state='completed',reply_message_id=?,
      reply_envelope_json=NULL,error_code=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=?
      WHERE message_id=? AND state='provider_accepted'`).run(businessMessageId,Date.now(),messageId);
    if(result.changes!==1)throw new Error('E2EE_V2_PROVIDER_STATE_CONFLICT');
  }

  outboundEnvelopes(businessMessageId:string):E2eeV2OutboundEnvelopeRow[]{
    return this.db.prepare(`SELECT * FROM e2ee_v2_outbound_envelopes WHERE business_message_id=?
      ORDER BY recipient_device_id`).all(businessMessageId) as E2eeV2OutboundEnvelopeRow[];
  }

  outboundMessage(businessMessageId:string):{local_agent_id:string;channel_id:string;state:E2eeV2OutboundState;
    projected_at:number|null}|null{
    return(this.db.prepare(`SELECT local_agent_id,channel_id,state,projected_at FROM e2ee_v2_outbound_messages
      WHERE business_message_id=?`).get(businessMessageId) as any)||null;
  }

  deliveredUnprojected(limit=100):Array<{business_message_id:string;local_agent_id:string}>{
    return this.db.prepare(`SELECT business_message_id,local_agent_id FROM e2ee_v2_outbound_messages
      WHERE state='sent' AND projected_at IS NULL ORDER BY updated_at LIMIT ?`).all(limit) as any;
  }

  markOutboundProjected(businessMessageId:string):void{
    this.db.prepare(`UPDATE e2ee_v2_outbound_messages SET projected_at=?,updated_at=?
      WHERE business_message_id=? AND state='sent'`).run(Date.now(),Date.now(),businessMessageId);
  }

  markOutboundsProjected(businessMessageIds:string[]):void{
    const ids=[...new Set(businessMessageIds.filter(Boolean))];
    if(!ids.length)return;
    const now=Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const update=this.db.prepare(`UPDATE e2ee_v2_outbound_messages SET projected_at=?,updated_at=?
        WHERE business_message_id=? AND state='sent'`);
      for(const id of ids)update.run(now,now,id);
      this.db.exec('COMMIT');
    }catch(error){try{this.db.exec('ROLLBACK');}catch{}throw error;}
  }

  outboundAttachment(businessMessageId:string):E2eeV2OutboundAttachmentRow|null{
    const row=this.db.prepare(`SELECT * FROM e2ee_v2_outbound_attachments WHERE business_message_id=?`)
      .get(businessMessageId) as any;
    if(!row)return null;
    return{business_message_id:row.business_message_id,upload_id:row.upload_id,
      manifest_json:decryptBundle(this.wrappingKey,row.encrypted_manifest),
      cek:decryptBundle(this.wrappingKey,row.encrypted_cek),ciphertext_sha256:row.ciphertext_sha256,
      ciphertext_size:Number(row.ciphertext_size),media_metadata_json:row.media_metadata_json,
      created_at:Number(row.created_at),updated_at:Number(row.updated_at)};
  }

  claimOutbound(transportMessageId:string,owner:string,leaseMs=60_000):boolean{
    const now=Date.now();
    return this.db.prepare(`UPDATE e2ee_v2_outbound_envelopes SET state='sending',lease_owner=?,
      lease_expires_at=?,attempts=attempts+1,updated_at=? WHERE transport_message_id=?
      AND state IN ('pending','outcome_unknown','sending') AND (lease_expires_at IS NULL OR lease_expires_at<?)`)
      .run(owner,now+leaseMs,now,transportMessageId,now).changes===1;
  }

  finishOutbound(transportMessageId:string,owner:string,state:'sent'|'pending'|'outcome_unknown'|'failed',error?:string):void{
    this.db.prepare(`UPDATE e2ee_v2_outbound_envelopes SET state=?,lease_owner=NULL,lease_expires_at=NULL,
      last_error=?,updated_at=? WHERE transport_message_id=? AND lease_owner=?`)
      .run(state,error||null,Date.now(),transportMessageId,owner);
    const envelope=this.db.prepare('SELECT business_message_id FROM e2ee_v2_outbound_envelopes WHERE transport_message_id=?')
      .get(transportMessageId) as {business_message_id?:string}|undefined;
    if(envelope?.business_message_id)this.refreshOutboundMessage(envelope.business_message_id);
  }

  finishOutbounds(rows:Array<{transportMessageId:string;owner:string;
    state:'sent'|'pending'|'outcome_unknown'|'failed';error?:string}>):void{
    if(!rows.length)return;
    const now=Date.now();
    const affected=new Set<string>();
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const update=this.db.prepare(`UPDATE e2ee_v2_outbound_envelopes SET state=?,lease_owner=NULL,
        lease_expires_at=NULL,last_error=?,updated_at=? WHERE transport_message_id=? AND lease_owner=?`);
      const parent=this.db.prepare(`SELECT business_message_id FROM e2ee_v2_outbound_envelopes
        WHERE transport_message_id=?`);
      for(const row of rows){
        const changed=update.run(row.state,row.error||null,now,row.transportMessageId,row.owner).changes===1;
        if(!changed)continue;
        const message=parent.get(row.transportMessageId) as {business_message_id?:string}|undefined;
        if(message?.business_message_id)affected.add(message.business_message_id);
      }
      for(const businessMessageId of affected)this.refreshOutboundMessage(businessMessageId);
      this.db.exec('COMMIT');
    }catch(error){try{this.db.exec('ROLLBACK');}catch{}throw error;}
  }

  private refreshOutboundMessage(businessMessageId:string):void{
    const counts=this.db.prepare(`SELECT COUNT(*) AS total,SUM(state='sent') AS sent,
      SUM(state='failed') AS failed,SUM(state='outcome_unknown') AS unknown
      FROM e2ee_v2_outbound_envelopes WHERE business_message_id=?`).get(businessMessageId) as any;
    const state=Number(counts?.total||0)>0&&Number(counts?.sent||0)===Number(counts?.total||0)?'sent'
      :Number(counts?.failed||0)===Number(counts?.total||0)?'failed'
        :Number(counts?.unknown||0)>0?'outcome_unknown':'pending';
    this.db.prepare('UPDATE e2ee_v2_outbound_messages SET state=?,updated_at=? WHERE business_message_id=?')
      .run(state,Date.now(),businessMessageId);
  }

  recoverableOutbound(limit=100):E2eeV2OutboundEnvelopeRow[]{
    return this.db.prepare(`SELECT * FROM e2ee_v2_outbound_envelopes WHERE state IN ('pending','outcome_unknown')
      OR (state='sending' AND lease_expires_at<?) ORDER BY created_at LIMIT ?`)
      .all(Date.now(),limit) as E2eeV2OutboundEnvelopeRow[];
  }

  saveAttachment(input:{messageId:string;uploadId:string;localAgentId:string;channelId:string;
    fileName:string;mediaType:string;sha256:string;bytes:Uint8Array}):E2eeV2AttachmentRow{
    const existing=this.attachment(input.messageId);if(existing)return existing;
    const root=path.join(path.dirname(this.databasePath),'e2ee-v2-attachments');
    fs.mkdirSync(root,{recursive:true,mode:0o700});
    const localPath=path.join(root,`${crypto.createHash('sha256').update(input.messageId).digest('hex')}.bin`);
    const temporary=`${localPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary,Buffer.from(input.bytes),{flag:'wx',mode:0o600});
    try{
      fs.renameSync(temporary,localPath);
      const createdAt=Date.now();
      this.db.prepare(`INSERT INTO e2ee_v2_attachments(message_id,upload_id,local_agent_id,channel_id,file_name,
        media_type,size,sha256,local_path,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
          input.messageId,input.uploadId,input.localAgentId,input.channelId,input.fileName,input.mediaType,
          input.bytes.byteLength,input.sha256,localPath,createdAt);
      return this.attachment(input.messageId)!;
    }catch(error){try{fs.unlinkSync(temporary);}catch{}try{if(!this.attachment(input.messageId))fs.unlinkSync(localPath);}catch{}throw error;}
  }

  attachment(messageId:string):E2eeV2AttachmentRow|null{
    return(this.db.prepare('SELECT * FROM e2ee_v2_attachments WHERE message_id=?').get(messageId) as E2eeV2AttachmentRow|undefined)||null;
  }

  closeAmbiguousExecutions(): number {
    return this.db.prepare(`UPDATE e2ee_v2_receipts SET state='outcome_unknown',error_code='E2EE_V2_PROVIDER_OUTCOME_UNKNOWN',
      lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE state IN ('processing','provider_accepted') AND reply_envelope_json IS NULL`)
      .run(Date.now()).changes;
  }
}

module.exports = { E2eeV2Store };
