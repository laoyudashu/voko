import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { nativeSessionDigest, parseApprovedExecutePayload } from './approval';
import type { ApprovalBinding } from './approval';
import { parseOwnerCancelPayload } from './cancel';
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

  persistVerified(envelope: VokoOwnerEnvelope, observedImUid: string, now = Date.now(), localAgentId = envelope.agentId): PersistResult {
    if (!observedImUid || observedImUid.length > 192) throw new OwnerLinkSecurityError('OWNER_IM_UID_INVALID');
    if (!localAgentId || localAgentId.length > 128) throw new OwnerLinkSecurityError('OWNER_LOCAL_AGENT_ID_INVALID');
    let approvedExecute: ReturnType<typeof parseApprovedExecutePayload> | null = null;
    let cancelTargetMessageId: string | null = null;
    if (envelope.operation === 'execute') {
      try { approvedExecute = parseApprovedExecutePayload(envelope.payload, now, Date.parse(envelope.expiresAt)); }
      catch (error: any) { throw new OwnerLinkSecurityError(String(error?.message || 'OWNER_APPROVAL_INVALID')); }
    } else if (envelope.operation === 'cancel') {
      try { cancelTargetMessageId = parseOwnerCancelPayload(envelope.payload).targetMessageId; }
      catch (error: any) { throw new OwnerLinkSecurityError(String(error?.message || 'OWNER_CANCEL_PAYLOAD_INVALID')); }
    }
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
      if (approvedExecute && this.db.prepare('SELECT 1 FROM owner_link_approvals WHERE approval_id=? LIMIT 1')
        .get(approvedExecute.approval.approvalId)) {
        throw new OwnerLinkSecurityError('OWNER_APPROVAL_REUSED');
      }
      if (cancelTargetMessageId) {
        const target = this.db.prepare(`SELECT state FROM owner_link_commands
          WHERE message_id=? AND conversation_id=? AND agent_id=? AND operation='execute' LIMIT 1`)
          .get(cancelTargetMessageId, envelope.ownerConversationId, envelope.agentId) as { state?: string } | undefined;
        if (!target) throw new OwnerLinkSecurityError('OWNER_CANCEL_TARGET_NOT_FOUND');
        if (['COMPLETED','REJECTED','EXPIRED'].includes(String(target.state || ''))) {
          throw new OwnerLinkSecurityError('OWNER_CANCEL_TOO_LATE');
        }
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
        (message_id,conversation_id,sequence,agent_id,local_agent_id,payload_digest,payload_json,state,expires_at,created_at,updated_at,
         operation,target_message_id,owner_identity_id,observed_im_uid,ownership_epoch,conversation_epoch)
        VALUES(?,?,?,?,?,?,?,'RECEIVED',?,?,?,?,?,?,?,?,?)`).run(envelope.messageId, envelope.ownerConversationId,
        envelope.sequence, envelope.agentId, localAgentId, envelope.payloadDigest, canonicalJson(envelope.payload),
        Date.parse(envelope.expiresAt), now, now, envelope.operation, cancelTargetMessageId, envelope.ownerIdentityId, observedImUid,
        envelope.ownershipEpoch, envelope.conversationEpoch);
      if (approvedExecute) {
        this.db.prepare(`INSERT INTO owner_link_approvals
          (approval_id,message_id,action_digest,enforcement,status,expires_at,created_at,updated_at)
          VALUES(?,?,?,'voko_enforced','pending',?,?,?)`).run(approvedExecute.approval.approvalId,
          envelope.messageId, approvedExecute.approval.actionDigest, Date.parse(approvedExecute.approval.expiresAt), now, now);
      }
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

  acquireApprovedDispatchLease(messageId: string, leaseOwner: string, binding: ApprovalBinding,
    leaseMs = 30_000, now = Date.now()): boolean {
    this.assertApprovalBinding(binding);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const command = this.db.prepare(`SELECT c.state,c.expires_at,a.status approval_status,a.expires_at approval_expires_at
        FROM owner_link_commands c JOIN owner_link_approvals a ON a.message_id=c.message_id
        WHERE c.message_id=?`).get(messageId) as any;
      if (!command || command.state !== 'PERSISTED' || command.approval_status !== 'pending'
          || Number(command.expires_at) <= now || Number(command.approval_expires_at) <= now) {
        this.db.exec('ROLLBACK'); return false;
      }
      const commandResult = this.db.prepare(`UPDATE owner_link_commands SET state='DISPATCH_RESERVED',lease_owner=?,
        lease_version=lease_version+1,lease_expires_at=?,updated_at=?
        WHERE message_id=? AND state='PERSISTED' AND expires_at>?`)
        .run(leaseOwner, now + leaseMs, now, messageId, now) as any;
      const approvalResult = this.db.prepare(`UPDATE owner_link_approvals SET status='claimed',provider_type=?,
        provider_instance_id=?,adapter_type=?,delivery_mode=?,binding_version=?,native_session_digest=?,claimed_at=?,updated_at=?
        WHERE message_id=? AND status='pending' AND expires_at>?`).run(binding.providerType,
          binding.providerInstanceId || '', binding.adapterType, binding.deliveryMode, binding.bindingVersion,
          nativeSessionDigest(binding.nativeSessionId), now, now, messageId, now) as any;
      if (Number(commandResult.changes || 0) !== 1 || Number(approvalResult.changes || 0) !== 1) {
        this.db.exec('ROLLBACK'); return false;
      }
      this.event(messageId, 'PERSISTED', 'DISPATCH_RESERVED', 'OWNER_APPROVAL_CLAIMED', now);
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch (_) {}
      throw error;
    }
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

  settleLocalCancel(input: {
    cancelMessageId: string;
    buildCancelAccepted: (command: any, sequence: number) => { eventId: string; rawEnvelope: string };
    buildCancelTerminal: (command: any, sequence: number, outcome: 'canceled'|'unsupported'|'too_late', code?: string) =>
      { eventId: string; rawEnvelope: string };
    buildTargetCanceled: (command: any, sequence: number) => { eventId: string; rawEnvelope: string };
    now?: number;
  }): { status: 'canceled'|'unsupported'|'too_late'; eventId: string } {
    const now = input.now || Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const cancel = this.getCommand(input.cancelMessageId);
      if (!cancel || cancel.operation !== 'cancel' || cancel.state !== 'PERSISTED' || !cancel.target_message_id) {
        throw new OwnerLinkSecurityError('OWNER_CANCEL_STATE_CONFLICT');
      }
      const target = this.getCommand(cancel.target_message_id);
      if (!target || target.operation !== 'execute' || target.conversation_id !== cancel.conversation_id
          || target.agent_id !== cancel.agent_id) throw new OwnerLinkSecurityError('OWNER_CANCEL_TARGET_NOT_FOUND');
      const outcome = Number(target.expires_at) <= now ? 'too_late'
        : ['PERSISTED','FAILED_NOT_DELIVERED'].includes(target.state) ? 'canceled'
        : ['DISPATCH_RESERVED','PROVIDER_ACCEPTED','OUTCOME_UNKNOWN'].includes(target.state) ? 'unsupported' : 'too_late';
      const code = outcome === 'unsupported' ? 'OWNER_CANCEL_UNSUPPORTED'
        : outcome === 'too_late' ? 'OWNER_CANCEL_TOO_LATE' : undefined;
      const sequenceRow = this.db.prepare(`SELECT COALESCE(MAX(o.producer_sequence),0) sequence
        FROM owner_link_outbox o JOIN owner_link_commands c ON c.message_id=o.message_id
        WHERE c.conversation_id=?`).get(cancel.conversation_id) as { sequence?: number } | undefined;
      let sequence = Number(sequenceRow?.sequence || 0);
      const events: Array<{ command: any; kind: 'receipt'|'event'; eventId: string; rawEnvelope: string; sequence: number }> = [];
      const acceptedSequence = ++sequence; const accepted = input.buildCancelAccepted(cancel, acceptedSequence);
      events.push({ command: cancel, kind: 'receipt', sequence: acceptedSequence, ...accepted });
      if (outcome === 'canceled') {
        const targetSequence = ++sequence; const targetEvent = input.buildTargetCanceled(target, targetSequence);
        events.push({ command: target, kind: 'event', sequence: targetSequence, ...targetEvent });
        const targetResult = this.db.prepare(`UPDATE owner_link_commands SET state='REJECTED',
          error_code='OWNER_CANCELED_BEFORE_DISPATCH',completed_at=?,updated_at=?
          WHERE message_id=? AND state=?`).run(now, now, target.message_id, target.state) as any;
        if (Number(targetResult.changes || 0) !== 1) throw new OwnerLinkSecurityError('OWNER_CANCEL_STATE_CONFLICT');
        this.db.prepare(`UPDATE owner_link_approvals SET status='rejected',updated_at=?
          WHERE message_id=? AND status='pending'`).run(now, target.message_id);
        this.event(target.message_id, target.state, 'REJECTED', 'OWNER_CANCELED_BEFORE_DISPATCH', now);
      }
      const terminalSequence = ++sequence; const terminal = input.buildCancelTerminal(cancel, terminalSequence, outcome, code);
      events.push({ command: cancel, kind: 'event', sequence: terminalSequence, ...terminal });
      for (const event of events) this.insertOutboxEvent(event.command.message_id, event.kind,
        event.eventId, event.rawEnvelope, event.sequence, now);
      const cancelState = outcome === 'canceled' ? 'COMPLETED' : 'REJECTED';
      const cancelResult = this.db.prepare(`UPDATE owner_link_commands SET state=?,error_code=?,
        completed_at=CASE WHEN ?='COMPLETED' THEN ? ELSE completed_at END,updated_at=?
        WHERE message_id=? AND state='PERSISTED'`).run(cancelState, code || null, cancelState, now, now,
          cancel.message_id) as any;
      if (Number(cancelResult.changes || 0) !== 1) throw new OwnerLinkSecurityError('OWNER_CANCEL_STATE_CONFLICT');
      this.event(cancel.message_id, 'PERSISTED', cancelState, code || null, now);
      this.db.exec('COMMIT');
      return { status: outcome, eventId: terminal.eventId };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch (_) {}
      throw error;
    }
  }

  listProcessableCommands(now = Date.now(), limit = 100): string[] {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
    return (this.db.prepare(`SELECT message_id FROM owner_link_commands
      WHERE state='PERSISTED' AND expires_at>? ORDER BY created_at LIMIT ?`).all(now, safeLimit) as Array<{ message_id: string }>)
      .map((row) => row.message_id);
  }

  claimNextForPull(agentId: string, leaseOwner: string, binding: ApprovalBinding,
    leaseMs = 5 * 60_000, now = Date.now()): any | null {
    this.assertApprovalBinding(binding);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(`SELECT c.* FROM owner_link_commands c
        JOIN owner_link_approvals a ON a.message_id=c.message_id
        WHERE COALESCE(c.local_agent_id,c.agent_id)=? AND c.state IN ('PERSISTED','FAILED_NOT_DELIVERED') AND c.expires_at>?
          AND a.status='pending' AND a.expires_at>?
        ORDER BY c.sequence,c.created_at LIMIT 1`).get(agentId, now, now) as any;
      if (!row) { this.db.exec('COMMIT'); return null; }
      const result = this.db.prepare(`UPDATE owner_link_commands SET state='DISPATCH_RESERVED',lease_owner=?,
        lease_version=lease_version+1,lease_expires_at=?,error_code=NULL,updated_at=?
        WHERE message_id=? AND state=? AND expires_at>?`)
        .run(leaseOwner, now + Math.max(30_000, leaseMs), now, row.message_id, row.state, now) as any;
      if (Number(result.changes || 0) !== 1) { this.db.exec('ROLLBACK'); return null; }
      const approvalResult = this.db.prepare(`UPDATE owner_link_approvals SET status='claimed',provider_type=?,
        provider_instance_id=?,adapter_type=?,delivery_mode=?,binding_version=?,native_session_digest=?,claimed_at=?,updated_at=?
        WHERE message_id=? AND status='pending' AND expires_at>?`).run(binding.providerType,
          binding.providerInstanceId || '', binding.adapterType, binding.deliveryMode, binding.bindingVersion,
          nativeSessionDigest(binding.nativeSessionId), now, now, row.message_id, now) as any;
      if (Number(approvalResult.changes || 0) !== 1) { this.db.exec('ROLLBACK'); return null; }
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

  transitionAndEnqueueSignedEvent(input: {
    messageId: string;
    from: Extract<OwnerCommandState, 'DISPATCH_RESERVED'|'PROVIDER_ACCEPTED'>;
    to: Extract<OwnerCommandState, 'COMPLETED'|'FAILED_NOT_DELIVERED'|'REJECTED'>;
    leaseOwner?: string | null;
    code?: string | null;
    kind?: 'receipt'|'event';
    build: (sequence: number) => { eventId: string; rawEnvelope: string };
    approvalBinding?: ApprovalBinding;
    approvalDisposition?: 'consumed'|'rejected';
    now?: number;
  }): string {
    const now = input.now || Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const command = this.db.prepare('SELECT conversation_id,state,lease_owner FROM owner_link_commands WHERE message_id=?')
        .get(input.messageId) as { conversation_id?: string; state?: string; lease_owner?: string | null } | undefined;
      if (!command?.conversation_id || command.state !== input.from
          || (input.leaseOwner != null && command.lease_owner !== input.leaseOwner)) {
        throw new OwnerLinkSecurityError('OWNER_STATE_CONFLICT');
      }
      const row = this.db.prepare(`SELECT COALESCE(MAX(o.producer_sequence),0) sequence
        FROM owner_link_outbox o JOIN owner_link_commands c ON c.message_id=o.message_id
        WHERE c.conversation_id=?`).get(command.conversation_id) as { sequence?: number } | undefined;
      const sequence = Number(row?.sequence || 0) + 1;
      const event = input.build(sequence);
      if (!event.eventId || event.eventId.length > 128 || Buffer.byteLength(event.rawEnvelope, 'utf8') > 8192) {
        throw new OwnerLinkSecurityError('OWNER_EVENT_INVALID');
      }
      this.db.prepare(`INSERT INTO owner_link_outbox
        (event_id,message_id,kind,producer_sequence,payload_json,status,attempt_count,next_attempt_at,created_at,updated_at)
        VALUES(?,?,?,?,?,'pending',0,?,?,?)`).run(event.eventId, input.messageId, input.kind || 'event', sequence,
          event.rawEnvelope, now, now, now);
      const result = this.db.prepare(`UPDATE owner_link_commands SET state=?,error_code=?,
        completed_at=CASE WHEN ?='COMPLETED' THEN ? ELSE completed_at END,
        lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE message_id=? AND state=?
          AND (? IS NULL OR lease_owner=?)`).run(input.to, input.code || null, input.to, now, now,
          input.messageId, input.from, input.leaseOwner || null, input.leaseOwner || null) as any;
      if (Number(result.changes || 0) !== 1) throw new OwnerLinkSecurityError('OWNER_STATE_CONFLICT');
      if (input.approvalBinding) {
        this.settleApproval(input.messageId, input.approvalBinding, input.approvalDisposition || 'consumed', now);
      }
      this.event(input.messageId, input.from, input.to, input.code || null, now);
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
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        const current = this.getCommand(row.message_id);
        const result = this.db.prepare(`UPDATE owner_link_commands SET state='OUTCOME_UNKNOWN',lease_owner=NULL,
          lease_expires_at=NULL,error_code='OWNER_DISPATCH_INTERRUPTED',updated_at=?
          WHERE message_id=? AND state IN ('DISPATCH_RESERVED','PROVIDER_ACCEPTED') AND lease_owner IS NOT NULL
            AND COALESCE(lease_expires_at,0)<=?`).run(now, row.message_id, now) as any;
        if (Number(result.changes || 0) === 1) {
          this.db.prepare(`UPDATE owner_link_approvals SET status='consumed',consumed_at=?,updated_at=?
            WHERE message_id=? AND status='claimed'`).run(now, now, row.message_id);
          this.event(row.message_id, current?.state || 'DISPATCH_RESERVED', 'OUTCOME_UNKNOWN', 'OWNER_DISPATCH_INTERRUPTED', now);
          changed += 1;
        }
      }
      this.db.exec('COMMIT');
      return changed;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch (_) {}
      throw error;
    }
  }

  getApproval(messageId: string): any {
    return this.db.prepare('SELECT * FROM owner_link_approvals WHERE message_id=?').get(messageId) || null;
  }

  settleClaimedApproval(messageId: string, binding: ApprovalBinding, disposition: 'consumed'|'rejected',
    now = Date.now()): boolean {
    this.assertApprovalBinding(binding);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.settleApproval(messageId, binding, disposition, now);
      this.db.exec('COMMIT'); return true;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch (_) {}
      if (error instanceof OwnerLinkSecurityError && error.code === 'OWNER_APPROVAL_BINDING_MISMATCH') return false;
      throw error;
    }
  }

  promoteClaimedApprovalBinding(messageId: string, selected: ApprovalBinding, actual: ApprovalBinding,
    now = Date.now()): boolean {
    this.assertApprovalBinding(selected); this.assertApprovalBinding(actual);
    if (selected.bindingVersion !== 0 || selected.nativeSessionId
        || actual.bindingVersion < 1 || !actual.nativeSessionId
        || selected.providerType !== actual.providerType
        || (selected.providerInstanceId && String(selected.providerInstanceId) !== String(actual.providerInstanceId || ''))
        || selected.adapterType !== actual.adapterType || selected.deliveryMode !== actual.deliveryMode) return false;
    const result = this.db.prepare(`UPDATE owner_link_approvals SET provider_instance_id=?,binding_version=?,native_session_digest=?,updated_at=?
      WHERE message_id=? AND status='claimed' AND provider_type=? AND provider_instance_id=?
        AND adapter_type=? AND delivery_mode=? AND binding_version=0 AND native_session_digest IS NULL`)
      .run(actual.providerInstanceId || '', actual.bindingVersion, nativeSessionDigest(actual.nativeSessionId), now, messageId, selected.providerType,
        selected.providerInstanceId || '', selected.adapterType, selected.deliveryMode) as any;
    return Number(result.changes || 0) === 1;
  }

  markOutcomeUnknownAndSettleApproval(messageId: string, leaseOwner: string, binding: ApprovalBinding,
    code: string, now = Date.now()): boolean {
    this.assertApprovalBinding(binding);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.db.prepare(`SELECT state,lease_owner FROM owner_link_commands
        WHERE message_id=? AND state IN ('DISPATCH_RESERVED','PROVIDER_ACCEPTED')`).get(messageId) as any;
      if (!current || (current.lease_owner && current.lease_owner !== leaseOwner)) {
        this.db.exec('ROLLBACK'); return false;
      }
      this.settleApproval(messageId, binding, 'consumed', now);
      const result = this.db.prepare(`UPDATE owner_link_commands SET state='OUTCOME_UNKNOWN',error_code=?,
        lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE message_id=? AND state=?`)
        .run(String(code || 'OWNER_OUTCOME_UNKNOWN').slice(0, 128), now, messageId, current.state) as any;
      if (Number(result.changes || 0) !== 1) throw new OwnerLinkSecurityError('OWNER_STATE_CONFLICT');
      this.event(messageId, current.state, 'OUTCOME_UNKNOWN', code, now);
      this.db.exec('COMMIT'); return true;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch (_) {}
      throw error;
    }
  }

  private casFromLease(messageId: string, leaseOwner: string, to: OwnerCommandState, code: string | null, now: number, accepted: boolean): boolean {
    const result = this.db.prepare(`UPDATE owner_link_commands SET state=?,error_code=?,lease_owner=NULL,lease_expires_at=NULL,
      provider_accepted_at=CASE WHEN ?=1 THEN ? ELSE provider_accepted_at END,updated_at=?
      WHERE message_id=? AND state='DISPATCH_RESERVED' AND lease_owner=?`).run(to, code, accepted ? 1 : 0, now, now, messageId, leaseOwner) as any;
    if (Number(result.changes || 0) === 1) this.event(messageId, 'DISPATCH_RESERVED', to, code, now);
    return Number(result.changes || 0) === 1;
  }
  private assertApprovalBinding(binding: ApprovalBinding): void {
    const values = [binding.providerType, binding.adapterType, binding.deliveryMode];
    if (values.some((value) => !value || String(value).length > 192)
        || !Number.isInteger(binding.bindingVersion) || binding.bindingVersion < 0
        || String(binding.providerInstanceId || '').length > 192
        || String(binding.nativeSessionId || '').length > 512) {
      throw new OwnerLinkSecurityError('OWNER_APPROVAL_BINDING_INVALID');
    }
  }
  private insertOutboxEvent(messageId: string, kind: 'receipt'|'event', eventId: string,
    rawEnvelope: string, sequence: number, now: number): void {
    if (!eventId || eventId.length > 128 || !Number.isInteger(sequence) || sequence < 1
        || Buffer.byteLength(rawEnvelope, 'utf8') > 8192) throw new OwnerLinkSecurityError('OWNER_EVENT_INVALID');
    this.db.prepare(`INSERT INTO owner_link_outbox
      (event_id,message_id,kind,producer_sequence,payload_json,status,attempt_count,next_attempt_at,created_at,updated_at)
      VALUES(?,?,?,?,?,'pending',0,?,?,?)`).run(eventId, messageId, kind, sequence, rawEnvelope, now, now, now);
  }
  private settleApproval(messageId: string, binding: ApprovalBinding, disposition: 'consumed'|'rejected', now: number): void {
    this.assertApprovalBinding(binding);
    const digest = nativeSessionDigest(binding.nativeSessionId);
    const result = this.db.prepare(`UPDATE owner_link_approvals SET status=?,consumed_at=?,updated_at=?,
      native_session_digest=COALESCE(native_session_digest,?)
      WHERE message_id=? AND status='claimed' AND provider_type=? AND provider_instance_id=?
        AND adapter_type=? AND delivery_mode=? AND binding_version=?
        AND (native_session_digest IS NULL OR native_session_digest=?)`).run(disposition, disposition === 'consumed' ? now : null,
          now, digest, messageId, binding.providerType, binding.providerInstanceId || '', binding.adapterType,
          binding.deliveryMode, binding.bindingVersion, digest) as any;
    if (Number(result.changes || 0) !== 1) throw new OwnerLinkSecurityError('OWNER_APPROVAL_BINDING_MISMATCH');
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
