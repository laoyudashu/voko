import crypto from 'node:crypto';
import { OwnerLinkStore } from './store';

interface OwnerEventTransport {
  deliver(agentId: string, channelId: string, content: string, messageType: 'text', channelType: 1,
    mentions: null, localMsgId: string): Promise<any>;
}

type AuthorizeOwnerEvent = (row: Record<string, unknown>) => boolean;

class OwnerEventOutbox {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  constructor(private readonly store: OwnerLinkStore, private readonly transport: OwnerEventTransport,
    private readonly intervalMs = 2_000, private readonly authorize: AuthorizeOwnerEvent = () => true) {}

  start(): () => void {
    if (this.timer) return () => this.stop();
    this.timer = setInterval(() => void this.flush(), Math.max(250, this.intervalMs));
    this.timer.unref?.();
    void this.flush();
    return () => this.stop();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async flush(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    const leaseOwner = `owner-outbox-${crypto.randomUUID()}`;
    let sent = 0;
    try {
      for (const row of this.store.claimOutbox(leaseOwner)) {
        try {
          if (!this.authorize(row)) {
            this.store.markOutboxDead(row.event_id, leaseOwner, 'OWNER_EVENT_AUTHORIZATION_REVOKED');
            continue;
          }
          const result = await this.transport.deliver(row.agent_id, row.observed_im_uid, row.payload_json,
            'text', 1, null, row.event_id);
          if (result?.success) {
            if (this.store.markOutboxSent(row.event_id, leaseOwner)) sent += 1;
          } else {
            this.store.releaseOutbox(row.event_id, leaseOwner, {
              code: result?.code || 'OWNER_EVENT_SEND_FAILED', outcomeUnknown: result?.outcomeUnknown === true,
            });
          }
        } catch (error: any) {
          this.store.releaseOutbox(row.event_id, leaseOwner, {
            code: error?.code || 'OWNER_EVENT_SEND_FAILED', outcomeUnknown: error?.outcomeUnknown === true,
          });
        }
      }
      return sent;
    } finally { this.running = false; }
  }
}

export { OwnerEventOutbox };
export type { AuthorizeOwnerEvent, OwnerEventTransport };
