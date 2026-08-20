import type { DatabaseLike } from '../types/database';

export interface ProductionE2eeScope {
  localAgentId: string;
  serverAgentId: string;
  targetAgentDid: string;
  creatorPrincipalId: string;
  senderDeviceKeyId: string;
  recipientDeviceKeyId: string;
  ownerScope: string;
  groupId: string;
  conversationScope: string;
  bindingGeneration: number;
}

export class ProductionE2eeStore {
  constructor(private readonly db: DatabaseLike) {
    db.exec(`CREATE TABLE IF NOT EXISTS e2ee_production_meta(
      key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS e2ee_production_sessions(
      group_id TEXT PRIMARY KEY,
      local_agent_id TEXT NOT NULL,
      server_agent_id TEXT NOT NULL,
      target_agent_did TEXT NOT NULL,
      creator_principal_id TEXT NOT NULL,
      sender_device_key_id TEXT,
      recipient_device_key_id TEXT NOT NULL,
      owner_scope TEXT NOT NULL,
      conversation_scope TEXT NOT NULL,
      binding_generation INTEGER NOT NULL,
      encrypted_state BLOB NOT NULL,
      state_version INTEGER NOT NULL DEFAULT 1,
      mode TEXT NOT NULL DEFAULT 'e2ee_active',
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(local_agent_id,creator_principal_id,conversation_scope),
      UNIQUE(recipient_device_key_id,group_id));
    CREATE INDEX IF NOT EXISTS idx_e2ee_production_scope
      ON e2ee_production_sessions(local_agent_id,creator_principal_id,conversation_scope,status);
    CREATE TABLE IF NOT EXISTS e2ee_production_key_packages(
      local_agent_id TEXT PRIMARY KEY,
      server_agent_id TEXT NOT NULL,
      target_agent_did TEXT NOT NULL,
      owner_device_key_id TEXT NOT NULL,
      owner_scope TEXT NOT NULL,
      key_epoch INTEGER NOT NULL,
      key_package_ref TEXT NOT NULL,
      key_package TEXT NOT NULL,
      encrypted_pending_state BLOB NOT NULL,
      publish_state TEXT NOT NULL,
      updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS e2ee_production_establishments(
      establishment_id TEXT PRIMARY KEY,
      local_agent_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      ack_json TEXT NOT NULL,
      ack_state TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS e2ee_production_receipts(
      message_id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      cipher_digest TEXT NOT NULL,
      state TEXT NOT NULL,
      encrypted_reply TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_e2ee_production_receipts_state
      ON e2ee_production_receipts(state,updated_at);`);
  }

  deviceGeneration(create: () => string): string {
    const existing = this.db.prepare("SELECT value FROM e2ee_production_meta WHERE key='device_generation'").get() as any;
    if (existing?.value) return String(existing.value);
    const value = create();
    this.db.prepare("INSERT OR IGNORE INTO e2ee_production_meta(key,value,updated_at) VALUES('device_generation',?,?)")
      .run(value,Date.now());
    return String((this.db.prepare("SELECT value FROM e2ee_production_meta WHERE key='device_generation'").get() as any).value);
  }

  deviceKeyEpoch(localAgentId: string): number {
    const row = this.db.prepare('SELECT value FROM e2ee_production_meta WHERE key=?')
      .get(`device_key_epoch:${localAgentId}`) as any;
    const value = Number(row?.value || 1);
    return Number.isSafeInteger(value) && value > 0 ? value : 1;
  }

  setDeviceKeyEpoch(localAgentId: string, epoch: number): void {
    if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error('E2EE_DEVICE_EPOCH_INVALID');
    const current = this.deviceKeyEpoch(localAgentId);
    if (epoch < current) throw new Error('E2EE_DEVICE_EPOCH_ROLLBACK');
    this.db.prepare(`INSERT INTO e2ee_production_meta(key,value,updated_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
      .run(`device_key_epoch:${localAgentId}`,String(epoch),Date.now());
  }

  session(groupId: string): any {
    return this.db.prepare('SELECT * FROM e2ee_production_sessions WHERE group_id=?').get(groupId);
  }

  resolve(localAgentId: string, groupId: string, creatorPrincipalId: string, conversationScope: string): any {
    return this.db.prepare(`SELECT * FROM e2ee_production_sessions
      WHERE local_agent_id=? AND group_id=? AND creator_principal_id=? AND conversation_scope=? AND status='active'`)
      .get(localAgentId,groupId,creatorPrincipalId,conversationScope);
  }

  keyPackage(localAgentId: string): any {
    return this.db.prepare('SELECT * FROM e2ee_production_key_packages WHERE local_agent_id=?').get(localAgentId);
  }

  saveKeyPackage(input: any): void {
    this.setDeviceKeyEpoch(input.localAgentId,Number(input.keyEpoch));
    this.db.prepare(`INSERT INTO e2ee_production_key_packages(local_agent_id,server_agent_id,target_agent_did,
      owner_device_key_id,owner_scope,key_epoch,key_package_ref,key_package,encrypted_pending_state,publish_state,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(local_agent_id) DO UPDATE SET
      server_agent_id=excluded.server_agent_id,target_agent_did=excluded.target_agent_did,
      owner_device_key_id=excluded.owner_device_key_id,owner_scope=excluded.owner_scope,key_epoch=excluded.key_epoch,
      key_package_ref=excluded.key_package_ref,key_package=excluded.key_package,
      encrypted_pending_state=excluded.encrypted_pending_state,publish_state=excluded.publish_state,
      updated_at=excluded.updated_at`).run(input.localAgentId,input.serverAgentId,input.targetAgentDid,
      input.ownerDeviceKeyId,input.ownerScope,input.keyEpoch,input.keyPackageRef,input.keyPackage,
      input.encryptedPendingState,input.publishState,Date.now());
  }

  markKeyPackagePublished(localAgentId: string, keyPackageRef: string): void {
    const result = this.db.prepare(`UPDATE e2ee_production_key_packages SET publish_state='published',updated_at=?
      WHERE local_agent_id=? AND key_package_ref=?`).run(Date.now(),localAgentId,keyPackageRef) as any;
    if (Number(result?.changes) !== 1) throw new Error('E2EE_KEY_PACKAGE_CAS_CONFLICT');
  }

  commitEstablishment(input: { establishmentId: string; scope: ProductionE2eeScope; encryptedState: Uint8Array;
    acknowledgement: unknown; nextKeyPackage: any }): 'created'|'duplicate' {
    const existing = this.db.prepare('SELECT group_id FROM e2ee_production_establishments WHERE establishment_id=?')
      .get(input.establishmentId) as any;
    if (existing) {
      if (existing.group_id !== input.scope.groupId) throw new Error('E2EE_ESTABLISHMENT_ID_CONFLICT');
      return 'duplicate';
    }
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT INTO e2ee_production_sessions(group_id,local_agent_id,server_agent_id,target_agent_did,
        creator_principal_id,sender_device_key_id,recipient_device_key_id,owner_scope,conversation_scope,
        binding_generation,encrypted_state,state_version,mode,status,created_at,updated_at)
        VALUES(?,?,?,?,?,NULL,?,?,?,?,?,1,'e2ee_active','active',?,?)`)
        .run(input.scope.groupId,input.scope.localAgentId,input.scope.serverAgentId,input.scope.targetAgentDid,
          input.scope.creatorPrincipalId,input.scope.recipientDeviceKeyId,input.scope.ownerScope,
          input.scope.conversationScope,input.scope.bindingGeneration,input.encryptedState,now,now);
      this.db.prepare(`INSERT INTO e2ee_production_establishments(establishment_id,local_agent_id,group_id,ack_json,
        ack_state,created_at,updated_at) VALUES(?,?,?,?,'pending',?,?)`)
        .run(input.establishmentId,input.scope.localAgentId,input.scope.groupId,JSON.stringify(input.acknowledgement),now,now);
      this.saveKeyPackage(input.nextKeyPackage);
      this.db.exec('COMMIT');
      return 'created';
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  pendingAcknowledgements(): any[] {
    return this.db.prepare(`SELECT * FROM e2ee_production_establishments WHERE ack_state='pending' ORDER BY created_at`).all() as any[];
  }

  establishment(establishmentId: string): any {
    return this.db.prepare('SELECT * FROM e2ee_production_establishments WHERE establishment_id=?').get(establishmentId);
  }

  markAcknowledged(establishmentId: string): void {
    this.db.prepare(`UPDATE e2ee_production_establishments SET ack_state='acknowledged',updated_at=?
      WHERE establishment_id=?`).run(Date.now(),establishmentId);
  }

  reserve(scope: ProductionE2eeScope, messageId: string, digest: string): 'new'|'duplicate' {
    const existing = this.db.prepare('SELECT cipher_digest FROM e2ee_production_receipts WHERE message_id=?').get(messageId) as any;
    if (existing) {
      if (existing.cipher_digest !== digest) throw new Error('E2EE_MESSAGE_ID_CONFLICT');
      return 'duplicate';
    }
    const now = Date.now();
    this.db.prepare(`INSERT INTO e2ee_production_receipts(message_id,group_id,cipher_digest,state,created_at,updated_at)
      VALUES(?,?,?,'received',?,?)`).run(messageId,scope.groupId,digest,now,now);
    return 'new';
  }

  bindSenderDevice(groupId: string, senderDeviceKeyId: string): void {
    const row = this.session(groupId);
    if (!row || row.status !== 'active') throw new Error('E2EE_SESSION_NOT_ACTIVE');
    if (row.sender_device_key_id && row.sender_device_key_id !== senderDeviceKeyId) {
      throw new Error('E2EE_SENDER_DEVICE_CHANGED');
    }
    this.db.prepare(`UPDATE e2ee_production_sessions SET sender_device_key_id=COALESCE(sender_device_key_id,?),updated_at=?
      WHERE group_id=?`).run(senderDeviceKeyId,Date.now(),groupId);
  }

  commitState(groupId: string, expectedVersion: number, encryptedState: Uint8Array, nextVersion: number): void {
    const result = this.db.prepare(`UPDATE e2ee_production_sessions SET encrypted_state=?,state_version=?,updated_at=?
      WHERE group_id=? AND state_version=? AND status='active'`).run(encryptedState,nextVersion,Date.now(),groupId,expectedVersion) as any;
    if (Number(result?.changes) !== 1) throw new Error('E2EE_STATE_CAS_CONFLICT');
  }

  transition(messageId: string, from: string[], to: string, encryptedReply?: string): void {
    const placeholders = from.map(() => '?').join(',');
    const result = this.db.prepare(`UPDATE e2ee_production_receipts SET state=?,encrypted_reply=COALESCE(?,encrypted_reply),updated_at=?
      WHERE message_id=? AND state IN (${placeholders})`).run(to,encryptedReply || null,Date.now(),messageId,...from) as any;
    if (Number(result?.changes) !== 1) throw new Error('E2EE_RECEIPT_CAS_CONFLICT');
  }

  isEmergencyDisabled(): boolean { return false; }
  diagnostics(): any {
    return {
      sessions: this.db.prepare('SELECT status,COUNT(*) count FROM e2ee_production_sessions GROUP BY status').all(),
      receipts: this.db.prepare('SELECT state,COUNT(*) count FROM e2ee_production_receipts GROUP BY state').all(),
    };
  }
}

module.exports = { ProductionE2eeStore };
