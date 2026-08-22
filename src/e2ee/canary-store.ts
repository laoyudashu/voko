import type { DatabaseLike } from '../types/database';

export type CanaryReceiptState = 'received'|'provider_accepted'|'completed'|'failed'|'outcome_unknown'|'revoked';

export class CanaryStore {
  constructor(private readonly db: DatabaseLike) {
    db.exec(`CREATE TABLE IF NOT EXISTS e2ee_canary_sessions(
      group_id TEXT PRIMARY KEY,local_agent_id TEXT NOT NULL,target_agent_did TEXT NOT NULL,
      sender_device_key_id TEXT NOT NULL,conversation_scope TEXT NOT NULL,encrypted_state BLOB,
      state_version INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'initializing',updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS e2ee_canary_receipts(
      message_id TEXT PRIMARY KEY,group_id TEXT NOT NULL,cipher_digest TEXT NOT NULL,state TEXT NOT NULL,
      encrypted_reply TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_e2ee_canary_receipts_state ON e2ee_canary_receipts(state,updated_at);
      CREATE TABLE IF NOT EXISTS e2ee_canary_channels(
        local_agent_id TEXT NOT NULL,channel_id TEXT NOT NULL,group_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,PRIMARY KEY(local_agent_id,channel_id));
      CREATE TABLE IF NOT EXISTS e2ee_canary_attachments(
        upload_id TEXT PRIMARY KEY,local_agent_id TEXT NOT NULL,channel_id TEXT NOT NULL,
        group_id TEXT NOT NULL,manifest_json TEXT NOT NULL,created_at INTEGER NOT NULL);`);
    db.exec(`CREATE TABLE IF NOT EXISTS e2ee_canary_control(
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),emergency_disabled INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL);`);
  }

  migrateLegacy(mainDb: DatabaseLike): { sessions: number; receipts: number } {
    const exists = (name: string) => Boolean(mainDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
    let sessions = 0;
    let receipts = 0;
    if (exists('e2ee_canary_sessions')) {
      for (const row of mainDb.prepare('SELECT * FROM e2ee_canary_sessions').all() as any[]) {
        const result = this.db.prepare(`INSERT OR IGNORE INTO e2ee_canary_sessions
          (group_id,local_agent_id,target_agent_did,sender_device_key_id,conversation_scope,encrypted_state,state_version,status,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?)`).run(row.group_id,row.local_agent_id,row.target_agent_did,row.sender_device_key_id,
          row.conversation_scope,row.encrypted_state,row.state_version,row.status,row.updated_at) as any;
        sessions += Number(result?.changes || 0);
      }
    }
    if (exists('e2ee_canary_receipts')) {
      for (const row of mainDb.prepare('SELECT * FROM e2ee_canary_receipts').all() as any[]) {
        const result = this.db.prepare(`INSERT OR IGNORE INTO e2ee_canary_receipts
          (message_id,group_id,cipher_digest,state,encrypted_reply,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`)
          .run(row.message_id,row.group_id,row.cipher_digest,row.state,row.encrypted_reply,row.created_at,row.updated_at) as any;
        receipts += Number(result?.changes || 0);
      }
    }
    return { sessions, receipts };
  }

  reserve(scope: any, messageId: string, digest: string): 'new'|'duplicate' {
    const now = Date.now();
    const existing = this.db.prepare('SELECT cipher_digest FROM e2ee_canary_receipts WHERE message_id=?').get(messageId) as any;
    if (existing) {
      if (existing.cipher_digest !== digest) throw new Error('E2EE_MESSAGE_ID_CONFLICT');
      return 'duplicate';
    }
    this.db.prepare(`INSERT INTO e2ee_canary_receipts(message_id,group_id,cipher_digest,state,created_at,updated_at)
      VALUES(?,?,?,'received',?,?)`).run(messageId,scope.groupId,digest,now,now);
    this.db.prepare(`INSERT INTO e2ee_canary_sessions(group_id,local_agent_id,target_agent_did,sender_device_key_id,conversation_scope,status,updated_at)
      VALUES(?,?,?,?,?,'initializing',?) ON CONFLICT(group_id) DO NOTHING`).run(scope.groupId,scope.localAgentId,
      scope.targetAgentDid,scope.senderDeviceKeyId,scope.conversationScope,now);
    return 'new';
  }

  session(groupId: string): any { return this.db.prepare('SELECT * FROM e2ee_canary_sessions WHERE group_id=?').get(groupId); }

  bindChannel(localAgentId: string, groupId: string, channelId: string): void {
    this.db.prepare(`INSERT INTO e2ee_canary_channels(local_agent_id,channel_id,group_id,updated_at)
      VALUES(?,?,?,?) ON CONFLICT(local_agent_id,channel_id) DO UPDATE SET group_id=excluded.group_id,updated_at=excluded.updated_at`)
      .run(localAgentId,channelId,groupId,Date.now());
  }

  isChannelActive(localAgentId: string, channelId: string): boolean {
    return Boolean(this.scopeForChannel(localAgentId,channelId));
  }

  scopeForChannel(localAgentId: string, channelId: string): any {
    return this.db.prepare(`SELECT s.* FROM e2ee_canary_channels c JOIN e2ee_canary_sessions s ON s.group_id=c.group_id
      WHERE c.local_agent_id=? AND c.channel_id=? AND s.status='active' LIMIT 1`).get(localAgentId,channelId);
  }

  saveAttachment(input: any): void {
    this.db.prepare(`INSERT INTO e2ee_canary_attachments
      (upload_id,local_agent_id,channel_id,group_id,manifest_json,created_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(upload_id) DO NOTHING`).run(input.uploadId,input.localAgentId,input.channelId,
      input.groupId,JSON.stringify(input.manifest),Date.now());
  }

  attachment(uploadId: string): any {
    return this.db.prepare('SELECT * FROM e2ee_canary_attachments WHERE upload_id=?').get(uploadId);
  }

  provision(scope: any, encryptedState: Uint8Array): void {
    const now = Date.now();
    this.db.prepare(`INSERT INTO e2ee_canary_sessions(group_id,local_agent_id,target_agent_did,sender_device_key_id,
      conversation_scope,encrypted_state,state_version,status,updated_at) VALUES(?,?,?,?,?,?,1,'active',?)
      ON CONFLICT(group_id) DO UPDATE SET encrypted_state=excluded.encrypted_state,state_version=1,status='active',updated_at=excluded.updated_at
      WHERE e2ee_canary_sessions.status='initializing'`).run(scope.groupId,scope.localAgentId,scope.targetAgentDid,
      scope.senderDeviceKeyId,scope.conversationScope,encryptedState,now);
  }

  commitState(groupId: string, expectedVersion: number, encryptedState: Uint8Array, nextVersion: number): void {
    const result = this.db.prepare(`UPDATE e2ee_canary_sessions SET encrypted_state=?,state_version=?,status='active',updated_at=?
      WHERE group_id=? AND state_version=? AND status IN ('initializing','active')`).run(encryptedState,nextVersion,Date.now(),groupId,expectedVersion) as any;
    if (Number(result?.changes) !== 1) throw new Error('E2EE_STATE_CAS_CONFLICT');
  }

  transition(messageId: string, from: CanaryReceiptState[], to: CanaryReceiptState, encryptedReply?: string): void {
    const placeholders = from.map(() => '?').join(',');
    const result = this.db.prepare(`UPDATE e2ee_canary_receipts SET state=?,encrypted_reply=COALESCE(?,encrypted_reply),updated_at=?
      WHERE message_id=? AND state IN (${placeholders})`).run(to,encryptedReply || null,Date.now(),messageId,...from) as any;
    if (Number(result?.changes) !== 1) throw new Error('E2EE_RECEIPT_CAS_CONFLICT');
  }

  lockAll(reason: 'revoked'|'failed' = 'revoked'): void {
    const now = Date.now();
    this.db.prepare("UPDATE e2ee_canary_sessions SET status='locked',updated_at=? WHERE status IN ('initializing','active')").run(now);
    this.db.prepare("UPDATE e2ee_canary_receipts SET state=?,updated_at=? WHERE state IN ('received','provider_accepted')").run(reason,now);
  }

  emergencyDisable(): void {
    this.lockAll('revoked');
    this.db.prepare(`INSERT INTO e2ee_canary_control(singleton,emergency_disabled,updated_at) VALUES(1,1,?)
      ON CONFLICT(singleton) DO UPDATE SET emergency_disabled=1,updated_at=excluded.updated_at`).run(Date.now());
  }

  isEmergencyDisabled(): boolean {
    return Number((this.db.prepare('SELECT emergency_disabled FROM e2ee_canary_control WHERE singleton=1').get() as any)?.emergency_disabled || 0) === 1;
  }

  diagnostics(): any {
    const sessions = this.db.prepare(`SELECT status,COUNT(*) count FROM e2ee_canary_sessions GROUP BY status`).all();
    const receipts = this.db.prepare(`SELECT state,COUNT(*) count FROM e2ee_canary_receipts GROUP BY state`).all();
    return { sessions, receipts };
  }
}

module.exports = { CanaryStore };
