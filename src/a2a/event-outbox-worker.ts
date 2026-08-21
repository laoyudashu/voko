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
        } else this.store.retryOutboxEvent(String(event.event_id), 'LEGACY_EVENT_NOT_PERSISTED');
      } catch (_) { uncertain += 1; }
    }
    const events = this.store.claimEvents(owner);
    for (const event of events) {
      try {
        await this.client.sendEvent(JSON.parse(String(event.envelope_json)));
        this.store.finishOutboxEvent(String(event.event_id), 'acked'); sent += 1;
        if (['completed', 'failed', 'rejected'].includes(String(event.operation))) {
          const route = this.store.getTaskLogRoute(String(event.gateway_task_id));
          const action = event.operation === 'completed' ? '完成任务'
            : event.operation === 'rejected' ? '拒绝任务' : '任务失败';
          console.log(`[${route?.protocolLabel || 'A2A'}] ${route?.agentId || 'Agent'} → ${route?.peerLabel || 'A2A 调用方'}（${action}）`);
        }
      } catch (error) {
        const status = Number((error as any)?.status || 0);
        const code = String((error as any)?.code || '');
        if (code === 'A2A_EVENT_PAYLOAD_CONFLICT' || code === 'A2A_EVENT_SEQUENCE_CONFLICT')
          this.store.finishOutboxEvent(String(event.event_id), 'dead', code);
        else if (status >= 400 && status < 500 && status !== 408 && status !== 429 && code !== 'A2A_EVENT_SEQUENCE_GAP')
          this.store.finishOutboxEvent(String(event.event_id), 'dead', code || `HTTP_${status}`);
        else this.store.retryOutboxEvent(String(event.event_id), code || (status ? `HTTP_${status}` : 'NETWORK_RETRY'));
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
