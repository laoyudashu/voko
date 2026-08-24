const crypto = require('node:crypto');
const net = require('node:net');
const os = require('node:os');
const { AsyncLocalStorage } = require('node:async_hooks');
const { spawn } = require('node:child_process');
const { PushProvider } = require('../base-provider');
const { killTree } = require('../../adapters/cli-spawner');
const { buildConversationDeliveryPrompt } = require('../conversation-context');
const { resolveWorkBuddyRuntime, workBuddySpawnCommand, probeWorkBuddyCliVersion } = require('../workbuddy-command');
const { resolveWorkBuddyAgentTarget } = require('../workbuddy-agents');
import type { ChildProcess } from 'node:child_process';
import type { AgentMeta, ProviderSteerMetadata, PushPayload } from '../types';

const ADAPTER_TYPE = 'workbuddy-http';
const MAX_REPLY_CHARS = 2 * 1024 * 1024;
const REQUIRED_PATHS = ['/api/v1/runs', '/api/v1/runs/{runId}', '/api/v1/runs/{runId}/stream',
  '/api/v1/runs/{runId}/cancel', '/api/v1/acp/connect', '/api/v1/acp'];

interface Options {
  db?: any;
  contextWindow?: number;
  binPath?: string;
  cwd?: string;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof spawn;
  resolveAgentTarget?: typeof resolveWorkBuddyAgentTarget;
}

function deliveryError(message: string, outcome: 'not_delivered' | 'outcome_unknown' | 'rejected'): Error {
  const error = new Error(message);
  (error as any).deliveryOutcome = outcome;
  return error;
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => port ? resolve(port) : reject(new Error('No loopback port available')));
    });
  });
}

function opaqueScope(...parts: unknown[]): string {
  return `voko_${crypto.createHash('sha256').update(parts.map(value => String(value ?? '')).join('\0')).digest('hex').slice(0, 40)}`;
}

function mergeMarkdown(current: string, incoming: string): string {
  if (!incoming) return current;
  if (!current || incoming.startsWith(current)) return incoming.slice(0, MAX_REPLY_CHARS);
  if (current.endsWith(incoming)) return current;
  return (current + incoming).slice(0, MAX_REPLY_CHARS);
}

function workBuddyServeArgs(argsPrefix: string[], port: number, sessionId: string,
  target: { agentId?: string; pluginRoot?: string } = {}): string[] {
  return [...argsPrefix, ...(target.pluginRoot ? ['--plugin-dir', target.pluginRoot] : []),
    ...(target.agentId ? ['--agent', target.agentId] : []), '--serve', '--host', '127.0.0.1', '--port', String(port),
    '--session-id', sessionId, '--permission-mode', 'dontAsk', '--tools', '', '--strict-mcp-config'];
}

interface ServerState {
  instanceId: string | null;
  pluginRoot: string | null;
  server: ChildProcess | null;
  serverPromise: Promise<void> | null;
  port: number;
}

class WorkBuddyHttpProvider extends PushProvider {
  _db: any;
  _contextWindow: number;
  _cwd: string;
  _runtime: ReturnType<typeof resolveWorkBuddyRuntime>;
  _stateContext = new AsyncLocalStorage();
  _states = new Map<string, ServerState>();
  _startupTimeoutMs: number;
  _requestTimeoutMs: number;
  _fetch: typeof fetch;
  _spawn: typeof spawn;
  _resolveAgentTarget: typeof resolveWorkBuddyAgentTarget;
  _inflight = new Map<string, Promise<unknown>>();
  _activeRuns = new Map<string, { runId: string; state: ServerState }>();
  _activeAcp = new Map<string, { connectionId: string; sessionId: string; state: ServerState }>();

  constructor(options: Options = {}) {
    super();
    this._db = options.db || null;
    this._contextWindow = options.contextWindow ?? 20;
    this._cwd = options.cwd || os.tmpdir();
    this._runtime = resolveWorkBuddyRuntime({ configuredCommand: options.binPath });
    this._startupTimeoutMs = Math.max(1000, Number(options.startupTimeoutMs || 20_000));
    this._requestTimeoutMs = Math.max(1000, Number(options.requestTimeoutMs || 180_000));
    this._fetch = options.fetchImpl || fetch;
    this._spawn = options.spawnImpl || spawn;
    this._resolveAgentTarget = options.resolveAgentTarget || resolveWorkBuddyAgentTarget;
    this._states.set('', { instanceId: null, pluginRoot: null, server: null, serverPromise: null, port: 0 });
  }

  _currentState(): ServerState { return (this._stateContext.getStore() as ServerState | undefined) || this._states.get('')!; }
  get _server(): ChildProcess | null { return this._currentState().server; }
  set _server(value: ChildProcess | null) { this._currentState().server = value; }
  get _serverPromise(): Promise<void> | null { return this._currentState().serverPromise; }
  set _serverPromise(value: Promise<void> | null) { this._currentState().serverPromise = value; }
  get _port(): number { return this._currentState().port; }
  set _port(value: number) { this._currentState().port = value; }

  _configuredInstance(agentId: string): string {
    try {
      const row = this._db?.prepare('SELECT backend_instance_id FROM agents WHERE agent_id=? AND backend_type=?')
        .get(agentId, 'workbuddy');
      return String(row?.backend_instance_id || '').trim();
    } catch (_) { return ''; }
  }

  _stateFor(payload: PushPayload): ServerState {
    const instanceId = this._configuredInstance(payload.agentId);
    const boundInstance = String(payload.providerBinding?.providerInstanceId || '').trim();
    if (boundInstance && boundInstance !== instanceId) throw deliveryError('WorkBuddy instance binding is stale', 'not_delivered');
    if (!instanceId) return this._states.get('')!;
    const target = this._resolveAgentTarget(instanceId);
    if (!target) throw deliveryError('Bound WorkBuddy agent is unavailable', 'not_delivered');
    let state = this._states.get(instanceId);
    if (!state) {
      state = { instanceId, pluginRoot: target.pluginRoot, server: null, serverPromise: null, port: 0 };
      this._states.set(instanceId, state);
    }
    return state;
  }

  get priority() { return 10; }
  get capabilities() { return ['http', 'streaming', 'async_reply', 'session_resume', 'cancel']; }
  get sessionMode() { return 'agent-issued-id' as const; }
  match(_agentId: string, meta?: AgentMeta | null) { return meta?.backend_type === 'workbuddy'; }
  isAvailable() { return Boolean(this._runtime.command); }

  _resolveRuntime(): { available: boolean; executable: string | null; argvPrefix: string[] } {
    const launch = workBuddySpawnCommand(this._runtime);
    return { available: !!launch, executable: launch?.command || null, argvPrefix: launch?.argsPrefix || [] };
  }

  _headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', 'X-CodeBuddy-Request': '1' };
  }

  async _fetchJson(pathname: string, init: RequestInit = {}, timeoutMs = 5000): Promise<any> {
    const response = await this._fetch(`http://127.0.0.1:${this._port}${pathname}`, {
      ...init,
      headers: { ...this._headers(), ...(init.headers || {}) },
      signal: init.signal || AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch {}
    if (!response.ok) {
      const error: any = new Error(`WorkBuddy HTTP ${response.status}`);
      error.httpStatus = response.status;
      error.responseBody = body;
      throw error;
    }
    return body;
  }

  async _validateRuntime(): Promise<void> {
    const health = await this._fetchJson('/api/v1/health', {}, 2000);
    if (health?.status !== 'ok' && health?.data?.status !== 'ok') throw new Error('WorkBuddy health check failed');
    const openapi = await this._fetchJson('/api/openapi.json', {}, 3000);
    const paths = openapi?.paths || {};
    if (!REQUIRED_PATHS.every(pathname => paths[pathname])) throw new Error('WorkBuddy HTTP contract is incomplete');
  }

  async _ensureServer(): Promise<void> {
    if (this._server && this._server.exitCode === null && this._port) {
      try { await this._validateRuntime(); return; } catch { this._disposeServer('unhealthy'); }
    }
    if (!this._runtime.command) throw deliveryError('WorkBuddy bundled CodeBuddy CLI is unavailable', 'not_delivered');
    if (this._serverPromise) return this._serverPromise;
    this._serverPromise = (async () => {
      const launch = workBuddySpawnCommand(this._runtime);
      if (!launch) throw deliveryError('WorkBuddy launch command is unavailable', 'not_delivered');
      this._port = await findFreePort();
      const state = this._currentState();
      const args = workBuddyServeArgs(launch.argsPrefix, this._port, `voko-${crypto.randomUUID()}`,
        { agentId: state.instanceId || undefined, pluginRoot: state.pluginRoot || undefined });
      const child = this._spawn(launch.command, args, {
        cwd: this._cwd, env: { ...process.env, NO_COLOR: '1' }, windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe'],
      }) as ChildProcess;
      this._server = child;
      child.stderr?.resume();
      child.once('exit', () => {
        if (this._server !== child) return;
        this._server = null;
        this._port = 0;
        this.notifyAvailability({ backendType: 'workbuddy', mode: 'http', available: false, reason: 'serve-exit' });
      });
      const deadline = Date.now() + this._startupTimeoutMs;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) throw deliveryError(`WorkBuddy HTTP service exited with code ${child.exitCode}`, 'not_delivered');
        try {
          await this._validateRuntime();
          this.notifyAvailability({ backendType: 'workbuddy', mode: 'http', available: true, reason: 'serve-ready' });
          return;
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      this._disposeServer('startup-timeout');
      throw deliveryError('WorkBuddy HTTP service did not become ready', 'not_delivered');
    })().catch(error => {
      if (!(error as any).deliveryOutcome) (error as any).deliveryOutcome = 'not_delivered';
      throw error;
    }).finally(() => { this._serverPromise = null; });
    return this._serverPromise;
  }

  _disposeServer(reason: string): void {
    const child = this._server;
    this._server = null;
    this._port = 0;
    if (child?.pid && child.exitCode === null) killTree(child.pid);
    this.notifyAvailability({ backendType: 'workbuddy', mode: 'http', available: false, reason });
  }

  async start(): Promise<void> {
    if (!this.isAvailable()) return;
    await this._ensureServer();
  }

  async preflightDelivery(_agentId: string): Promise<Record<string, unknown>> {
    if (!this.isAvailable()) return { ok: false, status: 'unavailable', sideEffects: false, code: 'WORKBUDDY_CLI_UNAVAILABLE' };
    if (!this._server || this._server.exitCode !== null || !this._port) {
      return { ok: true, status: 'preflight_passed', sideEffects: false, runtime: 'detected',
        desktopVersion: this._runtime.desktopVersion, cliVersion: probeWorkBuddyCliVersion(this._runtime) };
    }
    try {
      await this._validateRuntime();
      return { ok: true, status: 'preflight_passed', sideEffects: false, runtime: 'loopback_http',
        desktopVersion: this._runtime.desktopVersion, cliVersion: probeWorkBuddyCliVersion(this._runtime) };
    } catch {
      return { ok: false, status: 'unavailable', sideEffects: false, code: 'WORKBUDDY_HTTP_UNHEALTHY' };
    }
  }

  acceptsBinding(binding: any): boolean {
    return binding?.providerType === 'workbuddy' && binding.adapterType === ADAPTER_TYPE
      && binding.deliveryMode === 'http' && typeof binding.nativeSessionId === 'string'
      && binding.nativeSessionId.length > 0;
  }

  async canRestoreExactSession(binding: PushPayload['providerBinding'], agentId: string): Promise<boolean> {
    if (!binding || !this.acceptsBinding(binding)) return false;
    try {
      const state = this._stateFor({ agentId, providerBinding: binding } as PushPayload);
      if (!state.server || state.server.exitCode !== null || !state.port) return false;
      return await this._stateContext.run(state, async () => {
        const history = await this._fetchJson(`/api/v1/sessions/${encodeURIComponent(binding.nativeSessionId)}/history`, {}, 2500);
        return history?.data?.sessionId === binding.nativeSessionId && this.match(agentId, { backend_type: 'workbuddy' });
      });
    } catch { return false; }
  }

  _scope(payload: PushPayload): { senderId: string; conversationId: string; channelId: string; channelType: number } {
    const channelId = String(payload.providerBinding?.channelId || payload.channelId || payload.fromUid || 'unknown');
    const channelType = Number(payload.providerBinding?.channelType || payload.channelType || 1) === 2 ? 2 : 1;
    const sourceScope = payload.providerBinding?.sourceScope || (payload as any).sourceScope || 'conversation';
    return {
      senderId: opaqueScope('sender', payload.agentId, sourceScope, payload.senderUid || payload.fromUid),
      conversationId: opaqueScope('conversation', payload.agentId, sourceScope, channelType, channelId),
      channelId, channelType,
    };
  }

  async _consumeStream(runId: string, expectedReplyTo: string): Promise<{ reply: string; sessionId: string; status: string }> {
    const response = await this._fetch(`http://127.0.0.1:${this._port}/api/v1/runs/${encodeURIComponent(runId)}/stream`, {
      headers: this._headers(), signal: AbortSignal.timeout(this._requestTimeoutMs),
    });
    if (!response.ok || !response.body) throw new Error(`WorkBuddy stream HTTP ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let reply = '';
    let sessionId = '';
    let status = '';
    const consume = (block: string) => {
      for (const line of block.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '{}') continue;
        let event: any;
        try { event = JSON.parse(data); } catch { continue; }
        // WorkBuddy may replay completed events from the same native session.
        // Only the event correlated to this VOKO message may complete this turn.
        if (event.replyTo && String(event.replyTo) !== expectedReplyTo) continue;
        status = String(event.status || status);
        sessionId = String(event.agent?.sessionId || event.sessionId || sessionId);
        const markdown = typeof event.content?.markdown === 'string' ? event.content.markdown : '';
        reply = mergeMarkdown(reply, markdown);
        if (status === 'failed') throw deliveryError('WorkBuddy rejected the task', 'rejected');
      }
    };
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() || '';
      for (const block of blocks) consume(block);
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
    return { reply, sessionId, status };
  }

  async _streamAcceptedRun(runId: string, expectedReplyTo: string): Promise<{ reply: string; sessionId: string }> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await this._consumeStream(runId, expectedReplyTo);
        if (result.status === 'completed' && result.reply) return result;
        if (result.status === 'failed') throw deliveryError('WorkBuddy rejected the task', 'rejected');
      } catch (error) {
        if ((error as any)?.deliveryOutcome === 'rejected') throw error;
        lastError = error;
      }
      try {
        const state = await this._fetchJson(`/api/v1/runs/${encodeURIComponent(runId)}`, {}, 2500);
        if (state?.data?.active === false && attempt > 0) break;
      } catch (error) { lastError = error; }
    }
    throw deliveryError(`WorkBuddy accepted the task but its result could not be confirmed${lastError ? '' : ''}`, 'outcome_unknown');
  }

  async _readAcpResponse(response: Response, requestId: string | null, sessionId: string,
    onUpdate?: (update: any) => void): Promise<any> {
    if (!response.ok || !response.body) throw new Error(`WorkBuddy ACP HTTP ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result: any = null;
    const consume = (line: string) => {
      const raw = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
      if (!raw || raw === '{}') return;
      let event: any;
      try { event = JSON.parse(raw); } catch { return; }
      if (requestId && String(event.id || '') === requestId) {
        if (event.error) throw deliveryError('WorkBuddy ACP rejected the request', 'rejected');
        result = event.result ?? {};
      }
      if (event.method === 'session/update' && (!sessionId || event.params?.sessionId === sessionId)) {
        onUpdate?.(event.params?.update || {});
      }
    };
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) consume(line);
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
    return result;
  }

  async _acpRequest(connectionId: string, method: string, params: any, sessionId = '',
    onUpdate?: (update: any) => void, notification = false): Promise<any> {
    const requestId = notification ? null : crypto.randomUUID();
    const response = await this._fetch(`http://127.0.0.1:${this._port}/api/v1/acp`, {
      method: 'POST',
      headers: { ...this._headers(), Accept: 'application/json, text/event-stream', 'acp-connection-id': connectionId },
      body: JSON.stringify({ jsonrpc: '2.0', ...(requestId ? { id: requestId } : {}), method, params }),
      signal: AbortSignal.timeout(this._requestTimeoutMs),
    });
    return this._readAcpResponse(response, requestId, sessionId, onUpdate);
  }

  async _disconnectAcp(connectionId: string): Promise<void> {
    try {
      await this._fetch(`http://127.0.0.1:${this._port}/api/v1/acp`, {
        method: 'DELETE', headers: { ...this._headers(), 'acp-connection-id': connectionId },
        signal: AbortSignal.timeout(2500),
      });
    } catch {}
  }

  async _pushExistingSession(payload: PushPayload, turnId: string, nativeSessionId: string): Promise<unknown> {
    const scope = this._scope(payload);
    let connectionId = '';
    let promptStarted = false;
    try {
      const connected = await this._fetchJson('/api/v1/acp/connect', { method: 'POST' }, 5000);
      connectionId = String(connected?.connectionId || connected?.data?.connectionId || '');
      if (!connectionId) throw deliveryError('WorkBuddy ACP connection was not established', 'not_delivered');
      await this._acpRequest(connectionId, 'initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'VOKO', version: '1' },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      });
      // CodeBuddy 2.115.0 requires cwd although its published resume example omits it.
      await this._acpRequest(connectionId, 'session/resume', { sessionId: nativeSessionId, cwd: this._cwd }, nativeSessionId);
      let reply = '';
      let stopReason = '';
      this._activeAcp.set(turnId, { connectionId, sessionId: nativeSessionId, state: this._currentState() });
      promptStarted = true;
      this.notifyProviderEvent({ type: 'accepted', agentId: payload.agentId, messageId: payload.messageId,
        turnId, nativeSessionId, terminal: false });
      const prompt = buildConversationDeliveryPrompt(this._db, payload, true, this._contextWindow);
      const result = await this._acpRequest(connectionId, 'session/prompt', {
        sessionId: nativeSessionId, prompt: [{ type: 'text', text: prompt }],
      }, nativeSessionId, update => {
        const historyReplay = update?._meta?.['codebuddy.ai/historyReplay'] === true;
        if (!historyReplay && update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
          reply = (reply + String(update.content.text || '')).slice(0, MAX_REPLY_CHARS);
        }
        if (update?.sessionUpdate === 'session_end') stopReason = String(update.stopReason || '');
        if (update?.sessionUpdate === 'interruption_request') {
          const toolCallId = String(update.toolCallId || update._meta?.['codebuddy.ai/toolCallId'] || '');
          if (toolCallId) void this._acpRequest(connectionId, '_codebuddy.ai/resolveInterruption', {
            sessionId: nativeSessionId, toolCallId, decision: 'deny', answers: {},
          }, nativeSessionId).catch(() => {});
        }
      });
      stopReason = String(result?.stopReason || stopReason);
      if (stopReason === 'refusal') throw deliveryError('WorkBuddy refused the resumed task', 'rejected');
      if (stopReason === 'cancelled') throw deliveryError('WorkBuddy canceled the resumed task', 'rejected');
      if (!reply) throw deliveryError('WorkBuddy resumed the session but returned no reply', 'outcome_unknown');
      this.emit('agent.reply', { agentId: payload.agentId, visitorId: payload.fromUid, content: reply, done: true,
        sessionKey: `workbuddy:${scope.conversationId}`, turnId, replyId: turnId });
      this.notifyProviderEvent({ type: 'completed', agentId: payload.agentId, messageId: payload.messageId,
        turnId, nativeSessionId, terminal: true });
      return { nativeSessionId, providerInstanceId: this._currentState().instanceId, deliveryMode: 'http', adapterType: ADAPTER_TYPE };
    } catch (error) {
      if ((error as any)?.deliveryOutcome) throw error;
      throw deliveryError(promptStarted
        ? 'WorkBuddy accepted the resumed task but its result could not be confirmed'
        : 'WorkBuddy could not restore the exact session', promptStarted ? 'outcome_unknown' : 'not_delivered');
    } finally {
      this._activeAcp.delete(turnId);
      if (connectionId) await this._disconnectAcp(connectionId);
    }
  }

  async push(payload: PushPayload): Promise<unknown> {
    const turnId = String(payload.turnId || payload.messageId || '');
    if (!turnId) throw deliveryError('WorkBuddy delivery requires a stable message id', 'not_delivered');
    const state = this._stateFor(payload);
    const inflightKey = `${state.instanceId || ''}\0${turnId}`;
    const existing = this._inflight.get(inflightKey);
    if (existing) return existing;
    const task = this._stateContext.run(state, () => this._pushOnce(payload, turnId)).finally(() => {
      if (this._inflight.get(inflightKey) === task) this._inflight.delete(inflightKey);
      this._activeRuns.delete(turnId);
    });
    this._inflight.set(inflightKey, task);
    return task;
  }

  async _pushOnce(payload: PushPayload, turnId: string): Promise<unknown> {
    await this._ensureServer();
    const bindingInstance = String(payload.providerBinding?.providerInstanceId || '').trim();
    const currentInstance = this._currentState().instanceId || '';
    const boundSession = this.acceptsBinding(payload.providerBinding) && bindingInstance === currentInstance
      ? String(payload.providerBinding?.nativeSessionId || '') : '';
    if (boundSession) return this._pushExistingSession(payload, turnId, boundSession);
    const scope = this._scope(payload);
    const hasSession = Boolean(payload.providerBinding?.nativeSessionId);
    const prompt = buildConversationDeliveryPrompt(this._db, payload, hasSession, this._contextWindow);
    let accepted: any;
    try {
      accepted = await this._fetchJson('/api/v1/runs', {
        method: 'POST',
        body: JSON.stringify({
          id: turnId,
          type: 'message',
          source: {
            platform: 'voko',
            sender: { id: scope.senderId, name: 'VOKO' },
            conversation: { id: scope.conversationId, type: scope.channelType === 2 ? 'group' : 'direct' },
          },
          payload: { text: prompt },
        }),
      }, 10_000);
    } catch (error: any) {
      const outcome = error?.httpStatus && error.httpStatus >= 400 && error.httpStatus < 500 ? 'rejected' : 'not_delivered';
      throw deliveryError(error?.httpStatus ? `WorkBuddy rejected the request with HTTP ${error.httpStatus}` : 'WorkBuddy did not accept the request', outcome);
    }
    const runId = String(accepted?.data?.runId || '');
    if (!runId) throw deliveryError('WorkBuddy accepted the request without a run id', 'outcome_unknown');
    this._activeRuns.set(turnId, { runId, state: this._currentState() });
    this.notifyProviderEvent({ type: 'accepted', agentId: payload.agentId, messageId: payload.messageId,
      turnId, nativeSessionId: payload.providerBinding?.nativeSessionId || null, terminal: false });
    const result = await this._streamAcceptedRun(runId, turnId);
    const nativeSessionId = result.sessionId || payload.providerBinding?.nativeSessionId || '';
    if (!nativeSessionId) throw deliveryError('WorkBuddy completed without a session id', 'outcome_unknown');
    this.emit('agent.reply', {
      agentId: payload.agentId, visitorId: payload.fromUid, content: result.reply, done: true,
      sessionKey: `workbuddy:${scope.conversationId}`, turnId, replyId: turnId,
    });
    this.notifyProviderEvent({ type: 'completed', agentId: payload.agentId, messageId: payload.messageId,
      turnId, nativeSessionId, terminal: true });
    return { nativeSessionId, providerInstanceId: this._currentState().instanceId, deliveryMode: 'http', adapterType: ADAPTER_TYPE };
  }

  async steer(agentId: string, visitorId: string, content: string, metadata: ProviderSteerMetadata = {}): Promise<unknown> {
    const turnId = String(metadata.turnId || `steer-${crypto.randomUUID()}`);
    return this.push({ agentId, fromUid: visitorId, content, rawContent: content,
      messageId: turnId, turnId, channelId: metadata.channelId || visitorId,
      channelType: metadata.channelType || 1, providerBinding: metadata.providerBinding || null,
      timestamp: Date.now() });
  }

  async cancelTurn(turnId: string): Promise<{ canceled: boolean; outcome: string }> {
    const activeAcp = this._activeAcp.get(String(turnId || ''));
    if (activeAcp) {
      try {
        await this._stateContext.run(activeAcp.state, () => this._acpRequest(activeAcp.connectionId, 'session/cancel', { sessionId: activeAcp.sessionId }, activeAcp.sessionId, undefined, true));
        return { canceled: true, outcome: 'delivered' };
      } catch { return { canceled: false, outcome: 'outcome_unknown' }; }
    }
    const activeRun = this._activeRuns.get(String(turnId || ''));
    if (!activeRun) return { canceled: false, outcome: 'not_delivered' };
    try {
      const result = await this._stateContext.run(activeRun.state, () => this._fetchJson(`/api/v1/runs/${encodeURIComponent(activeRun.runId)}/cancel`, { method: 'POST' }, 5000));
      return { canceled: result?.data?.status === 'cancelled', outcome: result?.data?.status === 'cancelled' ? 'delivered' : 'outcome_unknown' };
    } catch { return { canceled: false, outcome: 'outcome_unknown' }; }
  }

  async runLoopbackTest(_agentId: string, options: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (options.acknowledgeCost !== true) return { ok: false, status: 'failed', code: 'LOOPBACK_CONFIRMATION_REQUIRED' };
    const challenge = String(options.challenge || '');
    if (!/^voko-[a-f0-9]{24}$/.test(challenge)) return { ok: false, status: 'failed', code: 'LOOPBACK_CHALLENGE_INVALID' };
    let reply = '';
    const handler = (event: any) => { if (event?.turnId === challenge) reply = String(event.content || ''); };
    this.on('agent.reply', handler);
    try {
      const receipt = await this.push({ agentId: _agentId || 'workbuddy-loopback', fromUid: 'voko-loopback',
        content: `VOKO local loopback test. Do not use tools. Reply with exactly: ${challenge}`,
        rawContent: challenge, channelId: `loopback-${challenge}`, channelType: 1,
        messageId: challenge, turnId: challenge, timestamp: Date.now() });
      const matched = reply.trim() === challenge;
      return { ok: matched, status: matched ? 'loopback_verified' : 'failed', challengeMatched: matched,
        loopbackSessionId: (receipt as any)?.nativeSessionId || null,
        detail: matched ? 'WorkBuddy HTTP loopback verified' : 'WorkBuddy returned an unexpected loopback reply' };
    } finally { this.off('agent.reply', handler); }
  }

  async cleanupLoopbackSession(_agentId: string, sessionId?: string): Promise<Record<string, unknown>> {
    if (!sessionId || !this._port) return { ok: true, cleaned: false };
    try {
      const response = await this._fetch(`http://127.0.0.1:${this._port}/api/v1/sessions/${encodeURIComponent(sessionId)}`,
        { method: 'DELETE', headers: this._headers(), signal: AbortSignal.timeout(3000) });
      return { ok: response.ok || response.status === 404, cleaned: response.ok };
    } catch { return { ok: false, cleaned: false }; }
  }

  async healthCheck(): Promise<Record<string, unknown>> {
    if (!this._server || this._server.exitCode !== null || !this._port) {
      return { ok: false, status: this.isAvailable() ? 'idle' : 'unavailable' };
    }
    try { await this._validateRuntime(); return { ok: true, status: 'running' }; }
    catch { return { ok: false, status: 'unhealthy' }; }
  }

  async stop(): Promise<void> {
    for (const state of this._states.values()) this._stateContext.run(state, () => this._disposeServer('provider-stopped'));
    this._inflight.clear();
    this._activeRuns.clear();
    this._activeAcp.clear();
  }
}

module.exports = { WorkBuddyHttpProvider, opaqueScope, mergeMarkdown, workBuddyServeArgs };
