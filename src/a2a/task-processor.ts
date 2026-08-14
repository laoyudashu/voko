import type { A2AEnvelope } from './envelope';
import { signEnvelope } from './envelope';
import type { A2AExecutionService } from './execution-service';
import type { A2ALocalIdentity } from './identity-store';
import type { A2ALocalTaskStore, DeliveryState, StandardTaskState } from './task-store';
import { A2ASafetyRejection } from './safety-gate';

class A2ATaskProcessor {
  constructor(private readonly store: A2ALocalTaskStore, private readonly execution: A2AExecutionService,
    private readonly identity: A2ALocalIdentity) {}
  private event(request: A2AEnvelope, operation: string, payload: Record<string, unknown>,
    state: StandardTaskState, delivery: DeliveryState): void {
    this.store.enqueueTaskEvent(request.gatewayTaskId, operation, state, delivery, (sequence, eventId) => {
      const createdAt = new Date();
      return signEnvelope({ version: 'voko.a2a/1', kind: 'event', operation, eventId,
        gatewayTaskId: request.gatewayTaskId, contextId: request.contextId,
        gatewayMessageId: request.gatewayMessageId, executionId: request.executionId, sequence,
        agentId: request.agentId, caller: { principalId: request.agentId, actorKind: 'agent', provenance: 'registered' },
        payload, trace: request.trace, timestamps: { createdAt: createdAt.toISOString(),
          expiresAt: new Date(createdAt.getTime() + 3_600_000).toISOString() } } as A2AEnvelope,
      this.identity.keyId, this.identity.privateKey);
    });
  }
  async process(request: A2AEnvelope): Promise<void> {
    if (request.kind === 'control' && request.operation === 'cancel') {
      const state = this.store.getTaskState(request.gatewayTaskId);
      const result = state && ['COMPLETED', 'FAILED', 'CANCELED', 'REJECTED'].includes(state) ? 'too_late' : 'unsupported';
      this.event(request, 'cancel_ack', { result }, state || 'SUBMITTED', state === 'WORKING' ? 'EXECUTING' : 'DELIVERED');
      return;
    }
    if (request.kind !== 'request' || !['execute', 'continue'].includes(request.operation)) throw new Error('Unsupported A2A command');
    this.event(request, 'accepted', {}, 'SUBMITTED', 'DELIVERED');
    this.event(request, 'working', {}, 'WORKING', 'EXECUTING');
    try {
      const result = await this.execution.execute(request);
      this.event(request, 'completed', { text: result.content }, 'COMPLETED', 'DELIVERED');
    } catch (error) {
      if (error instanceof A2ASafetyRejection) {
        this.event(request, 'rejected', { reasonCode: error.reasonCode }, 'REJECTED', 'DELIVERED');
        return;
      }
      this.event(request, 'working', { deliveryState: 'DELIVERY_UNKNOWN', reasonCode: 'PROVIDER_OUTCOME_UNKNOWN' },
        'WORKING', 'DELIVERY_UNKNOWN');
    }
  }
}
export { A2ATaskProcessor };
