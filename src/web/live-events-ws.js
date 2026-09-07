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
    if (authorizeConsoleRequest(requests.get(ws), options.ownerOnly ? undefined : options.authToken, options.webSessions)) return true;
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
    if (onConnect) onConnect(ws, req);
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
    for (const ws of clients) {
      if (authorized(ws) && ws.readyState === 1) { try { ws.send(JSON.stringify(options.filterOutput ? options.filterOutput(data, requests.get(ws)) : data)); } catch (_) {} }
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
  // Message and intervention events contain original bodies, including rejected content.
  return createAuthenticatedEventStream(wss, '/ws', { ...options, ownerOnly: true });
}

function createLiveEventsWs(wss, runtimeState, taskManager, options) {
  return createAuthenticatedEventStream(wss, '/voko/events/ws', { ...options,
    filterOutput(data, req) {
      if (data.type !== 'snapshot' || options.webSessions?.resolveRequest(req)) return data;
      return { ...data, data: { ...data.data, recentEvents: [], recentAudit: [] } };
    },
  }, (ws, req) => {
    if (!runtimeState) return;
    try {
      ws.send(JSON.stringify({ type: 'snapshot', data: {
        agents: runtimeState.getAll(), summary: runtimeState.summary(),
        tasks: taskManager?.snapshot?.() || [],
        recentEvents: options.webSessions?.resolveRequest(req) ? getHistory(null, null, 100) : [],
        recentAudit: options.webSessions?.resolveRequest(req) ? query({ limit: 50 }) : [],
      }}));
    } catch (_) {}
  });
}

module.exports = { authorizeConsoleRequest, createLiveEventsWs, createMessageEventsWs };
