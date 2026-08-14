import type { A2AEnvelope } from './envelope';
import type { A2AMailboxClient } from './mailbox-client';
import type { A2ALocalTaskStore } from './task-store';

interface A2ABridgeWorkerOptions { client: A2AMailboxClient; store: A2ALocalTaskStore;
  verify: (value: unknown) => A2AEnvelope; execute: (envelope: A2AEnvelope) => Promise<void>;
  availability?: () => Array<any> }

class A2ABridgeWorker {
  constructor(private readonly options: A2ABridgeWorkerOptions) {}
  async pollOnce(): Promise<{ claimed: number; processed: number; uncertain: number }> {
    const claim = await this.options.client.claim(20, this.options.availability?.() || []); let processed = 0; let uncertain = 0;
    for (const item of claim.items) {
      const envelope = this.options.verify(item.envelope);
      if (envelope.eventId !== item.eventId || envelope.gatewayTaskId !== item.taskId) throw new Error('A2A claim/envelope identity mismatch');
      this.options.store.createTask({ gatewayTaskId: envelope.gatewayTaskId, contextId: envelope.contextId,
        executionId: envelope.executionId, agentId: envelope.agentId, gatewayUid: 'mailbox-gateway',
        bindingGeneration: Number((envelope as any).bindingGeneration || 1), ownerEpoch: Number((envelope as any).ownerEpoch || 1),
        policyRevision: Number((envelope as any).policyRevision || 1) });
      const accepted = this.options.store.acceptCommand(envelope.eventId, envelope.gatewayTaskId, envelope.sequence, envelope.operation, envelope);
      if (accepted === 'duplicate') {
        if (this.options.store.commandStatus(envelope.eventId) === 'processed') await this.options.client.acknowledge(claim.leaseId, item.eventId);
        else uncertain += 1;
        continue;
      }
      if (!this.options.store.beginCommand(envelope.eventId)) { uncertain += 1; continue; }
      try {
        await this.options.execute(envelope);
        this.options.store.finishCommand(envelope.eventId, 'processed');
        await this.options.client.acknowledge(claim.leaseId, item.eventId); processed += 1;
      } catch (error) {
        this.options.store.finishCommand(envelope.eventId, 'outcome_unknown', 'EXECUTION_OUTCOME_UNKNOWN'); uncertain += 1;
      }
    }
    return { claimed: claim.items.length, processed, uncertain };
  }
}
export { A2ABridgeWorker };
export type { A2ABridgeWorkerOptions };
