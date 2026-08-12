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

interface A2ABridgeRuntimeOptions { database: DatabaseSync; mainDatabase?: any; dispatcher: any; env?: NodeJS.ProcessEnv;
  delay?: (ms: number) => Promise<void>; onError?: (code: string) => void }
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
    const identity = new A2AIdentityStore(this.options.database).getOrCreate();
    const safety = this.options.mainDatabase ? new A2ASafetyGate(this.options.mainDatabase) : undefined;
    const processor = new A2ATaskProcessor(store, new A2AExecutionService(store, this.options.dispatcher, safety), identity);
    const worker = new A2ABridgeWorker({ client, store, verify: (value) => {
      const envelope = validateEnvelope(value); if (!verifyEnvelope(envelope, gatewayPublicKey)) throw new Error('Invalid A2A Gateway signature'); return envelope;
    }, execute: (envelope) => processor.process(envelope) });
    const outbox = new A2AEventOutboxWorker(store, client); const outboundResults = new A2AOutboundResultWorker(store, client);
    const delay = this.options.delay || ((ms) => new Promise(resolve => setTimeout(resolve, ms)));
    this.stopped = false;
    const runLoop = (work: () => Promise<boolean>, idleMs: number) => void (async () => {
      while (!this.stopped) {
        try { if (!await work()) await delay(idleMs); }
        catch (error) { this.options.onError?.(error instanceof Error ? error.message : 'A2A_BRIDGE_ERROR'); if (!this.stopped) await delay(5000); }
      }
    })();
    runLoop(async () => (await worker.pollOnce()).claimed > 0, 2000);
    runLoop(async () => (await outbox.drain()).sent > 0, 500);
    runLoop(async () => (await outboundResults.pollOnce()).claimed > 0, 2000);
    return () => { this.stopped = true; };
  }
}
export { A2ABridgeRuntime };
export type { A2ABridgeRuntimeOptions };
