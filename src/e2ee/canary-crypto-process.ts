import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import type { CanaryEnvelope, CanaryScope } from './canary-policy';

type EndpointResponse = Record<string, any> & { success: boolean; error?: string };

class EndpointClient {
  private readonly pending: Array<{ resolve(value: EndpointResponse): void; reject(error: Error): void }> = [];
  private readonly child: ChildProcessWithoutNullStreams;
  readonly ready: Promise<EndpointResponse>;

  constructor(executable: string, scope: CanaryScope) {
    this.child = spawn(executable, [
      '--role=recipient',
      `--principal=${scope.conversationScope}`,
      `--device=${scope.recipientDeviceKeyId}`,
      `--agent=${scope.targetAgentDid}`,
      `--group=${scope.groupId}`,
      `--conversation=${scope.conversationScope}`,
      `--owner-scope=${scope.ownerScope}`,
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', (line) => {
      const waiter = this.pending.shift();
      if (!waiter) return;
      try { waiter.resolve(JSON.parse(line)); } catch { waiter.reject(new Error('E2EE_ENDPOINT_INVALID_RESPONSE')); }
    });
    this.child.once('error', error => this.rejectAll(error));
    this.child.once('exit', code => this.rejectAll(new Error(`E2EE_ENDPOINT_EXITED_${code}`)));
    this.ready = this.readResponse();
  }

  private readResponse(): Promise<EndpointResponse> {
    return new Promise<EndpointResponse>((resolve, reject) => this.pending.push({ resolve, reject })).then(result => {
      if (!result.success) throw new Error(result.error || 'E2EE_ENDPOINT_FAILED');
      return result;
    });
  }

  async request(command: Record<string, unknown>): Promise<EndpointResponse> {
    const response = this.readResponse();
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
    return response;
  }

  close(): void { this.child.stdin.end(); }
  private rejectAll(error: Error): void { while (this.pending.length) this.pending.shift()!.reject(error); }
}

export class PendingRecipientProcess {
  private readonly endpoint: EndpointClient;
  readonly ready: Promise<{ keyPackage: string; credentialPublicKey: string }>;

  constructor(executable: string, scope: CanaryScope) {
    if (!existsSync(executable)) throw new Error('E2EE_ENDPOINT_NOT_FOUND');
    this.endpoint = new EndpointClient(executable, scope);
    this.ready = this.endpoint.ready.then(response => {
      const keyPackage = String(response.keyPackage || '');
      const credentialPublicKey = String(response.credentialPublicKey || '');
      if (!/^[A-Za-z0-9_-]+$/.test(keyPackage) || !/^[A-Za-z0-9_-]+$/.test(credentialPublicKey)) {
        throw new Error('E2EE_ENDPOINT_INVALID_KEY_PACKAGE');
      }
      return { keyPackage, credentialPublicKey };
    });
  }

  async join(scope: CanaryScope, welcome: string, acknowledgementId: string): Promise<{
    encryptedState: Uint8Array; acknowledgement: CanaryEnvelope;
  }> {
    await this.ready;
    await this.endpoint.request({ op: 'bind_route', group_id: scope.groupId, conversation: scope.conversationScope });
    await this.endpoint.request({ op: 'join', welcome });
    const ack = await this.endpoint.request({ op: 'encrypt', message_id: acknowledgementId, text: 'GROUP_ESTABLISHED' });
    const sealed = await this.endpoint.request({ op: 'seal_snapshot' });
    return { encryptedState: Buffer.from(String(sealed.sealedSnapshot), 'base64url'), acknowledgement: ack.envelope as CanaryEnvelope };
  }

  close(): void { this.endpoint.close(); }
}

export class CanaryCryptoProcess {
  constructor(private readonly executable: string) {
    if (!existsSync(executable)) throw new Error('E2EE_CANARY_ENDPOINT_NOT_FOUND');
  }

  private async withEndpoint<T>(scope: CanaryScope, operation: (endpoint: EndpointClient) => Promise<T>): Promise<T> {
    const endpoint = new EndpointClient(this.executable, scope);
    try { await endpoint.ready; return await operation(endpoint); }
    finally { endpoint.close(); }
  }

  async provision(scope: CanaryScope, welcome: string): Promise<Uint8Array> {
    return this.withEndpoint(scope, async endpoint => {
      await endpoint.request({ op: 'join', welcome });
      const sealed = await endpoint.request({ op: 'seal_snapshot' });
      return Buffer.from(String(sealed.sealedSnapshot), 'base64url');
    });
  }

  async decrypt(input: { scope: CanaryScope; envelope: CanaryEnvelope; encryptedState?: Uint8Array|null; stateVersion: number }) {
    if (!input.encryptedState?.length) throw new Error('E2EE_CANARY_SESSION_NOT_PROVISIONED');
    return this.withEndpoint(input.scope, async endpoint => {
      await endpoint.request({ op: 'restore_sealed', sealed_snapshot: Buffer.from(input.encryptedState!).toString('base64url') });
      const opened = await endpoint.request({ op: 'decrypt', envelope: input.envelope });
      const sealed = await endpoint.request({ op: 'seal_snapshot' });
      return { plaintext: String(opened.text), encryptedState: Buffer.from(String(sealed.sealedSnapshot), 'base64url'),
        stateVersion: input.stateVersion + 1 };
    });
  }

  async encrypt(input: { scope: CanaryScope; messageId: string; plaintext: string; encryptedState: Uint8Array; stateVersion: number }) {
    return this.withEndpoint(input.scope, async endpoint => {
      await endpoint.request({ op: 'restore_sealed', sealed_snapshot: Buffer.from(input.encryptedState).toString('base64url') });
      const encrypted = await endpoint.request({ op: 'encrypt', message_id: input.messageId, text: input.plaintext });
      const sealed = await endpoint.request({ op: 'seal_snapshot' });
      return { envelope: encrypted.envelope as CanaryEnvelope,
        encryptedState: Buffer.from(String(sealed.sealedSnapshot), 'base64url'), stateVersion: input.stateVersion + 1 };
    });
  }

  async revoke(scope: CanaryScope): Promise<void> {
    await this.withEndpoint(scope, async endpoint => { await endpoint.request({ op: 'revoke_vault' }); });
  }
}

module.exports = { CanaryCryptoProcess, PendingRecipientProcess };
