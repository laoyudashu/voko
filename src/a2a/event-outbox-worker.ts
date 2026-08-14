import type { A2AMailboxClient } from './mailbox-client';
import type { A2ALocalTaskStore } from './task-store';
class A2AEventOutboxWorker {
  constructor(private readonly store: A2ALocalTaskStore, private readonly client: A2AMailboxClient) {}
  async flushOnce(owner = `lite-${process.pid}`): Promise<{ sent: number; uncertain: number }> {
    let sent = 0; let uncertain = 0;
    for (const event of this.store.uncertainEvents()) {
      try {
        const result = await this.client.findEvent(String(event.event_id));
        if (result.found && result.taskId === String(event.gateway_task_id)) {
          this.store.finishOutboxEvent(String(event.event_id), 'acked'); sent += 1;
        } else uncertain += 1;
      } catch (_) { uncertain += 1; }
    }
    const events = this.store.claimEvents(owner);
    for (const event of events) {
      try {
        await this.client.sendEvent(JSON.parse(String(event.envelope_json)));
        this.store.finishOutboxEvent(String(event.event_id), 'acked'); sent += 1;
        if (['completed', 'failed', 'rejected'].includes(String(event.operation))) console.log('[A2A] 回复了 A2A 消息');
      } catch (error) {
        const status = Number((error as any)?.status || 0);
        if (status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429) {
          this.store.finishOutboxEvent(String(event.event_id), 'dead', `HTTP_${status}`);
        } else {
          this.store.finishOutboxEvent(String(event.event_id), 'outcome_unknown', 'DELIVERY_OUTCOME_UNKNOWN'); uncertain += 1;
        }
      }
    }
    return { sent, uncertain };
  }
  async drain(owner = `lite-${process.pid}`, maxBatches = 100): Promise<{ sent: number; uncertain: number }> {
    let sent = 0; let uncertain = 0;
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const result = await this.flushOnce(owner); sent += result.sent; uncertain += result.uncertain;
      if (result.sent === 0) break;
    }
    return { sent, uncertain };
  }
}
export { A2AEventOutboxWorker };
