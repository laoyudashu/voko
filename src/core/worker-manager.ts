/**
 * worker-manager.js — Agent Worker 进程管理
 *
 * 管理 WuKongIM 子进程（fork agent-worker.js）的全生命周期：
 * 启动、停止、重启、状态追踪、系统消息发送。
 * 纯 Node.js，无 Electron 依赖。
 */

const { fork } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const EventEmitter = require('events');
const fs = require('fs');
const { req, res, event, normalize, isNewFrame, isOldFrame } = require('./ipc/frame');
const { registerWorker, registerWorkers, unregisterWorker } = require('./process-lifecycle');
const { normalizeOfficialImServerUrl } = require('./url-security');
import type { ChildProcess } from 'child_process';
import type { DatabaseLike } from '../types/database';
import type { InstanceMetadata, WorkerMetadata } from './process-lifecycle';

interface AgentWorkerConfig {
  agentId?: string;
  uid: string;
  token: string;
  serverUrl: string;
  [key: string]: unknown;
}

interface AppPaths {
  isPackaged?: boolean;
  resourcesPath?: string;
  userDataPath?: string;
}

interface WorkerEntry {
  worker: ChildProcess;
  config: AgentWorkerConfig;
  workerToken?: string;
  workerMetadata?: WorkerMetadata | null;
}

interface WorkerEventPayload {
  agentId: string;
  status?: string;
  statusCode?: number;
  data?: unknown;
  [key: string]: unknown;
}

type Deliver = (
  agentId: string,
  visitorId: string,
  content: string,
  messageType: string,
) => Promise<unknown>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class AgentWorkerManager extends EventEmitter {
  [key: string]: any;
  _deliver: Deliver | null;

  /**
   * @param {object} db - better-sqlite3 实例
   * @param {object} [options]
   * @param {object} [options.mainWindow] - Electron BrowserWindow（可选，用于 UI 通知）
   */
  constructor(
    db: Pick<DatabaseLike, 'prepare'> | null,
    options: {
      mainWindow?: unknown;
      dbPath?: string;
      instance?: InstanceMetadata | null;
    } = {},
  ) {
    super();
    this.db = db;
    this.mainWindow = options.mainWindow || null;
    this.dbPath = options.dbPath || null;
    this.instance = options.instance || null;

    // 统一 IM 投递器（由 initCore 注入；未注入时 sendSystemMessage 回退 worker-only）
    this._deliver = null;

    // WuKongIM 多连接管理: agentId → { sdk, config }
    this.wukongimConnections = new Map<string, { sdk: { disconnect(): void }; config: unknown }>();

    // Agent Worker 进程管理: agentId → { worker, config }
    this.workers = new Map<string, WorkerEntry>();

    // Worker 上报的真实 IM 连接状态
    this.connectionStatus = new Map<string, string>();  // agentId → 'connected' | 'disconnected' | 'connecting' | 'kicked'

    // 已连接 agent 追踪
    this.connectedAgents = new Set<string>();
    this.publishedAgentIds = new Set<string>();

    // 主动停止的 agent（Map: agentId → timestamp，防止 auto-restart 重新拉起）
    this._stoppedAgents = new Map<string, number>();

    // 重启退避：agentId → 连续失败次数（连接成功后清零，达上限停止自动重启）
    this._restartAttempts = new Map<string, number>();
    // agentId → 待执行的重启 setTimeout（单一重启路径，避免重复定时器）
    this._restartTimers = new Map<string, NodeJS.Timeout>();

    // 所有 worker 进程引用（包括已从 workers Map 删除的，供 exit 兜底清理）
    this._allWorkers = new Map<string, WorkerEntry>();
    this._pendingRegistry = new Map<string, {
      agentId: string;
      workerPath: string;
      workerToken: string;
      worker: ChildProcess;
    }>();
  }

  /** 断开某个 agent 的 WuKongIM 连接 */
  disconnect(agentId: string): { success: true } {
    const conn = this.wukongimConnections.get(agentId);
    if (conn) {
      conn.sdk.disconnect();
      this.wukongimConnections.delete(agentId);
      console.log(`[${agentId}] WuKongIM 已断开`);
    }
    return { success: true };
  }

  /** 获取某个 agent 的连接状态 */
  getStatus(agentId: string): { connected: boolean; uid: string | null; status?: string } {
    const entry = this.workers.get(agentId);
    if (!entry) return { connected: false, uid: null };
    const status = this.connectionStatus.get(agentId);
    const isConnected = status === 'connected';
    return { connected: isConnected, uid: entry.config.uid, status: status || 'unknown' };
  }

  /** 某个 agent 是否已在运行 */
  isRunning(agentId: string): boolean {
    return this.workers.has(agentId);
  }

  /** 获取 worker 条目 */
  getWorker(agentId: string): WorkerEntry | undefined {
    return this.workers.get(agentId);
  }

  /** 第一个已连接的 agent */
  getFirstAgentId(): string | null {
    const firstEntry = this.workers.values().next().value;
    return firstEntry?.config?.agentId || Array.from(this.workers.keys())[0] || null;
  }

  /**
   * 调度 worker 重启（单一重启路径）
   * - 先查 _stoppedAgents：用户主动停止的 agent 不复活
   * - 清掉该 agent 已有的待执行重启定时器，避免 exit/kicked 双路径给同一 agent 排两个定时器
   * - 指数退避（3s→30s 上限）+ 抖动；连续失败超上限则放弃自动重启
   */
  _scheduleRestart(
    agentId: string,
    config: AgentWorkerConfig,
    appPaths: AppPaths | undefined,
    reason: string,
  ): void {
    const stoppedAt = this._stoppedAgents.get(agentId);
    if (stoppedAt && Date.now() - stoppedAt < 10000) {
      this._stoppedAgents.delete(agentId);
      console.log(`[Agent Worker] ${agentId} 已主动停止，取消重启（${reason}）`);
      return;
    }
    const prev = this._restartTimers.get(agentId);
    if (prev) clearTimeout(prev);

    const attempts = this._restartAttempts.get(agentId) || 0;
    const MAX_ATTEMPTS = 10;
    if (attempts >= MAX_ATTEMPTS) {
      this._restartAttempts.delete(agentId);
      console.error(`[Agent Worker] ${agentId} 连续 ${MAX_ATTEMPTS} 次重启仍退出，停止自动重启（${reason}）`);
      return;
    }
    // 指数退避：3s,6s,12s,... 上限 30s，±20% 抖动
    const base = Math.min(30000, 3000 * Math.pow(2, attempts));
    const delay = Math.floor(base * (0.8 + Math.random() * 0.4));
    this._restartAttempts.set(agentId, attempts + 1);
    console.log(`[Agent Worker] ${agentId} 将在 ${delay}ms 后重启（第 ${attempts + 1}/${MAX_ATTEMPTS} 次，${reason}）`);
    const timer = setTimeout(() => {
      this._restartTimers.delete(agentId);
      // 到期再次确认：可能在此期间被主动停止或已被其他路径启动
      const st = this._stoppedAgents.get(agentId);
      if (st && Date.now() - st < 10000) {
        this._stoppedAgents.delete(agentId);
        console.log(`[Agent Worker] ${agentId} 重启前检测到主动停止，取消`);
        return;
      }
      if (!this.workers.has(agentId)) {
        this.start(agentId, config, appPaths);
      }
    }, delay);
    this._restartTimers.set(agentId, timer);
  }

  /**
   * 启动 Agent Worker 进程
   * @param {string} agentId
   * @param {object} config - { uid, token, serverUrl }
   * @param {object} [appPaths] - { isPackaged, resourcesPath, userDataPath }
   */
  start(
    agentId: string,
    config: AgentWorkerConfig,
    appPaths?: AppPaths,
    deferRegistry = false,
  ): void {
    config = { ...config, serverUrl: normalizeOfficialImServerUrl(config.serverUrl) };
    if (this.workers.has(agentId)) {
      console.log(`[Agent Worker] ${agentId} 已经运行，跳过启动`);
      return;
    }
    // 清除旧停止标记，允许启动
    this._stoppedAgents.delete(agentId);

    const workerPath = appPaths?.isPackaged
      ? path.join(appPaths.resourcesPath, 'app.asar.unpacked', 'src', 'workers', 'agent-worker.js')
      : path.join(__dirname, '..', 'workers', 'agent-worker.js');

    let worker: ChildProcess;
    const workerToken = crypto.randomUUID();
    try {
      const env = { ...process.env };
      worker = fork(workerPath, [
        agentId,
        JSON.stringify(config),
        `--voko-worker-token=${workerToken}`,
        `--voko-instance-id=${this.instance?.instanceId || ''}`,
      ], { env, windowsHide: true });
    } catch (err) {
      console.error(`[Agent Worker] ${agentId} fork 失败:`, errorMessage(err));
      return;
    }
    let workerMetadata = null;
    if (this.dbPath && this.instance) {
      if (deferRegistry) {
        this._pendingRegistry.set(workerToken, {
          agentId,
          workerPath,
          workerToken,
          worker,
        });
      } else {
        workerMetadata = registerWorker(
          this.dbPath,
          this.instance,
          agentId,
          workerPath,
          workerToken,
          worker,
        );
      }
    }
    const workerEntry = { worker, config, workerToken, workerMetadata };
    this.workers.set(agentId, workerEntry);
    this._allWorkers.set(agentId, workerEntry);

    worker.on('message', (_msg: unknown) => {
      this._handleWorkerMessage(_msg, worker);
    });

    worker.on('exit', (code: number | null) => {
      this._pendingRegistry.delete(workerToken);
      const entry = this.workers.get(agentId);
      if (entry && entry.worker === worker) {
        this.workers.delete(agentId);
        this.connectionStatus.delete(agentId);
      }
      const allEntry = this._allWorkers.get(agentId);
      if (allEntry && allEntry.worker === worker) this._allWorkers.delete(agentId);
      if (this.dbPath) unregisterWorker(this.dbPath, workerToken);
      // 统一走 _scheduleRestart：退避 + 上限 + 主动停止检查 + 单一定时器
      this._scheduleRestart(agentId, config, appPaths, `exit(code=${code})`);
    });

    worker.on('error', (err: Error) => {
      console.error(`[Agent Worker] ${agentId} 错误:`, err.message);
    });

  }

  flushWorkerRegistry(): void {
    if (!this.dbPath || !this.instance || this._pendingRegistry.size === 0) return;
    const pending = [...this._pendingRegistry.values()].filter((item) => {
      const entry = this.workers.get(item.agentId);
      return entry?.worker === item.worker;
    });
    this._pendingRegistry.clear();
    const registered = registerWorkers(this.dbPath, this.instance, pending);
    for (const item of pending) {
      const entry = this.workers.get(item.agentId);
      if (entry?.worker === item.worker) {
        entry.workerMetadata = registered.get(item.workerToken) || null;
      }
    }
  }

  _handleWorkerMessage(message: unknown, worker: ChildProcess): void {
    const frame = normalize(message);
    if (!isNewFrame(frame) || frame.type !== 'event') return;
    const payload = (frame.payload || {}) as WorkerEventPayload;

    if (frame.event === 'worker.message') {
      this.emit('message', {
        type: 'message',
        agentId: payload.agentId,
        data: payload.data,
      });
    } else if (frame.event === 'worker.status') {
      this._handleWorkerStatus(
        payload.agentId,
        payload.status,
        payload.statusCode,
        worker,
      );
      this.emit('status', {
        type: 'status',
        agentId: payload.agentId,
        status: payload.status,
        statusCode: payload.statusCode,
      });
    } else if (frame.event === 'worker.sent') {
      this.emit('sent', { type: 'sent', ...payload });
    } else if (frame.event === 'worker.pong') {
      this.emit('pong', { type: 'pong', ...payload });
    }
  }

  _handleWorkerStatus(
    agentId: string,
    status: string | undefined,
    statusCode: number | undefined,
    worker: ChildProcess,
  ): void {
    const normalizedStatus = status || 'unknown';
    this.connectionStatus.set(agentId, normalizedStatus);

    if (normalizedStatus === 'kicked' || statusCode === 4) {
      const currentEntry = this.workers.get(agentId);
      if (!currentEntry || currentEntry.worker !== worker) {
        console.log(`[Agent Worker] ${agentId} 忽略旧 worker 踢回`);
        return;
      }
      const stoppedAt = this._stoppedAgents.get(agentId);
      if (stoppedAt && Date.now() - stoppedAt < 10000) {
        console.log(`[Agent Worker] ${agentId} 已主动停止，忽略 kicked`);
        return;
      }
      console.log(`[Agent Worker] ${agentId} 被踢，停止 worker，由 exit 兜底按退避重启`);
      this.stop(agentId, { userInitiated: false });
      return;
    }

    if (normalizedStatus === 'connected' || statusCode === 2) {
      this.connectedAgents.add(agentId);
      this._restartAttempts.delete(agentId);
      this.emit('agent-connected', agentId);
    }
  }

  /**
   * 停止 Agent Worker 进程
   * @param {string} agentId
   * @param {object} [opts]
   * @param {boolean} [opts.userInitiated=true] - true=用户主动停止（标记 _stoppedAgents 防止 auto-restart）；false=内部恢复（如 kicked 后重启）不标记
   * @returns {Promise<void>}
   */
  stop(agentId: string, { userInitiated = true }: { userInitiated?: boolean } = {}): Promise<void> {
    return new Promise<void>(resolve => {
      const entry = this.workers.get(agentId);
      if (!entry) {
        return resolve();
      }
      this.workers.delete(agentId);
      this.connectionStatus.delete(agentId);
      // 取消该 agent 已排定的重启定时器
      const t = this._restartTimers.get(agentId);
      if (t) { clearTimeout(t); this._restartTimers.delete(agentId); }
      if (userInitiated) this._stoppedAgents.set(agentId, Date.now());

      let resolved = false;
      const timer = setTimeout(() => {
        resolved = true;
        try { entry.worker.kill('SIGKILL'); } catch (_) {}
        console.log(`[Agent Worker] ${agentId} 超时强制终止`);
        resolve();
      }, 3000);

      entry.worker.once('exit', () => {
        if (!resolved) {
          clearTimeout(timer);
          resolve();
        }
      });

      entry.worker.send({ type: 'disconnect' });
    });
  }

  /** 停止所有 worker */
  async stopAll(): Promise<void> {
    const ids = [...this.workers.keys()];
    await Promise.all(ids.map((id: string) => this.stop(id)));
  }

  /** 同步强杀所有 worker（用于进程退出时，不等回调） */
  killAll(): void {
    const ids = [...this._allWorkers.keys()];
    if (ids.length === 0) return;
    // 先标记所有 agent 为主动停止，防止 auto-restart 重新拉起
    for (const id of ids) {
      this._stoppedAgents.set(id, Date.now());
    }
    // 清掉所有待执行的重启定时器
    for (const t of this._restartTimers.values()) clearTimeout(t);
    this._restartTimers.clear();
    for (const id of ids) {
      const entry = this._allWorkers.get(id);
      if (!entry) continue;
      try { entry.worker.send?.({ type: 'disconnect' }); } catch (e) { console.error(`[WorkerManager] killAll ${id} send 失败:`, errorMessage(e)); }
      try { entry.worker.kill('SIGKILL'); } catch (e) { console.error(`[WorkerManager] killAll ${id} kill 失败:`, errorMessage(e)); }
      this.workers.delete(id);
      this._allWorkers.delete(id);
      this.connectionStatus.delete(id);
    }
  }

  /** 注入统一投递器（worker 优先 → wukongIM 直连兜底） */
  setDeliver(fn: Deliver): void { this._deliver = fn; }

  /**
   * 发送系统消息给访客。两种调用模式（向后兼容，调用点可渐进迁移到 i18n）：
   *
   *   i18n 模式（推荐）：sendSystemMessage(agentId, visitorId, sysCode, sysParams, ts)
   *     sysCode 命中 visitor 字典 → 按访客 locale 渲染
   *     （前缀 systemMessagePrefix(locale) + t('visitor.'+sysCode, sysParams)），
   *     落库 sys_code/sys_params。
   *   旧 content 模式：sendSystemMessage(agentId, visitorId, content, ts)
   *     sysCode 未命中字典 → content 原样使用（调用方已拼好含前缀的中文）。
   *
   * 模式判定：第 4 参为对象（或省略）→ i18n 模式；为数字 → 旧 content 模式（第 4 参即 ts）。
   */
  sendSystemMessage(
    agentId: string,
    visitorId: string,
    sysCodeOrContent: string,
    p1?: Record<string, unknown> | number | null,
    p2?: number,
  ): void {
    if (!agentId || !visitorId || !sysCodeOrContent) {
      console.error('[sendSystemMessage] 参数不完整', { agentId, visitorId, sysCodeOrContent });
      return;
    }
    const { t, systemMessagePrefix } = require('./i18n');
    const locale = this._visitorLocale(visitorId);
    // 兼容：新调用 (sysParams对象, ts数字)；旧调用 (ts数字, undefined)
    const isNewMode = (p1 === undefined || p1 === null) || typeof p1 === 'object';
    const sysParams = isNewMode ? (p1 || {}) : {};
    const serverTimestamp = isNewMode ? p2 : p1;

    // 字典查询：先查 'visitor.'+sysCode（短名，如 agent_unpublished），
    // 未命中再查 sysCode 本身（完整 key，如 audit.default.sensitive_keyword）
    let rendered = t('visitor.' + sysCodeOrContent, sysParams, locale);
    let isSysCode = rendered !== ('visitor.' + sysCodeOrContent);
    if (!isSysCode) {
      const r2 = t(sysCodeOrContent, sysParams, locale);
      if (r2 !== sysCodeOrContent) { rendered = r2; isSysCode = true; }
    }

    let content, sysCode = null, sysParamsJson = null;
    if (isSysCode) {
      sysCode = sysCodeOrContent;
      content = systemMessagePrefix(locale) + rendered;
      sysParamsJson = Object.keys(sysParams).length ? JSON.stringify(sysParams) : null;
    } else {
      content = sysCodeOrContent; // 旧 content 模式（已含前缀）
    }

    const agentRow = this.db.prepare(`SELECT imUid FROM agents WHERE agent_id = ?`).get(agentId);
    if (!agentRow) {
      console.error(`[sendSystemMessage] 未找到 agent: ${agentId}`);
      return;
    }
    const fromUid = agentRow.imUid;
    const timestamp = (typeof serverTimestamp === 'number') ? (serverTimestamp + 1) : Math.floor(Date.now() / 1000);
    const msgId = `sys-${agentId}-${visitorId}-${timestamp}-${Math.random().toString(36).substr(2, 4)}`;

    try {
      this.db.prepare(`INSERT INTO messages (id, from_uid, to_uid, content, channel_id, channel_type, agent_id, timestamp, is_me, status, message_seq, client_msg_no, no_persist, red_dot, sync_once, content_type, sys_code, sys_params)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(msgId, fromUid, visitorId, content, visitorId, 1, agentId, timestamp, 2, 'sent', null, null, 0, 0, 0, 1, sysCode, sysParamsJson);
    } catch (e) {
      console.error('[sendSystemMessage] messages 写入失败:', errorMessage(e));
    }

    try {
      const existConv = this.db.prepare(`SELECT user_uid FROM conversations WHERE user_uid = ? AND channel_id = ?`).get(fromUid, visitorId);
      if (existConv) {
        this.db.prepare(`UPDATE conversations SET last_message = ?, last_timestamp = ? WHERE user_uid = ? AND channel_id = ?`)
          .run(content, timestamp, fromUid, visitorId);
      } else {
        this.db.prepare(`INSERT INTO conversations (user_uid, channel_id, channel_type, name, last_message, last_timestamp, unread_count, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(fromUid, visitorId, 1, visitorId, content, timestamp, 0, agentId);
      }
    } catch (e) {
      console.error('[sendSystemMessage] 会话更新失败:', errorMessage(e));
    }

    if (this._deliver) {
      // 统一投递：worker 优先，无则 wukongIM 直连兜底（agent 离线/未发布也能送达）
      this._deliver(agentId, visitorId, content, 'text')
        .catch((e: unknown) => console.error('[sendSystemMessage] 投递失败:', errorMessage(e)));
    } else {
      const workerEntry = this.workers.get(agentId);
      if (workerEntry) {
        workerEntry.worker.send({ type: 'send', channelId: visitorId, content, localMsgId: msgId });
      } else {
        console.error(`[sendSystemMessage] 未找到 agent worker: ${agentId}`);
      }
    }

    this.emit('system-message', { agentId, fromUid, visitorId, content, msgId, timestamp, sysCode, locale });
  }

  /**
   * 访客 locale（P5.4 最小版）：user_cache.locale → 默认 zh。
   * 后续增强：agent.locale（运营者给 agent 设默认语言）作为 user_cache 为空时的回退。
   */
  _visitorLocale(visitorId: string): string {
    try {
      const row = this.db.prepare('SELECT locale FROM user_cache WHERE uid = ?').get(visitorId);
      return (row && row.locale) || 'zh';
    } catch (_) { return 'zh'; }
  }

}

module.exports = { AgentWorkerManager };
