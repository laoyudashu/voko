/**
 * live-events-ws.js — 控制台实时 WebSocket 服务
 *
 * 挂载到 /voko/events/ws，依附于已有的 WebSocket.Server。
 * 推送 agent 状态、消息流、审计日志等实时事件。
 *
 * 注意：不自行创建 WebSocket.Server，由调用方传入已有 wss，
 * 通过 connection handler 按 URL 路径路由。
 *
 * 鉴权：通过 URL query ?token= 或 origin localhost 校验。
 */

const { getHistory, clearHistory } = require('../core/lite-events');
const { query } = require('../core/audit-log');
const { RuntimeState } = require('../core/runtime-state');
const {
  isAllowedLocalHost,
  isAllowedLocalWebSocketOrigin,
} = require('../core/local-http-security');

function authorizeConsoleRequest(req, authToken) {
  if (!isAllowedLocalHost(req.headers.host)) return false;
  if (!authToken) {
    return isAllowedLocalWebSocketOrigin(req.headers.origin, req.headers.host);
  }
  const rawUrl = req.url || '';
  const qIdx = rawUrl.indexOf('?');
  const qs = new URLSearchParams(qIdx >= 0 ? rawUrl.slice(qIdx) : '');
  const token = qs.get('token') || req.headers['x-voko-console-token'] || '';
  return token === authToken;
}

/**
 * @param {object} wss  - 已有的 WebSocket.Server 实例
 * @param {object} runtimeState - RuntimeState 实例
 * @returns {{ broadcast, clients, close }}
 */
function createLiveEventsWs(wss, runtimeState) {
  const clients = new Set();
  const PATH_PREFIX = '/voko/events/ws';

  // ── 简易鉴权 ──
  const _authToken = process.env.VOKO_CONSOLE_TOKEN || '';

  function _authorize(req) {
    return authorizeConsoleRequest(req, _authToken);
  }

  // ── 心跳 ──
  const heartbeatInterval = setInterval(() => {
    for (const ws of clients) {
      try { ws.ping(); } catch {}
    }
  }, 30000);

  // ── 挂接到已有 wss（按路径过滤） ──
  wss.on('connection', (ws, req) => {
    const reqUrl = req.url || '';
    const reqPath = reqUrl.indexOf('?') >= 0 ? reqUrl.slice(0, reqUrl.indexOf('?')) : reqUrl;
    if (reqPath !== PATH_PREFIX) return; // 不是控制台连接，忽略

    if (!_authorize(req)) {
      ws.close(4001, 'Unauthorized');
      return;
    }
    clients.add(ws);

    // 推送初始快照
    if (runtimeState) {
      try {
        ws.send(JSON.stringify({ type: 'snapshot', data: {
          agents: runtimeState.getAll(),
          summary: runtimeState.summary(),
          recentEvents: getHistory(null, null, 100),
          recentAudit: query({ limit: 50 }),
        }}));
      } catch (_) {}
    }

    ws.on('close', () => {
      clients.delete(ws);
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      } catch {}
    });

    ws.on('error', () => { clients.delete(ws); });
  });

  // 广播
  function broadcast(data) {
    const msg = JSON.stringify(data);
    for (const ws of clients) {
      try { ws.send(msg); } catch {}
    }
  }

  function close() {
    clearInterval(heartbeatInterval);
    for (const ws of clients) { try { ws.close(); } catch {} }
    clients.clear();
  }

  return { broadcast, clients, close };
}

module.exports = { authorizeConsoleRequest, createLiveEventsWs };
