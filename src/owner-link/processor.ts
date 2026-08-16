import crypto from 'node:crypto';
import type { PushPayload } from '../core/dispatcher/types';
import { parseApprovedExecutePayload } from './approval';
import type { ApprovalBinding } from './approval';
import { createOwnerEventEnvelope } from './event-envelope';
import { OwnerLinkStore } from './store';

interface OwnerDispatcher {
  resolveTrustedOwnerTransport(agentId: string): {
    providerId: string;
    providerType: string;
    providerInstanceId: string | null;
    deliveryMode: string;
  } | null;
  executeIsolated(options: Record<string, unknown>): Promise<{ reply: any; receipt?: any }>;
}

interface OwnerCommandProcessorOptions {
  store: OwnerLinkStore;
  dispatcher: OwnerDispatcher;
  dispatchEnabled: boolean;
  resolveAgentIdentity?: (agentId: string) => { privateKey: string; keyId?: string; imUid: string } | null;
  timeoutMs?: number;
}

function contentOf(command: any): string {
  if (command.operation !== 'execute') return '';
  const payload = JSON.parse(String(command.payload_json || '{}'));
  try { return parseApprovedExecutePayload(payload, Date.now(), Number(command.expires_at)).action.text; }
  catch (_) { return ''; }
}

function approvalBindingOf(row: any): ApprovalBinding {
  return {
    providerType: String(row.provider_type), providerInstanceId: row.provider_instance_id || '',
    adapterType: String(row.adapter_type), deliveryMode: String(row.delivery_mode),
    bindingVersion: Number(row.binding_version), nativeSessionId: row.native_session_id || null,
  };
}

function bindingSnapshot(row: any): PushPayload['providerBinding'] {
  if (!row) return null;
  return {
    id: `owner:${row.owner_conversation_id}`,
    bindingVersion: Number(row.binding_version),
    providerType: String(row.provider_type),
    providerInstanceId: row.provider_instance_id || null,
    deliveryMode: String(row.delivery_mode),
    adapterType: String(row.adapter_type),
    nativeSessionId: String(row.native_session_id),
    sessionOrigin: 'voko_managed',
    channelId: String(row.owner_conversation_id),
    channelType: 1,
    sourceScope: 'trusted_owner',
    strictSessionRoute: true,
  };
}

class OwnerCommandProcessor {
  private readonly timeoutMs: number;
  constructor(private readonly options: OwnerCommandProcessorOptions) {
    this.timeoutMs = Math.max(1_000, Math.min(Number(options.timeoutMs || 120_000), 10 * 60_000));
  }

  async process(messageId: string): Promise<{ status: string; eventId?: string }> {
    const command = this.options.store.getCommand(messageId);
    if (!command) return { status: 'not_found' };
    if (!this.options.dispatchEnabled) return { status: 'held' };
    if (command.operation === 'cancel') return this.processCancel(command);
    if (command.operation !== 'execute') return { status: 'rejected_invalid_operation' };
    const content = contentOf(command);
    if (!content) return { status: 'rejected_invalid_payload' };
    const localAgentId = String(command.local_agent_id || command.agent_id);
    const identity = this.options.resolveAgentIdentity?.(localAgentId) || null;
    if (!identity?.privateKey || !identity.imUid) return { status: 'signing_identity_required' };
    const leaseOwner = `owner-dispatch-${crypto.randomUUID()}`;
    const existing = this.options.store.getActiveProviderBinding(command.conversation_id);
    const trusted = existing ? null : this.options.dispatcher.resolveTrustedOwnerTransport(localAgentId);
    if (!existing && !trusted) {
      if (this.options.store.acquireDispatchLease(messageId, leaseOwner, this.timeoutMs + 30_000)) {
        this.enqueueStatus(command, identity, 'accepted', {}, 'receipt');
        this.options.store.markFailedNotDelivered(messageId, leaseOwner, 'OWNER_SAFE_TRANSPORT_UNAVAILABLE');
      }
      return { status: 'pull_required' };
    }
    const claimedBinding: ApprovalBinding = existing ? approvalBindingOf(existing) : {
      providerType: String(trusted?.providerType), providerInstanceId: trusted?.providerInstanceId || '',
      adapterType: String(trusted?.providerId), deliveryMode: String(trusted?.deliveryMode),
      bindingVersion: 0, nativeSessionId: null,
    };
    if (!this.options.store.acquireApprovedDispatchLease(messageId, leaseOwner, claimedBinding, this.timeoutMs + 30_000)) {
      return { status: String(this.options.store.getCommand(messageId)?.state || 'approval_not_claimed') };
    }
    let settlementBinding = claimedBinding;
    try {
      this.enqueueStatus(command, identity, 'accepted', {}, 'receipt');
      const result = await this.options.dispatcher.executeIsolated({
        agentId: localAgentId,
        taskId: command.message_id,
        contextId: command.conversation_id,
        content,
        binding: bindingSnapshot(existing),
        preferredAdapter: trusted?.providerId,
        sourceType: 'owner',
        executionScope: 'owner_link',
        timeoutMs: this.timeoutMs,
      });
      const deliveryReceipt = result.receipt?.deliveryReceipt || result.receipt || {};
      const provider = result.receipt?.provider || {};
      if (!existing) {
        const actualProviderId = String(provider.providerId || trusted?.providerId || '');
        const actualProviderType = String(provider.providerType || trusted?.providerType || '');
        const actualMode = String(provider.deliveryMode || deliveryReceipt.deliveryMode || trusted?.deliveryMode || '');
        const actualInstance = String(deliveryReceipt.providerInstanceId || trusted?.providerInstanceId || '');
        if (actualProviderId !== trusted?.providerId || actualProviderType !== trusted?.providerType
            || actualMode !== trusted?.deliveryMode
            || (trusted?.providerInstanceId && actualInstance !== trusted.providerInstanceId)) {
          const mismatch: any = new Error('OWNER_PROVIDER_ROUTE_CHANGED');
          mismatch.code = 'OWNER_PROVIDER_ROUTE_CHANGED'; mismatch.deliveryOutcome = 'outcome_unknown';
          throw mismatch;
        }
        if (deliveryReceipt.nativeSessionId) {
          const saved = this.options.store.saveProviderBinding({
          ownerConversationId: command.conversation_id,
          agentId: localAgentId,
          providerType: actualProviderType, providerInstanceId: actualInstance || null,
          adapterType: actualProviderId, deliveryMode: actualMode,
          nativeSessionId: deliveryReceipt.nativeSessionId,
          expectedVersion: 0,
        });
          const actualBinding = approvalBindingOf(saved);
          if (!this.options.store.promoteClaimedApprovalBinding(messageId, claimedBinding, actualBinding)) {
            const mismatch: any = new Error('OWNER_PROVIDER_BINDING_PROMOTION_FAILED');
            mismatch.code = 'OWNER_PROVIDER_BINDING_PROMOTION_FAILED'; mismatch.deliveryOutcome = 'outcome_unknown';
            throw mismatch;
          }
          settlementBinding = actualBinding;
        }
      }
      this.enqueueStatus(command, identity, 'working');
      if (!this.options.store.markProviderAccepted(messageId, leaseOwner)) return { status: 'state_conflict' };
      const eventId = this.finalizeStatus(command, identity, 'PROVIDER_ACCEPTED', 'COMPLETED',
        'completed', { content: String(result.reply?.content || '') }, settlementBinding);
      return { status: 'completed', eventId };
    } catch (error: any) {
      const outcome = String(error?.deliveryOutcome || 'outcome_unknown');
      const code = String(error?.code || 'OWNER_PROVIDER_EXECUTION_FAILED').slice(0, 128);
      const currentState = String(this.options.store.getCommand(messageId)?.state || 'DISPATCH_RESERVED') as
        'DISPATCH_RESERVED'|'PROVIDER_ACCEPTED';
      if (outcome === 'not_delivered' || outcome === 'rejected') {
        this.finalizeStatus(command, identity, currentState,
          outcome === 'rejected' ? 'REJECTED' : 'FAILED_NOT_DELIVERED', 'failed', { errorCode: code },
          settlementBinding, currentState === 'DISPATCH_RESERVED' ? leaseOwner : null, code,
          outcome === 'rejected' ? 'consumed' : 'rejected');
      } else {
        this.options.store.markOutcomeUnknownAndSettleApproval(messageId, leaseOwner, settlementBinding, code);
      }
      return { status: outcome };
    }
  }

  private processCancel(command: any): { status: string; eventId?: string } {
    const identity = this.options.resolveAgentIdentity?.(String(command.local_agent_id || command.agent_id)) || null;
    if (!identity?.privateKey || !identity.imUid) return { status: 'signing_identity_required' };
    try {
      const result = this.options.store.settleLocalCancel({ cancelMessageId: command.message_id,
        buildCancelAccepted: (cancel, sequence) => {
          const envelope = createOwnerEventEnvelope({ command: cancel, operation: 'accepted', payload: {}, sequence,
            privateKey: identity.privateKey, keyId: identity.keyId, kind: 'receipt' });
          return { eventId: envelope.messageId, rawEnvelope: JSON.stringify(envelope) };
        },
        buildTargetCanceled: (target, sequence) => {
          const envelope = createOwnerEventEnvelope({ command: target, operation: 'canceled', payload: {}, sequence,
            privateKey: identity.privateKey, keyId: identity.keyId, kind: 'event' });
          return { eventId: envelope.messageId, rawEnvelope: JSON.stringify(envelope) };
        },
        buildCancelTerminal: (cancel, sequence, outcome, code) => {
          const envelope = createOwnerEventEnvelope({ command: cancel,
            operation: outcome === 'canceled' ? 'completed' : 'failed',
            payload: outcome === 'canceled' ? { targetMessageId: cancel.target_message_id }
              : { errorCode: code || 'OWNER_CANCEL_TOO_LATE' }, sequence,
            privateKey: identity.privateKey, keyId: identity.keyId, kind: 'event' });
          return { eventId: envelope.messageId, rawEnvelope: JSON.stringify(envelope) };
        },
      });
      return { status: result.status === 'canceled' ? 'completed' : result.status, eventId: result.eventId };
    } catch (_) { return { status: 'state_conflict' }; }
  }

  private enqueueStatus(command: any, identity: { privateKey: string; keyId?: string },
    operation: 'accepted'|'working'|'completed'|'failed'|'canceled', payload: Record<string, unknown> = {},
    kind: 'receipt'|'event' = 'event'): string {
    return this.options.store.enqueueSignedEvent(command.message_id, kind, (sequence) => {
      const envelope = createOwnerEventEnvelope({ command, operation, payload, sequence,
        privateKey: identity.privateKey, keyId: identity.keyId, kind });
      return { eventId: envelope.messageId, rawEnvelope: JSON.stringify(envelope) };
    });
  }

  private finalizeStatus(command: any, identity: { privateKey: string; keyId?: string },
    from: 'DISPATCH_RESERVED'|'PROVIDER_ACCEPTED', to: 'COMPLETED'|'FAILED_NOT_DELIVERED'|'REJECTED',
    operation: 'completed'|'failed', payload: Record<string, unknown>, approvalBinding: ApprovalBinding,
    leaseOwner: string | null = null, code: string | null = null,
    approvalDisposition: 'consumed'|'rejected' = 'consumed'): string {
    return this.options.store.transitionAndEnqueueSignedEvent({
      messageId: command.message_id, from, to, leaseOwner, code, kind: 'event', build: (sequence) => {
        const envelope = createOwnerEventEnvelope({ command, operation, payload, sequence,
          privateKey: identity.privateKey, keyId: identity.keyId, kind: 'event' });
        return { eventId: envelope.messageId, rawEnvelope: JSON.stringify(envelope) };
      }, approvalBinding, approvalDisposition,
    });
  }
}

export { OwnerCommandProcessor, bindingSnapshot };
export type { OwnerCommandProcessorOptions, OwnerDispatcher };
