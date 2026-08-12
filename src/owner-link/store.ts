import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson } from './envelope';
import type { OwnerEnvelope } from './envelope';

type OwnerCommandState = 'RECEIVED'|'VERIFIED'|'PERSISTED'|'DISPATCH_RESERVED'|'PROVIDER_ACCEPTED'|
  'COMPLETED'|'REJECTED'|'EXPIRED'|'FAILED_NOT_DELIVERED'|'OUTCOME_UNKNOWN';

interface PersistResult { status: 'inserted'|'duplicate'|'revoked'; state: OwnerCommandState }

class OwnerLinkSecurityError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'OwnerLinkSecurityError'; }
}

function digestDetails(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

class OwnerLinkStore {
  constructor(private readonly db: DatabaseSync) {}

  persistVerified(envelope: OwnerEnvelope, observedImUid: string, now = Date.now()): PersistResult {
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
        .get(envelope.conversationId, envelope.sequence) as { message_id: string; payload_digest: string } | undefined;
      if (sequenceOwner) {
        throw new OwnerLinkSecurityError('OWNER_SEQUENCE_CONFLICT');
      }
      const binding = this.db.prepare('SELECT * FROM owner_link_identity_bindings WHERE conversation_id=?')
        .get(envelope.conversationId) as any;
      if (!binding) {
        this.db.prepare(`INSERT INTO owner_link_identity_bindings
          (conversation_id,owner_identity_id,agent_id,observed_im_uid,ownership_epoch,conversation_epoch,status,created_at,updated_at)
          VALUES(?,?,?,?,?,?,'active',?,?)`).run(envelope.conversationId, envelope.ownerIdentityId,
          envelope.agentId, observedImUid, envelope.ownershipEpoch, envelope.conversationEpoch, now, now);
      } else if (binding.status !== 'active' || binding.owner_identity_id !== envelope.ownerIdentityId
        || binding.agent_id !== envelope.agentId || binding.observed_im_uid !== observedImUid
        || Number(binding.ownership_epoch) !== envelope.ownershipEpoch
        || Number(binding.conversation_epoch) !== envelope.conversationEpoch) {
        throw new OwnerLinkSecurityError('OWNER_BINDING_MISMATCH');
      }
      if (envelope.kind === 'control' && (envelope.payload as any).action === 'revoke_binding') {
        this.db.prepare("UPDATE owner_link_identity_bindings SET status='revoked',updated_at=? WHERE conversation_id=? AND status='active'")
          .run(now, envelope.conversationId);
      }
      this.db.prepare(`INSERT INTO owner_link_commands
        (message_id,conversation_id,sequence,agent_id,payload_digest,payload_json,state,expires_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'RECEIVED',?,?,?)`).run(envelope.messageId, envelope.conversationId,
        envelope.sequence, envelope.agentId, envelope.payloadDigest, canonicalJson(envelope.payload),
        Date.parse(envelope.expiresAt), now, now);
      this.transition(envelope.messageId, 'RECEIVED', 'VERIFIED', null, now);
      this.transition(envelope.messageId, 'VERIFIED', 'PERSISTED', null, now);
      this.db.exec('COMMIT');
      return { status: envelope.kind === 'control' ? 'revoked' : 'inserted', state: 'PERSISTED' };
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
  private securityEvent(code: string, envelope: OwnerEnvelope, now: number): void {
    this.db.prepare(`INSERT INTO owner_link_security_events(code,message_id,conversation_id,agent_id,details_digest,created_at)
      VALUES(?,?,?,?,?,?)`).run(code, envelope.messageId, envelope.conversationId, envelope.agentId,
      digestDetails({ code, messageId: envelope.messageId, conversationId: envelope.conversationId }), now);
  }
}

export { OwnerLinkSecurityError, OwnerLinkStore };
export type { OwnerCommandState, PersistResult };
