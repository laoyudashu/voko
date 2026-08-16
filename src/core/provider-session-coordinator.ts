import type { DatabaseLike } from '../types/database';
import type { ProviderDeliveryReceipt, PushPayload } from './dispatcher/types';
import { ProviderConversationBindingStore, type ProviderConversationBinding } from './provider-conversation-bindings';
const { normalizeProviderFamily } = require('./provider-routing');

export interface ProviderSessionRoute {
  providerType: string;
  providerInstanceId?: string | null;
  deliveryMode: string;
  adapterType: string;
  acceptsBinding?: (binding: NonNullable<PushPayload['providerBinding']>, agentId: string) => boolean;
}

function normalizeProviderType(value: unknown): string {
  return normalizeProviderFamily(String(value || '').trim());
}

/**
 * Owns VOKO's durable Provider-session state transitions. Transports may
 * restore or create a native session, but persistence and invalidation go
 * through this coordinator so caller-owned bindings cannot be overwritten by
 * an automatic fallback.
 */
export class ProviderSessionCoordinator {
  readonly store: ProviderConversationBindingStore;

  constructor(db: Pick<DatabaseLike, 'prepare' | 'exec'>) {
    this.store = new ProviderConversationBindingStore(db);
  }

  recoverPending(): { activated: number; discarded: number } {
    return this.store.recoverPending();
  }

  getActive(agentId: string, channelId: string, channelType = 1): ProviderConversationBinding | null {
    return this.store.getActive(agentId, channelId, channelType);
  }

  resolveForTransport(
    agentId: string,
    binding: PushPayload['providerBinding'],
    route: ProviderSessionRoute,
  ): PushPayload['providerBinding'] {
    if (!binding) return null;
    let compatible = normalizeProviderType(binding.providerType) === normalizeProviderType(route.providerType);
    if (compatible && binding.providerInstanceId && route.providerInstanceId !== undefined) {
      compatible = String(binding.providerInstanceId) === String(route.providerInstanceId || '');
    }
    if (compatible && !binding.strictSessionRoute) {
      compatible = route.acceptsBinding
        ? route.acceptsBinding(binding, agentId)
        : binding.deliveryMode === route.deliveryMode && binding.adapterType === route.adapterType;
    }
    if (compatible) return binding;
    if (binding.sessionOrigin !== 'caller') this.store.markStale(binding.id);
    return null;
  }

  onDeliveryFailure(binding: PushPayload['providerBinding'], outcome: string): void {
    if (!binding || binding.sessionOrigin === 'caller' || outcome !== 'not_delivered') return;
    this.store.markStale(binding.id);
  }

  commitDelivery(input: {
    agentId: string;
    channelId: string;
    channelType?: number;
    providerType: string;
    deliveryMode: string;
    adapterType: string;
    binding?: PushPayload['providerBinding'];
    receipt?: ProviderDeliveryReceipt | null;
  }): ProviderConversationBinding | null {
    const nativeSessionId = String(input.receipt?.nativeSessionId || '').trim();
    if (!nativeSessionId || input.binding?.sessionOrigin === 'caller') return null;
    return this.store.saveManaged({
      agentId: input.agentId,
      channelId: input.channelId,
      channelType: input.channelType,
      providerType: input.providerType,
      providerInstanceId: input.receipt?.providerInstanceId ?? input.binding?.providerInstanceId ?? null,
      nativeSessionId,
      deliveryMode: input.receipt?.deliveryMode || input.deliveryMode,
      adapterType: input.receipt?.adapterType || input.adapterType,
      expectedVersion: input.binding?.bindingVersion ?? 0,
    });
  }

  saveManaged(input: Parameters<ProviderConversationBindingStore['saveManaged']>[0]): ProviderConversationBinding | null {
    return this.store.saveManaged(input);
  }

  beginCallerBinding(input: Parameters<ProviderConversationBindingStore['beginCallerBinding']>[0]): ProviderConversationBinding | null {
    return this.store.beginCallerBinding(input);
  }

  activatePending(id: string): ProviderConversationBinding | null {
    return this.store.activatePending(id);
  }

  discardPending(id: string): void {
    this.store.discardPending(id);
  }

  invalidateForAgentConfigChange(input: Parameters<ProviderConversationBindingStore['invalidateForAgentConfigChange']>[0]): number {
    return this.store.invalidateForAgentConfigChange(input);
  }
}

module.exports = { ProviderSessionCoordinator };
