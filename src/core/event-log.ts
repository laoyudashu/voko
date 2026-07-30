/**
 * event-log.js — 结构化事件日志（events.jsonl）
 *
 * 供自动化测试稳定解析/断言，与人工日志 voko-im.log 并行。
 * 与主进程 src/logger.js 的 logEvent 同构，分别实现（跨包不可 require）。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
export {};

interface EventPayload {
  level?: string;
  traceId?: string;
  agentId?: string;
  visitorId?: string;
  id?: string;
  messageId?: string;
  data?: unknown;
}

function _eventLogPath(): string {
  const dir = process.platform === 'win32' && process.env.APPDATA
    ? path.join(process.env.APPDATA, 'voko')
    : process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'voko')
      : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'voko');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return path.join(dir, 'events.jsonl');
}

/**
 * 写结构化事件到 events.jsonl（供自动化测试断言）。
 * @param {string} event - 稳定事件名，如 'owner_intervention.sent'
 * @param {object} [payload] - { level?, traceId?, agentId?, visitorId?, id?, messageId?, data? }
 */
function logEvent(event: string, payload: EventPayload = {}): void {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level: payload.level || 'info',
      event,
      ...(payload.traceId ? { traceId: payload.traceId } : {}),
      ...(payload.agentId ? { agentId: payload.agentId } : {}),
      ...(payload.visitorId ? { visitorId: payload.visitorId } : {}),
      ...(payload.id ? { id: payload.id } : {}),
      ...(payload.messageId ? { messageId: payload.messageId } : {}),
      ...(payload.data ? { data: payload.data } : {}),
    });
    fs.appendFileSync(_eventLogPath(), line + '\n');
  } catch { /* 日志不应影响主流程 */ }
}

module.exports = { logEvent };
