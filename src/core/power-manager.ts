/** Detects system resume by timer drift and restores Agent IM connections safely. */
import type { DatabaseLike } from '../types/database';
import { normalizeOfficialImServerUrl } from './url-security';

const net = require('node:net');

interface AgentConfigRow {
  agent_id: string;
  imUid: string;
  imToken: string;
  im_server_url: string;
}

interface StartEntry {
  agentId: string;
  config: { uid: string; token: string; serverUrl: string };
}

interface StartResult {
  agentId: string;
  connected: boolean;
  error?: string;
}

interface AgentManagerLike {
  workers: Map<string, unknown>;
  stop(agentId: string): Promise<unknown> | unknown;
  start(agentId: string, config: StartEntry['config']): Promise<{ connected?: boolean; error?: string }> | { connected?: boolean; error?: string };
  startMany?(entries: StartEntry[], options?: { concurrency?: number; staggerMs?: number }): Promise<StartResult[]>;
  getStatus?(agentId: string): { connected?: boolean };
}

interface PowerManagerOptions {
  checkInterval?: number;
  driftThreshold?: number;
  recoveryAttempts?: number;
  recoveryBackoffMs?: number;
  recoveryConcurrency?: number;
  recoveryStaggerMs?: number;
  networkProbeAttempts?: number;
  networkProbeDelayMs?: number;
  failedRetryDelayMs?: number;
  networkProbe?: (serverUrl: string) => Promise<boolean>;
  delay?: (ms: number) => Promise<void>;
}

interface RuntimeRow { data?: string | null }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class PowerManager {
  agentManager: AgentManagerLike;
  db: DatabaseLike;
  checkInterval: number;
  driftThreshold: number;
  recoveryAttempts: number;
  recoveryBackoffMs: number;
  recoveryConcurrency: number;
  recoveryStaggerMs: number;
  networkProbeAttempts: number;
  networkProbeDelayMs: number;
  failedRetryDelayMs: number;
  networkProbe: (serverUrl: string) => Promise<boolean>;
  delay: (ms: number) => Promise<void>;
  _timer: NodeJS.Timeout | null;
  _lastTs: number;
  _recoveryPromise: Promise<void> | null;
  _failedRetryTimer: NodeJS.Timeout | null;

  constructor(agentManager: AgentManagerLike, db: DatabaseLike, options: PowerManagerOptions = {}) {
    this.agentManager = agentManager;
    this.db = db;
    this.checkInterval = options.checkInterval || 5000;
    this.driftThreshold = options.driftThreshold || 120000;
    this.recoveryAttempts = Math.max(1, options.recoveryAttempts || 3);
    this.recoveryBackoffMs = Math.max(0, options.recoveryBackoffMs ?? 1000);
    this.recoveryConcurrency = Math.max(1, options.recoveryConcurrency || 2);
    this.recoveryStaggerMs = Math.max(0, options.recoveryStaggerMs ?? 250);
    this.networkProbeAttempts = Math.max(1, options.networkProbeAttempts || 5);
    this.networkProbeDelayMs = Math.max(0, options.networkProbeDelayMs ?? 1000);
    this.failedRetryDelayMs = Math.max(0, options.failedRetryDelayMs ?? 30000);
    this.networkProbe = options.networkProbe || probeServerEndpoint;
    this.delay = options.delay || ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
    this._timer = null;
    this._lastTs = Date.now();
    this._recoveryPromise = null;
    this._failedRetryTimer = null;
  }

  start(): void {
    if (this._timer) return;
    this._lastTs = Date.now();
    this._timer = setInterval(() => this._check(), this.checkInterval);
    this._timer.unref();
  }

  stop(): void {
    if (this._timer) clearInterval(this._timer);
    if (this._failedRetryTimer) clearTimeout(this._failedRetryTimer);
    this._timer = null;
    this._failedRetryTimer = null;
  }

  _check(): void {
    const now = Date.now();
    const elapsed = now - this._lastTs;
    this._lastTs = now;
    if (elapsed <= this.driftThreshold) return;
    console.error(`[PowerManager] 检测到系统唤醒（间隔 ${Math.round(elapsed / 1000)}s），正在恢复连接...`);
    void this._recover().catch((error: unknown) => {
      console.error('[PowerManager] 恢复失败:', errorMessage(error));
    });
  }

  async _recover(): Promise<void> {
    if (this._recoveryPromise) {
      console.error('[PowerManager] 恢复任务已在执行，跳过重复触发');
      return this._recoveryPromise;
    }
    this._recoveryPromise = this._recoverOnce().finally(() => { this._recoveryPromise = null; });
    return this._recoveryPromise;
  }

  async _recoverOnce(): Promise<void> {
    if (this._failedRetryTimer) clearTimeout(this._failedRetryTimer);
    this._failedRetryTimer = null;
    for (const agentId of [...this.agentManager.workers.keys()]) {
      try { await this.agentManager.stop(agentId); } catch (_) {}
    }

    const runtimeRow = this.db.prepare("SELECT data FROM config WHERE type='runtime'").get<RuntimeRow>();
    let userEmail: string | null = null;
    try { userEmail = JSON.parse(runtimeRow?.data || '{}').userEmail || null; } catch (_) {}
    const published = userEmail
      ? this.db.prepare("SELECT * FROM agents WHERE publish_status = 'published' AND owner_email = ?").all<AgentConfigRow>(userEmail)
      : this.db.prepare("SELECT * FROM agents WHERE publish_status = 'published'").all<AgentConfigRow>();
    const entries: StartEntry[] = [];
    for (const agent of published) {
      if (!agent.agent_id || !agent.imUid || !agent.imToken || !agent.im_server_url) continue;
      try {
        entries.push({
          agentId: agent.agent_id,
          config: {
            uid: agent.imUid,
            token: agent.imToken,
            serverUrl: normalizeOfficialImServerUrl(agent.im_server_url),
          },
        });
      } catch (error) {
        console.error(`[PowerManager] 跳过无效 IM 地址 agent=${agent.agent_id}: ${errorMessage(error)}`);
      }
    }

    if (entries.length === 0) {
      console.error('[PowerManager] 系统唤醒恢复完成，没有可重启的 Agent IM 连接');
      return;
    }

    const endpoints = [...new Set(entries.map(entry => entry.config.serverUrl))];
    let networkReady = false;
    for (let attempt = 1; attempt <= this.networkProbeAttempts; attempt += 1) {
      const checks = await Promise.all(endpoints.map(endpoint => this.networkProbe(endpoint).catch(() => false)));
      networkReady = checks.every(Boolean);
      if (networkReady) break;
      if (attempt < this.networkProbeAttempts) await this.delay(this.networkProbeDelayMs);
    }
    if (!networkReady) console.error('[PowerManager] IM 服务端口尚未全部就绪，继续进入受控重试');

    const pending = await this._restoreEntries(entries);
    const connected = entries.length - pending.length;
    if (pending.length === 0) {
      console.error(`[PowerManager] ✅ 系统唤醒恢复成功，IM 已重新连接 ${connected}/${entries.length}`);
    } else {
      console.error(`[PowerManager] ⚠️ 系统唤醒恢复完成，IM 已连接 ${connected}/${entries.length}，失败 ${pending.length}`);
    }
    if (pending.length) this._scheduleFailedRetry(pending);
  }

  async _restoreEntries(entries: StartEntry[]): Promise<StartEntry[]> {
    let pending = entries;
    for (let attempt = 1; attempt <= this.recoveryAttempts && pending.length > 0; attempt += 1) {
      let results: StartResult[];
      try { results = await this._startMany(pending); }
      catch (error) {
        console.error(`[PowerManager] 第 ${attempt} 轮恢复启动异常: ${errorMessage(error)}`);
        results = [];
      }
      const resultByAgent = new Map(results.map(result => [result.agentId, result]));
      pending = pending.filter(entry => resultByAgent.get(entry.agentId)?.connected !== true);
      if (pending.length > 0 && attempt < this.recoveryAttempts) {
        const retryDelay = this.recoveryBackoffMs * (2 ** (attempt - 1));
        console.error(`[PowerManager] 第 ${attempt} 轮恢复后仍有 ${pending.length} 个 IM 未连接，${retryDelay}ms 后重试`);
        await this.delay(retryDelay);
      }
    }

    return pending;
  }

  _scheduleFailedRetry(entries: StartEntry[]): void {
    if (!this._timer || this._failedRetryTimer) return;
    this._failedRetryTimer = setTimeout(() => {
      this._failedRetryTimer = null;
      const pending = entries.filter(entry => !this.agentManager.getStatus?.(entry.agentId)?.connected);
      if (!pending.length) return;
      console.error(`[PowerManager] 后台重试 ${pending.length} 个仍断开的 Agent IM`);
      void this._restoreEntries(pending).then(stillPending => {
        if (stillPending.length) this._scheduleFailedRetry(stillPending);
        else console.error('[PowerManager] ✅ 后台恢复成功，所有 Agent IM 已连接');
      }).catch(error => {
        console.error('[PowerManager] 后台恢复异常:', errorMessage(error));
        this._scheduleFailedRetry(pending);
      });
    }, this.failedRetryDelayMs);
    this._failedRetryTimer.unref();
  }

  async _startMany(entries: StartEntry[]): Promise<StartResult[]> {
    if (this.agentManager.startMany) {
      return this.agentManager.startMany(entries, {
        concurrency: this.recoveryConcurrency,
        staggerMs: this.recoveryStaggerMs,
      });
    }
    const results: StartResult[] = [];
    for (const entry of entries) {
      const status = await this.agentManager.start(entry.agentId, entry.config);
      results.push({ agentId: entry.agentId, connected: !!status?.connected, ...(status?.error ? { error: status.error } : {}) });
    }
    return results;
  }
}

function probeServerEndpoint(serverUrl: string): Promise<boolean> {
  return new Promise(resolve => {
    let target: URL;
    try { target = new URL(serverUrl); } catch (_) { resolve(false); return; }
    const port = Number(target.port || (target.protocol === 'wss:' ? 443 : 80));
    const socket = net.createConnection({ host: target.hostname, port });
    let settled = false;
    const finish = (available: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(available);
    };
    socket.setTimeout(3000);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

module.exports = { PowerManager, probeServerEndpoint };
