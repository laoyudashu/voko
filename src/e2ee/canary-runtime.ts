import crypto from 'node:crypto';
import type { CanaryEnvelope } from './canary-policy';
const { parseCanaryEnvelope, CONTENT_TYPE_E2EE } = require('./canary-policy');

interface CanaryCrypto {
  provision?(scope: any, welcome: string): Promise<Uint8Array>;
  revoke?(scope: any): Promise<void>;
  decrypt(input: { scope: any; envelope: CanaryEnvelope; encryptedState?: Uint8Array|null; stateVersion: number }): Promise<{ plaintext: string; encryptedState: Uint8Array; stateVersion: number }>;
  encrypt(input: { scope: any; messageId: string; plaintext: string; encryptedState: Uint8Array; stateVersion: number }): Promise<{ envelope: CanaryEnvelope; encryptedState: Uint8Array; stateVersion: number }>;
}

type E2eeDispatcher = {
  executeE2ee?(input: any): Promise<{ reply: any; receipt?: unknown }>;
  executeCanary?(input: any): Promise<{ reply: any; receipt?: unknown }>;
};

type E2eeRuntimePolicy = {
  enabled: boolean;
  claims(contentType: unknown): boolean;
  authorize(localAgentId: string, envelope: CanaryEnvelope, message?: any): any;
  count(): number;
  configuredScopes(): any[];
};

type E2eeRuntimeStore = {
  isEmergencyDisabled(): boolean;
  reserve(scope: any, messageId: string, digest: string): 'new'|'duplicate';
  session(groupId: string): any;
  commitState(groupId: string, expectedVersion: number, encryptedState: Uint8Array, nextVersion: number): void;
  transition(messageId: string, from: string[], to: any, encryptedReply?: string): void;
  diagnostics(): any;
  bindSenderDevice?(groupId: string, senderDeviceKeyId: string): void;
  emergencyDisable?(): void;
  provision?(scope: any, encryptedState: Uint8Array): void;
};

export class CanaryRuntime {
  private stats = { received: 0, replied: 0, rejected: 0, failures: 0, plaintextFallbacks: 0 };
  private disabled = false;
  constructor(private readonly options: { policy: E2eeRuntimePolicy; store: E2eeRuntimeStore; crypto: CanaryCrypto;
    dispatcher: E2eeDispatcher; deliverRaw: (agentId:string,channelId:string,envelope:string,messageId:string)=>Promise<any> }) {
    this.disabled = options.store.isEmergencyDisabled();
  }

  claims(message: any): boolean { return this.options.policy.claims(message?.contentType); }

  async handle(localAgentId: string, message: any): Promise<{ handled:true;accepted:boolean;code?:string }> {
    if (!this.claims(message)) throw new Error('E2EE_CANARY_NOT_CLAIMED');
    if (this.disabled) return { handled:true,accepted:false,code:'E2EE_CANARY_EMERGENCY_DISABLED' };
    let envelope: CanaryEnvelope;
    let scope: any;
    try {
      envelope = parseCanaryEnvelope(message.content);
      scope = this.options.policy.authorize(localAgentId,envelope,message);
      if (String(message.fromUid || '') === '' || Number(message.channelType || 1) !== 1) throw new Error('E2EE_CANARY_ROUTE_REJECTED');
    } catch (error: any) {
      this.stats.rejected += 1;
      return { handled:true,accepted:false,code:String(error?.message || 'E2EE_CANARY_REJECTED') };
    }
    const digest = crypto.createHash('sha256').update(String(message.content)).digest('base64url');
    try {
      if (this.options.store.reserve(scope,envelope.messageId,digest) === 'duplicate') {
        message?.ack?.();
        if (message) message.__e2eeReceiptAcked = true;
        return { handled:true,accepted:true,code:'duplicate' };
      }
      // Receipt ACK only means that the immutable ciphertext is durably owned.
      // Provider execution and its outcome remain separate persisted states.
      message?.ack?.();
      if (message) message.__e2eeReceiptAcked = true;
      const session = this.options.store.session(scope.groupId);
      if (!session || session.status === 'locked') throw new Error('E2EE_CANARY_SESSION_LOCKED');
      const opened = await this.options.crypto.decrypt({ scope,envelope,encryptedState:session.encrypted_state,
        stateVersion:Number(session.state_version) });
      this.options.store.bindSenderDevice?.(scope.groupId,envelope.senderDeviceKeyId);
      this.options.store.commitState(scope.groupId,Number(session.state_version),opened.encryptedState,opened.stateVersion);
      this.stats.received += 1;
      this.options.store.transition(envelope.messageId,['received'],'provider_accepted');
      const execute = this.options.dispatcher.executeE2ee || this.options.dispatcher.executeCanary;
      if (!execute) throw new Error('E2EE_PROVIDER_EXECUTION_UNAVAILABLE');
      const result = await execute.call(this.options.dispatcher,{ agentId:localAgentId,content:opened.plaintext,
        taskId:envelope.messageId,contextId:scope.conversationScope,sessionScopeId:scope.groupId });
      const current = this.options.store.session(scope.groupId);
      const replyId = `e2ee-reply-${crypto.randomUUID()}`;
      const sealed = await this.options.crypto.encrypt({ scope,messageId:replyId,plaintext:String(result.reply?.content || ''),
        encryptedState:current.encrypted_state,stateVersion:Number(current.state_version) });
      this.options.store.commitState(scope.groupId,Number(current.state_version),sealed.encryptedState,sealed.stateVersion);
      const encoded = JSON.stringify(sealed.envelope);
      this.options.store.transition(envelope.messageId,['provider_accepted'],'completed',encoded);
      await this.options.deliverRaw(localAgentId,String(message.fromUid),encoded,replyId);
      this.stats.replied += 1;
      return { handled:true,accepted:true };
    } catch (error: any) {
      this.stats.failures += 1;
      try { this.options.store.transition(envelope.messageId,['received','provider_accepted'],'outcome_unknown'); } catch {}
      return { handled:true,accepted:false,code:String(error?.code || error?.message || 'E2EE_CANARY_FAILED') };
    }
  }

  diagnostics(): any { return { enabled:this.options.policy.enabled && !this.disabled,emergencyDisabled:this.disabled,
    scopeCount:this.options.policy.count(),...this.stats,...this.options.store.diagnostics() }; }
  async provision(scope: any, welcome: string): Promise<void> {
    if (!this.options.policy.enabled || this.disabled || !this.options.crypto.provision) throw new Error('E2EE_CANARY_DISABLED');
    const allowed = this.options.policy.configuredScopes().find(candidate => candidate.localAgentId === scope.localAgentId
      && candidate.groupId === scope.groupId && candidate.senderDeviceKeyId === scope.senderDeviceKeyId);
    if (!allowed) throw new Error('E2EE_CANARY_SCOPE_REJECTED');
    if (!this.options.store.provision) throw new Error('E2EE_PROVISION_UNAVAILABLE');
    this.options.store.provision(allowed, await this.options.crypto.provision(allowed,welcome));
  }
  async emergencyDisable(): Promise<void> {
    this.disabled = true;
    this.options.store.emergencyDisable?.();
    if (this.options.crypto.revoke) {
      await Promise.allSettled(this.options.policy.configuredScopes().map(scope => this.options.crypto.revoke!(scope)));
    }
  }
}

module.exports = { CanaryRuntime, CONTENT_TYPE_E2EE };
