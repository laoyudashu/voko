import { A2ABridgeWorker } from './bridge-worker';
import { validateEnvelope, verifyEnvelope } from './envelope';
import { A2AEventOutboxWorker } from './event-outbox-worker';
import { A2AExecutionService } from './execution-service';
import { A2AIdentityStore } from './identity-store';
import { A2AMailboxClient } from './mailbox-client';
import { A2ALocalTaskStore } from './task-store';
import { A2ATaskProcessor } from './task-processor';
import type { DatabaseSync } from 'node:sqlite';
import { A2ASafetyGate } from './safety-gate';
import { A2AOutboundResultWorker } from './outbound-result-worker';
import { A2AScopeResolver } from './scope';
import { A2AAttachmentWorkspace } from './attachment-workspace';

interface A2ABridgeRuntimeOptions { database: DatabaseSync; mainDatabase?: any; dispatcher: any; env?: NodeJS.ProcessEnv;
  delay?: (ms: number) => Promise<void>; onError?: (code: string) => void; onRecovery?: (code: string) => void }
class A2ABridgeRuntime {
  private stopped = false;
  constructor(private readonly options: A2ABridgeRuntimeOptions) {}
  async start(): Promise<() => void> {
    const env = this.options.env || process.env;
    const storedRow = this.options.database.prepare("SELECT value FROM a2a_settings WHERE key='bridge_config_v1'").get() as { value: string } | undefined;
    const stored = storedRow ? JSON.parse(storedRow.value) : {};
    const baseUrl = String(env.VOKO_A2A_MAILBOX_URL || stored.mailboxUrl || ''); const token = String(env.VOKO_A2A_DEVICE_TOKEN || stored.token || '');
    const gatewayPublicKey = Buffer.from(String(env.VOKO_A2A_GATEWAY_PUBLIC_KEY_B64 || stored.gatewayPublicKeyB64 || ''), 'base64').toString('utf8');
    if (!baseUrl || !token || !gatewayPublicKey) throw new Error('A2A Bridge configuration is incomplete');
    const client = new A2AMailboxClient({ baseUrl, token }); const store = new A2ALocalTaskStore(this.options.database);
    const scopes = new A2AScopeResolver(this.options.database);
    const identity = new A2AIdentityStore(this.options.database).getOrCreate();
    const safety = this.options.mainDatabase ? new A2ASafetyGate(this.options.mainDatabase) : undefined;
    const assertDispatchAllowed = this.options.mainDatabase ? (agentId: string) => {
      const row = this.options.mainDatabase.prepare("SELECT publish_status FROM agents WHERE agent_id=? LIMIT 1").get(agentId) as { publish_status?: string } | undefined;
      if (!row || row.publish_status !== 'published') throw new Error('A2A_AGENT_NOT_AVAILABLE');
    } : undefined;
    const executionConcurrency = Math.max(1, Math.min(32, Number(env.VOKO_A2A_EXECUTION_CONCURRENCY || 4) || 4));
    const executionTimeoutMs = Math.max(1_000, Math.min(900_000, Number(env.VOKO_A2A_EXECUTION_TIMEOUT_MS || 120_000) || 120_000));
    const processor = new A2ATaskProcessor(store, new A2AExecutionService(store, this.options.dispatcher, safety,
      assertDispatchAllowed, scopes, client, new A2AAttachmentWorkspace(), executionTimeoutMs), identity);
    const bindingGenerations = new Map<string, number>((Array.isArray(stored.agentBindings) ? stored.agentBindings : [])
      .map((item: any) => [String(item.localAgentId), Number(item.bindingGeneration || 1)]));
    const availability = () => {
      if (!this.options.mainDatabase) return [];
      const rows = this.options.mainDatabase.prepare("SELECT agent_id FROM agents WHERE publish_status='published'").all() as Array<{ agent_id: string }>;
      return rows.filter(row => bindingGenerations.has(row.agent_id)).map(row => {
        const key = `availability_sequence:${row.agent_id}`;
        const existing = this.options.database.prepare('SELECT value FROM a2a_meta WHERE key=?').get(key) as { value?: string } | undefined;
        const sequence = Number(existing?.value || 0) + 1;
        this.options.database.prepare(`INSERT INTO a2a_meta(key,value,updated_at) VALUES(?,?,?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(key, String(sequence), Date.now());
        const status = this.options.dispatcher.getAgentDeliveryStatus?.(row.agent_id);
        const state = status?.automaticDeliveryReady ? (status.activeAutomaticMode ? 'available' : 'degraded')
          : status?.pullReady ? 'queueing' : 'unavailable';
        return { localAgentId: row.agent_id, bindingGeneration: bindingGenerations.get(row.agent_id), snapshotSequence: sequence, state };
      });
    };
    const worker = new A2ABridgeWorker({ client, store, scopes, availability, verify: (value) => {
      const envelope = validateEnvelope(value); if (!verifyEnvelope(envelope, gatewayPublicKey)) throw new Error('Invalid A2A Gateway signature'); return envelope;
    }, execute: (envelope) => processor.process(envelope), concurrency: executionConcurrency });
    const outbox = new A2AEventOutboxWorker(store, client); const outboundResults = new A2AOutboundResultWorker(store, client);
    for (const command of store.listProcessingCommands()) {
      try {
        if (!command.envelope_json) throw new Error('A2A interrupted command has no envelope');
        const envelope = JSON.parse(command.envelope_json) as any;
        if (!store.hasTerminalEvent(command.gateway_task_id)) {
          processor.recoverInterrupted(envelope);
        }
        // The recovery event is durable in the outbox. A redelivered command must
        // be ACKed without invoking the Provider a second time.
        store.finishCommand(command.event_id, 'processed');
      } catch (error) {
        this.options.onError?.(error instanceof Error ? error.message : 'A2A_RECOVERY_ERROR');
      }
    }
    const delay = this.options.delay || ((ms) => new Promise(resolve => setTimeout(resolve, ms)));
    this.stopped = false;
    const errorSummaryMs = 5 * 60 * 1000;
    const runLoop = (component: string, work: () => Promise<boolean>, idleMs: number) => void (async () => {
      let lastError = ''; let totalFailures = 0; let suppressedFailures = 0; let lastReportAt = 0;
      while (!this.stopped) {
        try {
          const didWork = await work();
          if (totalFailures > 0) {
            this.options.onRecovery?.(`${component}: 服务已恢复，此前连续失败 ${totalFailures} 次`);
            lastError = ''; totalFailures = 0; suppressedFailures = 0; lastReportAt = 0;
          }
          if (!didWork) await delay(idleMs);
        }
        catch (error) {
          const message = error instanceof Error ? error.message : 'A2A_BRIDGE_ERROR';
          const now = Date.now(); totalFailures += 1;
          if (message !== lastError) {
            lastError = message; suppressedFailures = 0; lastReportAt = now;
            this.options.onError?.(`${component}: ${message}`);
          } else {
            suppressedFailures += 1;
            if (now - lastReportAt >= errorSummaryMs) {
              this.options.onError?.(`${component}: 相同错误在过去周期内重复 ${suppressedFailures} 次 (${message})`);
              suppressedFailures = 0; lastReportAt = now;
            }
          }
          if (!this.stopped) await delay(5000); }
      }
    })();
    runLoop('claim', async () => (await worker.pollOnce()).claimed > 0, 2000);
    runLoop('event-outbox', async () => (await outbox.drain()).sent > 0, 500);
    runLoop('outbound-results', async () => (await outboundResults.pollOnce()).claimed > 0, 2000);
    return () => { this.stopped = true; };
  }
}
export { A2ABridgeRuntime };
export type { A2ABridgeRuntimeOptions };
