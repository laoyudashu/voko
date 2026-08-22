import type { CanaryEnvelope } from './canary-policy';
import type { ProductionE2eeScope, ProductionE2eeStore } from './production-store';

export class ProductionE2eePolicy {
  readonly enabled: boolean;
  constructor(private readonly store: ProductionE2eeStore, enabled: boolean) { this.enabled = enabled; }
  claims(contentType: unknown): boolean { return Number(contentType) === 13; }
  authorize(localAgentId: string, envelope: CanaryEnvelope, message?: any): ProductionE2eeScope {
    if (!this.enabled) throw new Error('E2EE_PRODUCTION_DISABLED');
    const creatorPrincipalId = String(message?.fromUid || '');
    if (!creatorPrincipalId || Number(message?.channelType || 1) !== 1) throw new Error('E2EE_ROUTE_REJECTED');
    const row = this.store.resolve(localAgentId,envelope.groupId,creatorPrincipalId,envelope.conversationScope);
    if (!row || row.target_agent_did !== envelope.targetAgentDid) throw new Error('E2EE_SCOPE_REJECTED');
    return {
      localAgentId: row.local_agent_id, serverAgentId: row.server_agent_id,
      targetAgentDid: row.target_agent_did, creatorPrincipalId: row.creator_principal_id,
      senderDeviceKeyId: envelope.senderDeviceKeyId, recipientDeviceKeyId: row.recipient_device_key_id,
      ownerScope: row.owner_scope, groupId: row.group_id, conversationScope: row.conversation_scope,
      bindingGeneration: Number(row.binding_generation),
    };
  }
  count(): number { return Number((this.store.diagnostics().sessions || []).reduce((sum: number, row: any) => sum + Number(row.count || 0),0)); }
  configuredScopes(): ProductionE2eeScope[] { return []; }
}

module.exports = { ProductionE2eePolicy };
