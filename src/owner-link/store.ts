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
        (message_id,conversation_id,sequence,agent_id,payload_digest,payload_json,state,expires_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'RECEIVED',?,?,?)`).run(envelope.messageId, envelope.ownerConversationId,
        envelope.sequence, envelope.agentId, envelope.payloadDigest, canonicalJson(envelope.payload),
        Date.parse(envelope.expiresAt), now, now);
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
  complete(messageId: string, now = Date.now()): boolean {
    const result = this.db.prepare(`UPDATE owner_link_commands SET state='COMPLETED',completed_at=?,updated_at=?
      WHERE message_id=? AND state='PROVIDER_ACCEPTED'`).run(now, now, messageId) as any;
    if (Number(result.changes || 0) === 1) this.event(messageId, 'PROVIDER_ACCEPTED', 'COMPLETED', null, now);
    return Number(result.changes || 0) === 1;
  }

  getCommand(messageId: string): any { return this.db.prepare('SELECT * FROM owner_link_commands WHERE message_id=?').get(messageId); }

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
    const rows = this.db.prepare("SELECT message_id FROM owner_link_commands WHERE state='DISPATCH_RESERVED' AND COALESCE(lease_expires_at,0)<=?")
      .all(now) as Array<{ message_id: string }>;
    let changed = 0;
    for (const row of rows) {
      const result = this.db.prepare(`UPDATE owner_link_commands SET state='OUTCOME_UNKNOWN',lease_owner=NULL,
        lease_expires_at=NULL,error_code='OWNER_DISPATCH_INTERRUPTED',updated_at=?
        WHERE message_id=? AND state='DISPATCH_RESERVED' AND COALESCE(lease_expires_at,0)<=?`)
        .run(now, row.message_id, now) as any;
      if (Number(result.changes || 0) === 1) {
        this.event(row.message_id, 'DISPATCH_RESERVED', 'OUTCOME_UNKNOWN', 'OWNER_DISPATCH_INTERRUPTED', now);
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
