import type { DatabaseLike } from '../types/database';

export interface ProductionE2eeScope {
  localAgentId: string;
  serverAgentId: string;
  targetAgentDid: string;
  creatorPrincipalId: string;
  creatorDeviceBindingId: string;
  protocolMode: 'direct_v2'|'legacy_group_v1';
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
      creator_guest_device_uid TEXT,
      protocol_mode TEXT NOT NULL DEFAULT 'legacy_group_v1',
      sender_device_key_id TEXT,
      recipient_device_key_id TEXT NOT NULL,
      owner_scope TEXT NOT NULL,
      conversation_scope TEXT NOT NULL,
      binding_generation INTEGER NOT NULL,
      encrypted_state BLOB NOT NULL,
      state_version INTEGER NOT NULL DEFAULT 1,
      mls_epoch INTEGER NOT NULL DEFAULT 1,
      mode TEXT NOT NULL DEFAULT 'e2ee_active',
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(local_agent_id,creator_principal_id,conversation_scope),
      UNIQUE(recipient_device_key_id,group_id));
    CREATE INDEX IF NOT EXISTS idx_e2ee_production_scope
      ON e2ee_production_sessions(local_agent_id,creator_principal_id,conversation_scope,status);
    CREATE TABLE IF NOT EXISTS e2ee_production_session_senders(
      group_id TEXT NOT NULL REFERENCES e2ee_production_sessions(group_id) ON DELETE CASCADE,
      sender_device_key_id TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      revoked_at INTEGER,
      PRIMARY KEY(group_id,sender_device_key_id));
    CREATE TABLE IF NOT EXISTS e2ee_production_channels(
      local_agent_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      group_id TEXT NOT NULL UNIQUE REFERENCES e2ee_production_sessions(group_id) ON DELETE CASCADE,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(local_agent_id,channel_id));
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
      local_agent_id TEXT,
      channel_id TEXT,
      cipher_digest TEXT NOT NULL,
      state TEXT NOT NULL,
      reply_message_id TEXT,
      encrypted_reply TEXT,
      delivery_attempts INTEGER NOT NULL DEFAULT 0,
      delivery_lease_owner TEXT,
      delivery_lease_expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_e2ee_production_receipts_state
      ON e2ee_production_receipts(state,updated_at);
    CREATE TABLE IF NOT EXISTS e2ee_production_attachments(
      upload_id TEXT PRIMARY KEY,
      local_agent_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      created_at INTEGER NOT NULL);`);
    try { db.exec('ALTER TABLE e2ee_production_sessions ADD COLUMN mls_epoch INTEGER NOT NULL DEFAULT 1'); } catch {}
    try { db.exec("ALTER TABLE e2ee_production_sessions ADD COLUMN protocol_mode TEXT NOT NULL DEFAULT 'legacy_group_v1'"); } catch {}
    try { db.exec('ALTER TABLE e2ee_production_sessions ADD COLUMN creator_guest_device_uid TEXT'); } catch {}
    for (const definition of [
      'local_agent_id TEXT','channel_id TEXT','reply_message_id TEXT',
      'delivery_attempts INTEGER NOT NULL DEFAULT 0','delivery_lease_owner TEXT',
      'delivery_lease_expires_at INTEGER'
    ]) {
      try { db.exec(`ALTER TABLE e2ee_production_receipts ADD COLUMN ${definition}`); } catch {}
    }
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

  activeSessions(localAgentId:string):any[]{
    return this.db.prepare("SELECT * FROM e2ee_production_sessions WHERE local_agent_id=? AND status='active'").all(localAgentId) as any[];
  }

  applyEpoch(groupId:string,expectedEpoch:number,nextEpoch:number,encryptedState:Uint8Array,stateVersion:number):void{
    const result=this.db.prepare(`UPDATE e2ee_production_sessions SET encrypted_state=?,state_version=?,mls_epoch=?,updated_at=?
      WHERE group_id=? AND mls_epoch=? AND status='active'`).run(encryptedState,stateVersion,nextEpoch,Date.now(),groupId,expectedEpoch) as any;
    if(Number(result?.changes)!==1)throw new Error('E2EE_EPOCH_CAS_CONFLICT');
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
    const protocolMode = input.scope.protocolMode === 'direct_v2' ? 'direct_v2' : 'legacy_group_v1';
    const creatorDeviceBindingId = input.scope.creatorDeviceBindingId || null;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const replaced = this.db.prepare(`SELECT group_id FROM e2ee_production_sessions
        WHERE local_agent_id=? AND group_id<>? AND (
          (creator_principal_id=? AND conversation_scope=?) OR
          (?='direct_v2' AND protocol_mode='direct_v2' AND creator_guest_device_uid=?))`)
        .all(input.scope.localAgentId,input.scope.groupId,input.scope.creatorPrincipalId,input.scope.conversationScope,
          protocolMode,creatorDeviceBindingId) as any[];
      for (const previous of replaced) {
        this.db.prepare('DELETE FROM e2ee_production_receipts WHERE group_id=?').run(previous.group_id);
        this.db.prepare('DELETE FROM e2ee_production_sessions WHERE group_id=?').run(previous.group_id);
      }
      this.db.prepare(`INSERT INTO e2ee_production_sessions(group_id,local_agent_id,server_agent_id,target_agent_did,
        creator_principal_id,creator_guest_device_uid,protocol_mode,sender_device_key_id,recipient_device_key_id,
        owner_scope,conversation_scope,binding_generation,encrypted_state,state_version,mode,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,NULL,?,?,?,?,?,1,'e2ee_active','active',?,?)`)
        .run(input.scope.groupId,input.scope.localAgentId,input.scope.serverAgentId,input.scope.targetAgentDid,
          input.scope.creatorPrincipalId,creatorDeviceBindingId,protocolMode,
          input.scope.recipientDeviceKeyId,input.scope.ownerScope,
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

  reserve(scope: ProductionE2eeScope, messageId: string, digest: string,
    route: { localAgentId?:string; channelId?:string } = {}): 'new'|'duplicate' {
    const existing = this.db.prepare('SELECT cipher_digest FROM e2ee_production_receipts WHERE message_id=?').get(messageId) as any;
    if (existing) {
      if (existing.cipher_digest !== digest) throw new Error('E2EE_MESSAGE_ID_CONFLICT');
      return 'duplicate';
    }
    const now = Date.now();
    this.db.prepare(`INSERT INTO e2ee_production_receipts
      (message_id,group_id,local_agent_id,channel_id,cipher_digest,state,created_at,updated_at)
      VALUES(?,?,?,?,?,'received',?,?)`).run(messageId,scope.groupId,
        route.localAgentId || scope.localAgentId,route.channelId || null,digest,now,now);
    return 'new';
  }

  receipt(messageId: string): any {
    return this.db.prepare('SELECT * FROM e2ee_production_receipts WHERE message_id=?').get(messageId);
  }

  claim(messageId: string, staleAfterMs = 5 * 60 * 1000): 'claimed'|'busy'|'deliver'|'completed'|'terminal' {
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.receipt(messageId);
      if (!row) throw new Error('E2EE_RECEIPT_NOT_FOUND');
      if (row.state === 'completed') { this.db.exec('COMMIT'); return 'completed'; }
      if (row.state === 'reply_ready' || row.state === 'outcome_unknown') {
        this.db.exec('COMMIT'); return 'deliver';
      }
      if (row.state === 'processing' && now - Number(row.updated_at || 0) < staleAfterMs) {
        this.db.exec('COMMIT'); return 'busy';
      }
      if (!['received','processing','provider_accepted','failed'].includes(String(row.state))) {
        this.db.exec('COMMIT'); return 'terminal';
      }
      const result = this.db.prepare(`UPDATE e2ee_production_receipts SET state='processing',updated_at=?
        WHERE message_id=? AND state=? AND updated_at=?`).run(now,messageId,row.state,row.updated_at) as any;
      if (Number(result?.changes) !== 1) { this.db.exec('ROLLBACK'); return 'busy'; }
      this.db.exec('COMMIT');
      return 'claimed';
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  commitReply(input: { messageId:string; groupId:string; expectedVersion:number; encryptedState:Uint8Array;
    nextVersion:number; replyMessageId:string; encryptedReply:string }): void {
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const state = this.db.prepare(`UPDATE e2ee_production_sessions SET encrypted_state=?,state_version=?,updated_at=?
        WHERE group_id=? AND state_version=? AND status='active'`)
        .run(input.encryptedState,input.nextVersion,now,input.groupId,input.expectedVersion) as any;
      if (Number(state?.changes) !== 1) throw new Error('E2EE_STATE_CAS_CONFLICT');
      const receipt = this.db.prepare(`UPDATE e2ee_production_receipts
        SET state='reply_ready',reply_message_id=?,encrypted_reply=?,updated_at=?
        WHERE message_id=? AND group_id=? AND state='provider_accepted'`)
        .run(input.replyMessageId,input.encryptedReply,now,input.messageId,input.groupId) as any;
      if (Number(receipt?.changes) !== 1) throw new Error('E2EE_RECEIPT_CAS_CONFLICT');
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  pendingReplies(limit = 50): any[] {
    const bounded = Math.max(1,Math.min(100,Number(limit) || 50));
    return this.db.prepare(`SELECT * FROM e2ee_production_receipts
      WHERE state IN ('reply_ready','outcome_unknown') AND encrypted_reply IS NOT NULL
        AND reply_message_id IS NOT NULL AND local_agent_id IS NOT NULL AND channel_id IS NOT NULL
        AND (delivery_lease_owner IS NULL OR delivery_lease_expires_at IS NULL OR delivery_lease_expires_at<=?)
      ORDER BY updated_at LIMIT ${bounded}`).all(Date.now()) as any[];
  }

  claimDelivery(messageId: string, leaseOwner: string, leaseMs = 60_000): boolean {
    if (!leaseOwner) throw new Error('E2EE_DELIVERY_LEASE_OWNER_INVALID');
    const now = Date.now();
    const result = this.db.prepare(`UPDATE e2ee_production_receipts
      SET delivery_lease_owner=?,delivery_lease_expires_at=?,delivery_attempts=delivery_attempts+1,updated_at=?
      WHERE message_id=? AND state IN ('reply_ready','outcome_unknown')
        AND (delivery_lease_owner IS NULL OR delivery_lease_expires_at IS NULL OR delivery_lease_expires_at<=?)`)
      .run(leaseOwner,now+Math.max(1,leaseMs),now,messageId,now) as any;
    return Number(result?.changes) === 1;
  }

  finishDelivery(messageId: string, leaseOwner: string, delivered: boolean): boolean {
    const state = delivered ? 'completed' : 'outcome_unknown';
    const result = this.db.prepare(`UPDATE e2ee_production_receipts
      SET state=?,delivery_lease_owner=NULL,delivery_lease_expires_at=NULL,updated_at=?
      WHERE message_id=? AND delivery_lease_owner=? AND state IN ('reply_ready','outcome_unknown')`)
      .run(state,Date.now(),messageId,leaseOwner) as any;
    return Number(result?.changes) === 1;
  }

  bindSenderDevice(groupId: string, senderDeviceKeyId: string): void {
    const row = this.session(groupId);
    if (!row || row.status !== 'active') throw new Error('E2EE_SESSION_NOT_ACTIVE');
    if (!senderDeviceKeyId) throw new Error('E2EE_SENDER_DEVICE_INVALID');
    if (row.protocol_mode === 'direct_v2' && row.sender_device_key_id
        && row.sender_device_key_id !== senderDeviceKeyId) throw new Error('E2EE_SENDER_DEVICE_CHANGED');
    const now=Date.now();
    const member=this.db.prepare(`SELECT revoked_at FROM e2ee_production_session_senders WHERE group_id=? AND sender_device_key_id=?`)
      .get(groupId,senderDeviceKeyId) as any;
    if(member?.revoked_at)throw new Error('E2EE_SENDER_DEVICE_REVOKED');
    this.db.prepare(`INSERT INTO e2ee_production_session_senders(group_id,sender_device_key_id,first_seen_at,last_seen_at)
      VALUES(?,?,?,?) ON CONFLICT(group_id,sender_device_key_id) DO UPDATE SET last_seen_at=excluded.last_seen_at`)
      .run(groupId,senderDeviceKeyId,now,now);
    this.db.prepare(`UPDATE e2ee_production_sessions SET sender_device_key_id=COALESCE(sender_device_key_id,?),updated_at=?
      WHERE group_id=?`).run(senderDeviceKeyId,Date.now(),groupId);
  }

  bindChannel(localAgentId: string, groupId: string, channelId: string): void {
    const row = this.session(groupId);
    if (!row || row.status !== 'active' || row.local_agent_id !== localAgentId || !channelId) {
      throw new Error('E2EE_CHANNEL_BINDING_INVALID');
    }
    this.db.prepare(`INSERT INTO e2ee_production_channels(local_agent_id,channel_id,group_id,updated_at)
      VALUES(?,?,?,?) ON CONFLICT(local_agent_id,channel_id) DO UPDATE SET
      group_id=excluded.group_id,updated_at=excluded.updated_at`)
      .run(localAgentId,channelId,groupId,Date.now());
  }

  isChannelActive(localAgentId: string, channelId: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM e2ee_production_channels c
      JOIN e2ee_production_sessions s ON s.group_id=c.group_id
      WHERE c.local_agent_id=? AND c.channel_id=? AND s.status='active' LIMIT 1`)
      .get(localAgentId,channelId));
  }

  scopeForChannel(localAgentId: string, channelId: string): any {
    return this.db.prepare(`SELECT s.* FROM e2ee_production_channels c
      JOIN e2ee_production_sessions s ON s.group_id=c.group_id
      WHERE c.local_agent_id=? AND c.channel_id=? AND s.status='active' LIMIT 1`)
      .get(localAgentId,channelId);
  }

  saveAttachment(input: any): void {
    this.db.prepare(`INSERT INTO e2ee_production_attachments
      (upload_id,local_agent_id,channel_id,group_id,manifest_json,created_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(upload_id) DO NOTHING`).run(input.uploadId,input.localAgentId,input.channelId,
      input.groupId,JSON.stringify(input.manifest),Date.now());
  }

  attachment(uploadId: string): any {
    return this.db.prepare('SELECT * FROM e2ee_production_attachments WHERE upload_id=?').get(uploadId);
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

  noteDeliveryAttempt(messageId: string): void {
    this.db.prepare(`UPDATE e2ee_production_receipts SET delivery_attempts=delivery_attempts+1,updated_at=?
      WHERE message_id=? AND state IN ('reply_ready','outcome_unknown')`).run(Date.now(),messageId);
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
