import crypto from 'node:crypto';
import type { PushPayload } from '../core/dispatcher/types';
import { createOwnerEventEnvelope } from './event-envelope';
import { OwnerLinkStore } from './store';

interface OwnerDispatcher {
  resolveTrustedOwnerTransport(agentId: string): {
    providerId: string;
    providerType: string;
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
  const content = String(payload.text || '').trim();
  return content && Buffer.byteLength(content, 'utf8') <= 6144 ? content : '';
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
    if (command.operation !== 'execute') return { status: 'pending_control' };
    const content = contentOf(command);
    if (!content) return { status: 'rejected_invalid_payload' };
    const identity = this.options.resolveAgentIdentity?.(command.agent_id) || null;
    if (!identity?.privateKey || !identity.imUid) return { status: 'signing_identity_required' };
    const leaseOwner = `owner-dispatch-${crypto.randomUUID()}`;
    if (!this.options.store.acquireDispatchLease(messageId, leaseOwner, this.timeoutMs + 30_000)) {
      return { status: String(this.options.store.getCommand(messageId)?.state || 'not_claimed') };
    }
    const existing = this.options.store.getActiveProviderBinding(command.conversation_id);
    const trusted = existing ? null : this.options.dispatcher.resolveTrustedOwnerTransport(command.agent_id);
    if (!existing && !trusted) {
      this.options.store.markFailedNotDelivered(messageId, leaseOwner, 'OWNER_SAFE_TRANSPORT_UNAVAILABLE');
      return { status: 'pull_required' };
    }
    try {
      this.enqueueStatus(command, identity, 'accepted', {}, 'receipt');
      const result = await this.options.dispatcher.executeIsolated({
        agentId: command.agent_id,
        taskId: command.message_id,
        contextId: command.conversation_id,
        content,
        binding: bindingSnapshot(existing),
        preferredAdapter: trusted?.providerId,
        sourceType: 'owner',
        executionScope: 'owner_link',
        timeoutMs: this.timeoutMs,
      });
      if (!this.options.store.markProviderAccepted(messageId, leaseOwner)) return { status: 'state_conflict' };
      const deliveryReceipt = result.receipt?.deliveryReceipt || result.receipt || {};
      const provider = result.receipt?.provider || {};
      if (!existing && deliveryReceipt.nativeSessionId && (provider.providerId || trusted?.providerId)) {
        this.options.store.saveProviderBinding({
          ownerConversationId: command.conversation_id,
          agentId: command.agent_id,
          providerType: provider.providerType || trusted?.providerType,
          providerInstanceId: deliveryReceipt.providerInstanceId || null,
          adapterType: provider.providerId || trusted?.providerId,
          deliveryMode: provider.deliveryMode || deliveryReceipt.deliveryMode || trusted?.deliveryMode,
          nativeSessionId: deliveryReceipt.nativeSessionId,
          expectedVersion: 0,
        });
      }
      this.enqueueStatus(command, identity, 'working');
      this.options.store.complete(messageId);
      const eventId = this.enqueueStatus(command, identity, 'completed', { content: String(result.reply?.content || '') });
      return { status: 'completed', eventId };
    } catch (error: any) {
      const outcome = String(error?.deliveryOutcome || 'outcome_unknown');
      const code = String(error?.code || 'OWNER_PROVIDER_EXECUTION_FAILED').slice(0, 128);
      if (outcome === 'not_delivered') this.options.store.markFailedNotDelivered(messageId, leaseOwner, code);
      else if (outcome === 'rejected') this.options.store.markRejected(messageId, leaseOwner, code);
      else this.options.store.markOutcomeUnknown(messageId, leaseOwner, code);
      if (outcome === 'not_delivered' || outcome === 'rejected') {
        this.enqueueStatus(command, identity, 'failed', { errorCode: code });
      }
      return { status: outcome };
    }
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
}

export { OwnerCommandProcessor, bindingSnapshot };
export type { OwnerCommandProcessorOptions, OwnerDispatcher };
