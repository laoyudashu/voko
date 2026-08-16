import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import type { DatabaseSync } from 'node:sqlite';
import type { PushPayload, ProviderDeliveryReceipt } from '../types';
import { defaultAgentRuntimeResolver, withRuntimePath, type AgentRuntimeResolver, type RuntimeRequest } from '../../runtime/agent-runtime-resolver';
import { readOwnerCodexConfig } from '../../../owner-chat/codex-config';

type JsonObject = Record<string, any>;

interface CodexAppServerOptions {
  db?: DatabaseSync;
  runtimeResolver?: AgentRuntimeResolver;
  spawnProcess?: typeof spawn;
  resolveAgentConfig?: (agentId: string) => { cwd?: string | null; profile?: string | null };
}

interface PendingRequest {
  resolve(value: any): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

interface ActiveTurn {
  agentId: string;
  conversationId: string;
  messageId: string;
  threadId: string;
  turnId: string;
  correlationTurnId: string;
  text: string;
  sequence: number;
}

interface PendingApproval {
  rpcId: string | number;
  method: string;
  params: JsonObject;
  active: ActiveTurn | null;
}

const RUNTIME_REQUEST: RuntimeRequest = {
  providerId: 'codex-app-server', mode: 'cli',
  candidates: [
    { kind: 'node-package-bin', command: 'codex', packageName: '@openai/codex', binName: 'codex' },
    { kind: 'native', command: 'codex' },
  ],
};

/**
 * Owner-only Codex control plane. It speaks Codex app-server JSON-RPC directly;
 * it never runs the visitor prompt adapter and never overrides Codex permissions.
 */
export class CodexAppServerProvider extends EventEmitter {
  readonly priority = 100;
  private readonly db?: DatabaseSync;
  private readonly runtimeResolver: AgentRuntimeResolver;
  private readonly spawnProcess: typeof spawn;
  private readonly resolveAgentConfig: NonNullable<CodexAppServerOptions['resolveAgentConfig']>;
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private initialized = false;
  private processProfile: string | null = null;
  private starting: Promise<void> | null = null;
  private pending = new Map<string | number, PendingRequest>();
  private activeByTurn = new Map<string, ActiveTurn>();
  private activeByConversation = new Map<string, ActiveTurn>();
  private approvals = new Map<string, PendingApproval>();
  private available: boolean | null = null;

  constructor(options: CodexAppServerOptions = {}) {
    super();
    this.db = options.db;
    this.runtimeResolver = options.runtimeResolver || defaultAgentRuntimeResolver;
    this.spawnProcess = options.spawnProcess || spawn;
    this.resolveAgentConfig = options.resolveAgentConfig || ((agentId: string) => this.db
      ? readOwnerCodexConfig(this.db,agentId) : {});
  }

  setAvailabilityProviderId(_providerId: string): void {}
  match(_agentId: string, meta: JsonObject): boolean { return meta?.backend_type === 'codex'; }
  acceptsBinding(binding: any): boolean {
    return binding?.providerType === 'codex' && binding?.sourceScope === 'trusted_owner'
      && ((binding?.adapterType === 'codex-app-server' && binding?.deliveryMode === 'owner_io')
        || (binding?.adapterType === 'codex-cli' && binding?.deliveryMode === 'cli'));
  }
  isAvailable(_agentId: string): boolean {
    if (this.available != null) return this.available;
    return (this.available = this.runtimeResolver.resolve(RUNTIME_REQUEST).available);
  }
  get capabilities(): string[] { return ['owner-io', 'streaming', 'session_resume', 'cancel', 'approval']; }

  start(): void { this.healthCheck(); }
  async stop(): Promise<void> {
    const child = this.child;
    this.child = null; this.initialized = false; this.processProfile = null; this.starting = null;
    if (child && !child.killed) child.kill();
    this.failPending(new Error('Codex app-server stopped'));
  }
  healthCheck(): void {
    const next = this.runtimeResolver.resolve(RUNTIME_REQUEST).available;
    if (next !== this.available) this.emitAvailability(next, next ? 'runtime-detected' : 'runtime-not-found');
    this.available = next;
  }

  async pushOwner(payload: PushPayload, context: any): Promise<ProviderDeliveryReceipt> {
    if (context?.authority !== 'verified_owner_conversation' || context?.executionScope !== 'owner_chat') {
      const error: any = new Error('Invalid Owner execution context'); error.deliveryOutcome = 'rejected'; throw error;
    }
    if (payload.securityContext || payload.content !== payload.rawContent) {
      const error: any = new Error('Owner input must be passed verbatim'); error.deliveryOutcome = 'rejected'; throw error;
    }
    const conversationId = String(payload.channelId || '').trim();
    if (this.activeByConversation.has(conversationId)) {
      const error: any = this.protocolError('Codex conversation already has a running turn', 'not_delivered');
      error.code = 'OWNER_TURN_BUSY'; throw error;
    }
    const configured = this.resolveAgentConfig(payload.agentId) || {};
    if (!configured.cwd) {
      const error: any = new Error('Codex Owner Bridge requires an explicit Agent work directory');
      error.deliveryOutcome = 'rejected'; error.code = 'OWNER_CODEX_WORKDIR_REQUIRED'; throw error;
    }
    await this.ensureStarted(configured.profile || null);
    const boundThread = String(payload.providerBinding?.nativeSessionId || '').trim();
    let threadId = boundThread;
    if (threadId) {
      try { await this.request('thread/resume', { threadId, cwd: configured.cwd }); }
      catch (error) { const failed: any = new Error(`Codex thread resume failed: ${String((error as Error).message)}`);
        failed.deliveryOutcome = 'not_delivered'; failed.code = 'OWNER_SESSION_UNAVAILABLE'; throw failed; }
    } else {
      const result = await this.request('thread/start', {
        cwd: configured.cwd,
        ephemeral: false,
      });
      threadId = String(result?.thread?.id || '').trim();
      if (!threadId) throw this.protocolError('Codex did not return a thread id', 'outcome_unknown');
    }
    const result = await this.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: String(payload.content), text_elements: [] }],
      clientUserMessageId: String(payload.messageId || payload.turnId || ''),
    });
    const turnId = String(result?.turn?.id || '').trim();
    if (!turnId) throw this.protocolError('Codex did not accept the turn', 'outcome_unknown');
    const active: ActiveTurn = { agentId: payload.agentId, conversationId,
      messageId: String(payload.messageId || ''), threadId, turnId,
      correlationTurnId: String(payload.turnId || turnId), text: '', sequence: 0 };
    this.activeByTurn.set(turnId, active); this.activeByConversation.set(conversationId, active);
    this.emitIo(active, 'turn.started', { status: result?.turn?.status || 'inProgress' });
    return { nativeSessionId: threadId, providerInstanceId: configured.profile || null,
      deliveryMode: 'owner_io', adapterType: 'codex-app-server' };
  }

  async canRestoreExactSession(binding: any): Promise<boolean> {
    return !!binding?.nativeSessionId && this.acceptsBinding(binding);
  }

  async cancelOwnerTurn(conversationId: string): Promise<boolean> {
    const active = this.activeByConversation.get(conversationId);
    if (!active) return false;
    await this.request('turn/interrupt', { threadId: active.threadId, turnId: active.turnId });
    return true;
  }

  respondOwnerApproval(approvalId: string, decision: 'accept' | 'decline' | 'cancel'): boolean {
    const pending = this.approvals.get(approvalId);
    if (!pending || !this.child?.stdin.writable) return false;
    this.approvals.delete(approvalId);
    this.write({ id: pending.rpcId, result: { decision } });
    if (pending.active) this.emitIo(pending.active, 'approval.resolved', { approvalId, decision });
    return true;
  }

  private async ensureStarted(profile: string|null = null): Promise<void> {
    if (this.child && this.initialized) {
      if (this.processProfile !== profile) throw this.protocolError('Codex profile differs from the active Owner Bridge process', 'not_delivered');
      return;
    }
    if (this.starting) return this.starting;
    this.starting = this.startProcess(profile);
    try { await this.starting; } finally { this.starting = null; }
  }

  private async startProcess(profile: string|null): Promise<void> {
    const runtime = this.runtimeResolver.resolve(RUNTIME_REQUEST);
    if (!runtime.available || !runtime.executable) throw this.protocolError('Codex runtime unavailable', 'not_delivered');
    const args = [...runtime.argvPrefix, ...(profile ? ['-p',profile] : []), 'app-server', '--stdio'];
    const child = this.spawnProcess(runtime.executable, args, {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: withRuntimePath({ ...process.env }, runtime),
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    readline.createInterface({ input: child.stdout }).on('line', line => this.onLine(line));
    readline.createInterface({ input: child.stderr }).on('line', line => {
      if (line.trim()) this.emit('diagnostic', { providerId: 'codex-app-server', message: line.slice(0, 1000) });
    });
    child.once('error', error => this.onExit(error));
    child.once('exit', (code, signal) => this.onExit(new Error(`Codex app-server exited code=${code} signal=${signal}`)));
    await this.request('initialize', { clientInfo: { name: 'voko-owner-bridge', title: 'VOKO Owner Bridge', version: '1' },
      capabilities: { experimentalApi: true } });
    this.write({ method: 'initialized', params: {} });
    this.initialized = true; this.available = true; this.processProfile = profile;
  }

  private request(method: string, params: JsonObject, timeoutMs = 15_000): Promise<any> {
    if (!this.child?.stdin.writable && method !== 'initialize') return Promise.reject(this.protocolError('Codex app-server is not running', 'not_delivered'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout=setTimeout(()=>{this.pending.delete(id);const error:any=this.protocolError(`Codex JSON-RPC timeout: ${method}`,'outcome_unknown');
        error.code='OWNER_CODEX_RPC_TIMEOUT';reject(error);},timeoutMs);timeout.unref?.();
      this.pending.set(id, { resolve, reject, timeout });
      try { this.write({ id, method, params }); } catch (error) { clearTimeout(timeout);this.pending.delete(id); reject(error as Error); }
    });
  }

  private write(message: JsonObject): void {
    if (!this.child?.stdin.writable) throw new Error('Codex app-server stdin unavailable');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onLine(line: string): void {
    let message: JsonObject;
    try { message = JSON.parse(line); } catch (_) { return; }
    if (message.id != null && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(new Error(String(message.error?.message || 'Codex JSON-RPC error')));
      else pending.resolve(message.result);
      return;
    }
    if (message.id != null && message.method) { this.onServerRequest(message); return; }
    if (message.method) this.onNotification(String(message.method), message.params || {});
  }

  private onServerRequest(message: JsonObject): void {
    const method = String(message.method || '');
    const params = message.params || {};
    if (!/requestApproval$/.test(method)) {
      this.write({ id: message.id, error: { code: -32601, message: 'Unsupported Owner Bridge request' } }); return;
    }
    const active = this.activeByTurn.get(String(params.turnId || '')) || null;
    const approvalId = String(params.approvalId || params.itemId || `approval-${message.id}`);
    this.approvals.set(approvalId, { rpcId: message.id, method, params, active });
    if (active) this.emitIo(active, 'approval.required', { approvalId, kind: method,
      command: params.command || null, cwd: params.cwd || null, reason: params.reason || null,
      availableDecisions: params.availableDecisions || ['accept', 'decline', 'cancel'] });
  }

  private onNotification(method: string, params: JsonObject): void {
    const active = this.activeByTurn.get(String(params.turnId || params.turn?.id || ''));
    if (!active) return;
    if (method === 'item/agentMessage/delta') {
      active.text += String(params.delta || '');
      this.emitIo(active, 'message.delta', { delta: String(params.delta || '') });
    } else if (method === 'item/reasoning/summaryTextDelta') {
      this.emitIo(active, 'reasoning.summary.delta', { delta: String(params.delta || '') });
    } else if (method === 'item/commandExecution/outputDelta') {
      this.emitIo(active, 'tool.output.delta', { itemId: params.itemId, delta: String(params.delta || '') });
    } else if (method === 'item/fileChange/patchUpdated' || method === 'item/fileChange/outputDelta') {
      this.emitIo(active, 'file.changed', { itemId: params.itemId, delta: params.delta || params.patch || '' });
    } else if (method === 'item/started') {
      this.emitIo(active, 'tool.started', { item: params.item });
    } else if (method === 'turn/completed') {
      const status = String(params.turn?.status || 'failed');
      this.emitIo(active, status === 'completed' ? 'turn.completed' : 'turn.failed', { status, error: params.turn?.error || null });
      this.activeByTurn.delete(active.turnId); this.activeByConversation.delete(active.conversationId);
      this.emit('agent.reply', { agentId: active.agentId, visitorId: `owner-chat:${active.conversationId}`,
        content: active.text, done: true, sessionKey: `codex:${active.threadId}`, turnId: active.correlationTurnId, replyId: active.turnId,
        ...(status === 'completed' ? {} : { error: params.turn?.error?.message || status,
          errorCode: ['interrupted','canceled','cancelled'].includes(status) ? 'OWNER_TURN_CANCELED' : 'OWNER_CODEX_TURN_FAILED' }) });
    }
  }

  private emitIo(active: ActiveTurn, type: string, payload: JsonObject): void {
    this.emit('owner.io-event', { eventId: `codex:${active.turnId}:${++active.sequence}`, sequence: active.sequence,
      type, providerId: 'codex-app-server', agentId: active.agentId, conversationId: active.conversationId,
      messageId: active.messageId, nativeSessionId: active.threadId, turnId: active.turnId,
      occurredAt: Date.now(), payload });
  }

  private onExit(error: Error): void {
    if (!this.child) return;
    this.child = null; this.initialized = false; this.processProfile = null; this.available = false;
    this.runtimeResolver.invalidate(RUNTIME_REQUEST); this.failPending(error);
    for (const active of this.activeByTurn.values()) {
      this.emitIo(active, 'turn.failed', { outcome: 'outcome_unknown', error: error.message });
    }
    this.activeByTurn.clear(); this.activeByConversation.clear(); this.approvals.clear();
    this.emitAvailability(false, 'app-server-exited');
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timeout);pending.reject(error); }
    this.pending.clear();
  }
  private emitAvailability(available: boolean, reason: string): void {
    this.emit('availability', { providerId: 'codex-app-server', backendType: 'codex', mode: 'owner_io',
      operations: ['owner_push'], available, reason });
  }
  private protocolError(message: string, outcome: 'not_delivered' | 'outcome_unknown' | 'rejected'): Error {
    const error: any = new Error(message); error.deliveryOutcome = outcome; return error;
  }
}

module.exports = { CodexAppServerProvider, RUNTIME_REQUEST };
