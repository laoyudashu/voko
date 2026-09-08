const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { DeepSeekHarnessRemote } = require('../deepseek-harness-remote');
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
  private readonly _remote: any;
  private readonly _cwd: string;
  private readonly _authUrl: string;
  private readonly _tails = new Map<string, Promise<unknown>>();
  private readonly _spawn: typeof spawn;
  private readonly _startServer: boolean;
  private _server: any = null;
  private _ready = false;
  private _stopped = false;
  private _lifecycleGeneration = 0;
  private readonly _blocked = new Set<string>();
  private readonly _active = new Map<string, string>();

  constructor(options: Record<string, unknown> = {}) {
    super();
    this._db = options.db;
    this._contextWindow = Number(options.contextWindow || 20);
    this._baseUrl = loopbackBaseUrl(options.apiHost || options.baseUrl);
    this._requestTimeoutMs = Math.max(500, Math.min(Number(options.requestTimeoutMs || 5000), 30_000));
    this._turnTimeoutMs = Math.max(5000, Math.min(Number(options.turnTimeoutMs || 180_000), 600_000));
    this._remote = options.remote || new DeepSeekHarnessRemote(this._baseUrl, options.fetchImpl || fetch, this._requestTimeoutMs);
    this._cwd = path.resolve(String(options.cwd || os.tmpdir()));
    this._authUrl = String(options.authUrl || process.env.DSH_AUTH_URL || '');
    this._spawn = (options.spawnImpl as typeof spawn | undefined) || spawn;
    this._startServer = options.startServer !== false;
  }

  get priority(): number { return 10; }
  getTurnTimeoutMs(): number { return this._turnTimeoutMs; }
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
    return { value: await this._remote.call(method, payload) };
  }

  async start(): Promise<void> {
    this._stopped = false;
    const generation = this._lifecycleGeneration;
    if (this._authUrl) await this._remote.authenticate(this._authUrl);
    try {
      await this._rpc('agentPresets/list', {});
      if (generation !== this._lifecycleGeneration) return;
      this._ready = true;
      this.notifyAvailability({ backendType: 'deepseek-harness', mode: 'http', available: true });
      return;
    } catch (error: any) {
      if (error?.httpStatus === 401 || error?.httpStatus === 403) {
        this._ready = false;
        return; // An existing Host needs authentication, not a second server.
      }
    }
    if (generation !== this._lifecycleGeneration) return;
    const runtime = resolveDeepSeekHarnessRuntime();
    if (!this._startServer || !runtime.command) {
      this._ready = false;
      this.notifyAvailability({ backendType: 'deepseek-harness', mode: 'http', available: false, reason: 'api_unavailable' });
      return;
    }
    this._server = this._spawn(runtime.command, [...runtime.argsPrefix, '--profile', 'web', '--port', new URL(this._baseUrl).port || '80', '--no-open'], {
      cwd: this._cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    // Only capture the launch URL of the process we own. Never log this buffer.
    let launchBuffer = '';
    let authenticating: Promise<void> | undefined;
    const capture = (chunk: Buffer) => {
      launchBuffer = (launchBuffer + chunk.toString()).slice(-8192);
      const match = launchBuffer.match(/http:\/\/(?:localhost|127\.0\.0\.1):[0-9]+\/\?token=[A-Za-z0-9_-]+/);
      if (match && !authenticating) {
        const url = new URL(match[0]);
        url.host = new URL(this._baseUrl).host;
        authenticating = this._remote.authenticate(url.toString()).catch(() => {});
        launchBuffer = '';
      }
    };
    this._server.stdout?.on('data', capture);
    this._server.stderr?.on('data', capture);
    this._server.once('exit', () => {
      if (generation !== this._lifecycleGeneration) return;
      this._server = null;
      if (this._ready) {
        this._ready = false;
        this.notifyAvailability({ backendType: 'deepseek-harness', mode: 'http', available: false, reason: 'server_exited' });
      }
    });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && generation === this._lifecycleGeneration) {
      try {
        await this._rpc('agentPresets/list', {}, 1500);
        if (generation !== this._lifecycleGeneration) return;
        this._ready = true;
        this.notifyAvailability({ backendType: 'deepseek-harness', mode: 'http', available: true });
        return;
      } catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    if (generation !== this._lifecycleGeneration) return;
    this._server?.kill();
    this._server = null;
    this._ready = false;
    this.notifyAvailability({ backendType: 'deepseek-harness', mode: 'http', available: false, reason: 'startup_timeout' });
  }

  async preflightDelivery(): Promise<Record<string, unknown>> {
    try {
      const listed = await this._rpc('agentPresets/list', {});
      const presets = Array.isArray(listed.value?.presets) ? listed.value.presets : [];
      this._ready = true;
      return { ok: true, status: 'preflight_passed', sideEffects: false, presetCount: presets.length,
        ownerIntervention: false, warning: 'A dedicated VOKO-safe agent preset is required for visitor delivery.' };
    } catch (error: any) {
      this._ready = false;
      return { ok: false, status: 'unavailable', sideEffects: false, code: error?.rpcCode || 'api_unavailable' };
    }
  }

  private targetPreset(payload: PushPayload): string {
    let config = payload.providerSecurityPolicy?.config;
    if (!config && this._db) {
      const row = this._db.prepare("SELECT config_json FROM provider_security_policies WHERE agent_id=? AND transport_id=?")
        .get(payload.agentId, ADAPTER_TYPE);
      config = row?.config_json ? JSON.parse(row.config_json) : {};
    }
    const value = String(config?.permissionPreset || '').trim();
    if (value && (!/^[A-Za-z0-9_-]{1,80}$/.test(value) || value === 'custom')) {
      throw deliveryError('DSH permission preset is invalid', 'not_delivered');
    }
    return value;
  }

  private sessionPrefix(agentId: string, instance: string, preset: string): string {
    const digest = crypto.createHash('sha256').update(JSON.stringify([agentId, instance, preset, this._cwd])).digest('hex').slice(0, 24);
    return `voko-${digest}-`;
  }

  async canRestoreExactSession(binding: PushPayload['providerBinding'], agentId: string): Promise<boolean> {
    if (!binding?.strictSessionRoute || !this.acceptsBinding(binding, agentId)) return false;
    try {
      const snapshot = await this._remote.snapshot(binding.nativeSessionId);
      return snapshot.header?.agentPreset === this._instanceForAgent(agentId);
    } catch { return false; }
  }

  private checkSnapshot(snapshot: any, instance: string, preset: string): void {
    if (snapshot.header?.agentPreset !== instance || (preset && path.resolve(snapshot.header?.cwd || '') !== this._cwd)) {
      throw deliveryError('DSH session preset or workspace does not match its binding', 'not_delivered');
    }
    if (preset && snapshot.projections?.values?.permissions?.currentValue !== preset) {
      throw deliveryError('DSH session permission preset is missing or has drifted', 'not_delivered');
    }
  }

  private async _waitForTurn(sessionId: string, requestId: string, instance: string, preset: string): Promise<{ reply: string; reason: string }> {
    const deadline = Date.now() + this._turnTimeoutMs;
    while (Date.now() < deadline) {
      const snapshot = await this._remote.snapshot(sessionId);
      this.checkSnapshot(snapshot, instance, preset);
      let records = [...snapshot.records];
      let hasMore = snapshot.hasMore;
      while (hasMore && !records.some((r: any) => r.event?.type === 'user/message' && r.event.data?.source?.rpcId === requestId)) {
        const beforeSeq = records[0]?.event?.seq;
        if (!Number.isInteger(beforeSeq) || Date.now() >= deadline) throw new Error('DSH history pagination did not converge');
        const page = (await this._rpc('session/page', { request: { address: { kind: 'session', sessionId },
          throughSeq: snapshot.cursor, beforeSeq, maxMessages: 50 } })).value;
        if (!Array.isArray(page?.records) || !page.records.length || page.records[0]?.event?.seq >= beforeSeq) {
          throw new Error('DSH invalid history page');
        }
        records = [...page.records, ...records];
        hasMore = page.hasMore;
      }
      const events = records.map((r: any) => r.event).filter(Boolean);
      const user = events.find((e: any) => e.type === 'user/message' && e.data?.source?.rpcId === requestId);
      // User messages themselves carry their turn, so a page boundary need not contain turn/start.
      const turn = user?.data?.turn ?? events.filter((e: any) => e.type === 'turn/start' && e.seq < user?.seq).at(-1)?.data?.turn;
      const ended = turn !== undefined && events.find((e: any) => e.type === 'turn/end' && e.data?.turn === turn);
      if (ended) return { reply: events.filter((e: any) => e.type === 'assistant/message' && e.data?.turn === turn)
        .map(assistantText).join('').slice(0, MAX_REPLY_CHARS), reason: String(ended.data?.reason?.kind || 'unknown') };
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw deliveryError('DSH accepted the prompt but no terminal turn was observed', 'outcome_unknown');
  }

  async push(payload: PushPayload): Promise<ProviderDeliveryReceipt> {
    const key = payload.providerBinding?.nativeSessionId || `${payload.agentId}:${payload.channelType}:${payload.channelId || payload.fromUid}`;
    const previous = this._tails.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.pushSerial(payload));
    this._tails.set(key, next);
    try { return await next; } finally { if (this._tails.get(key) === next) this._tails.delete(key); }
  }

  private async pushSerial(payload: PushPayload): Promise<ProviderDeliveryReceipt> {
    if (this._stopped) throw deliveryError('DSH Provider is stopped', 'not_delivered');
    const generation = this._lifecycleGeneration;
    const turnId = String(payload.turnId || payload.messageId || '');
    if (!turnId) throw deliveryError('DeepSeek Harness delivery requires a stable turn id', 'not_delivered');
    if (payload.attachments?.length) throw deliveryError('DeepSeek Harness attachment delivery is not enabled', 'not_delivered');
    const instanceId = this._instanceForAgent(payload.agentId) || '';
    if (!instanceId) throw deliveryError('DeepSeek Harness delivery requires an agent preset instance', 'not_delivered');
    const boundInstance = String(payload.providerBinding?.providerInstanceId || '').trim();
    if (boundInstance && boundInstance !== instanceId) {
      throw deliveryError('DeepSeek Harness agent preset binding is stale', 'not_delivered');
    }

    const preset = this.targetPreset(payload);
    const prefix = this.sessionPrefix(payload.agentId, instanceId, preset);
    let sessionId = '';
    const hasBinding = Boolean(payload.providerBinding?.nativeSessionId);
    if (hasBinding) {
      const binding = payload.providerBinding;
      if (!binding || !this.acceptsBinding(binding, payload.agentId)) {
        throw deliveryError('DeepSeek Harness exact-session binding is incompatible', 'not_delivered');
      }
      sessionId = binding.nativeSessionId;
      if (this._blocked.has(sessionId)) throw deliveryError('DSH session has an unresolved prior turn', 'outcome_unknown');
      if (preset && (binding.sessionOrigin !== 'voko_managed' || !sessionId.startsWith(prefix))) {
        throw deliveryError('DSH requires its dedicated fixed-policy VOKO session; create a new binding', 'not_delivered');
      }
      if (!await this.canRestoreExactSession({ ...binding, strictSessionRoute: true }, payload.agentId)) {
        throw deliveryError('DeepSeek Harness could not restore the exact session', 'not_delivered');
      }
    } else {
      try {
        const created = await this._rpc('session/create', { request: { sessionId: prefix + crypto.randomUUID(), agentPreset: instanceId, cwd: this._cwd } });
        sessionId = String(created.value?.sessionId || '');
      } catch (error: any) {
        throw deliveryError(error?.rpcCode === 'agent-preset-not-found' || error?.rpcCode === 'agent-preset-invalid'
          ? 'DeepSeek Harness agent preset is unavailable' : 'DeepSeek Harness did not create a session', 'not_delivered');
      }
      if (!sessionId) throw deliveryError('DeepSeek Harness created no session identity', 'outcome_unknown');
    }

    if (!hasBinding && preset) {
      const commands = (await this._rpc('commands/list', { agentId: sessionId })).value;
      if (!Array.isArray(commands) || !commands.some((c: any) => c.name === 'permission')) {
        throw deliveryError('DSH permission command is unavailable', 'not_delivered');
      }
      const switched = (await this._rpc('commands/execute', { agentId: sessionId,
        line: `/permission ${preset}`, submittedAttachments: [] })).value;
      if (switched?.result?.kind !== 'success') throw deliveryError('DSH permission command failed', 'not_delivered');
    }
    this.checkSnapshot(await this._remote.snapshot(sessionId), instanceId, preset);
    const prompt = buildConversationDeliveryPrompt(this._db, payload, hasBinding, this._contextWindow);
    let accepted: any;
    await payload.assertSubmissionCurrent?.();
    if (this._stopped || generation !== this._lifecycleGeneration) throw deliveryError('DSH Provider stopped before submission', 'not_delivered');
    if (!payload.providerSecurityPolicy && this.targetPreset(payload) !== preset) {
      throw deliveryError('DSH permission changed before submission', 'not_delivered');
    }
    try {
      accepted = await this._rpc('session/prompt', { request: { requestId: turnId, sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }] } });
      if (accepted.value?.accepted !== true) throw new Error('DSH invalid prompt admission');
    } catch (error: any) {
      if (!error?.rpcCode) this._blocked.add(sessionId);
      throw deliveryError(error?.rpcCode === 'agent-busy' ? 'DeepSeek Harness rejected the prompt' :
        'DeepSeek Harness did not confirm prompt admission', error?.rpcCode ? 'rejected' : 'outcome_unknown');
    }
    this._active.set(turnId, sessionId);
    this.notifyProviderEvent({ type: 'accepted', agentId: payload.agentId, messageId: payload.messageId,
      turnId, nativeSessionId: sessionId, terminal: false });
    try {
      const result = await this._waitForTurn(sessionId, turnId, instanceId, preset);
      if (!['completed', 'max-tokens'].includes(result.reason)) {
        throw deliveryError(`DeepSeek Harness turn ended with ${result.reason}`, 'rejected');
      }
      if (!result.reply) throw deliveryError('DeepSeek Harness completed without a committed text reply', 'outcome_unknown');
      this.emit('agent.reply', { agentId: payload.agentId, visitorId: payload.fromUid, content: result.reply,
        sessionKey: `deepseek-harness:${sessionId}`, turnId, replyId: turnId, done: true });
      this.notifyProviderEvent({ type: 'completed', agentId: payload.agentId, messageId: payload.messageId,
        turnId, nativeSessionId: sessionId, terminal: true });
      return { nativeSessionId: sessionId, providerInstanceId: instanceId, deliveryMode: 'http', adapterType: ADAPTER_TYPE };
    } catch (error: any) {
      // A lost stream or permission drift cannot prove an accepted task did not execute.
      if (error.deliveryOutcome === 'rejected') throw error;
      this._blocked.add(sessionId);
      await this.cancelTurn(turnId);
      throw deliveryError('DSH accepted task outcome could not be confirmed', 'outcome_unknown');
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
      await this._rpc('session/cancel', { request: { sessionId } });
      // DSH acknowledges admission and keeps its inbox; it does not confirm termination.
      return { canceled: false, outcome: 'outcome_unknown' };
    } catch { return { canceled: false, outcome: 'outcome_unknown' }; }
  }

  async healthCheck(): Promise<Record<string, unknown>> {
    const result = await this.preflightDelivery();
    return { ok: result.ok === true, status: String(result.status || 'unavailable') };
  }

  async stop(): Promise<void> {
    this._stopped = true;
    this._lifecycleGeneration++;
    this._ready = false;
    this._active.clear();
    if (this._server) {
      this._server.kill();
      this._server = null;
    }
  }
}

module.exports = { DeepSeekHarnessHttpProvider, loopbackBaseUrl, assistantText };
