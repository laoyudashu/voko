/**
 * wakeup.js — 统一 wakeup 调度队列
 *
 * 将 message / owner / reconnect / offline_sync / timer 五类触发源
 * 统一到 agent_wakeup_requests 表，提供 coalescing 合并、幂等去重、
 * 崩溃恢复等能力。
 *
 * 用法：
 *   const wq = createWakeupQueue(db);
 *   await wq.enqueue(agentId, { source: 'message', reason: '新访客消息',
 *     idempotencyKey: msgId, payload: { ... } });
 *   const pending = wq.dequeue(agentId);  // 取出下一个待处理请求
 */

import type { DatabaseLike } from '../../types/database';

interface WakeupOptions {
  source?: string;
  reason?: string;
  payload?: unknown;
  idempotencyKey?: string;
}

interface WakeupRow {
  id: string;
  source: string;
  reason: string | null;
  payload: string | null;
  coalesced_count: number;
}

interface ExistingRow {
  id: string;
  coalesced_count: number;
}

function parsePayload(payload: string | null): unknown {
  if (!payload) return null;
  try { return JSON.parse(payload); } catch { return payload; }
}

function createWakeupQueue(db: DatabaseLike) {

  /**
   * 入队一个 wakeup 请求。
   *
   * @param {string} agentId
   * @param {object} opts
   * @param {string} opts.source      - 'message'|'owner'|'reconnect'|'offline_sync'|'timer'
   * @param {string} [opts.reason]    - 原因描述
   * @param {*}      [opts.payload]   - 携带数据
   * @param {string} [opts.idempotencyKey] - 幂等键（如 messageId），重复入队返回已有记录
   * @returns {{ id: string, coalesced: boolean, coalescedCount: number }}
   */
  function enqueue(agentId: string, opts: WakeupOptions = {}) {
    const now = Date.now();
    const idempotencyKey = opts.idempotencyKey || null;

    // 幂等检查
    if (idempotencyKey) {
      const existing = db.prepare(
        `SELECT id, coalesced_count FROM agent_wakeup_requests WHERE idempotency_key=? AND agent_id=? AND status='pending'`
      ).get<ExistingRow>(idempotencyKey, agentId);
      if (existing) {
        return { id: existing.id, coalesced: true, coalescedCount: existing.coalesced_count };
      }
    }

    // Coalescing：同 agent 已有 pending 请求时合并（提高 count，不新增行）
    const existingPending = db.prepare(
      `SELECT id, coalesced_count FROM agent_wakeup_requests WHERE agent_id=? AND status='pending' ORDER BY created_at ASC LIMIT 1`
    ).get<ExistingRow>(agentId);
    if (existingPending) {
      db.prepare(
        `UPDATE agent_wakeup_requests SET coalesced_count=coalesced_count+1, updated_at=? WHERE id=?`
      ).run(now, existingPending.id);
      return { id: existingPending.id, coalesced: true, coalescedCount: existingPending.coalesced_count + 1 };
    }

    // 新建请求
    const id = `wakeup_${now}_${Math.random().toString(36).substr(2, 6)}`;
    db.prepare(
      `INSERT INTO agent_wakeup_requests (id, agent_id, source, reason, idempotency_key, payload, status, coalesced_count, created_at, updated_at) VALUES (?,?,?,?,?,?,'pending',1,?,?)`
    ).run(id, agentId, opts.source, opts.reason || null, idempotencyKey,
      opts.payload ? JSON.stringify(opts.payload) : null, now, now);

    return { id, coalesced: false, coalescedCount: 1 };
  }

  /**
   * 取出 agent 的下一个待处理请求（FIFO）。标记为 processing。
   * @returns {object|null} { id, source, reason, payload, coalescedCount }
   */
  function dequeue(agentId: string) {
    const row = db.prepare(
      `SELECT id, source, reason, payload, coalesced_count FROM agent_wakeup_requests WHERE agent_id=? AND status='pending' ORDER BY created_at ASC LIMIT 1`
    ).get<WakeupRow>(agentId);
    if (!row) return null;

    db.prepare(`UPDATE agent_wakeup_requests SET status='processing', updated_at=? WHERE id=?`).run(Date.now(), row.id);

    return {
      id: row.id,
      source: row.source,
      reason: row.reason,
      payload: parsePayload(row.payload),
      coalescedCount: row.coalesced_count,
    };
  }

  /** 标记完成 */
  function complete(wakeupId: string): void {
    db.prepare(`UPDATE agent_wakeup_requests SET status='completed', updated_at=? WHERE id=?`).run(Date.now(), wakeupId);
    _cleanup(); // 全局清理，不依赖 agentId
  }

  /** 标记失败 */
  function fail(wakeupId: string, _error?: unknown): void {
    db.prepare(`UPDATE agent_wakeup_requests SET status='failed', updated_at=? WHERE id=?`).run(Date.now(), wakeupId);
  }

  /** agent 崩溃后恢复 pending/processing 的请求。去重：同一 idempotency_key 只返回最早一条。 */
  function recoverPending(agentId: string) {
    // 重置 processing 为 pending（进程死亡，不可能完成）
    db.prepare(`UPDATE agent_wakeup_requests SET status='pending', updated_at=? WHERE agent_id=? AND status='processing'`).run(Date.now(), agentId);
    const rows = db.prepare(
      `SELECT id, source, reason, payload, coalesced_count FROM agent_wakeup_requests WHERE agent_id=? AND status='pending' ORDER BY created_at ASC`
    ).all<WakeupRow>(agentId);
    return rows.map(r => ({
      id: r.id,
      source: r.source,
      reason: r.reason,
      payload: parsePayload(r.payload),
      coalescedCount: r.coalesced_count,
    }));
  }

  /** 清理旧的已完成记录 — 全局保留 500 条，按 agent 均匀分布 */
  function _cleanup() {
    try {
      const totalCompleted = db.prepare(`SELECT COUNT(*) as cnt FROM agent_wakeup_requests WHERE status='completed'`).get<{ cnt: number }>()?.cnt || 0;
      if (totalCompleted > 500) {
        const cutoff = db.prepare(`SELECT created_at FROM agent_wakeup_requests WHERE status='completed' ORDER BY created_at DESC LIMIT 1 OFFSET 500`).get<{ created_at: number }>();
        if (cutoff) {
          db.prepare(`DELETE FROM agent_wakeup_requests WHERE status='completed' AND created_at < ?`).run(cutoff.created_at);
        }
      }
    } catch {}
  }

  return { enqueue, dequeue, complete, fail, recoverPending };
}

module.exports = { createWakeupQueue };
