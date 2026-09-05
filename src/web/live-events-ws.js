/** Local event streams require current-owner cookies or an instance credential. */
const { getHistory } = require('../core/lite-events');
const { query } = require('../core/audit-log');
const { isAllowedLocalHost, isAllowedLocalWebSocketOrigin } = require('../core/local-http-security');

function authorizeConsoleRequest(req, authToken, webSessions) {
  const headers = req.headers || {};
  if (!isAllowedLocalHost(headers.host)
      || !isAllowedLocalWebSocketOrigin(headers.origin, headers.host)) return false;
  const bearer = String(headers.authorization || '').match(/^Bearer (.+)$/i)?.[1];
  const token = headers['x-voko-token'] || bearer || headers['x-voko-console-token'];
  if (authToken && token === authToken) return true;
  try { return Boolean(webSessions?.resolveRequest(req)); } catch (_) { return false; }
}

function createAuthenticatedEventStream(wss, path, options = {}, onConnect) {
  const clients = new Set();
  const requests = new WeakMap();
  function authorized(ws) {
    if (authorizeConsoleRequest(requests.get(ws), options.authToken, options.webSessions)) return true;
    clients.delete(ws);
    try { ws.close(4001, 'Unauthorized'); } catch (_) {}
    return false;
  }
  function connection(ws, req) {
    if (String(req.url || '').split('?', 1)[0] !== path) return;
    requests.set(ws, req);
    if (!authorized(ws)) return;
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
    if (onConnect) onConnect(ws);
    ws.on('message', raw => {
      if (!authorized(ws)) return;
      try { if (JSON.parse(raw).type === 'ping') ws.send(JSON.stringify({ type: 'pong' })); } catch (_) {}
    });
  }
  wss.on('connection', connection);
  const heartbeatInterval = setInterval(() => {
    for (const ws of clients) {
      if (authorized(ws)) { try { ws.ping(); } catch (_) {} }
    }
  }, 30000);
  heartbeatInterval.unref?.();
  function broadcast(data) {
    const message = JSON.stringify(data);
    for (const ws of clients) {
      if (authorized(ws) && ws.readyState === 1) { try { ws.send(message); } catch (_) {} }
    }
  }
  function close() {
    clearInterval(heartbeatInterval);
    wss.off('connection', connection);
    wss.off('close', close);
    for (const ws of clients) { try { ws.close(); } catch (_) {} }
    clients.clear();
  }
  wss.once('close', close);
  return { broadcast, clients, close };
}

function createMessageEventsWs(wss, options) {
  return createAuthenticatedEventStream(wss, '/ws', options);
}

function createLiveEventsWs(wss, runtimeState, taskManager, options) {
  return createAuthenticatedEventStream(wss, '/voko/events/ws', options, ws => {
    if (!runtimeState) return;
    try {
      ws.send(JSON.stringify({ type: 'snapshot', data: {
        agents: runtimeState.getAll(), summary: runtimeState.summary(),
        tasks: taskManager?.snapshot?.() || [],
        recentEvents: getHistory(null, null, 100), recentAudit: query({ limit: 50 }),
      }}));
    } catch (_) {}
  });
}

module.exports = { authorizeConsoleRequest, createLiveEventsWs, createMessageEventsWs };
