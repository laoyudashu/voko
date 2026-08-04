const http = require('node:http');
const { WebSocketServer } = require('ws');
const { FaultController } = require('./fault-controller');

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': data.length });
  res.end(data);
}

async function applyHttpFault(rule, res) {
  if (!rule) return false;
  if (rule.delayMs) await new Promise((resolve) => setTimeout(resolve, rule.delayMs));
  if (rule.mode === 'timeout') return true;
  if (/^http-\d+$/.test(rule.mode)) {
    const status = Number(rule.mode.slice(5));
    json(res, status, { success: false, error: `injected ${status}` });
    return true;
  }
  if (rule.mode === 'outcome_unknown') {
    res.destroy();
    return true;
  }
  if (rule.mode === 'process-exit') {
    json(res, 503, { success: false, error: 'injected process exit' });
    return true;
  }
  if (rule.mode === 'rejected') {
    json(res, 422, { success: false, error: 'injected business rejection' });
    return true;
  }
  return false;
}

function parseJsonBody(body) {
  try {
    const parsed = JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : String(body || ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function handleFaultControl(req, res, body, faults) {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/__test__/fault' && req.method === 'POST') {
    const input = parseJsonBody(body);
    if (!input?.target || !input?.mode) {
      json(res, 400, { success: false, error: 'target and mode are required' });
      return true;
    }
    faults.set({
      target: String(input.target),
      mode: String(input.mode),
      delayMs: Number(input.delayMs) || 0,
      count: input.count === undefined ? 1 : Number(input.count),
    });
    json(res, 200, { success: true, target: input.target, mode: input.mode, faults: faults.snapshot() });
    return true;
  }
  if (url.pathname === '/__test__/fault' && req.method === 'DELETE') {
    faults.clear(url.searchParams.get('target') || undefined);
    json(res, 200, { success: true, faults: faults.snapshot() });
    return true;
  }
  if (url.pathname === '/__test__/faults' && req.method === 'GET') {
    json(res, 200, { success: true, faults: faults.snapshot() });
    return true;
  }
  return false;
}

async function startFakeServices(options = {}) {
  if (options.separate) return startSeparateFakeServices(options);
  const faults = options.faults || new FaultController();
  const events = [];
  const server = http.createServer(async (req, res) => {
    const target = req.url.startsWith('/oss/') ? 'oss' : req.url.startsWith('/provider/') ? 'provider' : 'voko-api';
    if (await applyHttpFault(faults.consume(target), res)) return;
    const body = await readBody(req);
    events.push({ target, method: req.method, url: req.url, body });
    if (target === 'voko-api' && handleFaultControl(req, res, body, faults)) return;
    if (target === 'oss') return json(res, 200, { success: true, url: `${baseUrl}/files/test.bin` });
    if (target === 'provider') return json(res, 200, { success: true, reply: 'fake provider reply', turnId: req.headers['x-turn-id'] || null });
    if (req.url === '/api/heartbeat') return json(res, 200, { success: true });
    if (req.url === '/api/login') return json(res, 200, { success: true, token: 'fake-token' });
    return json(res, 200, { success: true, data: [] });
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const rule = faults.peek('im');
    if (rule?.mode === 'auth-failure') {
      faults.consume('im');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws) => {
    let reorderPending = null;
    ws.on('message', async (raw) => {
      const rule = faults.consume('im');
      if (rule?.delayMs) await new Promise((resolve) => setTimeout(resolve, rule.delayMs));
      if (rule?.mode === '1006') return ws.terminate();
      if (rule?.mode === 'sendack-lost') return;
      const message = raw.toString();
      events.push({ target: 'im', message });
      if (rule?.mode === 'reorder') {
        if (reorderPending === null) { reorderPending = message; return; }
        ws.send(message);
        ws.send(reorderPending);
        reorderPending = null;
        return;
      }
      const replies = rule?.mode === 'duplicate' ? 2 : 1;
      for (let index = 0; index < replies; index += 1) ws.send(message);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port || 0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    wsUrl: `ws://127.0.0.1:${address.port}`,
    faults,
    events,
    close: () => new Promise((resolve) => {
      for (const client of wss.clients) client.terminate();
      wss.close(() => server.close(resolve));
    }),
  };
}

function listenServer(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      resolve({ port: address.port, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

function closeHttpServer(server) {
  return new Promise((resolve) => {
    try { server.closeAllConnections?.(); } catch {}
    if (!server.listening) return resolve();
    server.close(() => resolve());
  });
}

function createSeparateHttpServer(target, faults, events, responseFor) {
  return http.createServer(async (req, res) => {
    if (await applyHttpFault(faults.consume(target), res)) return;
    const body = await readBody(req);
    events.push({ target, method: req.method, url: req.url, body });
    return responseFor(req, res, body);
  });
}

async function startSeparateFakeServices(options = {}) {
  const faults = options.faults || new FaultController();
  const events = [];
  const ports = options.ports || {};

  let apiBaseUrl = '';
  const apiServer = createSeparateHttpServer('voko-api', faults, events, (req, res, body) => {
    // The control plane is only exposed by the in-process fake API used by E2E.
    // It never exists on the VOKO production server.
    if (handleFaultControl(req, res, body, faults)) return;
    if (req.url === '/health' || req.url === '/api/heartbeat') return json(res, 200, { success: true, status: 'ok' });
    if (req.url === '/api/login') return json(res, 200, { success: true, token: 'fake-token' });
    return json(res, 200, { success: true, data: [] });
  });
  const apiAddress = await listenServer(apiServer, ports.api || 0);
  apiBaseUrl = apiAddress.baseUrl;

  let ossBaseUrl = '';
  const ossServer = createSeparateHttpServer('oss', faults, events, (_req, res) =>
    json(res, 200, { success: true, url: `${ossBaseUrl}/files/test.bin` }));
  const ossAddress = await listenServer(ossServer, ports.oss || 0);
  ossBaseUrl = ossAddress.baseUrl;

  const providerServer = createSeparateHttpServer('provider', faults, events, (req, res) =>
    json(res, 200, { success: true, reply: 'fake provider reply', turnId: req.headers['x-turn-id'] || null }));
  const providerAddress = await listenServer(providerServer, ports.provider || 0);

  const imServer = http.createServer((_req, res) => json(res, 404, { success: false, error: 'IM websocket only' }));
  const wss = new WebSocketServer({ noServer: true });
  imServer.on('upgrade', (req, socket, head) => {
    const rule = faults.peek('im');
    if (rule?.mode === 'auth-failure') {
      faults.consume('im');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws) => {
    let reorderPending = null;
    ws.on('message', async (raw) => {
      const rule = faults.consume('im');
      if (rule?.delayMs) await new Promise((resolve) => setTimeout(resolve, rule.delayMs));
      if (rule?.mode === '1006') return ws.terminate();
      if (rule?.mode === 'sendack-lost') return;
      const message = raw.toString();
      events.push({ target: 'im', message });
      if (rule?.mode === 'reorder') {
        if (reorderPending === null) { reorderPending = message; return; }
        ws.send(message);
        ws.send(reorderPending);
        reorderPending = null;
        return;
      }
      const replies = rule?.mode === 'duplicate' ? 2 : 1;
      for (let index = 0; index < replies; index += 1) ws.send(message);
    });
  });
  const imAddress = await listenServer(imServer, ports.im || 0);

  return {
    baseUrl: apiBaseUrl,
    apiBaseUrl,
    wsUrl: `ws://127.0.0.1:${imAddress.port}`,
    imWsUrl: `ws://127.0.0.1:${imAddress.port}`,
    ossBaseUrl,
    providerBaseUrl: providerAddress.baseUrl,
    faults,
    events,
    services: {
      api: apiBaseUrl,
      im: `ws://127.0.0.1:${imAddress.port}`,
      oss: ossBaseUrl,
      provider: providerAddress.baseUrl,
    },
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => wss.close(() => resolve()));
      await Promise.all([
        closeHttpServer(apiServer),
        closeHttpServer(ossServer),
        closeHttpServer(providerServer),
        closeHttpServer(imServer),
      ]);
    },
  };
}

module.exports = { startFakeServices };
