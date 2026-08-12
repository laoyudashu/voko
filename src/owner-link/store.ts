import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson } from './envelope';
import type { VokoOwnerEnvelope } from './envelope';

type OwnerCommandState = 'RECEIVED'|'VERIFIED'|'PERSISTED'|'DISPATCH_RESERVED'|'PROVIDER_ACCEPTED'|
  'COMPLETED'|'REJECTED'|'EXPIRED'|'FAILED_NOT_DELIVERED'|'OUTCOME_UNKNOWN';

interface PersistResult { status: 'inserted'|'duplicate'; state: OwnerCommandState }

class OwnerLinkSecurityError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'OwnerLinkSecurityError'; }
}

function digestDetails(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

class OwnerLinkStore {
  constructor(private readonly db: DatabaseSync) {}

  persistVerified(envelope: VokoOwnerEnvelope, observedImUid: string, now = Date.now()): PersistResult {
    if (!observedImUid || observedImUid.length > 192) throw new OwnerLinkSecurityError('OWNER_IM_UID_INVALID');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const byMessage = this.db.prepare('SELECT state,payload_digest FROM owner_link_commands WHERE message_id=?')
        .get(envelope.messageId) as { state: OwnerCommandState; payload_digest: string } | undefined;
      if (byMessage) {
        if (byMessage.payload_digest !== envelope.payloadDigest) {
          throw new OwnerLinkSecurityError('OWNER_MESSAGE_ID_DIGEST_CONFLICT');
        }
        this.db.exec('COMMIT');
        return { status: 'duplicate', state: byMessage.state };
      }
      const sequenceOwner = this.db.prepare('SELECT message_id,payload_digest FROM owner_link_commands WHERE conversation_id=? AND sequence=?')
        .get(envelope.ownerConversationId, envelope.sequence) as { message_id: string; payload_digest: string } | undefined;
      if (sequenceOwner) {
        throw new OwnerLinkSecurityError('OWNER_SEQUENCE_CONFLICT');
      }
      const sequenceRow = this.db.prepare('SELECT COALESCE(MAX(sequence),0) max_sequence FROM owner_link_commands WHERE conversation_id=?')
        .get(envelope.ownerConversationId) as { max_sequence?: number } | undefined;
      const maxSequence = Number(sequenceRow?.max_sequence || 0);
      if (envelope.sequence > maxSequence + 32 || (maxSequence > 32 && envelope.sequence <= maxSequence - 32)) {
        throw new OwnerLinkSecurityError('OWNER_SEQUENCE_WINDOW_EXCEEDED');
      }
      const binding = this.db.prepare('SELECT * FROM owner_link_identity_bindings WHERE conversation_id=?')
        .get(envelope.ownerConversationId) as any;
      if (!binding) {
        this.db.prepare(`INSERT INTO owner_link_identity_bindings
          (conversation_id,owner_identity_id,agent_id,observed_im_uid,ownership_epoch,conversation_epoch,status,created_at,updated_at)
          VALUES(?,?,?,?,?,?,'active',?,?)`).run(envelope.ownerConversationId, envelope.ownerIdentityId,
          envelope.agentId, observedImUid, envelope.ownershipEpoch, envelope.conversationEpoch, now, now);
      } else if (binding.status !== 'active' || binding.owner_identity_id !== envelope.ownerIdentityId
        || binding.agent_id !== envelope.agentId || binding.observed_im_uid !== observedImUid
        || Number(binding.ownership_epoch) !== envelope.ownershipEpoch
        || Number(binding.conversation_epoch) !== envelope.conversationEpoch) {
        throw new OwnerLinkSecurityError('OWNER_BINDING_MISMATCH');
      }
      this.db.prepare(`INSERT INTO owner_link_commands
        (message_id,conversation_id,sequence,agent_id,payload_digest,payload_json,state,expires_at,created_at,updated_at,
         operation,owner_identity_id,observed_im_uid,ownership_epoch,conversation_epoch)
        VALUES(?,?,?,?,?,?,'RECEIVED',?,?,?,?,?,?,?,?)`).run(envelope.messageId, envelope.ownerConversationId,
        envelope.sequence, envelope.agentId, envelope.payloadDigest, canonicalJson(envelope.payload),
        Date.parse(envelope.expiresAt), now, now, envelope.operation, envelope.ownerIdentityId, observedImUid,
        envelope.ownershipEpoch, envelope.conversationEpoch);
      this.transition(envelope.messageId, 'RECEIVED', 'VERIFIED', null, now);
      this.transition(envelope.messageId, 'VERIFIED', 'PERSISTED', null, now);
      this.db.exec('COMMIT');
      return { status: 'inserted', state: 'PERSISTED' };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch (_) {}
      if (error instanceof OwnerLinkSecurityError) this.securityEvent(error.code, envelope, now);
      throw error;
    }
  }

  acquireDispatchLease(messageId: string, leaseOwner: string, leaseMs = 30_000, now = Date.now()): boolean {
    const result = this.db.prepare(`UPDATE owner_link_commands SET state='DISPATCH_RESERVED',lease_owner=?,
      lease_version=lease_version+1,lease_expires_at=?,updated_at=?
      WHERE message_id=? AND state='PERSISTED' AND expires_at>?`).run(leaseOwner, now + leaseMs, now, messageId, now) as any;
    if (Number(result.changes || 0) === 1) this.event(messageId, 'PERSISTED', 'DISPATCH_RESERVED', null, now);
    return Number(result.changes || 0) === 1;
  }

  markProviderAccepted(messageId: string, leaseOwner: string, now = Date.now()): boolean {
    return this.casFromLease(messageId, leaseOwner, 'PROVIDER_ACCEPTED', null, now, true);
  }
  markFailedNotDelivered(messageId: string, leaseOwner: string, code: string, now = Date.now()): boolean {
    return this.casFromLease(messageId, leaseOwner, 'FAILED_NOT_DELIVERED', code, now, false);
  }
  markOutcomeUnknown(messageId: string, leaseOwner: string, code: string, now = Date.now()): boolean {
    return this.casFromLease(messageId, leaseOwner, 'OUTCOME_UNKNOWN', code, now, false);
  }
  markRejected(messageId: string, leaseOwner: string, code: string, now = Date.now()): boolean {
    return this.casFromLease(messageId, leaseOwner, 'REJECTED', code, now, false);
  }
  complete(messageId: string, now = Date.now()): boolean {
    const result = this.db.prepare(`UPDATE owner_link_commands SET state='COMPLETED',completed_at=?,updated_at=?
      WHERE message_id=? AND state='PROVIDER_ACCEPTED'`).run(now, now, messageId) as any;
    if (Number(result.changes || 0) === 1) this.event(messageId, 'PROVIDER_ACCEPTED', 'COMPLETED', null, now);
    return Number(result.changes || 0) === 1;
  }

  getCommand(messageId: string): any { return this.db.prepare('SELECT * FROM owner_link_commands WHERE message_id=?').get(messageId); }

  listProcessableCommands(now = Date.now(), limit = 100): string[] {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
    return (this.db.prepare(`SELECT message_id FROM owner_link_commands
      WHERE state='PERSISTED' AND expires_at>? ORDER BY created_at LIMIT ?`).all(now, safeLimit) as Array<{ message_id: string }>)
      .map((row) => row.message_id);
  }

  claimNextForPull(agentId: string, leaseOwner: string, leaseMs = 5 * 60_000, now = Date.now()): any | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(`SELECT * FROM owner_link_commands
        WHERE agent_id=? AND state IN ('PERSISTED','FAILED_NOT_DELIVERED') AND expires_at>?
        ORDER BY sequence,created_at LIMIT 1`).get(agentId, now) as any;
      if (!row) { this.db.exec('COMMIT'); return null; }
      const result = this.db.prepare(`UPDATE owner_link_commands SET state='DISPATCH_RESERVED',lease_owner=?,
        lease_version=lease_version+1,lease_expires_at=?,error_code=NULL,updated_at=?
        WHERE message_id=? AND state=? AND expires_at>?`)
        .run(leaseOwner, now + Math.max(30_000, leaseMs), now, row.message_id, row.state, now) as any;
      if (Number(result.changes || 0) !== 1) { this.db.exec('ROLLBACK'); return null; }
      this.event(row.message_id, row.state, 'DISPATCH_RESERVED', 'OWNER_PULL_CLAIMED', now);
      this.db.exec('COMMIT');
      return this.getCommand(row.message_id);
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch (_) {}
      throw error;
    }
  }

  acceptPullLease(messageId: string, leaseOwner: string, now = Date.now()): boolean {
    const result = this.db.prepare(`UPDATE owner_link_commands SET state='PROVIDER_ACCEPTED',
      provider_accepted_at=?,updated_at=? WHERE message_id=? AND state='DISPATCH_RESERVED' AND lease_owner=?`)
      .run(now, now, messageId, leaseOwner) as any;
    if (Number(result.changes || 0) === 1) this.event(messageId, 'DISPATCH_RESERVED', 'PROVIDER_ACCEPTED', 'OWNER_PULL_ACCEPTED', now);
    return Number(result.changes || 0) === 1;
  }

  completePullLease(messageId: string, leaseOwner: string, now = Date.now()): boolean {
    const result = this.db.prepare(`UPDATE owner_link_commands SET state='COMPLETED',completed_at=?,
      lease_owner=NULL,lease_expires_at=NULL,updated_at=?
      WHERE message_id=? AND state='PROVIDER_ACCEPTED' AND lease_owner=?`).run(now, now, messageId, leaseOwner) as any;
    if (Number(result.changes || 0) === 1) this.event(messageId, 'PROVIDER_ACCEPTED', 'COMPLETED', 'OWNER_PULL_COMPLETED', now);
    return Number(result.changes || 0) === 1;
  }

  failPullLease(messageId: string, leaseOwner: string, code: string, now = Date.now()): boolean {
    const result = this.db.prepare(`UPDATE owner_link_commands SET state='FAILED_NOT_DELIVERED',error_code=?,
      lease_owner=NULL,lease_expires_at=NULL,updated_at=?
      WHERE message_id=? AND state='PROVIDER_ACCEPTED' AND lease_owner=?`)
      .run(String(code || 'OWNER_PULL_FAILED').slice(0, 128), now, messageId, leaseOwner) as any;
    if (Number(result.changes || 0) === 1) this.event(messageId, 'PROVIDER_ACCEPTED', 'FAILED_NOT_DELIVERED', code, now);
    return Number(result.changes || 0) === 1;
  }

  getActiveProviderBinding(ownerConversationId: string): any {
    return this.db.prepare(`SELECT * FROM owner_link_provider_bindings
      WHERE owner_conversation_id=? AND status='active' LIMIT 1`).get(ownerConversationId) || null;
  }

  saveProviderBinding(input: {
    ownerConversationId: string;
    agentId: string;
    providerType: string;
    providerInstanceId?: string | null;
    adapterType: string;
    deliveryMode: string;
    nativeSessionId: string;
    expectedVersion?: number | null;
    now?: number;
  }): any {
    const values = [input.ownerConversationId, input.agentId, input.providerType, input.adapterType,
      input.deliveryMode, input.nativeSessionId];
    if (values.some((value) => !value || String(value).length > 192)) throw new OwnerLinkSecurityError('OWNER_PROVIDER_BINDING_INVALID');
    const now = input.now || Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.db.prepare('SELECT * FROM owner_link_provider_bindings WHERE owner_conversation_id=?')
        .get(input.ownerConversationId) as any;
      if (input.expectedVersion != null && Number(current?.binding_version || 0) !== input.expectedVersion) {
        throw new OwnerLinkSecurityError('OWNER_PROVIDER_BINDING_VERSION_CONFLICT');
      }
      const conflict = this.db.prepare(`SELECT owner_conversation_id FROM owner_link_provider_bindings
        WHERE provider_type=? AND provider_instance_id=? AND adapter_type=?
          AND native_session_id=? AND status='active' AND owner_conversation_id<>? LIMIT 1`)
        .get(input.providerType, input.providerInstanceId || '', input.adapterType,
          input.nativeSessionId, input.ownerConversationId);
      if (conflict) throw new OwnerLinkSecurityError('OWNER_NATIVE_SESSION_ALREADY_BOUND');
      const nextVersion = Number(current?.binding_version || 0) + 1;
      this.db.prepare(`INSERT INTO owner_link_provider_bindings
        (owner_conversation_id,agent_id,provider_type,provider_instance_id,adapter_type,delivery_mode,
         native_session_id,binding_version,status,created_at,updated_at,last_used_at)
        VALUES(?,?,?,?,?,?,?,?,'active',?,?,?)
        ON CONFLICT(owner_conversation_id) DO UPDATE SET
          agent_id=excluded.agent_id,provider_type=excluded.provider_type,
          provider_instance_id=excluded.provider_instance_id,adapter_type=excluded.adapter_type,
          delivery_mode=excluded.delivery_mode,native_session_id=excluded.native_session_id,
          binding_version=excluded.binding_version,status='active',updated_at=excluded.updated_at,
          last_used_at=excluded.last_used_at`)
        .run(input.ownerConversationId, input.agentId, input.providerType, input.providerInstanceId || '',
          input.adapterType, input.deliveryMode, input.nativeSessionId, nextVersion,
          Number(current?.created_at || now), now, now);
      this.db.exec('COMMIT');
      return this.getActiveProviderBinding(input.ownerConversationId);
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch (_) {}
      throw error;
    }
  }

  markProviderBindingUnavailable(ownerConversationId: string, expectedVersion: number, now = Date.now()): boolean {
    const result = this.db.prepare(`UPDATE owner_link_provider_bindings SET status='unavailable',updated_at=?
      WHERE owner_conversation_id=? AND binding_version=? AND status='active'`)
      .run(now, ownerConversationId, expectedVersion) as any;
    return Number(result.changes || 0) === 1;
  }

  enqueueSignedEvent(messageId: string, kind: 'receipt'|'event', build: (sequence: number) => {
    eventId: string;
    rawEnvelope: string;
  }, now = Date.now()): string {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const command = this.db.prepare('SELECT conversation_id FROM owner_link_commands WHERE message_id=?')
        .get(messageId) as { conversation_id?: string } | undefined;
      if (!command?.conversation_id) throw new OwnerLinkSecurityError('OWNER_COMMAND_NOT_FOUND');
      const row = this.db.prepare(`SELECT COALESCE(MAX(o.producer_sequence),0) sequence
        FROM owner_link_outbox o JOIN owner_link_commands c ON c.message_id=o.message_id
        WHERE c.conversation_id=?`).get(command.conversation_id) as { sequence?: number } | undefined;
      const sequence = Number(row?.sequence || 0) + 1;
      const event = build(sequence);
      if (!event.eventId || event.eventId.length > 128 || Buffer.byteLength(event.rawEnvelope, 'utf8') > 8192) {
        throw new OwnerLinkSecurityError('OWNER_EVENT_INVALID');
      }
      this.db.prepare(`INSERT INTO owner_link_outbox
        (event_id,message_id,kind,producer_sequence,payload_json,status,attempt_count,next_attempt_at,created_at,updated_at)
        VALUES(?,?,?,?,?,'pending',0,?,?,?)`)
        .run(event.eventId, messageId, kind, sequence, event.rawEnvelope, now, now, now);
      this.db.exec('COMMIT');
      return event.eventId;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch (_) {}
      throw error;
    }
  }

  claimOutbox(leaseOwner: string, limit = 10, leaseMs = 30_000, now = Date.now()): any[] {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 100));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db.prepare(`SELECT o.*,c.agent_id,c.conversation_id,c.observed_im_uid
        FROM owner_link_outbox o JOIN owner_link_commands c ON c.message_id=o.message_id
        WHERE ((o.status='pending' AND o.next_attempt_at<=?)
          OR (o.status='leased' AND COALESCE(o.lease_expires_at,0)<=?))
        AND NOT EXISTS (
          SELECT 1 FROM owner_link_outbox earlier
          JOIN owner_link_commands earlier_command ON earlier_command.message_id=earlier.message_id
          WHERE earlier_command.conversation_id=c.conversation_id
            AND earlier.producer_sequence<o.producer_sequence
            AND earlier.status NOT IN ('sent','acked')
        )
        ORDER BY o.created_at,o.producer_sequence LIMIT ?`).all(now, now, safeLimit) as any[];
      const claimed: any[] = [];
      for (const row of rows) {
        const result = this.db.prepare(`UPDATE owner_link_outbox SET status='leased',lease_owner=?,lease_expires_at=?,updated_at=?
          WHERE event_id=? AND ((status='pending' AND next_attempt_at<=?) OR (status='leased' AND COALESCE(lease_expires_at,0)<=?))`)
          .run(leaseOwner, now + leaseMs, now, row.event_id, now, now) as any;
        if (Number(result.changes || 0) === 1) claimed.push({ ...row, lease_owner: leaseOwner, lease_expires_at: now + leaseMs });
      }
      this.db.exec('COMMIT');
      return claimed;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch (_) {}
      throw error;
    }
  }

  markOutboxSent(eventId: string, leaseOwner: string, now = Date.now()): boolean {
    const result = this.db.prepare(`UPDATE owner_link_outbox SET status='sent',lease_owner=NULL,lease_expires_at=NULL,
      attempt_count=attempt_count+1,updated_at=? WHERE event_id=? AND status='leased' AND lease_owner=?`)
      .run(now, eventId, leaseOwner) as any;
    return Number(result.changes || 0) === 1;
  }

  markOutboxDead(eventId: string, leaseOwner: string, code: string, now = Date.now()): boolean {
    const result = this.db.prepare(`UPDATE owner_link_outbox SET status='dead',lease_owner=NULL,lease_expires_at=NULL,
      attempt_count=attempt_count+1,last_error_code=?,updated_at=?
      WHERE event_id=? AND status='leased' AND lease_owner=?`)
      .run(String(code || 'OWNER_EVENT_AUTHORIZATION_REVOKED').slice(0, 128), now, eventId, leaseOwner) as any;
    return Number(result.changes || 0) === 1;
  }

  releaseOutbox(eventId: string, leaseOwner: string, input: { code: string; outcomeUnknown?: boolean }, now = Date.now()): boolean {
    const status = input.outcomeUnknown ? 'outcome_unknown' : 'pending';
    const current = this.db.prepare('SELECT attempt_count FROM owner_link_outbox WHERE event_id=? AND status=\'leased\' AND lease_owner=?')
      .get(eventId, leaseOwner) as { attempt_count?: number } | undefined;
    if (!current) return false;
    const attempts = Number(current.attempt_count || 0) + 1;
    const delay = Math.min(300_000, 1_000 * (2 ** Math.min(attempts, 8)));
    const result = this.db.prepare(`UPDATE owner_link_outbox SET status=?,lease_owner=NULL,lease_expires_at=NULL,
      attempt_count=?,next_attempt_at=?,last_error_code=?,updated_at=? WHERE event_id=? AND status='leased' AND lease_owner=?`)
      .run(status, attempts, now + delay, String(input.code || 'OWNER_EVENT_SEND_FAILED').slice(0, 128),
        now, eventId, leaseOwner) as any;
    return Number(result.changes || 0) === 1;
  }

  isKnownOwnerImUid(imUid: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM owner_link_identity_bindings WHERE observed_im_uid=? AND status='active' LIMIT 1").get(imUid);
  }

  recordSecurityEvent(input: {
    code: string;
    messageId?: string | null;
    conversationId?: string | null;
    agentId?: string | null;
    details?: unknown;
    now?: number;
  }): void {
    this.db.prepare(`INSERT INTO owner_link_security_events(code,message_id,conversation_id,agent_id,details_digest,created_at)
      VALUES(?,?,?,?,?,?)`).run(input.code, input.messageId || null, input.conversationId || null,
      input.agentId || null, input.details == null ? null : digestDetails(input.details), input.now || Date.now());
  }

  recoverReservedCommands(now = Date.now()): number {
    const rows = this.db.prepare(`SELECT message_id,state FROM owner_link_commands
      WHERE state IN ('DISPATCH_RESERVED','PROVIDER_ACCEPTED') AND lease_owner IS NOT NULL
        AND COALESCE(lease_expires_at,0)<=?`)
      .all(now) as Array<{ message_id: string }>;
    let changed = 0;
    for (const row of rows) {
      const current = this.getCommand(row.message_id);
      const result = this.db.prepare(`UPDATE owner_link_commands SET state='OUTCOME_UNKNOWN',lease_owner=NULL,
        lease_expires_at=NULL,error_code='OWNER_DISPATCH_INTERRUPTED',updated_at=?
        WHERE message_id=? AND state IN ('DISPATCH_RESERVED','PROVIDER_ACCEPTED') AND lease_owner IS NOT NULL
          AND COALESCE(lease_expires_at,0)<=?`)
        .run(now, row.message_id, now) as any;
      if (Number(result.changes || 0) === 1) {
        this.event(row.message_id, current?.state || 'DISPATCH_RESERVED', 'OUTCOME_UNKNOWN', 'OWNER_DISPATCH_INTERRUPTED', now);
        changed += 1;
      }
    }
    return changed;
  }

  private casFromLease(messageId: string, leaseOwner: string, to: OwnerCommandState, code: string | null, now: number, accepted: boolean): boolean {
    const result = this.db.prepare(`UPDATE owner_link_commands SET state=?,error_code=?,lease_owner=NULL,lease_expires_at=NULL,
      provider_accepted_at=CASE WHEN ?=1 THEN ? ELSE provider_accepted_at END,updated_at=?
      WHERE message_id=? AND state='DISPATCH_RESERVED' AND lease_owner=?`).run(to, code, accepted ? 1 : 0, now, now, messageId, leaseOwner) as any;
    if (Number(result.changes || 0) === 1) this.event(messageId, 'DISPATCH_RESERVED', to, code, now);
    return Number(result.changes || 0) === 1;
  }

  private transition(messageId: string, from: OwnerCommandState, to: OwnerCommandState, code: string | null, now: number): void {
    const result = this.db.prepare('UPDATE owner_link_commands SET state=?,error_code=?,updated_at=? WHERE message_id=? AND state=?')
      .run(to, code, now, messageId, from) as any;
    if (Number(result.changes || 0) !== 1) throw new Error('OWNER_STATE_CONFLICT');
    this.event(messageId, from, to, code, now);
  }
  private event(messageId: string, from: OwnerCommandState | null, to: OwnerCommandState, code: string | null, now: number): void {
    this.db.prepare('INSERT INTO owner_link_command_events(message_id,from_state,to_state,reason_code,created_at) VALUES(?,?,?,?,?)')
      .run(messageId, from, to, code, now);
  }
  private securityEvent(code: string, envelope: VokoOwnerEnvelope, now: number): void {
    this.db.prepare(`INSERT INTO owner_link_security_events(code,message_id,conversation_id,agent_id,details_digest,created_at)
      VALUES(?,?,?,?,?,?)`).run(code, envelope.messageId, envelope.ownerConversationId, envelope.agentId,
      digestDetails({ code, messageId: envelope.messageId, conversationId: envelope.ownerConversationId }), now);
  }
}

export { OwnerLinkSecurityError, OwnerLinkStore };
export type { OwnerCommandState, PersistResult };
