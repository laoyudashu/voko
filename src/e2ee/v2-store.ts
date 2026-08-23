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
    `);
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

  hasChannel(localAgentId:string,channelId:string):boolean{
    return Boolean(this.db.prepare(`SELECT 1 FROM e2ee_v2_receipts WHERE local_agent_id=? AND channel_id=? LIMIT 1`)
      .get(localAgentId,channelId));
  }

  closeAmbiguousExecutions(): number {
    return this.db.prepare(`UPDATE e2ee_v2_receipts SET state='outcome_unknown',error_code='E2EE_V2_PROVIDER_OUTCOME_UNKNOWN',
      lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE state IN ('processing','provider_accepted') AND reply_envelope_json IS NULL`)
      .run(Date.now()).changes;
  }
}

module.exports = { E2eeV2Store };
