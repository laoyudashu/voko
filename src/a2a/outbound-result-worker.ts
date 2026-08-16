import type { A2AMailboxClient } from './mailbox-client'; import type { A2ALocalTaskStore } from './task-store';
class A2AOutboundResultWorker { constructor(private readonly store: A2ALocalTaskStore, private readonly client: A2AMailboxClient) {}
  async pollOnce(): Promise<{ claimed: number; updated: number }> { const claim = await this.client.claimOutboundResults(); let updated = 0;
    for (const item of claim.items) { if (this.store.saveOutboundResult(item)) updated += 1; await this.client.acknowledgeOutboundResult(claim.leaseId, item.eventId); }
    return { claimed: claim.items.length, updated }; }
}
export { A2AOutboundResultWorker };
