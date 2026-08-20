import crypto from 'node:crypto';
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
    targetAgentDid: agent.targetAgentDid, creatorPrincipalId: 'pending', senderDeviceKeyId: 'pending',
    recipientDeviceKeyId: agent.ownerDeviceKeyId, ownerScope: agent.ownerScope,
    groupId: `pending-${epoch}`, conversationScope: `pending-${epoch}`,
    bindingGeneration: agent.bindingGeneration,
  };
}

export class ProductionE2eeDirectoryWorker {
  private readonly processes = new Map<string,Recipient>();
  private timer: NodeJS.Timeout|null = null;
  private running = false;
  private retryAfter = 0;

  constructor(private readonly options: {
    client: E2eeDirectoryClient;
    store: ProductionE2eeStore;
    agents: () => ProductionE2eeAgent[];
    processFactory: (scope: ProductionE2eeScope) => Recipient;
    intervalMs?: number;
    now?: () => number;
    onError?: (agentId: string, error: unknown) => void;
  }) {}

  private process(agent: ProductionE2eeAgent, epoch: number): Recipient {
    const existing = this.processes.get(agent.localAgentId);
    if (existing) return existing;
    const created = this.options.processFactory(pendingScope(agent,epoch));
    this.processes.set(agent.localAgentId,created);
    return created;
  }

  private async ensurePackage(agent: ProductionE2eeAgent): Promise<any> {
    let row = this.options.store.keyPackage(agent.localAgentId);
    const epoch = Number(row?.key_epoch || 1);
    const recipient = this.process(agent,epoch);
    if (row) {
      await recipient.restorePending(row.encrypted_pending_state);
    } else {
      const ready = await recipient.ready;
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
      const ready = await recipient.ready;
      await this.options.client.registerDevice({ ownerDeviceKeyId:agent.ownerDeviceKeyId,keyEpoch:epoch,
        credentialPublicKey:ready.credentialPublicKey });
      const published = await this.options.client.publishKeyPackage({ agentId:agent.serverAgentId,
        ownerDeviceKeyId:agent.ownerDeviceKeyId,keyEpoch:epoch,keyPackage:row.key_package,
        expiresAtMs:(this.options.now || Date.now)() + 23 * 60 * 60 * 1000 });
      if (String(published?.keyPackageRef || '') !== row.key_package_ref) throw new Error('E2EE_KEY_PACKAGE_REF_MISMATCH');
      this.options.store.markKeyPackagePublished(agent.localAgentId,row.key_package_ref);
      row = this.options.store.keyPackage(agent.localAgentId);
    }
    return row;
  }

  private async flushAcknowledgements(agent: ProductionE2eeAgent): Promise<void> {
    for (const item of this.options.store.pendingAcknowledgements().filter(row => row.local_agent_id === agent.localAgentId)) {
      await this.options.client.acknowledge({ establishmentId:item.establishment_id,agentId:agent.serverAgentId,
        ownerDeviceKeyId:agent.ownerDeviceKeyId,
        ack:Buffer.from(item.ack_json,'utf8').toString('base64url') });
      this.options.store.markAcknowledged(item.establishment_id);
    }
  }

  private async accept(agent: ProductionE2eeAgent, row: any, establishment: E2eeDirectoryEstablishment): Promise<void> {
    if (this.options.store.establishment(establishment.establishmentId)) return;
    if (establishment.keyPackageRef !== row.key_package_ref || establishment.keyEpoch !== Number(row.key_epoch)) {
      throw new Error('E2EE_ESTABLISHMENT_KEY_PACKAGE_MISMATCH');
    }
    if (establishment.bindingGeneration !== agent.bindingGeneration) throw new Error('E2EE_BINDING_GENERATION_MISMATCH');
    const recipient = this.process(agent,Number(row.key_epoch));
    const scope: ProductionE2eeScope = {
      localAgentId:agent.localAgentId,serverAgentId:agent.serverAgentId,targetAgentDid:agent.targetAgentDid,
      creatorPrincipalId:establishment.creatorPrincipalId,senderDeviceKeyId:'',
      recipientDeviceKeyId:agent.ownerDeviceKeyId,ownerScope:agent.ownerScope,groupId:establishment.groupId,
      conversationScope:establishment.conversationScope,bindingGeneration:establishment.bindingGeneration,
    };
    const joined = await recipient.join(scope,establishment.welcome,`e2ee-established-${establishment.establishmentId}`);
    // keyEpoch versions the device credential, not individual KeyPackages.
    // Rotating it for every package would invalidate already active groups.
    const nextEpoch = Number(row.key_epoch);
    const nextPackage = await recipient.replenish();
    const next = {
      localAgentId:agent.localAgentId,serverAgentId:agent.serverAgentId,targetAgentDid:agent.targetAgentDid,
      ownerDeviceKeyId:agent.ownerDeviceKeyId,ownerScope:agent.ownerScope,keyEpoch:nextEpoch,
      keyPackageRef:packageReference(nextPackage),keyPackage:nextPackage,
      encryptedPendingState:await recipient.sealPending(),publishState:'pending',
    };
    this.options.store.commitEstablishment({ establishmentId:establishment.establishmentId,scope,
      encryptedState:joined.encryptedState,acknowledgement:joined.acknowledgement,nextKeyPackage:next });
  }

  async runOnce(): Promise<void> {
    if (this.running) return;
    if ((this.options.now || Date.now)() < this.retryAfter) return;
    this.running = true;
    try {
      for (const agent of this.options.agents()) {
        try {
          let row = await this.ensurePackage(agent);
          await this.flushAcknowledgements(agent);
          const establishments = await this.options.client.pullEstablishments({ agentId:agent.serverAgentId,
            ownerDeviceKeyId:agent.ownerDeviceKeyId,limit:20 });
          for (const establishment of establishments) {
            await this.accept(agent,row,establishment);
            await this.flushAcknowledgements(agent);
            row = await this.ensurePackage(agent);
          }
        } catch (error: any) {
          this.options.onError?.(agent.localAgentId,error);
          if (Number(error?.status) === 429) {
            this.retryAfter = (this.options.now || Date.now)() + Math.max(Number(error?.retryAfterMs) || 60_000, 1_000);
            break;
          }
        }
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
      for (const process of this.processes.values()) process.close();
      this.processes.clear();
    };
  }
}

module.exports = { ProductionE2eeDirectoryWorker, packageReference };
