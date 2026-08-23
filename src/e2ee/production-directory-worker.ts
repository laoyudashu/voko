import crypto from 'node:crypto';
import { availableParallelism, cpus } from 'node:os';
import type { E2eeDirectoryClient, E2eeDirectoryEstablishment } from './directory-client';
import type { PendingRecipientProcess } from './canary-crypto-process';
import type { ProductionE2eeScope, ProductionE2eeStore } from './production-store';

export interface ProductionE2eeAgent {
  localAgentId: string;
  serverAgentId: string;
  targetAgentDid: string;
  ownerDeviceKeyId: string;
  ownerScope: string;
  bindingGeneration: number;
}

type Recipient = Pick<PendingRecipientProcess,'ready'|'join'|'sealPending'|'restorePending'|'replenish'|'close'>;

function packageReference(keyPackage: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(keyPackage)) throw new Error('E2EE_ENDPOINT_INVALID_KEY_PACKAGE');
  return crypto.createHash('sha256').update(Buffer.from(keyPackage,'base64url')).digest('base64url');
}

function pendingScope(agent: ProductionE2eeAgent, epoch: number): any {
  return {
    localAgentId: agent.localAgentId, serverAgentId: agent.serverAgentId,
    targetAgentDid: agent.targetAgentDid, creatorPrincipalId: 'pending', creatorDeviceBindingId: 'pending',
    protocolMode: 'legacy_group_v1', senderDeviceKeyId: 'pending',
    recipientDeviceKeyId: agent.ownerDeviceKeyId, ownerScope: agent.ownerScope,
    groupId: `pending-${epoch}`, conversationScope: `pending-${epoch}`,
    bindingGeneration: agent.bindingGeneration,
    keyEpoch: epoch,
  };
}

export class ProductionE2eeDirectoryWorker {
  private readonly processes = new Map<string,{ recipient:Recipient; lastUsed:number }>();
  private processClock = 0;
  private timer: NodeJS.Timeout|null = null;
  private running = false;
  private retryAfter = 0;
  private nextAgentIndex = 0;
  private sharedFailureCount = 0;

  constructor(private readonly options: {
    client: E2eeDirectoryClient;
    store: ProductionE2eeStore;
    agents: () => ProductionE2eeAgent[];
    processFactory: (scope: ProductionE2eeScope) => Recipient;
    applyCommit?: (input:{scope:ProductionE2eeScope;commit:string;encryptedState:Uint8Array;stateVersion:number})=>Promise<{encryptedState:Uint8Array;stateVersion:number}>;
    prepareAddMember?: (input:{scope:ProductionE2eeScope;keyPackage:string;encryptedState:Uint8Array;stateVersion:number})=>Promise<{commit:string;welcome:string;pendingState:Uint8Array}>;
    prepareRemoveDevice?: (input:{scope:ProductionE2eeScope;deviceKeyId:string;encryptedState:Uint8Array;stateVersion:number})=>Promise<{commit:string;pendingState:Uint8Array}>;
    acceptPendingCommit?: (input:{scope:ProductionE2eeScope;pendingState:Uint8Array;stateVersion:number})=>Promise<{encryptedState:Uint8Array;stateVersion:number}>;
    intervalMs?: number;
    maxAgentsPerRun?: number;
    maxResidentProcesses?: number;
    now?: () => number;
    onError?: (agentId: string, error: unknown) => void;
    onRecovery?: (failureCount: number) => void;
  }) {}

  private isSharedServiceFailure(error: any): boolean {
    const status = Number(error?.status || 0);
    const code = String(error?.code || '');
    const causeCode = String(error?.cause?.code || '');
    return status === 429 || status >= 500
      || /^E2EE_DIRECTORY_HTTP_5\d\d$/.test(code)
      || ['ECONNREFUSED','ECONNRESET','ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET'].includes(code)
      || ['ECONNREFUSED','ECONNRESET','ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET'].includes(causeCode);
  }

  private backoffSharedFailure(error: any, affectedAgents: number): void {
    this.sharedFailureCount += 1;
    const base = Math.max(2_000,Number(this.options.intervalMs || 30_000));
    const retryMs = Number(error?.status) === 429
      ? Math.max(1_000,Number(error?.retryAfterMs) || 60_000)
      : Math.min(60_000,base * (2 ** Math.min(this.sharedFailureCount - 1,5)));
    this.retryAfter = (this.options.now || Date.now)() + retryMs;
    error.sharedServiceFailure = true;
    error.affectedAgents = affectedAgents;
    error.retryAfterMs = retryMs;
    this.options.onError?.('directory',error);
  }

  private process(agent: ProductionE2eeAgent, epoch: number): Recipient {
    const existing = this.processes.get(agent.localAgentId);
    if (existing) {
      existing.lastUsed = ++this.processClock;
      return existing.recipient;
    }
    const configured = Number(this.options.maxResidentProcesses || 0);
    const cpuLimit = Math.max(1,Math.min(4,typeof availableParallelism === 'function'
      ? availableParallelism() : cpus().length));
    const limit = Number.isSafeInteger(configured) && configured > 0 ? Math.min(configured,32) : cpuLimit;
    while (this.processes.size >= limit) {
      const oldest = [...this.processes.entries()].sort((left,right) => left[1].lastUsed - right[1].lastUsed)[0];
      if (!oldest) break;
      oldest[1].recipient.close();
      this.processes.delete(oldest[0]);
    }
    const created = this.options.processFactory(pendingScope(agent,epoch));
    this.processes.set(agent.localAgentId,{ recipient:created,lastUsed:++this.processClock });
    return created;
  }

  residentProcessCount(): number { return this.processes.size; }

  private async ensurePackage(agent: ProductionE2eeAgent): Promise<any> {
    let row = this.options.store.keyPackage(agent.localAgentId);
    const epoch = Number(row?.key_epoch || this.options.store.deviceKeyEpoch(agent.localAgentId));
    const recipient = this.process(agent,epoch);
    let credentialPublicKey: string;
    if (row) {
      credentialPublicKey = await recipient.restorePending(row.encrypted_pending_state);
    } else {
      const ready = await recipient.ready;
      credentialPublicKey = ready.credentialPublicKey;
      const ref = packageReference(ready.keyPackage);
      row = {
        localAgentId:agent.localAgentId,serverAgentId:agent.serverAgentId,targetAgentDid:agent.targetAgentDid,
        ownerDeviceKeyId:agent.ownerDeviceKeyId,ownerScope:agent.ownerScope,keyEpoch:epoch,keyPackageRef:ref,
        keyPackage:ready.keyPackage,encryptedPendingState:await recipient.sealPending(),publishState:'pending',
      };
      this.options.store.saveKeyPackage(row);
      row = this.options.store.keyPackage(agent.localAgentId);
    }
    if (row.publish_state !== 'published') {
      await this.options.client.registerDevice({ ownerDeviceKeyId:agent.ownerDeviceKeyId,keyEpoch:epoch,
        credentialPublicKey });
      const published = await this.options.client.publishKeyPackage({ agentId:agent.serverAgentId,
        ownerDeviceKeyId:agent.ownerDeviceKeyId,keyEpoch:epoch,keyPackage:row.key_package,
        expiresAtMs:(this.options.now || Date.now)() + 23 * 60 * 60 * 1000 });
      if (String(published?.keyPackageRef || '') !== row.key_package_ref) throw new Error('E2EE_KEY_PACKAGE_REF_MISMATCH');
      this.options.store.markKeyPackagePublished(agent.localAgentId,row.key_package_ref);
      row = this.options.store.keyPackage(agent.localAgentId);
    }
    return row;
  }

  private async rotatePending(agent: ProductionE2eeAgent, row: any): Promise<any> {
    const current = this.processes.get(agent.localAgentId);
    current?.recipient.close();
    this.processes.delete(agent.localAgentId);
    const recipient = this.process(agent,Number(row.key_epoch));
    await recipient.ready;
    await recipient.restorePending(row.encrypted_pending_state);
    const replenished = await recipient.replenish();
    const next = {
      localAgentId:agent.localAgentId,serverAgentId:agent.serverAgentId,targetAgentDid:agent.targetAgentDid,
      ownerDeviceKeyId:agent.ownerDeviceKeyId,ownerScope:agent.ownerScope,keyEpoch:Number(row.key_epoch),
      keyPackageRef:packageReference(replenished.keyPackage),keyPackage:replenished.keyPackage,
      encryptedPendingState:await recipient.sealPending(),publishState:'pending',
    };
    return next;
  }

  private async flushAcknowledgements(agent: ProductionE2eeAgent): Promise<void> {
    for (const item of this.options.store.pendingAcknowledgements().filter(row => row.local_agent_id === agent.localAgentId)) {
      await this.options.client.acknowledge({ establishmentId:item.establishment_id,agentId:agent.serverAgentId,
        ownerDeviceKeyId:agent.ownerDeviceKeyId,
        ack:Buffer.from(item.ack_json,'utf8').toString('base64url') });
      this.options.store.markAcknowledged(item.establishment_id);
    }
  }

  private async syncDeviceCommits(agent:ProductionE2eeAgent):Promise<void>{
    if(!this.options.applyCommit)return;
    for(const session of this.options.store.activeSessions(agent.localAgentId)){
      if(session.protocol_mode==='direct_v2')continue;
      const events=await this.options.client.pullDeviceCommits({agentId:agent.serverAgentId,ownerDeviceKeyId:agent.ownerDeviceKeyId,
        groupId:String(session.group_id),afterEpoch:Number(session.mls_epoch||1)});
      let current=session;
      for(const event of events){
        if(event.groupId!==session.group_id||event.epoch!==Number(current.mls_epoch)+1)throw new Error('E2EE_DEVICE_COMMIT_SEQUENCE_INVALID');
        const scope:ProductionE2eeScope={localAgentId:String(current.local_agent_id),serverAgentId:String(current.server_agent_id),
          targetAgentDid:String(current.target_agent_did),creatorPrincipalId:String(current.creator_principal_id),
          creatorDeviceBindingId:String(current.creator_guest_device_uid||''),
          protocolMode:current.protocol_mode==='direct_v2'?'direct_v2':'legacy_group_v1',
          senderDeviceKeyId:String(current.sender_device_key_id||''),recipientDeviceKeyId:String(current.recipient_device_key_id),
          ownerScope:String(current.owner_scope),groupId:String(current.group_id),conversationScope:String(current.conversation_scope),
          bindingGeneration:Number(current.binding_generation)};
        const applied=await this.options.applyCommit({scope,commit:event.commit,encryptedState:new Uint8Array(current.encrypted_state),stateVersion:Number(current.state_version)});
        this.options.store.applyEpoch(scope.groupId,Number(current.mls_epoch),event.epoch,applied.encryptedState,applied.stateVersion);
        await this.options.client.acknowledgeDeviceCommit({agentId:agent.serverAgentId,ownerDeviceKeyId:agent.ownerDeviceKeyId,
          groupId:scope.groupId,epoch:event.epoch});
        current=this.options.store.session(scope.groupId);
      }
    }
  }

  private scopeFromSession(current:any):ProductionE2eeScope{return{localAgentId:String(current.local_agent_id),serverAgentId:String(current.server_agent_id),
    targetAgentDid:String(current.target_agent_did),creatorPrincipalId:String(current.creator_principal_id),senderDeviceKeyId:String(current.sender_device_key_id||''),
    creatorDeviceBindingId:String(current.creator_guest_device_uid||''),protocolMode:current.protocol_mode==='direct_v2'?'direct_v2':'legacy_group_v1',
    recipientDeviceKeyId:String(current.recipient_device_key_id),ownerScope:String(current.owner_scope),groupId:String(current.group_id),
    conversationScope:String(current.conversation_scope),bindingGeneration:Number(current.binding_generation)}}

  private async hostDeviceJoins(agent:ProductionE2eeAgent):Promise<void>{
    if(!this.options.prepareAddMember||!this.options.acceptPendingCommit)return
    for(const session of this.options.store.activeSessions(agent.localAgentId)){
      if(session.protocol_mode==='direct_v2')continue;
      const claim=await this.options.client.claimDeviceJoin({agentId:agent.serverAgentId,ownerDeviceKeyId:agent.ownerDeviceKeyId,groupId:String(session.group_id)});
      if(!claim)continue;const scope=this.scopeFromSession(session);const epoch=Number(session.mls_epoch||1)+1;
      const prepared=await this.options.prepareAddMember({scope,keyPackage:String(claim.keyPackage),encryptedState:new Uint8Array(session.encrypted_state),stateVersion:Number(session.state_version)});
      await this.options.client.completeDeviceJoin({agentId:agent.serverAgentId,ownerDeviceKeyId:agent.ownerDeviceKeyId,groupId:scope.groupId,
        joinId:String(claim.joinId),commit:prepared.commit,welcome:prepared.welcome,epoch});
      const accepted=await this.options.acceptPendingCommit({scope,pendingState:prepared.pendingState,stateVersion:Number(session.state_version)});
      this.options.store.applyEpoch(scope.groupId,Number(session.mls_epoch||1),epoch,accepted.encryptedState,accepted.stateVersion);
      await this.options.client.acknowledgeDeviceCommit({agentId:agent.serverAgentId,ownerDeviceKeyId:agent.ownerDeviceKeyId,groupId:scope.groupId,epoch});
    }
  }

  private async hostDeviceRevocations(agent:ProductionE2eeAgent):Promise<void>{
    if(!this.options.prepareRemoveDevice||!this.options.acceptPendingCommit)return
    for(const session of this.options.store.activeSessions(agent.localAgentId)){
      if(session.protocol_mode==='direct_v2')continue;
      const claim=await this.options.client.claimDeviceRevocation({agentId:agent.serverAgentId,ownerDeviceKeyId:agent.ownerDeviceKeyId,groupId:String(session.group_id)});
      if(!claim)continue;const scope=this.scopeFromSession(session);const epoch=Number(session.mls_epoch||1)+1;
      const prepared=await this.options.prepareRemoveDevice({scope,deviceKeyId:String(claim.deviceKeyId),encryptedState:new Uint8Array(session.encrypted_state),stateVersion:Number(session.state_version)});
      await this.options.client.completeDeviceRevocation({agentId:agent.serverAgentId,ownerDeviceKeyId:agent.ownerDeviceKeyId,groupId:scope.groupId,
        revocationId:String(claim.revocationId),commit:prepared.commit,epoch});
      const accepted=await this.options.acceptPendingCommit({scope,pendingState:prepared.pendingState,stateVersion:Number(session.state_version)});
      this.options.store.applyEpoch(scope.groupId,Number(session.mls_epoch||1),epoch,accepted.encryptedState,accepted.stateVersion);
      await this.options.client.acknowledgeDeviceCommit({agentId:agent.serverAgentId,ownerDeviceKeyId:agent.ownerDeviceKeyId,groupId:scope.groupId,epoch});
    }
  }

  private async accept(agent: ProductionE2eeAgent, row: any, establishment: E2eeDirectoryEstablishment): Promise<void> {
    if (this.options.store.establishment(establishment.establishmentId)) return;
    if (establishment.keyPackageRef !== row.key_package_ref || establishment.keyEpoch !== Number(row.key_epoch)) {
      throw new Error('E2EE_ESTABLISHMENT_KEY_PACKAGE_MISMATCH');
    }
    if (establishment.bindingGeneration !== agent.bindingGeneration) throw new Error('E2EE_BINDING_GENERATION_MISMATCH');
    const protocolMode = establishment.protocolMode === 'direct_v2' ? 'direct_v2' : 'legacy_group_v1';
    if (protocolMode === 'direct_v2' && !establishment.creatorDeviceBindingId) {
      throw new Error('E2EE_DIRECT_DEVICE_BINDING_MISSING');
    }
    const recipient = this.process(agent,Number(row.key_epoch));
    const scope: ProductionE2eeScope = {
      localAgentId:agent.localAgentId,serverAgentId:agent.serverAgentId,targetAgentDid:agent.targetAgentDid,
      creatorPrincipalId:establishment.creatorPrincipalId,senderDeviceKeyId:'',
      creatorDeviceBindingId:establishment.creatorDeviceBindingId || '',protocolMode,
      recipientDeviceKeyId:agent.ownerDeviceKeyId,ownerScope:agent.ownerScope,groupId:establishment.groupId,
      conversationScope:establishment.conversationScope,bindingGeneration:establishment.bindingGeneration,
    };
    const joined = await recipient.join(scope,establishment.welcome,`e2ee-established-${establishment.establishmentId}`);
    // keyEpoch versions the device credential, not individual KeyPackages.
    // Rotating it for every package would invalidate already active groups.
    const next = await this.rotatePending(agent,row);
    this.options.store.commitEstablishment({ establishmentId:establishment.establishmentId,scope,
      encryptedState:joined.encryptedState,acknowledgement:joined.acknowledgement,nextKeyPackage:next });
  }

  async runOnce(): Promise<void> {
    if (this.running) return;
    if ((this.options.now || Date.now)() < this.retryAfter) return;
    this.running = true;
    try {
      const agents = this.options.agents();
      if (agents.length === 0) return;
      const batchSize = Math.max(1,Math.min(agents.length,Number(this.options.maxAgentsPerRun || 5)));
      const batch = Array.from({ length:batchSize },(_,offset) => agents[(this.nextAgentIndex + offset) % agents.length]);
      this.nextAgentIndex = agents.length ? (this.nextAgentIndex + batchSize) % agents.length : 0;
      let sharedFailure = false;
      for (const agent of batch) {
        try {
          let row = await this.ensurePackage(agent);
          await this.flushAcknowledgements(agent);
          await this.syncDeviceCommits(agent);
          await this.hostDeviceJoins(agent);
          await this.hostDeviceRevocations(agent);
          const establishments = await this.options.client.pullEstablishments({ agentId:agent.serverAgentId,
            ownerDeviceKeyId:agent.ownerDeviceKeyId,limit:20 });
          for (const establishment of establishments) {
            try {
              await this.accept(agent,row,establishment);
            } catch (error) {
              const poisoned = this.processes.get(agent.localAgentId);
              poisoned?.recipient.close();
              this.processes.delete(agent.localAgentId);
              await this.options.client.reject({ establishmentId:establishment.establishmentId,
                agentId:agent.serverAgentId,ownerDeviceKeyId:agent.ownerDeviceKeyId,reasonCode:'LOCAL_CRYPTO_ERROR' });
              const next = await this.rotatePending(agent,row);
              this.options.store.saveKeyPackage(next);
              row = this.options.store.keyPackage(agent.localAgentId);
              throw error;
            }
            await this.flushAcknowledgements(agent);
            row = await this.ensurePackage(agent);
          }
          const inventory = await this.options.client.keyPackageStatus({
            ownerDeviceKeyId:agent.ownerDeviceKeyId,agentIds:[agent.serverAgentId],
          });
          const available = Number(inventory?.agents?.find((item: any) => item?.agentId === agent.serverAgentId)?.available || 0);
          if (available < 1) {
            // A KeyPackage is single-use once a remote party has built a
            // handshake from it. If Lite was offline until that establishment
            // expired, the local row still says "published" although the
            // directory can no longer offer it. Publish a fresh package rather
            // than reusing the consumed one.
            const next = await this.rotatePending(agent,row);
            this.options.store.saveKeyPackage(next);
            row = await this.ensurePackage(agent);
          }
        } catch (error: any) {
          if (this.isSharedServiceFailure(error)) {
            sharedFailure = true;
            this.backoffSharedFailure(error,agents.length);
            break;
          }
          this.options.onError?.(agent.localAgentId,error);
        }
      }
      if (!sharedFailure && this.sharedFailureCount > 0) {
        const failures = this.sharedFailureCount;
        this.sharedFailureCount = 0;
        this.retryAfter = 0;
        this.options.onRecovery?.(failures);
      }
    } finally { this.running = false; }
  }

  start(): () => Promise<void> {
    void this.runOnce().catch(error => this.options.onError?.('worker',error));
    this.timer = setInterval(() => { void this.runOnce().catch(error => this.options.onError?.('worker',error)); },this.options.intervalMs || 30_000);
    this.timer.unref?.();
    return async () => {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      for (const process of this.processes.values()) process.recipient.close();
      this.processes.clear();
    };
  }
}

module.exports = { ProductionE2eeDirectoryWorker, packageReference };
