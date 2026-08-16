import type { DatabaseSync } from 'node:sqlite';
import { transitionOwnerExecution } from './execution';

interface RecoverableMessage {
  message_id: string;
  local_agent_id: string;
  conversation_id: string;
}

class OwnerChatInboxRecovery {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly db: DatabaseSync,
    private readonly processor: { process(messageId: string): Promise<unknown> },
    private readonly intervalMs = 2_000,
    private readonly onUpdate?: (event: { agentId: string; conversationId: string }) => void,
  ) {}

  start(): () => void {
    if (!this.timer) {
      this.timer = setInterval(() => void this.flush(), this.intervalMs);
      this.timer.unref?.();
      void this.flush();
    }
    return () => this.stop();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async flush(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const now = Date.now();
      const expired = this.db.prepare(`SELECT message_id FROM owner_chat_messages
        WHERE execution_state='DISPATCH_RESERVED' AND COALESCE(lease_expires_at,0)<=?`).all(now) as Array<{message_id:string}>;
      for (const row of expired) transitionOwnerExecution(this.db, { messageId: row.message_id,
        from: 'DISPATCH_RESERVED', to: 'OUTCOME_UNKNOWN', at: now, reasonCode: 'OWNER_DISPATCH_LEASE_EXPIRED' });
      const rows = this.db.prepare(`SELECT message_id,local_agent_id,conversation_id
        FROM owner_chat_messages WHERE execution_state='PERSISTED' ORDER BY created_at LIMIT 20`).all() as unknown as RecoverableMessage[];
      let processed = 0;
      for (const row of rows) {
        try {
          const result: any = await this.processor.process(row.message_id);
          if (result?.status && result.status !== 'not_claimed' && result.status !== 'not_found') processed += 1;
        } finally {
          this.onUpdate?.({ agentId: row.local_agent_id, conversationId: row.conversation_id });
        }
      }
      return processed;
    } finally {
      this.running = false;
    }
  }
}

export { OwnerChatInboxRecovery };
