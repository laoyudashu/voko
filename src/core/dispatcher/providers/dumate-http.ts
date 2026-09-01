const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { PushProvider } = require('../base-provider');
const { killTree, checkCliAvailable } = require('../../adapters/cli-spawner');
const { buildConversationDeliveryPrompt } = require('../conversation-context');
const { resolveDuMateCommand, resolveDuMateBackendPort } = require('../dumate-command');
const { resolveDuMateAgentTarget } = require('../dumate-agents');
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentMeta, ProviderSteerMetadata, PushPayload } from '../types';

const ADAPTER_TYPE = 'dumate-http';
const MAX_REPLY_CHARS = 2 * 1024 * 1024;

interface Options {
  db?: any;
  contextWindow?: number;
  cwd?: string;
  binPath?: string;
  resolveAgentTarget?: typeof resolveDuMateAgentTarget;
  resolveBackendPort?: typeof resolveDuMateBackendPort;
}

interface RuntimeState {
  instanceId: string;
  child: ChildProcessWithoutNullStreams | null;
  starting: Promise<void> | null;
  port: number;
  password: string;
  tempRoot: string;
  stderr: string;
}

function deliveryError(message: string, outcome = 'not_delivered'): Error {
  const error: any = new Error(message);
  error.deliveryOutcome = outcome;
  return error;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function ephemeralRouteId(agentId: string): string {
  return `voko-${crypto.createHash('sha256').update(String(agentId || '')).digest('hex').slice(0, 24)}`;
}

function writeEphemeralDuMatePlugin(dataRoot: string, routeId: string, metadata: Record<string, unknown> = {}): string {
  const pluginRoot = path.join(dataRoot, 'plugins', 'user', routeId);
  const manifestRoot = path.join(pluginRoot, '.claude-plugin');
  const agentsRoot = path.join(pluginRoot, 'agents');
  fs.mkdirSync(manifestRoot, { recursive: true });
  fs.mkdirSync(agentsRoot, { recursive: true });
  const fullName = String(metadata.agentName || 'VOKO Agent').trim() || 'VOKO Agent';
  const displayName = [...fullName].slice(0, 10).join('');
  const description = String(metadata.description || `接收并处理发给 ${fullName} 的 VOKO 消息`).trim();
  const manifest = {
    name: routeId, displayName, version: '1.0.0', description,
    author: { name: 'VOKO 临时路由' }, license: 'UNLICENSED', keywords: ['voko', 'temporary-route'],
    defaultEnabled: true, entry: routeId,
    agents: [{ name: routeId, displayName, description, mode: 'primary', prompt: `./agents/${routeId}.md`, skills: [] }],
    skills: './skills/', exampleQuestions: [],
  };
  fs.writeFileSync(path.join(manifestRoot, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(agentsRoot, `${routeId}.md`),
    `# ${displayName}\n\n你是 VOKO Agent「${fullName}」。${description}\n\n请只处理当前 VOKO 会话中的用户请求，清晰、准确地回复。\n`, 'utf8');
  return pluginRoot;
}

class DuMateHttpProvider extends PushProvider {
  private readonly _db: any;
  private readonly _contextWindow: number;
  private readonly _cwd: string;
  private readonly _cmd: string;
  private readonly _resolveAgentTarget: typeof resolveDuMateAgentTarget;
  private readonly _resolveBackendPort: typeof resolveDuMateBackendPort;
  private readonly _states = new Map<string, RuntimeState>();
  private readonly _verification = new Map<string, { status: 'unverified' | 'loopback_verified' | 'login_failed' | 'timeout' | 'failed'; detail?: string; verifiedAt?: number }>();

  constructor(options: Options = {}) {
    super();
    this._db = options.db || null;
    this._contextWindow = options.contextWindow ?? 20;
    this._cwd = options.cwd || os.tmpdir();
    this._cmd = options.binPath || resolveDuMateCommand();
    this._resolveAgentTarget = options.resolveAgentTarget || resolveDuMateAgentTarget;
    this._resolveBackendPort = options.resolveBackendPort || resolveDuMateBackendPort;
  }

  get priority() { return 10; }
  get capabilities() { return ['http', 'streaming', 'session_resume']; }
  match(_agentId: string, meta?: AgentMeta | null) { return meta?.backend_type === 'dumate'; }

  _instanceForAgent(agentId: string): string {
    try {
      const row = this._db?.prepare('SELECT backend_type, backend_instance_id FROM agents WHERE agent_id=?').get(agentId);
      return row?.backend_type === 'dumate' ? String(row.backend_instance_id || '').trim() : '';
    } catch (_) { return ''; }
  }

  private _routeForAgent(agentId: string): string {
    return this._instanceForAgent(agentId) || ephemeralRouteId(agentId);
  }

  private _agentMetadata(agentId: string): Record<string, unknown> {
    try {
      const row = this._db?.prepare('SELECT agent_name, description FROM agents WHERE agent_id=?').get(agentId);
      return { agentName: row?.agent_name, description: row?.description };
    } catch (_) { return {}; }
  }

  isAvailable(agentId: string): boolean {
    const instanceId = this._instanceForAgent(agentId);
    return checkCliAvailable(this._cmd) && (!instanceId || !!this._resolveAgentTarget(instanceId));
  }

  getDeliveryReadiness(agentId = ''): Record<string, unknown> {
    const installed = checkCliAvailable(this._cmd);
    const backendReady = installed && Boolean(this._resolveBackendPort());
    const verification = this._verification.get(String(agentId || ''));
    return { installed, ready: backendReady, automaticReady: backendReady && verification?.status === 'loopback_verified',
      authenticationStatus: backendReady ? 'unverified' : 'unverified',
      reason: !installed ? 'not_found' : !backendReady ? 'login_required' : 'auth_test_required',
      verificationStatus: verification?.status || 'unverified',
      ...(verification?.detail ? { detail: verification.detail } : {}),
      ...(verification?.verifiedAt ? { verifiedAt: verification.verifiedAt } : {}) };
  }

  getSecurityControlEvidence(agentId = ''): Record<string, unknown> {
    const observed = (this as any).getProviderVersion?.();
    return { transportId: ADAPTER_TYPE, platform: process.platform, runtimeVersion: observed?.version || null,
      versionVerified: Boolean(observed?.version && observed?.result === 'known'), versionSource: observed?.source || 'unknown',
      contract: 'isolated_xdg_root_and_loopback_http',
      readiness: this.getDeliveryReadiness(agentId) };
  }

  describeSecurityInvocation(config: Record<string,string>): Array<{ text: string; risk: 'low'|'medium'|'high' }> {
    return [
      { text: 'POST /session/<sessionId>/prompt_async', risk: 'low' },
      { text: config.sessionPersistence === 'ephemeral' ? '每条消息新建 Session' : '复用当前访客 Session',
        risk: config.sessionPersistence === 'ephemeral' ? 'low' : 'medium' },
    ];
  }

  acceptsBinding(binding: any, agentId = ''): boolean {
    const instanceId = this._routeForAgent(agentId);
    return binding?.providerType === 'dumate' && binding.adapterType === ADAPTER_TYPE
      && binding.deliveryMode === 'http' && binding.nativeSessionId
      && binding.providerInstanceId === instanceId;
  }

  async preflightDelivery(agentId: string): Promise<Record<string, unknown>> {
    const boundInstanceId = this._instanceForAgent(agentId);
    const instanceId = this._routeForAgent(agentId);
    if (!checkCliAvailable(this._cmd)) return { ok: false, status: 'unavailable', sideEffects: false, code: 'DUMATE_CLI_UNAVAILABLE' };
    if (boundInstanceId && !this._resolveAgentTarget(boundInstanceId)) {
      return { ok: false, status: 'unavailable', sideEffects: false, code: 'DUMATE_AGENT_UNAVAILABLE' };
    }
    if (!this._resolveBackendPort()) {
      return { ok: false, status: 'configuration_required', sideEffects: false,
        code: 'DUMATE_BACKEND_UNAVAILABLE', providerInstanceId: instanceId };
    }
    return { ok: false, status: 'configuration_required', sideEffects: false,
      code: 'DUMATE_AUTH_TEST_REQUIRED', providerInstanceId: instanceId,
      routing: boundInstanceId ? 'plugin_part' : 'ephemeral_plugin_part' };
  }

  private _headers(state: RuntimeState): Record<string, string> {
    return { 'Content-Type': 'application/json' };
  }

  private async _fetch(state: RuntimeState, pathname: string, init: RequestInit = {}, timeout = 10_000): Promise<Response> {
    return fetch(`http://127.0.0.1:${state.port}${pathname}`, {
      ...init, headers: { ...this._headers(state), ...(init.headers || {}) }, signal: AbortSignal.timeout(timeout),
    });
  }

  private async _json(state: RuntimeState, pathname: string, init: RequestInit = {}, timeout = 10_000): Promise<any> {
    const response = await this._fetch(state, pathname, init, timeout);
    if (!response.ok) throw deliveryError(`DuMate HTTP ${response.status}`, response.status < 500 ? 'rejected' : 'not_delivered');
    const body = await response.text();
    return body.trim() ? JSON.parse(body) : {};
  }

  private async _ensureState(instanceId: string, agentId = ''): Promise<RuntimeState> {
    let state = this._states.get(instanceId);
    if (!state) {
      state = { instanceId, child: null, starting: null, port: 0, password: '', tempRoot: '', stderr: '' };
      this._states.set(instanceId, state);
    }
    if (state.child?.exitCode === null && state.port) {
      try { if ((await this._fetch(state, '/global/health', {}, 1500)).ok) return state; } catch (_) {}
    }
    if (state.starting) { await state.starting; return state; }
    const target = this._resolveAgentTarget(instanceId);
    if (!target && instanceId !== ephemeralRouteId(agentId)) throw deliveryError('Bound DuMate Agent is unavailable');
    state.starting = (async () => {
      state!.port = await freePort();
      state!.password = '';
      state!.tempRoot = path.join(os.homedir(), '.voko', 'provider-data', 'dumate', instanceId);
      const dataRoot = path.join(state!.tempRoot, 'data');
      fs.mkdirSync(path.join(dataRoot, 'plugins', 'user'), { recursive: true });
      if (target) fs.cpSync(target.pluginRoot, path.join(dataRoot, 'plugins', 'user', instanceId), { recursive: true });
      else writeEphemeralDuMatePlugin(dataRoot, instanceId, this._agentMetadata(agentId));
      const backendPort = this._resolveBackendPort();
      if (!backendPort) throw deliveryError('DuMate backend is not running; start DuMate before automatic delivery');
      const child = spawn(this._cmd, ['serve', '--hostname', '127.0.0.1', '--port', String(state!.port)], {
        cwd: this._cwd,
        env: { ...process.env, XDG_DATA_HOME: dataRoot, OPENCODE_SERVER_PASSWORD: '',
          DUMATE_BACK_END_PORT: backendPort, NO_COLOR: '1' },
        windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams;
      state!.child = child;
      state!.stderr = '';
      child.stderr.on('data', (chunk) => { state!.stderr = (state!.stderr + String(chunk)).slice(-4000); });
      child.on('error', () => {});
      child.on('exit', () => { if (state!.child === child) state!.child = null; });
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) throw deliveryError(`DuMate serve exited with code ${child.exitCode}: ${state!.stderr.trim()}`);
        try {
          if ((await this._fetch(state!, '/global/health', {}, 1500)).ok) {
            await this._json(state!, '/global/runtime/ready', { method: 'POST', body: '{}' });
            return;
          }
        } catch (_) {}
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw deliveryError('DuMate serve health check timed out');
    })().finally(() => { state!.starting = null; });
    try { await state.starting; return state; }
    catch (error) { await this._dispose(state); throw error; }
  }

  private async _session(state: RuntimeState, sessionId: string): Promise<any> {
    return this._json(state, `/session/${encodeURIComponent(sessionId)}`);
  }

  private async _latestAssistant(state: RuntimeState, sessionId: string): Promise<{ id: string; reply: string }> {
    const messages = await this._json(state, `/session/${encodeURIComponent(sessionId)}/message`);
    const assistant = [...(Array.isArray(messages) ? messages : [])].reverse().find((item: any) => item?.info?.role === 'assistant');
    const reply = (assistant?.parts || []).filter((part: any) => part?.type === 'text' && part?.phase === 'final_answer')
      .map((part: any) => String(part.text || '')).join('').slice(0, MAX_REPLY_CHARS);
    return { id: String(assistant?.info?.id || ''), reply };
  }

  private async _wait(state: RuntimeState, sessionId: string, previousAssistantId: string): Promise<string> {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const status = await this._json(state, '/session/status');
      const current = status?.[sessionId];
      if (!current || current.type === 'idle') {
        const latest = await this._latestAssistant(state, sessionId).catch(() => ({ id: '', reply: '' }));
        if (latest.id && latest.id !== previousAssistantId && latest.reply) return latest.reply;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw deliveryError('DuMate accepted the message but completion could not be confirmed', 'outcome_unknown');
  }

  async canRestoreExactSession(binding: PushPayload['providerBinding'], agentId: string): Promise<boolean> {
    if (!binding || !this.acceptsBinding(binding, agentId)) return false;
    try {
      const state = await this._ensureState(binding.providerInstanceId!, agentId);
      const session = await this._session(state, binding.nativeSessionId);
      return Array.isArray(session?.activePlugins) && session.activePlugins.includes(binding.providerInstanceId);
    } catch (_) { return false; }
  }

  private async _pushOnce(payload: PushPayload): Promise<unknown> {
    const boundInstanceId = this._instanceForAgent(payload.agentId);
    const instanceId = this._routeForAgent(payload.agentId);
    if (boundInstanceId && !this._resolveAgentTarget(boundInstanceId)) throw deliveryError('Bound DuMate Agent is unavailable');
    const binding = payload.providerSecurityPolicy?.config.sessionPersistence === 'ephemeral'
      ? null : payload.providerBinding;
    if (binding?.providerInstanceId && binding.providerInstanceId !== instanceId) throw deliveryError('DuMate Agent binding is stale');
    const state = await this._ensureState(instanceId, payload.agentId);
    let sessionId = this.acceptsBinding(binding, payload.agentId) ? binding!.nativeSessionId : '';
    if (sessionId) {
      const session = await this._session(state, sessionId).catch(() => null);
      if (!session || !Array.isArray(session.activePlugins) || !session.activePlugins.includes(instanceId)) {
        throw deliveryError('DuMate session is not bound to the selected Agent');
      }
    } else {
      const created = await this._json(state, '/session', { method: 'POST', body: JSON.stringify({}) });
      sessionId = String(created?.id || created?.sessionId || '');
      if (!sessionId) throw deliveryError('DuMate session was not created');
    }
    const prompt = buildConversationDeliveryPrompt(this._db, payload, Boolean(binding), this._contextWindow);
    const parts = [
      ...(!binding ? [{ type: 'plugin', name: instanceId }] : []),
      { type: 'text', text: prompt },
    ];
    this.notifyProviderEvent({ type: 'accepted', agentId: payload.agentId, messageId: payload.messageId,
      turnId: payload.turnId || payload.messageId, nativeSessionId: sessionId, providerInstanceId: instanceId, terminal: false });
    const previousAssistantId = (await this._latestAssistant(state, sessionId).catch(() => ({ id: '', reply: '' }))).id;
    await this._json(state, `/session/${encodeURIComponent(sessionId)}/prompt_async`, {
      method: 'POST', body: JSON.stringify({ model: { providerID: 'qianfan-multimodal', modelID: 'model-mm' }, agent: 'build', parts }),
    }, 15_000);
    const reply = await this._wait(state, sessionId, previousAssistantId);
    const verified = await this._session(state, sessionId);
    if (!Array.isArray(verified?.activePlugins) || !verified.activePlugins.includes(instanceId)) {
      throw deliveryError('DuMate did not activate the selected Agent', 'outcome_unknown');
    }
    const turnId = String(payload.turnId || payload.messageId || '');
    this.emit('agent.reply', { agentId: payload.agentId, visitorId: payload.fromUid, content: reply, done: true,
      sessionKey: `dumate:${instanceId}:${sessionId}`, turnId, replyId: turnId });
    this.notifyProviderEvent({ type: 'completed', agentId: payload.agentId, messageId: payload.messageId,
      turnId, nativeSessionId: sessionId, providerInstanceId: instanceId, terminal: true });
    return { nativeSessionId: sessionId, providerInstanceId: instanceId, deliveryMode: 'http', adapterType: ADAPTER_TYPE };
  }

  async push(payload: PushPayload): Promise<unknown> {
    try {
      const result = await this._pushOnce(payload);
      this._verification.set(payload.agentId, { status: 'loopback_verified', verifiedAt: Date.now() });
      return result;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const status = /not logged|unauthorized|login|required|backend.*unavailable|未登录|登录/i.test(detail)
        ? 'login_failed' : /timed?\s*out|timeout|etimedout|超时/i.test(detail) ? 'timeout' : 'failed';
      this._verification.set(payload.agentId, { status, detail });
      if (error && typeof error === 'object' && !(error as { code?: string }).code) {
        (error as { code?: string }).code = status === 'login_failed' ? 'DUMATE_LOGIN_FAILED'
          : status === 'timeout' ? 'DUMATE_TIMEOUT' : 'DUMATE_DELIVERY_FAILED';
      }
      throw error;
    }
  }

  async steer(agentId: string, visitorId: string, content: string, metadata: ProviderSteerMetadata = {}): Promise<unknown> {
    const turnId = metadata.turnId || `steer-${crypto.randomUUID()}`;
    return this.push({ agentId, fromUid: visitorId, content, rawContent: content, messageId: turnId,
      turnId, channelId: metadata.channelId || visitorId, channelType: metadata.channelType || 1,
      providerBinding: metadata.providerBinding || null, timestamp: Date.now() });
  }

  private async _dispose(state: RuntimeState): Promise<void> {
    if (state.child?.pid && state.child.exitCode === null) killTree(state.child.pid);
    state.child = null;
    state.port = 0; state.password = ''; state.tempRoot = ''; state.stderr = '';
  }

  async stop(): Promise<void> {
    await Promise.all([...this._states.values()].map((state) => this._dispose(state)));
    this._states.clear();
  }
}

module.exports = { DuMateHttpProvider, ephemeralRouteId, writeEphemeralDuMatePlugin };
