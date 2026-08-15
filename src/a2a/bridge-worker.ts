import type { A2AEnvelope } from './envelope';
import type { A2AMailboxClient } from './mailbox-client';
import type { A2ALocalTaskStore } from './task-store';
import type { A2AScopeResolver } from './scope';

interface A2ABridgeWorkerOptions { client: A2AMailboxClient; store: A2ALocalTaskStore;
  scopes: A2AScopeResolver;
  verify: (value: unknown) => A2AEnvelope; execute: (envelope: A2AEnvelope) => Promise<void>;
  availability?: () => Array<any> }

class A2ABridgeWorker {
  constructor(private readonly options: A2ABridgeWorkerOptions) {}
  private async executePersisted(eventId: string, envelope: A2AEnvelope): Promise<'processed' | 'retry' | 'uncertain'> {
    if (!this.options.store.beginCommand(eventId)) return 'uncertain';
    try {
      await this.options.execute(envelope);
      this.options.store.finishCommand(eventId, 'processed');
      return 'processed';
    } catch (error: any) {
      if (error?.deliveryOutcome === 'not_delivered') {
        this.options.store.retryCommand(eventId, String(error?.code || 'PROVIDER_NOT_DELIVERED'));
        return 'retry';
      }
      this.options.store.finishCommand(eventId, 'outcome_unknown', String(error?.code || 'EXECUTION_OUTCOME_UNKNOWN'));
      return 'uncertain';
    }
  }
  async pollOnce(): Promise<{ claimed: number; processed: number; uncertain: number }> {
    const claim = await this.options.client.claim(20, this.options.availability?.() || []); let processed = 0; let uncertain = 0;
    for (const item of claim.items) {
      const envelope = this.options.verify(item.envelope);
      if (envelope.eventId !== item.eventId || envelope.gatewayTaskId !== item.taskId) throw new Error('A2A claim/envelope identity mismatch');
      const principalScope = this.options.scopes.principalScope({ issuer: envelope.caller.issuer || 'agentdid',
        provenance: envelope.caller.provenance, principalId: envelope.caller.principalId });
      this.options.store.createTask({ gatewayTaskId: envelope.gatewayTaskId, contextId: envelope.contextId,
        executionId: envelope.executionId, agentId: envelope.agentId, gatewayUid: 'mailbox-gateway',
        principalScope, scopeVersion: this.options.scopes.version, scopeKeyId: this.options.scopes.keyId,
        bindingGeneration: Number((envelope as any).bindingGeneration || 1), ownerEpoch: Number((envelope as any).ownerEpoch || 1),
        policyRevision: Number((envelope as any).policyRevision || 1) });
      const accepted = this.options.store.acceptCommand(envelope.eventId, envelope.gatewayTaskId, envelope.sequence, envelope.operation, envelope);
      if (accepted !== 'duplicate') console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] [A2A] 收到 A2A 消息`);
      await this.options.client.acknowledge(claim.leaseId, item.eventId);
      this.options.store.markReceiptAcknowledged(envelope.eventId);
      const status = this.options.store.commandStatus(envelope.eventId);
      if (accepted === 'duplicate' && status !== 'received') continue;
      const result = await this.executePersisted(envelope.eventId, envelope);
      if (result === 'processed') processed += 1;
      else if (result === 'uncertain') uncertain += 1;
    }
    for (const command of this.options.store.listReadyRetryCommands()) {
      if (!command.envelope_json) continue;
      const result = await this.executePersisted(command.event_id, this.options.verify(JSON.parse(command.envelope_json)));
      if (result === 'processed') processed += 1;
      else if (result === 'uncertain') uncertain += 1;
    }
    return { claimed: claim.items.length, processed, uncertain };
  }
}
export { A2ABridgeWorker };
export type { A2ABridgeWorkerOptions };
