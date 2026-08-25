const http = require('node:http');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const { FaultController } = require('./fault-controller');
const { generateKeyPair, sharedKey } = require('curve25519-js');
const { Md5 } = require('md5-typescript');
const { BinaryProtocol, PacketType, Writer, Reader, frame } = require('../../src/im-sdk/protocol');
const { CryptoContext } = require('../../src/im-sdk/crypto-context');
const { ContentType, encodeContent, decodeContent } = require('../../src/im-sdk/messages');

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

function parseConnectPacket(data) {
  const r = new Reader(data);
  const first = r.byte();
  if ((first >> 4) !== PacketType.CONNECT) return null;
  const remaining = r.variable();
  if (r.offset + remaining !== data.length) throw new Error('Malformed CONNECT packet');
  return {
    version: r.byte(),
    deviceFlag: r.byte(),
    deviceId: r.string(),
    uid: r.string(),
    token: r.string(),
    clientTimestamp: r.int64(),
    clientKey: r.string(),
  };
}

function encodeConnack(serverKey, salt, serverVersion = 4) {
  const w = new Writer();
  w.byte(serverVersion);
  w.int64(0);
  w.byte(1);
  w.string(Buffer.from(serverKey).toString('base64'));
  w.string(salt);
  w.int64(1);
  return frame(PacketType.CONNACK, w.result(), { noPersist: true });
}

function encodeSendack(messageId, clientSeq, messageSeq, reasonCode = 1) {
  const w = new Writer();
  w.int64(messageId);
  w.int32(clientSeq);
  w.int32(messageSeq);
  w.byte(reasonCode);
  return frame(PacketType.SENDACK, w.result());
}

function encodeRecv(state, message) {
  const messageId = BigInt(message.messageId);
  const messageSeq = Number(message.messageSeq || 1);
  const timestamp = Number(message.timestamp || Math.floor(Date.now() / 1000));
  const clientMsgNo = String(message.clientMsgNo || `e2e-${messageId}`);
  const payload = encodeContent(Number(message.contentType || ContentType.Text), message.fields || { content: String(message.content || '') }, message.mention);
  const encryptedText = state.crypto.encryptBytes(payload);
  const encrypted = Uint8Array.from(Buffer.from(encryptedText, 'utf8'));
  const fromUid = String(message.fromUid || 'e2e-visitor');
  const channelId = String(message.channelId || fromUid);
  const channelType = Number(message.channelType || 1);
  const verify = `${messageId}${messageSeq}${clientMsgNo}${timestamp}${fromUid}${channelId}${channelType}${encryptedText}`;
  const msgKey = Md5.init(state.crypto.encryptString(verify));
  const w = new Writer();
  w.byte(Number(message.setting || 0));
  w.string(msgKey);
  w.string(fromUid);
  w.string(channelId);
  w.byte(channelType);
  w.int32(Number(message.expire || 0));
  w.string(clientMsgNo);
  w.int64(messageId);
  w.int32(messageSeq);
  w.int32(timestamp);
  if (Number(message.setting || 0) & 8) w.string(message.topic || '');
  w.raw(encrypted);
  return frame(PacketType.RECV, w.result(), {
    noPersist: !!message.noPersist,
    reddot: message.redDot !== false,
    syncOnce: !!message.syncOnce,
  });
}

function createProtocolConnection(ws, req, { faults, events, connections, nextMessageId }) {
  const state = {
    ws, req, protocol: null, crypto: null, uid: null, authenticated: false, messageSeq: 0,
    sendCount: 0, sendAckCount: 0, sendAckLostCount: 0,
  };
  let legacyReorderPending = null;
  const onClose = (code) => {
    if (state.authenticated) {
      events.push({ target: 'im', direction: 'disconnect', uid: state.uid, code: Number(code || 0) });
    }
    if (state.uid && connections.get(state.uid) === state) connections.delete(state.uid);
  };
  ws.once('close', onClose);
  ws.on('message', async (raw) => {
    const data = Buffer.from(raw);
    const packetType = data.length ? data[0] >> 4 : 0;
    // Keep the legacy text echo used by the low-level fault tests.  Real VOKO
    // clients always begin with a binary CONNECT packet (0x10).
    if (packetType !== PacketType.CONNECT && !state.authenticated) {
      const rule = faults.consume('im');
      if (rule?.delayMs) await new Promise(resolve => setTimeout(resolve, rule.delayMs));
      if (rule?.mode === '1006') return ws.terminate();
      if (rule?.mode === 'sendack-lost') return;
      const message = data.toString();
      events.push({ target: 'im', message });
      const replies = rule?.mode === 'duplicate' ? 2 : 1;
      if (rule?.mode === 'reorder') {
        if (legacyReorderPending === null) { legacyReorderPending = message; return; }
        ws.send(message);
        ws.send(legacyReorderPending);
        legacyReorderPending = null;
        return;
      }
      for (let index = 0; index < replies; index += 1) ws.send(message);
      return;
    }

    if (packetType === PacketType.CONNECT) {
      let connect;
      try { connect = parseConnectPacket(data); } catch (error) { ws.close(1002, error.message); return; }
      if (!connect?.clientKey) return ws.close(1002, 'Missing client key');
      const serverPair = generateKeyPair(Uint8Array.from(crypto.randomBytes(32)));
      const secret = sharedKey(serverPair.private, Uint8Array.from(Buffer.from(connect.clientKey, 'base64')));
      const aesKey = Md5.init(Buffer.from(secret).toString('base64')).slice(0, 16);
      const salt = crypto.randomBytes(16).toString('hex').slice(0, 16);
      const cryptoContext = new CryptoContext();
      cryptoContext.configure(aesKey, salt);
      state.crypto = cryptoContext;
      state.protocol = new BinaryProtocol(cryptoContext);
      state.protocol.serverVersion = 4;
      state.uid = connect.uid;
      state.authenticated = true;
      connections.set(state.uid, state);
      events.push({ target: 'im', direction: 'connect', uid: state.uid, token: connect.token });
      ws.send(encodeConnack(serverPair.public, salt));
      return;
    }
    if (!state.authenticated || !state.protocol) return;
    if (packetType === PacketType.PING) { ws.send(frame(PacketType.PONG, [])); return; }
    if (packetType === PacketType.SEND) {
      let packet;
      try { packet = state.protocol.decode(data); } catch (error) { ws.close(1002, error.message); return; }
      let content = null;
      try { content = decodeContent(state.crypto.decryptBytes(packet.encryptedPayload)); } catch (_) {}
      state.sendCount += 1;
      events.push({ target: 'im', direction: 'send', uid: state.uid, packet, content });
      const channelFaultTarget = packet.channelId ? `im:${state.uid}:${packet.channelId}` : null;
      const rule = (channelFaultTarget && faults.consume(channelFaultTarget)) || faults.consume('im');
      if (rule?.delayMs) await new Promise(resolve => setTimeout(resolve, rule.delayMs));
      if (rule?.mode === '1006') return ws.terminate();
      if (rule?.mode === 'sendack-lost') {
        state.sendAckLostCount += 1;
        events.push({ target: 'im', direction: 'sendack-lost', uid: state.uid, clientSeq: packet.clientSeq });
        return;
      }
      // A delayed ACK can race with an injected 1006 close.  Treat a closed
      // socket as an undeliverable ACK instead of throwing from the fake
      // server's asynchronous handler.
      if (ws.readyState !== 1) return;
      const id = nextMessageId();
      state.messageSeq += 1;
      state.sendAckCount += 1;
      events.push({ target: 'im', direction: 'sendack', uid: state.uid, clientSeq: packet.clientSeq });
      ws.send(encodeSendack(id, packet.clientSeq, state.messageSeq));
    }
  });
  return state;
}

function createIncomingInjector(connections, nextMessageId) {
  return (input = {}) => {
    const targetUid = String(input.toUid || input.uid || '');
    const state = connections.get(targetUid);
    if (!state?.authenticated) return { delivered: false, error: 'IM agent is not connected' };
    const base = { ...input };
    delete base.messages;
    delete base.duplicate;
    delete base.reorder;
    const items = Array.isArray(input.messages)
      ? input.messages.map(item => ({ ...base, ...item }))
      : [input];
    const normalized = items.map(item => ({
      ...item,
      messageId: String(item.messageId || nextMessageId()),
      messageSeq: Number(item.messageSeq || nextMessageId()),
    }));
    const expanded = input.duplicate ? [...normalized, ...normalized] : normalized;
    const ordered = input.reorder ? [...expanded].reverse() : expanded;
    for (const item of ordered) {
      state.ws.send(encodeRecv(state, item));
    }
    return { delivered: true, count: ordered.length, uid: targetUid };
  };
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
  const connections = new Map();
  let nextMessageIdValue = 1000n;
  const nextMessageId = () => { nextMessageIdValue += 1n; return nextMessageIdValue; };
  let injectIncoming = () => ({ delivered: false, error: 'IM is not ready' });
  const groupState = {
    role: 'owner',
    name: 'E2E Test Group',
    channelId: 'e2e-group',
    members: [
      { uid: 'e2e-im-uid', role: 'owner', nickname: 'E2E Test Agent' },
      { uid: 'e2e-visitor', role: 'member', nickname: 'E2E Visitor' },
      { uid: 'e2e-member', role: 'member', nickname: 'E2E Member' },
    ],
  };

  let apiBaseUrl = '';
  const apiServer = createSeparateHttpServer('voko-api', faults, events, (req, res, body) => {
    // The control plane is only exposed by the in-process fake API used by E2E.
    // It never exists on the VOKO production server.
    if (handleFaultControl(req, res, body, faults)) return;
    if (req.url === '/__test__/im/state' && req.method === 'GET') {
      const imEvents = events.filter((event) => event.target === 'im');
      return json(res, 200, {
        success: true,
        connections: [...connections.values()].map((state) => ({
          uid: state.uid,
          authenticated: state.authenticated,
          readyState: state.ws.readyState,
          messageSeq: state.messageSeq,
          sendCount: state.sendCount,
          sendAckCount: state.sendAckCount,
          sendAckLostCount: state.sendAckLostCount,
        })),
        stats: {
          connects: imEvents.filter((event) => event.direction === 'connect').length,
          disconnects: imEvents.filter((event) => event.direction === 'disconnect').length,
          sends: imEvents.filter((event) => event.direction === 'send').length,
          sendAcks: imEvents.filter((event) => event.direction === 'sendack').length,
          sendAckLost: imEvents.filter((event) => event.direction === 'sendack-lost').length,
        },
      });
    }
    if (req.url === '/__test__/im/control' && req.method === 'POST') {
      const input = parseJsonBody(body) || {};
      if (input.action !== 'disconnect') return json(res, 400, { success: false, error: 'unsupported IM control action' });
      const targetUid = input.uid ? String(input.uid) : null;
      let closed = 0;
      for (const state of [...connections.values()]) {
        if (targetUid && state.uid !== targetUid) continue;
        closed += 1;
        state.ws.terminate();
      }
      return json(res, 200, { success: true, action: 'disconnect', uid: targetUid, closed, code: 1006 });
    }
    if (req.url === '/__test__/im/message' && req.method === 'POST') {
      return json(res, 200, { success: true, ...injectIncoming(parseJsonBody(body) || {}) });
    }
    if (req.url === '/__test__/group-role' && req.method === 'POST') {
      const input = parseJsonBody(body) || {};
      if (input.role) groupState.role = String(input.role);
      return json(res, 200, { success: true, role: groupState.role });
    }
    if (req.url === '/health' || req.url === '/api/heartbeat') return json(res, 200, { success: true, status: 'ok' });
    if (req.url === '/api/login') return json(res, 200, { success: true, token: 'fake-token' });
    if (req.url === '/api/group/v1/info' && req.method === 'POST') {
      return json(res, 200, {
        success: true,
        data: {
          channel_id: groupState.channelId,
          name: groupState.name,
          status: 'active',
          owner_uid: 'e2e-im-uid',
          members: groupState.members.map(member => member.uid === 'e2e-im-uid' ? { ...member, role: groupState.role } : member),
        },
      });
    }
    if (req.url === '/api/group/v1/list' && req.method === 'POST') {
      return json(res, 200, { success: true, data: { groups: [{ channel_id: groupState.channelId, name: groupState.name, status: 'active', member_count: groupState.members.length }], total: 1 } });
    }
    if (req.url.startsWith('/api/group/v1/')) return json(res, 200, { success: true, data: {} });
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
    createProtocolConnection(ws, null, { faults, events, connections, nextMessageId });
  });
  const imAddress = await listenServer(imServer, ports.im || 0);
  injectIncoming = createIncomingInjector(connections, nextMessageId);

  return {
    baseUrl: apiBaseUrl,
    apiBaseUrl,
    wsUrl: `ws://127.0.0.1:${imAddress.port}`,
    imWsUrl: `ws://127.0.0.1:${imAddress.port}`,
    ossBaseUrl,
    providerBaseUrl: providerAddress.baseUrl,
    injectIncoming,
    connections,
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
