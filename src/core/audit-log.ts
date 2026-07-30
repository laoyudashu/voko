/**
 * audit-log.js — 不可变操作审计日志
 *
 * 记录系统内所有 actor（visitor/agent/owner/system）的关键操作，
 * 供控制台 Activity 面板与恢复动作追溯。
 *
 * 用法：
 *   audit('agent.status.changed', { agentId:'a1', actor:'system', detail:'连接断开' });
 */

// ── Actor 类型 ───────────────────────────────────────────────────────

const ActorType = Object.freeze({
  VISITOR: 'visitor',
  AGENT: 'agent',
  OWNER: 'owner',
  SYSTEM: 'system',
});
export {};

type ActorTypeValue = typeof ActorType[keyof typeof ActorType];

interface AuditOptions {
  actor?: ActorTypeValue;
  agentId?: string;
  visitorId?: string;
  detail?: string;
  meta?: Record<string, unknown>;
}

interface AuditEntry {
  id: string;
  timestamp: number;
  action: string;
  actor: ActorTypeValue;
  agentId: string | null;
  visitorId: string | null;
  detail: string;
  meta: Record<string, unknown> | null;
}

interface QueryOptions {
  action?: string;
  actor?: ActorTypeValue;
  agentId?: string;
  limit?: number;
  offset?: number;
}

// ── 环形缓冲 ─────────────────────────────────────────────────────────

const MAX_LOG = 1000;
const _log: AuditEntry[] = [];
let _seq = 0;

// ── 写审计日志 ───────────────────────────────────────────────────────

/**
 * 写入一条审计日志。
 *
 * @param {string} action     - 操作名，如 'agent.status.changed'
 * @param {object} opts
 * @param {string} opts.actor       - ActorType 常量
 * @param {string} [opts.agentId]
 * @param {string} [opts.visitorId]
 * @param {string} [opts.detail]     - 人类可读描述
 * @param {object} [opts.meta]       - 结构化元数据
 * @returns {{ id: string, action, actor, agentId, visitorId, detail, timestamp }}
 */
function audit(action: string, opts: AuditOptions = {}): AuditEntry {
  const entry = {
    id: `audit_${Date.now()}_${(++_seq).toString(36)}`,
    timestamp: Date.now(),
    action,
    actor: opts.actor || ActorType.SYSTEM,
    agentId: opts.agentId || null,
    visitorId: opts.visitorId || null,
    detail: opts.detail || '',
    meta: opts.meta || null,
  };

  _log.push(entry);
  if (_log.length > MAX_LOG) _log.shift();

  return entry;
}

// ── 查询 ─────────────────────────────────────────────────────────────

function query(opts: QueryOptions = {}) {
  const { action, actor, agentId, limit = 100, offset = 0 } = opts;
  let filtered = _log;
  if (action) filtered = filtered.filter(e => e.action === action);
  if (actor) filtered = filtered.filter(e => e.actor === actor);
  if (agentId) filtered = filtered.filter(e => e.agentId === agentId);
  const total = filtered.length;
  return {
    entries: filtered.slice(-limit - offset, -offset || undefined).reverse(),
    total,
    limit,
    offset,
  };
}

function clear() { _log.length = 0; _seq = 0; }

module.exports = { ActorType, audit, query, clear };
