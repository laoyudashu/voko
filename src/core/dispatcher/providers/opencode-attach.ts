const { spawn } = require('child_process');
const net = require('net');
const os = require('os');
const { PushProvider } = require('../base-provider');
const { runCli, killTree, checkCliAvailable } = require('../../adapters/cli-spawner');
const { createParser } = require('../../adapters/cli-parsers');
const { ProviderConversationBindingStore } = require('../../provider-conversation-bindings');
const { buildConversationDeliveryPrompt } = require('../conversation-context');
const {
  isolatedOpenCodeEnv,
  buildOpenCodeVisitorContent,
  newServerPassword,
  resolveOpenCodeCommand,
} = require('./opencode-runtime');
import type { ChildProcessWithoutNullStreams } from 'child_process';
import type { DatabaseLike } from '../../../types/database';
import type { AgentMeta, PushPayload } from '../types';

interface Options {
  db?: Pick<DatabaseLike, 'prepare'> | null;
  contextWindow?: number;
  cwd?: string;
  sessionPersistence?: 'transport' | 'dispatcher';
}

interface SessionRow { session_handle?: string }
interface OpenCodeMessage {
  info?: { role?: string };
  parts?: Array<{ type?: string; text?: string }>;
}

const ADAPTER_TYPE = 'opencode-attach';
const MAX_REPLY_CHARS = 2 * 1024 * 1024;

function findPort(preferred = 4096): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => {
      const fallback = net.createServer();
      fallback.unref();
      fallback.once('error', reject);
      fallback.listen(0, '127.0.0.1', () => {
        const address = fallback.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        fallback.close(() => resolve(port));
      });
    });
    server.listen(preferred, '127.0.0.1', () => server.close(() => resolve(preferred)));
  });
}

class OpenCodeAttachProvider extends PushProvider {
  _db: Options['db'];
  _contextWindow: number;
  _cwd: string;
  _cmd: string;
  _server: ChildProcessWithoutNullStreams | null = null;
  _serverPromise: Promise<void> | null = null;
  _port = 0;
  _password = '';
  _sessionPersistence: 'transport' | 'dispatcher' = 'transport';

  constructor(options: Options = {}) {
    super();
    this._db = options.db || null;
    this._bindingStore = options.db && typeof (options.db as any).exec === 'function'
      ? new ProviderConversationBindingStore(options.db as any)
      : null;
    this._contextWindow = options.contextWindow ?? 20;
    this._cwd = options.cwd || os.tmpdir();
    this._cmd = resolveOpenCodeCommand();
    if (options.sessionPersistence === 'dispatcher') this.useDispatcherSessionPersistence();
  }

  get priority() { return 5; }
  get capabilities() { return ['http', 'streaming', 'session_resume']; }
  match(_agentId: string, meta?: AgentMeta | null) { return meta?.backend_type === 'opencode'; }
  isAvailable() { return checkCliAvailable(this._cmd); }

  async _ensureServer(): Promise<void> {
    if (this._server && this._server.exitCode === null && this._port && this._password) {
      try {
        const auth = Buffer.from(`opencode:${this._password}`).toString('base64');
        const response = await fetch(`http://127.0.0.1:${this._port}/global/health`, {
          headers: { Authorization: `Basic ${auth}` },
          signal: AbortSignal.timeout(2000),
        });
        if (response.ok) return;
      } catch (_) {}
      this._disposeFailedServer();
    }
    if (this._serverPromise) return this._serverPromise;
    this._serverPromise = (async () => {
      this._port = await findPort(4096);
      this._password = newServerPassword();
      const env = {
        ...process.env,
        ...isolatedOpenCodeEnv(),
        OPENCODE_SERVER_PASSWORD: this._password,
      };
      const child = spawn(this._cmd, [
        'serve', '--hostname', '127.0.0.1', '--port', String(this._port),
      ], {
        cwd: this._cwd,
        env,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams;
      this._server = child;
      child.on('exit', () => {
        this.notifyAvailability({ backendType: 'opencode', mode: 'attach', available: false, reason: 'serve-exit' });
        if (this._server === child) {
          this._server = null;
          this._port = 0;
          this._password = '';
        }
      });
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`OpenCode serve exited with code ${child.exitCode}`);
        try {
          const auth = Buffer.from(`opencode:${this._password}`).toString('base64');
          const response = await fetch(`http://127.0.0.1:${this._port}/global/health`, {
            headers: { Authorization: `Basic ${auth}` },
          });
          if (response.ok) {
            this.notifyAvailability({ backendType: 'opencode', mode: 'attach', available: true, reason: 'serve-ready' });
            return;
          }
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      this._disposeFailedServer();
      const error = new Error('OpenCode serve health check timed out before delivery');
      (error as any).deliveryOutcome = 'not_delivered';
      throw error;
    })().finally(() => { this._serverPromise = null; });
    return this._serverPromise;
  }

  _disposeFailedServer(): void {
    const server = this._server;
    if (server?.pid && server.exitCode === null) killTree(server.pid);
    this._server = null;
    this._port = 0;
    this._password = '';
    this.notifyAvailability({ backendType: 'opencode', mode: 'attach', available: false, reason: 'serve-unhealthy' });
  }

  _loadSession(agentId: string, visitorId: string): string | null {
    if (this._sessionPersistence === 'dispatcher') return null;
    try {
      const row = this._db?.prepare(
        'SELECT session_handle FROM agent_session_handles WHERE agent_id=? AND visitor_id=? AND adapter_type=?',
      ).get(agentId, visitorId, ADAPTER_TYPE) as SessionRow | undefined;
      return row?.session_handle || null;
    } catch { return null; }
  }

  _saveSession(agentId: string, visitorId: string, sessionId: string): void {
    if (!this._db || !sessionId || this._sessionPersistence === 'dispatcher') return;
    this._db.prepare(`
      INSERT OR REPLACE INTO agent_session_handles
        (agent_id, visitor_id, adapter_type, session_handle, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(agentId, visitorId, ADAPTER_TYPE, sessionId, Date.now());
  }

  async _loadLatestReply(sessionId: string): Promise<string> {
    if (!sessionId || !this._port || !this._password) return '';
    const auth = Buffer.from(`opencode:${this._password}`).toString('base64');
    const response = await fetch(
      `http://127.0.0.1:${this._port}/session/${encodeURIComponent(sessionId)}/message`,
      { headers: { Authorization: `Basic ${auth}` } },
    );
    if (!response.ok) throw new Error(`OpenCode session reply lookup failed with HTTP ${response.status}`);
    const messages = await response.json() as OpenCodeMessage[];
    const assistant = [...messages].reverse().find(message => message.info?.role === 'assistant');
    return (assistant?.parts || [])
      .filter(part => part.type === 'text' && typeof part.text === 'string')
      .map(part => part.text)
      .join('')
      .slice(0, MAX_REPLY_CHARS);
  }

  async push(payload: PushPayload): Promise<unknown> {
    try {
      return await this._pushOnce(payload);
    } catch (error) {
      const binding = payload.providerBinding?.providerType === 'opencode' ? payload.providerBinding : null;
      if (this._sessionPersistence === 'dispatcher' || !binding || (payload as any).__vokoManagedRetry) throw error;
      const message = String((error as any)?.message || error || '');
      const outcome = (error as any)?.deliveryOutcome
        || (/timeout|timed out|超时/i.test(message) ? 'outcome_unknown' : 'not_delivered');
      // A timeout or an incomplete response may have reached OpenCode. Do not
      // create a second session and risk sending the visitor's message twice.
      if (outcome !== 'not_delivered') throw error;
      try { this._bindingStore?.markStale(binding.id); } catch (_) {}
      return this._pushOnce({ ...payload, providerBinding: null, __vokoManagedRetry: true });
    }
  }

  async _pushOnce(payload: PushPayload): Promise<unknown> {
    await this._ensureServer();
    const { agentId, fromUid, content, messageId } = payload;
    const turnId = String(payload.turnId || messageId || `opencode-${Date.now()}`);
    const sessionKey = `opencode:${agentId}:${fromUid}`;
    const channelId = payload.providerBinding?.channelId || payload.channelId || fromUid.replace(/^group:/, '');
    const channelType = payload.providerBinding?.channelType || (payload.channelType === 2 ? 2 : 1);
    const activeBinding = (payload as any).__vokoManagedRetry
      ? null
      : payload.providerBinding?.providerType === 'opencode'
      ? payload.providerBinding
      : this._bindingStore?.getByAdapter(agentId, channelId, channelType, ADAPTER_TYPE)
        || this._bindingStore?.importLegacy({
          agentId,
          channelId,
          channelType,
          providerType: 'opencode',
          deliveryMode: 'attach',
          adapterType: ADAPTER_TYPE,
          legacyVisitorId: fromUid,
        });
    const savedSession = activeBinding?.nativeSessionId
      || ((payload as any).__vokoManagedRetry ? null : this._loadSession(agentId, fromUid));
    const deliveryContent = buildConversationDeliveryPrompt(
      this._db, payload, Boolean(savedSession), this._contextWindow,
    );
    const prompt = buildOpenCodeVisitorContent(agentId, fromUid, deliveryContent);
    const args = [
      'run', '--attach', `http://127.0.0.1:${this._port}`, '--format', 'json',
      ...(savedSession ? ['--session', savedSession] : []),
      prompt,
    ];
    let fullContent = '';
    let observedSession = savedSession || '';
    let eventError = '';
    const parser = createParser({
      format: 'opencode-json',
      onText: (chunk: string) => {
        fullContent = (fullContent + chunk).slice(0, MAX_REPLY_CHARS);
      },
    });
    const result = await runCli({
      cmd: this._cmd,
      args,
      cwd: this._cwd,
      timeout: 120000,
      tag: 'OPENCODE ATTACH',
      env: {
        ...isolatedOpenCodeEnv(),
        OPENCODE_SERVER_PASSWORD: this._password,
      },
      logOutput: false,
      onStdoutLine: (line: string) => {
        try {
          const event = JSON.parse(line);
          observedSession = String(event.sessionID || event.sessionId || event.part?.sessionID || observedSession);
          if (event.type === 'error') {
            eventError = String(event.error?.message || event.error || 'OpenCode returned an error event');
          }
        } catch {}
        parser.handleLine(line);
      },
    });
    parser.finish();
    if (result.code !== 0) {
      const error = new Error(`OpenCode attach exited with code ${result.code}`);
      (error as any).deliveryOutcome = 'not_delivered';
      throw error;
    }
    if (observedSession && this._bindingStore) {
      this._bindingStore.saveManaged({
        agentId,
        channelId,
        channelType,
        providerType: 'opencode',
        providerInstanceId: activeBinding?.providerInstanceId || null,
        nativeSessionId: observedSession,
        deliveryMode: 'attach',
        adapterType: ADAPTER_TYPE,
        expectedVersion: activeBinding?.bindingVersion ?? 0,
      });
    }
    if (eventError) {
      const error = new Error(eventError);
      (error as any).deliveryOutcome = 'not_delivered';
      throw error;
    }
    if (!fullContent && observedSession) fullContent = await this._loadLatestReply(observedSession);
    if (!fullContent) throw new Error('OpenCode attach returned no reply');
    this.emit('agent.reply', {
      agentId, visitorId: fromUid, content: fullContent, done: true,
      sessionKey, turnId, replyId: turnId,
    });
    return { nativeSessionId: observedSession || null,
      providerInstanceId: activeBinding?.providerInstanceId || null,
      deliveryMode: 'attach', adapterType: ADAPTER_TYPE };
  }

  useDispatcherSessionPersistence(): void {
    this._sessionPersistence = 'dispatcher';
    this._bindingStore = null;
  }

  async steer(agentId: string, visitorId: string, content: string): Promise<unknown> {
    return this.push({
      agentId, fromUid: visitorId, content,
      messageId: `steer-${Date.now()}`, timestamp: Date.now(),
    });
  }

  async stop(): Promise<void> {
    this.notifyAvailability({ backendType: 'opencode', mode: 'attach', available: false, reason: 'provider-stopped' });
    const server = this._server;
    const port = this._port;
    const password = this._password;
    if (server && port && password && server.exitCode === null) {
      try {
        const auth = Buffer.from(`opencode:${password}`).toString('base64');
        await fetch(`http://127.0.0.1:${port}/global/dispose`, {
          method: 'POST',
          headers: { Authorization: `Basic ${auth}` },
          signal: AbortSignal.timeout(3000),
        });
      } catch (_) {}
      const deadline = Date.now() + 2000;
      while (server.exitCode === null && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    if (server?.pid && server.exitCode === null) killTree(server.pid);
    this._server = null;
    this._port = 0;
    this._password = '';
  }

  async healthCheck() {
    return { ok: Boolean(this._server && this._server.exitCode === null), status: this._server ? 'running' : 'idle' };
  }
}

module.exports = { OpenCodeAttachProvider };
