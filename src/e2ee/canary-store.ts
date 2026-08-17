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
      CREATE INDEX IF NOT EXISTS idx_e2ee_canary_receipts_state ON e2ee_canary_receipts(state,updated_at);`);
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

  diagnostics(): any {
    const sessions = this.db.prepare(`SELECT status,COUNT(*) count FROM e2ee_canary_sessions GROUP BY status`).all();
    const receipts = this.db.prepare(`SELECT state,COUNT(*) count FROM e2ee_canary_receipts GROUP BY state`).all();
    return { sessions, receipts };
  }
}

module.exports = { CanaryStore };
