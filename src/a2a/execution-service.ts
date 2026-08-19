import type { A2AEnvelope } from './envelope';
import type { A2ALocalTaskStore } from './task-store';
import type { A2AScopeResolver } from './scope';
import { getProviderTransport } from '../core/dispatcher/provider-catalog';
import type { A2AMailboxClient } from './mailbox-client';
import type { A2AAttachmentWorkspace } from './attachment-workspace';

interface IsolatedDispatcher { executeIsolated(options: Record<string, unknown>): Promise<{ reply: any; receipt?: any }> }
interface SafetyGate { assertAllowed(content: string, direction: 'inbound' | 'outbound'): Promise<void> }
const INTERNAL_NO_REPLY = new Set(['NO_REPLY', 'HEARTBEAT_OK', 'ANNOUNCE_SKIP']);
class A2AExecutionService {
  constructor(private readonly store: A2ALocalTaskStore, private readonly dispatcher: IsolatedDispatcher,
    private readonly safety?: SafetyGate, private readonly assertDispatchAllowed?: (agentId: string) => void,
    private readonly scopes?: A2AScopeResolver, private readonly mailbox?: A2AMailboxClient,
    private readonly attachmentWorkspace?: A2AAttachmentWorkspace) {}
  async execute(envelope: A2AEnvelope, callbacks?: { onProviderAccepted?: () => void }): Promise<{ content: string; noReply?: boolean; artifacts?: Array<any> }> {
    this.assertDispatchAllowed?.(envelope.agentId);
    let content = String((envelope.payload as any)?.text || '');
    const attachmentRefs = Array.isArray((envelope.payload as any)?.attachments)
      ? (envelope.payload as any).attachments.map((item: any) => String(item.attachmentRef || '')) : [];
    if ((!content && !attachmentRefs.length) || Buffer.byteLength(content, 'utf8') > 6144) throw new Error('Invalid A2A text payload');
    if(content)await this.safety?.assertAllowed(content, 'inbound');
    if (!this.scopes) throw new Error('A2A_PRINCIPAL_SCOPE_REQUIRED');
    const principalScope = this.scopes.principalScope({ issuer: envelope.caller.issuer || 'agentdid',
      provenance: envelope.caller.provenance, principalId: envelope.caller.principalId });
    const sessionScopeId = this.scopes.sessionScope(envelope.agentId, principalScope, envelope.contextId);
    const bindingGeneration = Number(envelope.bindingGeneration || 0);
    if (!Number.isSafeInteger(bindingGeneration) || bindingGeneration < 1)
      throw new Error('A2A_BINDING_GENERATION_REQUIRED');
    const context = this.store.getContext(envelope.agentId, principalScope, envelope.contextId,
      this.scopes.version, this.scopes.keyId, bindingGeneration);
    const binding = context?.native_session_id ? { id: `a2a:${sessionScopeId}`, bindingVersion: context.binding_generation,
      providerType: context.provider_family, providerInstanceId: context.provider_instance_id,
      deliveryMode: context.delivery_mode, adapterType: context.adapter_type,
      nativeSessionId: context.native_session_id, sessionOrigin: 'voko_managed',
      channelId: sessionScopeId, channelType: 1, sourceScope: 'a2a', strictSessionRoute: true,
      nativeSessionNamespace: context.native_session_namespace,
      restoreCompatibilityGroup: context.restore_compatibility_group } : null;
    const leaseToken = this.store.acquireSessionLease(sessionScopeId, envelope.gatewayTaskId);
    if (!leaseToken) { const error: any = new Error('A2A_CONTEXT_BUSY'); error.deliveryOutcome = 'not_delivered'; throw error; }
    let prepared: Awaited<ReturnType<A2AAttachmentWorkspace['prepare']>> | undefined;
    if (attachmentRefs.length) {
      if (!this.mailbox || !this.attachmentWorkspace) {
        this.store.releaseSessionLease(sessionScopeId,leaseToken);
        const error: any = new Error('A2A_ATTACHMENT_DELIVERY_NOT_READY');
        error.code='A2A_ATTACHMENT_DELIVERY_NOT_READY';error.deliveryOutcome='not_delivered';throw error;
      }
      try { prepared=await this.attachmentWorkspace.prepare(envelope.gatewayTaskId,attachmentRefs,this.mailbox,this.safety);content=prepared.prompt(content); }
      catch(error:any){this.store.releaseSessionLease(sessionScopeId,leaseToken);error.deliveryOutcome='not_delivered';
        error.code=error.code||error.message||'A2A_ATTACHMENT_PREPARE_FAILED';throw error;}
    }
    let accepted = false;
    let result: any;
    try {
      result = await this.dispatcher.executeIsolated({ agentId: envelope.agentId, taskId: envelope.gatewayTaskId,
        contextId: envelope.contextId, content, binding, executionScope: 'a2a_mailbox', sessionScopeId,
        principalScope, bindingGeneration, protocolContextId: envelope.contextId,
        attachments: prepared?.inputs, attachmentOutputDirectory: prepared?.outputDirectory,
        onProviderAccepted: () => { accepted = true; this.store.markLeaseAccepted(sessionScopeId, leaseToken);
          callbacks?.onProviderAccepted?.(); } });
    } catch (error: any) {
      await prepared?.cleanup(); prepared=undefined;
      if (!accepted && error?.deliveryOutcome === 'not_delivered') this.store.releaseSessionLease(sessionScopeId, leaseToken);
      throw error;
    }
    const replyContent = String(result.reply?.content || '');let artifacts:any[]=[];
    try {
      const deliveryReceipt = result.receipt?.deliveryReceipt || result.receipt;
      const provider = result.receipt?.provider || {};
      const providerFamily = provider.providerType || binding?.providerType;
      if (deliveryReceipt?.nativeSessionId && providerFamily) {
        const transport = getProviderTransport(provider.providerId || deliveryReceipt.adapterType || binding?.adapterType);
        this.store.saveContext({ agentId: envelope.agentId, principalScope, contextId: envelope.contextId,
        sessionScopeId, scopeVersion: this.scopes.version, scopeKeyId: this.scopes.keyId,
        bindingGeneration, providerFamily,
        providerInstanceId: deliveryReceipt.providerInstanceId || binding?.providerInstanceId,
        deliveryMode: provider.deliveryMode || deliveryReceipt.deliveryMode || binding?.deliveryMode,
        adapterType: provider.providerId || deliveryReceipt.adapterType || binding?.adapterType,
        nativeSessionNamespace: transport?.exactSession?.nativeSessionNamespace || providerFamily,
        restoreCompatibilityGroup: transport?.exactSession?.restoreCompatibilityGroup || String(provider.providerId || ''),
        nativeSessionId: deliveryReceipt.nativeSessionId });
      }
      artifacts=prepared?await this.attachmentWorkspace!.uploadOutputs(envelope.gatewayTaskId,prepared.outputDirectory,this.mailbox!,this.safety):[];
      this.store.releaseSessionLease(sessionScopeId, leaseToken, true);
    } catch(error) {
      await prepared?.cleanup();prepared=undefined;throw error;
    }
    await prepared?.cleanup(); prepared=undefined;
    if (INTERNAL_NO_REPLY.has(replyContent.trim())) return { content: '', noReply: true, ...(artifacts.length?{artifacts}:{}) };
    await this.safety?.assertAllowed(replyContent, 'outbound');
    return { content: replyContent, ...(artifacts.length?{artifacts}:{}) };
  }
}
export { A2AExecutionService, INTERNAL_NO_REPLY };
