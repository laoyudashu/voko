/**
 * recovery-actions.js — 结构化恢复动作
 *
 * 当 agent 无法处理 / 超时 / 访客不满 → 创建恢复动作。
 * watchover 和 token guard 的输出统一走这里。
 *
 * 用法：
 *   const ra = createRecoveryActions(db);
 *   ra.create({ type: 'escalate', actor: 'system', agentId: '...', visitorId: '...', reason: '超时' });
 *   ra.resolve('action-id', 'resolved', 'agent recovered');
 */

const bus = require('../lite-bus');
import type { DatabaseLike } from '../../types/database';

interface RecoveryOptions {
  type?: 'escalate' | 'transfer' | 'wait_owner';
  actor?: 'visitor' | 'agent' | 'system';
  agentId?: string;
  visitorId?: string;
  reason?: string;
  evidence?: string;
  nextAction?: string;
  deadline?: number;
}

/**
 * @param {object} db - better-sqlite3 实例
 */
function createRecoveryActions(db: DatabaseLike) {
  // 确保表存在
  db.exec(`
    CREATE TABLE IF NOT EXISTS recovery_actions (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      actor TEXT NOT NULL,
      agent_id TEXT,
      visitor_id TEXT,
      reason TEXT,
      evidence TEXT,
      next_action TEXT,
      deadline INTEGER,
      status TEXT NOT NULL DEFAULT 'open',
      resolution TEXT,
      resolved_by TEXT,
      resolved_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  /**
   * 创建恢复动作。
   *
   * @param {object} opts
   * @param {'escalate'|'transfer'|'wait_owner'} opts.type
   * @param {'visitor'|'agent'|'system'} opts.actor
   * @param {string} opts.agentId
   * @param {string} [opts.visitorId]
   * @param {string} opts.reason
   * @param {string} [opts.evidence]
   * @param {string} [opts.nextAction]
   * @param {number} [opts.deadline]
   * @returns {{ id: string }}
   */
  function create(opts: RecoveryOptions = {}) {
    const now = Date.now();
    const id = `ra_${now}_${Math.random().toString(36).substr(2, 6)}`;
    db.prepare(`
      INSERT INTO recovery_actions (id, type, actor, agent_id, visitor_id, reason, evidence, next_action, deadline, status, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,'open',?,?)
    `).run(id, opts.type, opts.actor, opts.agentId || null, opts.visitorId || null,
      opts.reason || '', opts.evidence || null, opts.nextAction || null,
      opts.deadline || null, now, now);

    bus.emit('recovery.created', { id, type: opts.type, agentId: opts.agentId, visitorId: opts.visitorId, reason: opts.reason });
    return { id };
  }

  /**
   * 处置恢复动作。
   *
   * @param {string} id
   * @param {'resolved'|'delegated'|'false_positive'|'blocked'} resolution
   * @param {string} [resolvedBy]
   */
  function resolve(id: string, resolution: 'resolved' | 'delegated' | 'false_positive' | 'blocked', resolvedBy?: string): void {
    const now = Date.now();
    db.prepare(`UPDATE recovery_actions SET status='closed', resolution=?, resolved_by=?, resolved_at=?, updated_at=? WHERE id=?`)
      .run(resolution, resolvedBy || null, now, now, id);
  }

  /** 查询未关闭的恢复动作 */
  function listOpen(agentId?: string): unknown[] {
    if (agentId) {
      return db.prepare(`SELECT * FROM recovery_actions WHERE status='open' AND agent_id=? ORDER BY created_at DESC`).all(agentId);
    }
    return db.prepare(`SELECT * FROM recovery_actions WHERE status='open' ORDER BY created_at DESC`).all();
  }

  /** 按 ID 查询 */
  function get(id: string): unknown | null {
    return db.prepare(`SELECT * FROM recovery_actions WHERE id=?`).get(id) || null;
  }

  return { create, resolve, listOpen, get };
}

module.exports = { createRecoveryActions };
