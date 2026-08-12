import type { A2AEnvelope } from './envelope';
import type { A2ALocalTaskStore } from './task-store';

interface IsolatedDispatcher { executeIsolated(options: Record<string, unknown>): Promise<{ reply: any; receipt?: any }> }
class A2AExecutionService {
  constructor(private readonly store: A2ALocalTaskStore, private readonly dispatcher: IsolatedDispatcher) {}
  async execute(envelope: A2AEnvelope): Promise<{ content: string }> {
    const content = String((envelope.payload as any)?.text || '');
    if (!content || Buffer.byteLength(content, 'utf8') > 6144) throw new Error('Invalid A2A text payload');
    const context = this.store.getContext(envelope.agentId, envelope.contextId);
    const binding = context?.native_session_id ? { id: `a2a:${envelope.contextId}`, bindingVersion: 1,
      providerType: context.provider_family, providerInstanceId: context.provider_instance_id,
      deliveryMode: context.delivery_mode, adapterType: context.adapter_type,
      nativeSessionId: context.native_session_id, sessionOrigin: 'voko_managed',
      channelId: envelope.contextId, channelType: 1, strictSessionRoute: true } : null;
    const result = await this.dispatcher.executeIsolated({ agentId: envelope.agentId, taskId: envelope.gatewayTaskId,
      contextId: envelope.contextId, content, binding });
    const deliveryReceipt = result.receipt?.deliveryReceipt || result.receipt;
    const provider = result.receipt?.provider || {};
    const providerFamily = provider.providerType || binding?.providerType;
    if (deliveryReceipt?.nativeSessionId && providerFamily) this.store.saveContext({ agentId: envelope.agentId,
      contextId: envelope.contextId, providerFamily,
      providerInstanceId: deliveryReceipt.providerInstanceId || binding?.providerInstanceId,
      deliveryMode: provider.deliveryMode || deliveryReceipt.deliveryMode || binding?.deliveryMode,
      adapterType: provider.providerId || deliveryReceipt.adapterType || binding?.adapterType,
      nativeSessionId: deliveryReceipt.nativeSessionId });
    return { content: String(result.reply?.content || '') };
  }
}
export { A2AExecutionService };
