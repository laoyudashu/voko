/**
 * power-manager.js — 系统休眠唤醒检测
 *
 * 利用 Node.js 定时器在系统休眠时暂停、唤醒后集中触发的特性，
 * 通过检测定时器间隔偏差判断系统是否从休眠中恢复。
 *
 * 检测到唤醒后执行恢复逻辑（停旧 worker → 重启已发布 agent）
 * 等效于原 Desktop 中 powerMonitor.on('resume') 的行为。
 */

import type { DatabaseLike } from '../types/database';

interface AgentConfigRow {
  agent_id: string;
  imUid: string;
  imToken: string;
  im_server_url: string;
}

interface AgentManagerLike {
  workers: Map<string, unknown>;
  stop(agentId: string): Promise<unknown> | unknown;
  start(agentId: string, config: { uid: string; token: string; serverUrl: string }): unknown;
}

interface PowerManagerOptions {
  checkInterval?: number;
  driftThreshold?: number;
}

interface RuntimeRow {
  data?: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class PowerManager {
  agentManager: AgentManagerLike;
  db: DatabaseLike;
  checkInterval: number;
  driftThreshold: number;
  _timer: NodeJS.Timeout | null;
  _lastTs: number;

  /**
   * @param {object} agentManager - AgentWorkerManager 实例
   * @param {object} db - better-sqlite3 实例
   * @param {object} [options]
   * @param {number} [options.checkInterval=5000] - 检测间隔（毫秒）
   * @param {number} [options.driftThreshold=120000] - 超过此间隔视为休眠唤醒（毫秒）
   */
  constructor(agentManager: AgentManagerLike, db: DatabaseLike, options: PowerManagerOptions = {}) {
    this.agentManager = agentManager;
    this.db = db;
    this.checkInterval = options.checkInterval || 5000;
    this.driftThreshold = options.driftThreshold || 120000;
    this._timer = null;
    this._lastTs = Date.now();
  }

  /** 启动检测 */
  start() {
    if (this._timer) return;
    this._lastTs = Date.now();
    this._timer = setInterval(() => this._check(), this.checkInterval);
    this._timer.unref();
    console.error('[PowerManager] 休眠唤醒检测已启动（间隔 ' + (this.checkInterval / 1000) + 's）');
  }

  /** 停止检测 */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /** 每次检测：判断时间偏差 */
  _check() {
    const now = Date.now();
    const elapsed = now - this._lastTs;
    this._lastTs = now;

    if (elapsed > this.driftThreshold) {
      console.error('[PowerManager] 检测到系统唤醒（间隔 ' + Math.round(elapsed / 1000) + 's），正在恢复连接...');
      this._recover().catch((err: unknown) => {
        console.error('[PowerManager] 恢复失败:', errorMessage(err));
      });
    }
  }

  /** 恢复逻辑：停旧 worker → 读已发布 agent → 全部重启 */
  async _recover(): Promise<void> {
    // 1. 停掉所有旧 worker
    const agentIds = [...this.agentManager.workers.keys()];
    for (const id of agentIds) {
      try { await this.agentManager.stop(id); } catch (_) {}
    }

    // 2. 从 DB 读取已发布 agent（按当前 owner_email 过滤，与启动期一致；无当前用户则全量）
    const runtimeRow = this.db.prepare("SELECT data FROM config WHERE type='runtime'").get<RuntimeRow>();
    let userEmail: string | null = null;
    try { userEmail = JSON.parse(runtimeRow?.data || '{}').userEmail || null; } catch (_) {}
    const published = userEmail
      ? this.db.prepare("SELECT * FROM agents WHERE publish_status = 'published' AND owner_email = ?").all<AgentConfigRow>(userEmail)
      : this.db.prepare("SELECT * FROM agents WHERE publish_status = 'published'").all<AgentConfigRow>();

    // 3. 逐个启动 worker
    for (const agent of published) {
      const config = { uid: agent.imUid, token: agent.imToken, serverUrl: agent.im_server_url };
      this.agentManager.start(agent.agent_id, config);
    }

    console.error('[PowerManager] 系统唤醒恢复完成，已重启 ' + published.length + ' 个 worker');
  }
}

module.exports = { PowerManager };
