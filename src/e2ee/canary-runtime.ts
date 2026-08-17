import crypto from 'node:crypto';
import type { CanaryEnvelope, CanaryRuntimePolicy } from './canary-policy';
import type { CanaryStore } from './canary-store';
const { parseCanaryEnvelope, CONTENT_TYPE_E2EE } = require('./canary-policy');

interface CanaryCrypto {
  decrypt(input: { scope: any; envelope: CanaryEnvelope; encryptedState?: Uint8Array|null; stateVersion: number }): Promise<{ plaintext: string; encryptedState: Uint8Array; stateVersion: number }>;
  encrypt(input: { scope: any; messageId: string; plaintext: string; encryptedState: Uint8Array; stateVersion: number }): Promise<{ envelope: CanaryEnvelope; encryptedState: Uint8Array; stateVersion: number }>;
}

export class CanaryRuntime {
  private stats = { received: 0, replied: 0, rejected: 0, failures: 0, plaintextFallbacks: 0 };
  constructor(private readonly options: { policy: CanaryRuntimePolicy; store: CanaryStore; crypto: CanaryCrypto;
    dispatcher: any; deliverRaw: (agentId:string,channelId:string,envelope:string,messageId:string)=>Promise<any> }) {}

  claims(message: any): boolean { return this.options.policy.claims(message?.contentType); }

  async handle(localAgentId: string, message: any): Promise<{ handled:true;accepted:boolean;code?:string }> {
    if (!this.claims(message)) throw new Error('E2EE_CANARY_NOT_CLAIMED');
    let envelope: CanaryEnvelope;
    let scope: any;
    try {
      envelope = parseCanaryEnvelope(message.content);
      scope = this.options.policy.authorize(localAgentId,envelope);
      if (String(message.fromUid || '') === '' || Number(message.channelType || 1) !== 1) throw new Error('E2EE_CANARY_ROUTE_REJECTED');
    } catch (error: any) {
      this.stats.rejected += 1;
      return { handled:true,accepted:false,code:String(error?.message || 'E2EE_CANARY_REJECTED') };
    }
    const digest = crypto.createHash('sha256').update(String(message.content)).digest('base64url');
    try {
      if (this.options.store.reserve(scope,envelope.messageId,digest) === 'duplicate') return { handled:true,accepted:true,code:'duplicate' };
      const session = this.options.store.session(scope.groupId);
      if (!session || session.status === 'locked') throw new Error('E2EE_CANARY_SESSION_LOCKED');
      const opened = await this.options.crypto.decrypt({ scope,envelope,encryptedState:session.encrypted_state,
        stateVersion:Number(session.state_version) });
      this.options.store.commitState(scope.groupId,Number(session.state_version),opened.encryptedState,opened.stateVersion);
      this.stats.received += 1;
      this.options.store.transition(envelope.messageId,['received'],'provider_accepted');
      const result = await this.options.dispatcher.executeCanary({ agentId:localAgentId,content:opened.plaintext,
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

  diagnostics(): any { return { enabled:this.options.policy.enabled,scopeCount:this.options.policy.count(),...this.stats,...this.options.store.diagnostics() }; }
  emergencyDisable(): void { this.options.store.lockAll('revoked'); }
}

module.exports = { CanaryRuntime, CONTENT_TYPE_E2EE };
