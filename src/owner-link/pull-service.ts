import crypto from 'node:crypto';
import { parseApprovedExecutePayload } from './approval';
import type { ApprovalBinding } from './approval';
import { createOwnerEventEnvelope } from './event-envelope';
import { OwnerLinkStore } from './store';

interface OwnerPullIdentity { privateKey: string; keyId?: string; imUid: string }

interface OwnerPullServiceOptions {
  store: OwnerLinkStore;
  authorizeAgent: (agentId: string) => (ApprovalBinding & { evidence?: string }) | null | false;
  resolveAgentIdentity: (agentId: string) => OwnerPullIdentity | null;
  claimTtlMs?: number;
}

function commandText(command: any): string {
  if (command?.operation !== 'execute') return '';
  try {
    const payload = JSON.parse(String(command.payload_json || '{}'));
    return parseApprovedExecutePayload(payload, Date.now(), Number(command.expires_at)).action.text;
  } catch (_) { return ''; }
}

class OwnerPullService {
  private readonly claimTtlMs: number;
  constructor(private readonly options: OwnerPullServiceOptions) {
    this.claimTtlMs = Math.max(30_000, Math.min(Number(options.claimTtlMs || 5 * 60_000), 30 * 60_000));
  }

  fetch(agentId: string): Record<string, unknown> {
    const authorization = this.options.authorizeAgent(agentId);
    if (!authorization) return { success: false, code: 'OWNER_PULL_CALLER_UNVERIFIED' };
    const identity = this.options.resolveAgentIdentity(agentId);
    if (!identity?.privateKey || !identity.imUid) return { success: false, code: 'OWNER_AGENT_IDENTITY_UNAVAILABLE' };
    const claimId = `owner-pull-${crypto.randomUUID()}`;
    const command = this.options.store.claimNextForPull(agentId, claimId, authorization, this.claimTtlMs);
    if (!command) return { success: true, command: null };
    const text = commandText(command);
    if (!text) {
      this.options.store.markRejected(command.message_id, claimId, 'OWNER_PULL_PAYLOAD_INVALID');
      return { success: false, code: 'OWNER_PULL_PAYLOAD_INVALID' };
    }
    try {
      this.enqueue(command, identity, 'accepted', {}, 'receipt');
      if (!this.options.store.acceptPullLease(command.message_id, claimId)) throw new Error('OWNER_PULL_STATE_CONFLICT');
      return {
        success: true,
        command: {
          messageId: command.message_id,
          operation: command.operation,
          content: text,
          expiresAt: new Date(Number(command.expires_at)).toISOString(),
          claimId,
          trust: 'verified_owner',
        },
      };
    } catch (error: any) {
      this.options.store.markOutcomeUnknown(command.message_id, claimId,
        /^OWNER_[A-Z0-9_]+$/.test(String(error?.message || '')) ? error.message : 'OWNER_PULL_ACCEPT_FAILED');
      return { success: false, code: 'OWNER_PULL_ACCEPT_FAILED' };
    }
  }

  complete(agentId: string, messageId: string, claimId: string, content = ''): Record<string, unknown> {
    return this.finish(agentId, messageId, claimId, 'completed', content, null);
  }

  fail(agentId: string, messageId: string, claimId: string, errorCode = 'OWNER_PULL_EXECUTION_FAILED'): Record<string, unknown> {
    return this.finish(agentId, messageId, claimId, 'failed', '', errorCode);
  }

  private finish(agentId: string, messageId: string, claimId: string, operation: 'completed'|'failed',
    content: string, errorCode: string | null): Record<string, unknown> {
    const authorization = this.options.authorizeAgent(agentId);
    if (!authorization) return { success: false, code: 'OWNER_PULL_CALLER_UNVERIFIED' };
    const identity = this.options.resolveAgentIdentity(agentId);
    const command = this.options.store.getCommand(messageId);
    if (!identity?.privateKey || !command || command.agent_id !== agentId || command.lease_owner !== claimId
        || command.state !== 'PROVIDER_ACCEPTED') return { success: false, code: 'OWNER_PULL_CLAIM_INVALID' };
    const safeContent = String(content || '').slice(0, 6144);
    const safeCode = String(errorCode || 'OWNER_PULL_EXECUTION_FAILED').replace(/[^A-Z0-9_]/g, '_').slice(0, 128);
    try {
      this.enqueue(command, identity, 'working');
      this.options.store.transitionAndEnqueueSignedEvent({
        messageId, from: 'PROVIDER_ACCEPTED', to: operation === 'completed' ? 'COMPLETED' : 'FAILED_NOT_DELIVERED',
        leaseOwner: claimId, code: operation === 'failed' ? safeCode : null, kind: 'event', build: (sequence) => {
          const envelope = createOwnerEventEnvelope({ command, operation,
            payload: operation === 'completed' ? { content: safeContent } : { errorCode: safeCode }, sequence,
            privateKey: identity.privateKey, keyId: identity.keyId, kind: 'event' });
          return { eventId: envelope.messageId, rawEnvelope: JSON.stringify(envelope) };
        }, approvalBinding: authorization, approvalDisposition: 'consumed',
      });
      return { success: true, status: operation };
    } catch (_) {
      return { success: false, code: 'OWNER_PULL_RESULT_PERSIST_FAILED' };
    }
  }

  private enqueue(command: any, identity: OwnerPullIdentity,
    operation: 'accepted'|'working'|'completed'|'failed', payload: Record<string, unknown> = {},
    kind: 'receipt'|'event' = 'event'): string {
    return this.options.store.enqueueSignedEvent(command.message_id, kind, (sequence) => {
      const envelope = createOwnerEventEnvelope({ command, operation, payload, sequence,
        privateKey: identity.privateKey, keyId: identity.keyId, kind });
      return { eventId: envelope.messageId, rawEnvelope: JSON.stringify(envelope) };
    });
  }
}

export { OwnerPullService };
export type { OwnerPullIdentity, OwnerPullServiceOptions };
