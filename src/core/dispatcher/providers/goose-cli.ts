const crypto = require('crypto');
const { PushProvider } = require('../base-provider');
const { runCli } = require('../../adapters/cli-spawner');
const { resolveGooseCommand, isGooseRuntimeAvailable } = require('../goose-command');
const { ProviderConversationBindingStore } = require('../../provider-conversation-bindings');
const { buildConversationDeliveryPrompt } = require('../conversation-context');
import type { DatabaseLike } from '../../../types/database';
import type { PushPayload, AgentMeta } from '../types';

type RunCli = typeof runCli;

export interface GooseCliOptions {
  binPath?: string;
  db?: Pick<DatabaseLike, 'prepare'> | null;
  contextWindow?: number;
  runCli?: RunCli;
  checkAvailable?: (command: string) => boolean;
}

interface GooseContent { type?: string; text?: string }
interface GooseMessage { role?: string; content?: GooseContent[] }
interface GooseSessionSummary { id?: string; name?: string }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function conversationScope(payload: PushPayload): { channelId: string; channelType: number; key: string; logicalName: string } {
  const channelId = String(payload.providerBinding?.channelId || payload.channelId || payload.fromUid.replace(/^group:/, ''));
  const channelType = Number(payload.providerBinding?.channelType ?? (payload.channelType === 2 ? 2 : 1));
  const digest = crypto.createHash('sha256')
    .update(JSON.stringify([payload.agentId, channelType, channelId]))
    .digest('hex')
    .slice(0, 24);
  return { channelId, channelType, key: `${payload.agentId}:${channelType}:${channelId}`, logicalName: `voko-goose-${digest}` };
}

class GooseCliProvider extends PushProvider {
  private readonly _runCli: RunCli;
  private readonly _checkAvailable: (command: string) => boolean;
  private readonly _queues = new Map<string, Promise<void>>();

  constructor(options: GooseCliOptions = {}) {
    super();
    this._available = null;
    this._binPath = options.binPath || resolveGooseCommand();
    this._db = options.db || null;
    this._bindingStore = options.db && typeof (options.db as any).exec === 'function'
      ? new ProviderConversationBindingStore(options.db as any)
      : null;
    this._contextWindow = options.contextWindow ?? 0;
    this._runCli = options.runCli || runCli;
    this._checkAvailable = options.checkAvailable || (() => isGooseRuntimeAvailable('cli'));
  }

  get priority() { return 1; }
  get sessionMode() { return 'agent-issued-id' as const; }

  match(_agentId: string, meta?: AgentMeta | null): boolean {
    const bt = meta?.backend_type;
    return bt === 'goose' || bt === 'goose-ai' || bt === 'goose-acp' || bt === 'acp-goose';
  }

  acceptsBinding(binding: any): boolean {
    return binding?.providerType === 'goose'
      && !binding.providerInstanceId
      && (binding.adapterType === 'goose-cli' || binding.adapterType === 'goose-acp')
      && typeof binding.nativeSessionId === 'string'
      && binding.nativeSessionId.length > 0;
  }

  isAvailable(_agentId: string): boolean {
    if (this._available !== null) return this._available;
    this._available = this._checkAvailable(this._binPath);
    return this._available;
  }

  push(payload: PushPayload): Promise<void> {
    const scope = conversationScope(payload);
    const previous = this._queues.get(scope.key) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => this._pushScoped(payload, scope));
    this._queues.set(scope.key, current);
    current.finally(() => {
      if (this._queues.get(scope.key) === current) this._queues.delete(scope.key);
    }).catch(() => {});
    return current;
  }

  private async _pushScoped(
    payload: PushPayload,
    scope: { channelId: string; channelType: number; key: string; logicalName: string },
  ): Promise<void> {
    const { agentId, fromUid } = payload;
    const turnId = String(payload.turnId || payload.messageId || `goose-cli-${Date.now()}`);
    let binding = this.acceptsBinding(payload.providerBinding) ? payload.providerBinding : null;
    if (!binding && this._bindingStore) {
      const active = this._bindingStore.getActive(agentId, scope.channelId, scope.channelType);
      if (this.acceptsBinding(active)) binding = active as any;
    }

    let sessionId = binding?.nativeSessionId || null;
    let createName: string | null = null;
    let sessionsBefore: GooseSessionSummary[] = [];
    if (sessionId && /^(?:goose:|voko-goose-)/.test(sessionId)) {
      const legacyName = sessionId;
      const matches = ((await this._safeListSessions()) || []).filter(row => row.name === legacyName && row.id);
      if (matches.length === 1) sessionId = String(matches[0]!.id);
      else {
        if (binding?.id) this._bindingStore?.markStale(binding.id);
        binding = null;
        sessionId = null;
      }
    }

    if (!sessionId) {
      const listed = await this._safeListSessions();
      sessionsBefore = listed || [];
      const matches = (listed || []).filter(row => row.name === scope.logicalName && row.id);
      if (matches.length === 1) sessionId = String(matches[0]!.id);
      else createName = matches.length > 1 || listed === null
        ? `${scope.logicalName}-${crypto.randomBytes(5).toString('hex')}`
        : scope.logicalName;
    }

    const hasSession = !!sessionId;
    const deliveryContent = buildConversationDeliveryPrompt(this._db, payload, hasSession, this._contextWindow);
    const notification = `session: ${scope.logicalName}\n\n${deliveryContent}`;
    let result;
    try {
      result = await this._execute(notification, sessionId, createName);
    } catch (error) {
      this._handleRuntimeFailure(agentId, error);
      throw error;
    }

    if (sessionId && result.code !== 0 && /session[^\r\n]*(?:not found|does not exist)|no session found/i.test(result.stderr || result.stdout)) {
      if (binding?.id) this._bindingStore?.markStale(binding.id);
      binding = null;
      sessionId = null;
      createName = `${scope.logicalName}-${crypto.randomBytes(5).toString('hex')}`;
      sessionsBefore = (await this._safeListSessions()) || [];
      try {
        result = await this._execute(notification, null, createName);
      } catch (error) {
        this._handleRuntimeFailure(agentId, error);
        throw error;
      }
    }

    if (result.code !== 0) throw new Error(`Goose exited with code ${result.code}`);

    if (!sessionId && createName) {
      const beforeIds = new Set(sessionsBefore.map(row => row.id).filter(Boolean));
      const created = ((await this._safeListSessions()) || [])
        .filter(row => row.name === createName && row.id && !beforeIds.has(row.id));
      if (created.length === 1) sessionId = String(created[0]!.id);
    }

    if (sessionId && this._bindingStore) {
      this._bindingStore.saveManaged({
        agentId,
        channelId: scope.channelId,
        channelType: scope.channelType,
        providerType: 'goose',
        providerInstanceId: null,
        nativeSessionId: sessionId,
        deliveryMode: 'cli',
        adapterType: 'goose-cli',
        expectedVersion: binding?.bindingVersion ?? 0,
      });
    }

    const replyText = _extractReply(result.stdout);
    if (replyText) {
      this.emit('agent.reply', {
        agentId, visitorId: fromUid, content: replyText, done: true,
        sessionKey: `goose:${scope.logicalName}`, turnId, replyId: turnId,
      });
      console.error(`[GooseCli] push OK scope=${scope.logicalName.slice(-12)} reply=${replyText.length}chars`);
    } else {
      console.error(`[GooseCli] push OK scope=${scope.logicalName.slice(-12)} no reply text`);
    }
  }

  private _execute(input: string, sessionId: string | null, createName: string | null) {
    const args = ['run', '-i', '-'];
    if (sessionId) args.push('--session-id', sessionId, '--resume');
    else args.push('--name', createName!);
    args.push('--quiet', '--output-format', 'json');
    return this._runCli({
      cmd: this._binPath, args, stdinInput: input, tag: 'goose-cli',
      timeout: 180000, logOutput: false,
    });
  }

  private _handleRuntimeFailure(agentId: string, error: unknown): void {
    const message = errorMessage(error);
    if (!/ENOENT|not found|not recognized/i.test(message)) return;
    this._available = false;
    (error as any).deliveryOutcome = 'not_delivered';
    this.notifyAvailability({ backendType: 'goose', mode: 'cli', agentId, available: false, reason: message });
  }

  private async _safeListSessions(): Promise<GooseSessionSummary[] | null> {
    try {
      const result = await this._runCli({
        cmd: this._binPath,
        args: ['session', 'list', '--format', 'json'],
        tag: 'goose-session-list', timeout: 15000, maxOutputBytes: 32 * 1024 * 1024, logOutput: false,
      });
      if (result.code !== 0) return null;
      const parsed = JSON.parse(result.stdout);
      return Array.isArray(parsed) ? parsed.filter(row => row && typeof row === 'object') : null;
    } catch (_) { return null; }
  }

  async steer(agentId: string, visitorId: string, content: string, metadata?: { turnId?: string }): Promise<void> {
    const messageId = metadata?.turnId || `steer-${Date.now()}`;
    return this.push({ agentId, fromUid: visitorId, content, messageId, turnId: messageId, timestamp: Date.now() });
  }

  start() { this._refreshAvailability(); }
  stop() {
    if (this._available === true) {
      this.notifyAvailability({ backendType: 'goose', mode: 'cli', available: false, reason: 'provider stopped' });
    }
    this._available = false;
  }
  healthCheck() { this._refreshAvailability(); }
  _refreshAvailability() {
    const previous = this._available;
    this._available = this._checkAvailable(this._binPath);
    if (previous !== this._available) {
      this.notifyAvailability({ backendType: 'goose', mode: 'cli', available: this._available, reason: this._available ? 'cli-detected' : 'cli-not-found' });
    }
  }
}

function _extractReply(stdout: string): string | null {
  if (!stdout) return null;
  try {
    const parsed = JSON.parse(stdout) as { messages?: GooseMessage[] };
    const assistants = (parsed.messages || []).filter(message => message.role === 'assistant');
    const last = assistants[assistants.length - 1];
    const texts = last?.content?.filter(content => content.type === 'text')
      .map(content => content.text).filter((text): text is string => Boolean(text)) || [];
    return texts.length ? texts.join('\n').trim() : null;
  } catch (_) { return null; }
}

module.exports = GooseCliProvider;
module.exports.conversationScope = conversationScope;
