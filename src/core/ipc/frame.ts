/**
 * frame.js — IPC 信封标准化
 *
 * 借鉴 openclaw-gateway req/res/event 信封，统一 worker↔main 通信。
 * 双格式并存渐进迁移：新代码发新帧，旧代码收旧帧，frame 层自动兼容。
 *
 * 新帧格式：
 *   req  = { type:'req',  id, method, params, ts }
 *   res  = { type:'res',  id, ok, payload, error, ts }
 *   event= { type:'event', event, payload, seq, ts }
 *
 * 旧帧格式（直接 type 字符串）：
 *   { type:'status', agentId, ... }
 *   { type:'message', agentId, data }
 *   { type:'sent', agentId, ... }
 *   { type:'pong', agentId, ... }
 *   { type:'send', channelId, ... }
 *   { type:'disconnect' }
 */

const crypto = require('crypto');
export {};

type AnyRecord = Record<string, any>;

interface RequestFrame {
  type: 'req';
  id: string;
  method: string;
  params: unknown;
  ts: number;
}

interface ResponseFrame {
  type: 'res';
  id: string;
  ok: boolean;
  payload: unknown;
  error: unknown;
  ts: number;
}

interface EventFrame {
  type: 'event';
  event: string;
  payload: unknown;
  seq: number;
  ts: number;
}

type IpcFrame = RequestFrame | ResponseFrame | EventFrame;

// ── 帧类型常量 ───────────────────────────────────────────────────────

const FrameType = Object.freeze({
  REQ: 'req',
  RES: 'res',
  EVENT: 'event',
});

// ── 旧帧类型集合（用于向前兼容判定） ─────────────────────────────────

const OLD_FRAME_TYPES = new Set([
  'status', 'message', 'sent', 'pong', 'ping', 'send', 'disconnect',
]);

// ── 新帧创建工厂 ─────────────────────────────────────────────────────

let _seq = 0;
function nextSeq() { return ++_seq; }

function makeId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
}

/** 创建请求帧 */
function req(method: string, params?: unknown, id?: string): RequestFrame {
  return { type: FrameType.REQ, id: id || makeId(), method, params, ts: Date.now() };
}

/** 创建响应帧 */
function res(reqFrame: Pick<RequestFrame, 'id'>, ok: boolean, payload?: unknown, error?: unknown): ResponseFrame {
  return { type: FrameType.RES, id: reqFrame.id, ok, payload, error, ts: Date.now() };
}

/** 创建事件帧 */
function event(eventName: string, payload?: unknown): EventFrame {
  return { type: FrameType.EVENT, event: eventName, payload, seq: nextSeq(), ts: Date.now() };
}

// ── 兼容性工具 ───────────────────────────────────────────────────────

/** 判断是否为新的 IPC 帧格式 */
function isNewFrame(msg: any): msg is IpcFrame {
  return msg && typeof msg === 'object' && (msg.type === FrameType.REQ || msg.type === FrameType.RES || msg.type === FrameType.EVENT);
}

/** 判断是否为旧帧格式 */
function isOldFrame(msg: any): boolean {
  return msg && typeof msg === 'object' && OLD_FRAME_TYPES.has(msg.type);
}

/** 将旧帧包装为统一事件格式（便于 handler 统一处理） */
function oldFrameToEvent(msg: AnyRecord | null | undefined): EventFrame | null {
  if (!msg || typeof msg !== 'object') return null;
  switch (msg.type) {
    case 'status':
      return event('worker.status', { agentId: msg.agentId, status: msg.status, statusCode: msg.statusCode });
    case 'message':
      return event('worker.message', { agentId: msg.agentId, data: msg.data });
    case 'sent':
      return event('worker.sent', {
        agentId: msg.agentId, channelId: msg.channelId,
        localMsgId: msg.localMsgId, messageId: msg.messageId,
        messageSeq: msg.messageSeq, clientMsgNo: msg.clientMsgNo,
        success: msg.success, error: msg.error,
      });
    case 'pong':
      return event('worker.pong', { agentId: msg.agentId, connected: msg.connected, statusCode: msg.statusCode });
    default:
      return event(`worker.${msg.type}`, msg);
  }
}

/** 统一处理：无论新旧格式，都返回标准化的事件对象 */
function normalize(msg: any): any {
  if (isNewFrame(msg)) return msg;
  if (isOldFrame(msg)) return oldFrameToEvent(msg);
  return msg;
}

module.exports = {
  FrameType, req, res, event,
  isNewFrame, isOldFrame, oldFrameToEvent, normalize,
  makeId, OLD_FRAME_TYPES,
};
