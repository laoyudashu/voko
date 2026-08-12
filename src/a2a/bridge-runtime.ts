import { A2ABridgeWorker } from './bridge-worker';
import { validateEnvelope, verifyEnvelope } from './envelope';
import { A2AEventOutboxWorker } from './event-outbox-worker';
import { A2AExecutionService } from './execution-service';
import { A2AIdentityStore } from './identity-store';
import { A2AMailboxClient } from './mailbox-client';
import { A2ALocalTaskStore } from './task-store';
import { A2ATaskProcessor } from './task-processor';
import type { DatabaseSync } from 'node:sqlite';

interface A2ABridgeRuntimeOptions { database: DatabaseSync; dispatcher: any; env?: NodeJS.ProcessEnv; delay?: (ms: number) => Promise<void> }
class A2ABridgeRuntime {
  private stopped = false;
  constructor(private readonly options: A2ABridgeRuntimeOptions) {}
  async start(): Promise<() => void> {
    const env = this.options.env || process.env;
    const baseUrl = String(env.VOKO_A2A_MAILBOX_URL || ''); const token = String(env.VOKO_A2A_DEVICE_TOKEN || '');
    const gatewayPublicKey = Buffer.from(String(env.VOKO_A2A_GATEWAY_PUBLIC_KEY_B64 || ''), 'base64').toString('utf8');
    if (!baseUrl || !token || !gatewayPublicKey) throw new Error('A2A Bridge configuration is incomplete');
    const client = new A2AMailboxClient({ baseUrl, token }); const store = new A2ALocalTaskStore(this.options.database);
    const identity = new A2AIdentityStore(this.options.database).getOrCreate();
    const processor = new A2ATaskProcessor(store, new A2AExecutionService(store, this.options.dispatcher), identity);
    const worker = new A2ABridgeWorker({ client, store, verify: (value) => {
      const envelope = validateEnvelope(value); if (!verifyEnvelope(envelope, gatewayPublicKey)) throw new Error('Invalid A2A Gateway signature'); return envelope;
    }, execute: (envelope) => processor.process(envelope) });
    const outbox = new A2AEventOutboxWorker(store, client); const delay = this.options.delay || ((ms) => new Promise(resolve => setTimeout(resolve, ms)));
    this.stopped = false;
    void (async () => {
      while (!this.stopped) {
        try { await outbox.flushOnce(); const result = await worker.pollOnce(); if (result.claimed === 0) await delay(2000); }
        catch (_) { if (!this.stopped) await delay(5000); }
      }
    })();
    return () => { this.stopped = true; };
  }
}
export { A2ABridgeRuntime };
export type { A2ABridgeRuntimeOptions };
