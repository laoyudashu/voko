/**
 * lite-events.js — 增强事件总线
 *
 * 包装 lite-bus.js（不动本体），提供：
 *   - 事件信封 { eventId, type, entityType, entityId, occurredAt, payload }
 *   - 环形历史缓冲（保留最近 500 条）
 *   - 按类型/实体过滤订阅
 *
 * 事件类型：
 *   agent.status.changed / agent.message / agent.run.log / agent.error
 *   wakeup.coalesced / session.resumed / recovery.created
 */

const bus = require('./lite-bus');
export {};

type EventTypeValue =
  | 'agent.status.changed'
  | 'agent.message'
  | 'agent.run.log'
  | 'agent.error'
  | 'wakeup.coalesced'
  | 'session.resumed'
  | 'recovery.created';

interface EventOptions {
  entityType?: string;
  entityId?: string;
  payload?: unknown;
  occurredAt?: number;
}

interface LiteEvent {
  eventId: string;
  type: string;
  entityType: string;
  entityId: string;
  occurredAt: number;
  payload: unknown;
}

// ── 环形历史缓冲 ─────────────────────────────────────────────────────

const HISTORY_MAX = 500;
const _history: LiteEvent[] = [];

// ── 事件 ID ──────────────────────────────────────────────────────────

let _seq = 0;
function nextId() {
  return `evt_${Date.now()}_${(++_seq).toString(36)}`;
}

// ── 事件类型常量 ─────────────────────────────────────────────────────

const EventType = Object.freeze({
  AGENT_STATUS_CHANGED: 'agent.status.changed',
  AGENT_MESSAGE: 'agent.message',
  AGENT_RUN_LOG: 'agent.run.log',
  AGENT_ERROR: 'agent.error',
  WAKEUP_COALESCED: 'wakeup.coalesced',
  SESSION_RESUMED: 'session.resumed',
  RECOVERY_CREATED: 'recovery.created',
});

// ── 发射封装 ─────────────────────────────────────────────────────────

/**
 * 发射标准事件。
 *
 * @param {string} type   - EventType 常量
 * @param {object} opts
 * @param {string} [opts.entityType='agent']
 * @param {string} [opts.entityId]
 * @param {*}      opts.payload
 * @param {number} [opts.occurredAt]
 */
function emit(type: EventTypeValue | string, opts: EventOptions = {}): LiteEvent {
  const event = {
    eventId: nextId(),
    type,
    entityType: opts.entityType || 'agent',
    entityId: opts.entityId || '',
    occurredAt: opts.occurredAt || Date.now(),
    payload: opts.payload,
  };

  // 入历史缓冲
  _history.push(event);
  if (_history.length > HISTORY_MAX) _history.shift();

  // 通过原始 bus 发射（向后兼容）
  bus.emit(type, event);
  bus.emit(`${type}:${event.entityId}`, event);

  return event;
}

// ── 便捷发射器 ───────────────────────────────────────────────────────

const Events = {
  agentStatus(entityId: string, status: string) {
    return emit(EventType.AGENT_STATUS_CHANGED, { entityId, payload: { status } });
  },
  agentMessage(entityId: string, msg: unknown) {
    return emit(EventType.AGENT_MESSAGE, { entityId, payload: msg });
  },
  agentRunLog(entityId: string, log: unknown) {
    return emit(EventType.AGENT_RUN_LOG, { entityId, payload: log });
  },
  agentError(entityId: string, error: unknown) {
    return emit(EventType.AGENT_ERROR, { entityId, payload: error });
  },
  wakeupCoalesced(entityId: string, info: unknown) {
    return emit(EventType.WAKEUP_COALESCED, { entityId, payload: info });
  },
  sessionResumed(entityId: string, info: unknown) {
    return emit(EventType.SESSION_RESUMED, { entityId, payload: info });
  },
  recoveryCreated(entityId: string, info: unknown) {
    return emit(EventType.RECOVERY_CREATED, { entityId, payload: info });
  },
};

// ── 历史查询 ─────────────────────────────────────────────────────────

function getHistory(type?: string, entityId?: string, limit = 50): LiteEvent[] {
  let filtered = _history;
  if (type) filtered = filtered.filter(e => e.type === type);
  if (entityId) filtered = filtered.filter(e => e.entityId === entityId);
  return filtered.slice(-limit);
}

function clearHistory(): void { _history.length = 0; }

module.exports = { EventType, Events, emit, getHistory, clearHistory, bus };
