const crypto = require('node:crypto');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { PushProvider } = require('../base-provider');
const { buildConversationDeliveryPrompt } = require('../conversation-context');
const { resolveDeepSeekHarnessRuntime } = require('../deepseek-harness-command');
import type { AgentMeta, ProviderDeliveryReceipt, ProviderSteerMetadata, PushPayload } from '../types';

const ADAPTER_TYPE = 'deepseek-harness-http';
const MAX_REPLY_CHARS = 200_000;

function deliveryError(message: string, outcome: 'not_delivered' | 'outcome_unknown' | 'rejected'): Error {
  return Object.assign(new Error(message), { deliveryOutcome: outcome });
}

function loopbackBaseUrl(value: unknown): string {
  const parsed = new URL(String(value || 'http://127.0.0.1:3080'));
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
    throw new Error('DeepSeek Harness API must use a loopback HTTP address');
  }
  parsed.pathname = '/';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

function assistantText(event: any): string {
  if (event?.type !== 'assistant/message') return '';
  const blocks = event?.data?.message?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks.filter((block: any) => block?.type === 'text')
    .map((block: any) => String(block.text || '')).join('').slice(0, MAX_REPLY_CHARS);
}

/** DeepSeek Harness Web Host transport. It uses the public loopback API and never answers Owner interactions. */
class DeepSeekHarnessHttpProvider extends PushProvider {
  private readonly _db: any;
  private readonly _contextWindow: number;
  private readonly _baseUrl: string;
  private readonly _requestTimeoutMs: number;
  private readonly _turnTimeoutMs: number;
  private readonly _fetch: typeof fetch;
  private readonly _spawn: typeof spawn;
  private readonly _startServer: boolean;
  private _server: any = null;
  private _ready = false;
  private readonly _active = new Map<string, string>();

  constructor(options: Record<string, unknown> = {}) {
    super();
    this._db = options.db;
    this._contextWindow = Number(options.contextWindow || 20);
    this._baseUrl = loopbackBaseUrl(options.apiHost || options.baseUrl);
    this._requestTimeoutMs = Math.max(500, Math.min(Number(options.requestTimeoutMs || 5000), 30_000));
    this._turnTimeoutMs = Math.max(5000, Math.min(Number(options.turnTimeoutMs || 180_000), 600_000));
    this._fetch = (options.fetchImpl as typeof fetch | undefined) || fetch;
    this._spawn = (options.spawnImpl as typeof spawn | undefined) || spawn;
    this._startServer = options.startServer !== false;
  }

  get priority(): number { return 10; }
  get sessionMode(): 'agent-issued-id' { return 'agent-issued-id'; }
  get capabilities(): string[] { return ['http', 'async_reply', 'session_resume', 'cancel']; }

  match(_agentId: string, meta?: AgentMeta | null): boolean {
    return meta?.backend_type === 'deepseek-harness';
  }

  isAvailable(): boolean { return this._ready; }

  _instanceForAgent(agentId: string): string | null {
    try {
      const row = this._db?.prepare('SELECT backend_instance_id FROM agents WHERE agent_id=? AND backend_type=?')
        .get(agentId, 'deepseek-harness');
      return String(row?.backend_instance_id || '').trim() || null;
    } catch { return null; }
  }

  acceptsBinding(binding: PushPayload['providerBinding'], _agentId?: string): boolean {
    return binding?.providerType === 'deepseek-harness'
      && binding.adapterType === ADAPTER_TYPE
      && binding.deliveryMode === 'http'
      && typeof binding.nativeSessionId === 'string'
      && binding.nativeSessionId.length > 0;
  }

  private async _rpc(method: string, payload: Record<string, unknown>, timeoutMs = this._requestTimeoutMs): Promise<any> {
    const rpcId = crypto.randomUUID();
    const response = await this._fetch(`${this._baseUrl}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw Object.assign(new Error(`DeepSeek Harness HTTP ${response.status}`), { httpStatus: response.status });
    const body: any = await response.json();
    if (body?.type !== 'server-response' || body?.rpcId !== rpcId) throw new Error('DeepSeek Harness returned an invalid RPC envelope');
    if (body.result?.ok !== true) {
      const error = new Error(String(body.result?.error?.message || 'DeepSeek Harness rejected the request'));
      throw Object.assign(error, { rpcCode: body.result?.error?.code || 'internal' });
    }
    return { rpcId, value: body.result.value };
  }

  async start(): Promise<void> {
    try {
      await this._rpc('agentPreset.list', {});
      this._ready = true;
      this.notifyAvailability({ backendType: 'deepseek-harness', mode: 'http', available: true });
      return;
    } catch {}
    const runtime = resolveDeepSeekHarnessRuntime();
    if (!this._startServer || !runtime.command) {
      this._ready = false;
      this.notifyAvailability({ backendType: 'deepseek-harness', mode: 'http', available: false, reason: 'api_unavailable' });
      return;
    }
    this._server = this._spawn(runtime.command, [...runtime.argsPrefix, 'web'], {
      cwd: os.tmpdir(), env: process.env, stdio: 'ignore', windowsHide: true,
    });
    this._server.once('exit', () => {
      this._server = null;
      if (this._ready) {
        this._ready = false;
        this.notifyAvailability({ backendType: 'deepseek-harness', mode: 'http', available: false, reason: 'server_exited' });
      }
    });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        await this._rpc('agentPreset.list', {}, 1500);
        this._ready = true;
        this.notifyAvailability({ backendType: 'deepseek-harness', mode: 'http', available: true });
        return;
      } catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    this._server?.kill();
    this._server = null;
    this._ready = false;
    this.notifyAvailability({ backendType: 'deepseek-harness', mode: 'http', available: false, reason: 'startup_timeout' });
  }

  async preflightDelivery(): Promise<Record<string, unknown>> {
    try {
      const listed = await this._rpc('agentPreset.list', {});
      const presets = Array.isArray(listed.value?.presets) ? listed.value.presets : [];
      this._ready = true;
      return { ok: true, status: 'preflight_passed', sideEffects: false, presetCount: presets.length,
        ownerIntervention: false, warning: 'A dedicated VOKO-safe agent preset is required for visitor delivery.' };
    } catch (error: any) {
      this._ready = false;
      return { ok: false, status: 'unavailable', sideEffects: false, code: error?.rpcCode || 'api_unavailable' };
    }
  }

  async canRestoreExactSession(binding: PushPayload['providerBinding'], agentId: string): Promise<boolean> {
    if (!binding?.strictSessionRoute || !this.acceptsBinding(binding, agentId)) return false;
    try {
      const history = await this._rpc('session.history', { sessionId: binding.nativeSessionId, maxMessages: 1 });
      return Array.isArray(history.value?.events);
    } catch { return false; }
  }

  private async _waitForTurn(sessionId: string, rpcId: string): Promise<{ reply: string; reason: string }> {
    const deadline = Date.now() + this._turnTimeoutMs;
    while (Date.now() < deadline) {
      const history = await this._rpc('session.history', { sessionId, maxMessages: 50 });
      const events = Array.isArray(history.value?.events)
        ? history.value.events.map((entry: any) => entry?.event).filter(Boolean) : [];
      const user = events.find((event: any) => event?.type === 'user/message'
        && event?.data?.source?.rpcId === rpcId);
      const started = user && events.filter((event: any) => event?.type === 'turn/start' && event.seq < user.seq).at(-1);
      const turn = started?.data?.turn;
      if (turn !== undefined) {
        const ended = events.find((event: any) => event?.type === 'turn/end' && event?.data?.turn === turn);
        if (ended) {
          const reply = events.filter((event: any) => event?.type === 'assistant/message' && event?.data?.turn === turn)
            .map(assistantText).join('').slice(0, MAX_REPLY_CHARS);
          return { reply, reason: String(ended?.data?.reason?.kind || 'unknown') };
        }
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw deliveryError('DeepSeek Harness accepted the prompt but its terminal turn was not observed', 'outcome_unknown');
  }

  async push(payload: PushPayload): Promise<ProviderDeliveryReceipt> {
    const turnId = String(payload.turnId || payload.messageId || '');
    if (!turnId) throw deliveryError('DeepSeek Harness delivery requires a stable turn id', 'not_delivered');
    if (payload.attachments?.length) throw deliveryError('DeepSeek Harness attachment delivery is not enabled', 'not_delivered');
    const instanceId = this._instanceForAgent(payload.agentId) || '';
    if (!instanceId) throw deliveryError('DeepSeek Harness delivery requires an agent preset instance', 'not_delivered');
    const boundInstance = String(payload.providerBinding?.providerInstanceId || '').trim();
    if (boundInstance && boundInstance !== instanceId) {
      throw deliveryError('DeepSeek Harness agent preset binding is stale', 'not_delivered');
    }

    let sessionId = '';
    const hasBinding = Boolean(payload.providerBinding?.nativeSessionId);
    if (hasBinding) {
      const binding = payload.providerBinding;
      if (!binding || !this.acceptsBinding(binding, payload.agentId)) {
        throw deliveryError('DeepSeek Harness exact-session binding is incompatible', 'not_delivered');
      }
      sessionId = binding.nativeSessionId;
      if (!await this.canRestoreExactSession({ ...binding, strictSessionRoute: true }, payload.agentId)) {
        throw deliveryError('DeepSeek Harness could not restore the exact session', 'not_delivered');
      }
    } else {
      try {
        const created = await this._rpc('session.create', { agentPreset: instanceId });
        sessionId = String(created.value?.sessionId || '');
      } catch (error: any) {
        throw deliveryError(error?.rpcCode === 'agent-preset-not-found' || error?.rpcCode === 'agent-preset-invalid'
          ? 'DeepSeek Harness agent preset is unavailable' : 'DeepSeek Harness did not create a session', 'not_delivered');
      }
      if (!sessionId) throw deliveryError('DeepSeek Harness created no session identity', 'outcome_unknown');
    }

    const prompt = buildConversationDeliveryPrompt(this._db, payload, hasBinding, this._contextWindow);
    let accepted: any;
    try {
      accepted = await this._rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }] });
    } catch (error: any) {
      throw deliveryError(error?.rpcCode === 'agent-busy' ? 'DeepSeek Harness rejected the prompt' :
        'DeepSeek Harness did not confirm prompt admission', error?.rpcCode ? 'rejected' : 'not_delivered');
    }
    this._active.set(turnId, sessionId);
    this.notifyProviderEvent({ type: 'accepted', agentId: payload.agentId, messageId: payload.messageId,
      turnId, nativeSessionId: sessionId, terminal: false });
    try {
      const result = await this._waitForTurn(sessionId, accepted.rpcId);
      if (!['completed', 'max-tokens'].includes(result.reason)) {
        throw deliveryError(`DeepSeek Harness turn ended with ${result.reason}`, 'rejected');
      }
      if (!result.reply) throw deliveryError('DeepSeek Harness completed without a committed text reply', 'outcome_unknown');
      this.emit('agent.reply', { agentId: payload.agentId, visitorId: payload.fromUid, content: result.reply,
        sessionKey: `deepseek-harness:${sessionId}`, turnId, replyId: turnId, done: true });
      this.notifyProviderEvent({ type: 'completed', agentId: payload.agentId, messageId: payload.messageId,
        turnId, nativeSessionId: sessionId, terminal: true });
      return { nativeSessionId: sessionId, providerInstanceId: instanceId, deliveryMode: 'http', adapterType: ADAPTER_TYPE };
    } finally {
      this._active.delete(turnId);
    }
  }

  async steer(agentId: string, visitorId: string, content: string, metadata: ProviderSteerMetadata = {}): Promise<ProviderDeliveryReceipt> {
    const turnId = String(metadata.turnId || `steer-${crypto.randomUUID()}`);
    return this.push({ agentId, fromUid: visitorId, content, rawContent: content, messageId: turnId, turnId,
      channelId: metadata.channelId || visitorId, channelType: metadata.channelType || 1,
      providerBinding: metadata.providerBinding || null });
  }

  async cancelTurn(turnId: string): Promise<{ canceled: boolean; outcome: string }> {
    const sessionId = this._active.get(String(turnId || ''));
    if (!sessionId) return { canceled: false, outcome: 'not_delivered' };
    try {
      await this._rpc('session.cancel', { sessionId });
      return { canceled: true, outcome: 'delivered' };
    } catch { return { canceled: false, outcome: 'outcome_unknown' }; }
  }

  async healthCheck(): Promise<Record<string, unknown>> {
    const result = await this.preflightDelivery();
    return { ok: result.ok === true, status: String(result.status || 'unavailable') };
  }

  async stop(): Promise<void> {
    this._ready = false;
    this._active.clear();
    if (this._server) {
      this._server.kill();
      this._server = null;
    }
  }
}

module.exports = { DeepSeekHarnessHttpProvider, loopbackBaseUrl, assistantText };
