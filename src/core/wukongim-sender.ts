const path = require('path');
const crypto = require('crypto');
const { fork } = require('child_process');
const { registerWorker, unregisterWorker } = require('./process-lifecycle');
const { normalizeOfficialImServerUrl } = require('./url-security');

import type { ChildProcess } from 'child_process';
import type { InstanceMetadata } from './process-lifecycle';

type SenderResult = {
  success: boolean;
  messageId?: string;
  clientMsgNo?: string | null;
  messageSeq?: number | null;
  error?: string;
};

type SenderConfig = {
  uid: string;
  token: string;
  serverUrl: string;
};

type PendingRequest = {
  timer: NodeJS.Timeout;
  resolve: (result: SenderResult) => void;
};

type SenderEntry = {
  agentId: string;
  configKey: string;
  child: ChildProcess;
  token: string;
  pending: Map<string, PendingRequest>;
  ready: Promise<void>;
  resolveReady: () => void;
  rejectReady: (error: Error) => void;
  closing: boolean;
  exited: Promise<void>;
  resolveExited: () => void;
};

type SenderOptions = {
  dbPath?: string;
  instance?: InstanceMetadata | null;
  workerPath?: string;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  forkProcess?: typeof fork;
  registerChild?: typeof registerWorker;
  unregisterChild?: typeof unregisterWorker;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createWukongimSender(db: any, options: SenderOptions = {}) {
  const entries = new Map<string, SenderEntry>();
  const starts = new Map<string, Promise<SenderEntry>>();
  const workerPath = options.workerPath
    || path.join(__dirname, '..', 'workers', 'wukongim-sender-worker.js');
  const requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 3_000;
  const forkProcess = options.forkProcess || fork;
  const registerChild = options.registerChild || registerWorker;
  const unregisterChild = options.unregisterChild || unregisterWorker;

  function getAgentConfig(agentId: string): SenderConfig | null {
    const agent = db.prepare(`
      SELECT imUid, imToken, im_server_url
      FROM agents WHERE agent_id = ?
    `).get(agentId);
    if (!agent?.imUid || !agent?.imToken || !agent?.im_server_url) {
      return null;
    }
    let serverUrl;
    try { serverUrl = normalizeOfficialImServerUrl(agent.im_server_url); }
    catch (_) { return null; }
    return {
      uid: agent.imUid,
      token: agent.imToken,
      serverUrl,
    };
  }

  function configKey(config: SenderConfig): string {
    return crypto
      .createHash('sha256')
      .update(`${config.uid}\0${config.token}\0${config.serverUrl}`)
      .digest('hex');
  }

  function settlePending(entry: SenderEntry, result: SenderResult) {
    for (const pending of entry.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve(result);
    }
    entry.pending.clear();
  }

  function unregister(entry: SenderEntry) {
    if (!options.dbPath) return;
    try {
      unregisterChild(options.dbPath, entry.token);
    } catch (error) {
      console.warn(`[WukongIMSender] sender registry cleanup failed: ${errorMessage(error)}`);
    }
  }

  function attachEntryHandlers(entry: SenderEntry) {
    let finalized = false;
    const finalize = (code: number | null, signal: NodeJS.Signals | null) => {
      if (finalized) return;
      finalized = true;
      const current = entries.get(entry.agentId);
      if (current === entry) entries.delete(entry.agentId);
      const detail = signal ? `signal ${signal}` : `code ${code}`;
      entry.rejectReady(new Error(`WuKongIM sender exited with ${detail}`));
      settlePending(entry, {
        success: false,
        error: `WuKongIM sender exited with ${detail}`,
      });
      unregister(entry);
      entry.resolveExited();
    };

    entry.child.on('message', (message: any) => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'ready') {
        if (message.success) entry.resolveReady();
        else entry.rejectReady(new Error(message.error || 'Sender initialization failed'));
        return;
      }
      if (message.type !== 'result' || !message.requestId) return;
      const pending = entry.pending.get(message.requestId);
      if (!pending) return;
      entry.pending.delete(message.requestId);
      clearTimeout(pending.timer);
      pending.resolve(message.result);
    });

    entry.child.once('error', (error: Error) => {
      entry.rejectReady(error);
      settlePending(entry, { success: false, error: error.message });
    });
    entry.child.once('exit', finalize);
    entry.child.once('close', finalize);
  }

  function createEntry(agentId: string, config: SenderConfig): SenderEntry {
    const token = crypto.randomUUID();
    const child = forkProcess(
      workerPath,
      [
        `--voko-worker-token=${token}`,
        `--voko-instance-id=${options.instance?.instanceId || 'standalone'}`,
      ],
      { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] },
    );
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    let resolveExited!: () => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const exited = new Promise<void>((resolve) => {
      resolveExited = resolve;
    });
    const entry: SenderEntry = {
      agentId,
      configKey: configKey(config),
      child,
      token,
      pending: new Map(),
      ready,
      resolveReady,
      rejectReady,
      closing: false,
      exited,
      resolveExited,
    };
    entries.set(agentId, entry);
    attachEntryHandlers(entry);

    if (options.dbPath && options.instance) {
      try {
        registerChild(
          options.dbPath,
          options.instance,
          agentId,
          workerPath,
          token,
          child,
        );
      } catch (error) {
        console.warn(`[WukongIMSender] sender registry write failed: ${errorMessage(error)}`);
      }
    }
    child.send?.({ type: 'init', agentId, config });
    return entry;
  }

  async function closeEntry(entry: SenderEntry): Promise<void> {
    if (entry.closing) return entry.exited;
    entry.closing = true;
    const current = entries.get(entry.agentId);
    if (current === entry) entries.delete(entry.agentId);
    try {
      entry.child.send?.({ type: 'shutdown' });
    } catch {
      // The exit handler will settle pending requests.
    }

    const timedOut = await Promise.race([
      entry.exited.then(() => false),
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(true), shutdownTimeoutMs);
        timer.unref?.();
      }),
    ]);
    if (timedOut && entry.child.exitCode === null && entry.child.signalCode === null) {
      entry.child.kill('SIGKILL');
      const killed = await Promise.race([
        entry.exited.then(() => true),
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), shutdownTimeoutMs);
          timer.unref?.();
        }),
      ]);
      if (!killed) throw new Error(`WuKongIM sender ${entry.child.pid} did not exit`);
    }
  }

  async function getEntry(agentId: string, config: SenderConfig): Promise<SenderEntry> {
    const key = configKey(config);
    const existing = entries.get(agentId);
    if (existing && !existing.closing && existing.configKey === key) return existing;
    if (existing) await closeEntry(existing);

    const starting = starts.get(agentId);
    if (starting) {
      const entry = await starting;
      if (!entry.closing && entry.configKey === key) return entry;
      await closeEntry(entry);
    }

    const start = Promise.resolve().then(() => createEntry(agentId, config));
    starts.set(agentId, start);
    try {
      return await start;
    } finally {
      if (starts.get(agentId) === start) starts.delete(agentId);
    }
  }

  async function send(
    agentId: string,
    channelId: string,
    content: string,
    messageType = 'text',
    channelType = 1,
    mentions: { all?: boolean; uids?: string[] } | null = null,
  ): Promise<SenderResult> {
    const config = getAgentConfig(agentId);
    if (!config) {
      return { success: false, error: '无法连接 wukongIM，请检查 Agent 配置' };
    }

    try {
      const entry = await getEntry(agentId, config);
      await entry.ready;
      if (entry.closing) return { success: false, error: 'WuKongIM sender is closing' };
      const requestId = crypto.randomUUID();
      return await new Promise<SenderResult>((resolve) => {
        const timer = setTimeout(() => {
          entry.pending.delete(requestId);
          resolve({ success: false, error: 'WuKongIM sender request timeout' });
        }, requestTimeoutMs);
        timer.unref?.();
        entry.pending.set(requestId, { timer, resolve });
        try {
          entry.child.send?.({
            type: 'send',
            requestId,
            agentId,
            uid: config.uid,
            channelId,
            content,
            messageType,
            channelType,
            mentions,
          });
        } catch (error) {
          entry.pending.delete(requestId);
          clearTimeout(timer);
          resolve({ success: false, error: errorMessage(error) });
        }
      });
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  }

  function disconnect(agentId: string): { success: true } {
    const entry = entries.get(agentId);
    if (entry) void closeEntry(entry);
    return { success: true };
  }

  async function disconnectAll(): Promise<void> {
    await Promise.all([...entries.values()].map(closeEntry));
  }

  return { send, disconnect, disconnectAll };
}

module.exports = { createWukongimSender };
