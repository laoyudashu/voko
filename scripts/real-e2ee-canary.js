'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { DatabaseSync } = require('node:sqlite');
const { VokoIMClient } = require('../src/im-sdk/client');
const { encodeContent } = require('../src/im-sdk/messages');

const root = path.resolve(__dirname, '..');
const envFile = path.join(root, '.env.real-test.local');
const CONTENT_TYPE_E2EE = 13;

function loadEnv(file) {
  if (!fs.existsSync(file)) throw new Error(`real-test config not found: ${file}`);
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || line.trim().startsWith('#') || process.env[match[1]] !== undefined) continue;
    let value = match[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

function serverAgentIdFromDid(did) {
  const hex = String(did || '').split(':').pop().replaceAll('-', '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error('The test Agent DID does not contain a server Agent UUID');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`.toLowerCase();
}

function readLocalConfig() {
  const dbPath = process.env.VOKO_REAL_DB_PATH;
  const localAgentId = process.env.VOKO_REAL_AGENT_ID;
  if (!dbPath || !path.isAbsolute(dbPath) || !localAgentId) throw new Error('VOKO_REAL_DB_PATH and VOKO_REAL_AGENT_ID are required');
  if (!/^(1|true|yes)$/i.test(process.env.VOKO_E2EE_CANARY_ALLOW_AGENT_SESSION || '')) {
    throw new Error('Set VOKO_E2EE_CANARY_ALLOW_AGENT_SESSION=true after stopping the dedicated Agent worker');
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const agent = db.prepare('SELECT agent_id,imUid,imToken,im_server_url,owner_email,did FROM agents WHERE agent_id=?').get(localAgentId);
    if (!agent?.imUid || !agent?.imToken || !agent?.im_server_url || !agent?.did) throw new Error('Dedicated test Agent is incomplete');
    const tokenRow = db.prepare("SELECT data FROM config WHERE type='user_access_token'").get();
    const tokens = tokenRow?.data ? JSON.parse(tokenRow.data) : {};
    const ownerEmail = String(agent.owner_email || '').trim().toLowerCase();
    const token = tokens[ownerEmail]?.user_access_token || tokens[ownerEmail];
    if (!String(token || '').startsWith('ut_')) throw new Error('Dedicated test owner User Access Token is unavailable');
    return { dbPath, localAgentId, serverAgentId: serverAgentIdFromDid(agent.did), targetAgentDid: agent.did,
      agentImUid: agent.imUid, agentImToken: agent.imToken, imServerUrl: agent.im_server_url, ownerToken: token };
  } finally { db.close(); }
}

function cargoPath() {
  const name = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
  const local = path.join(require('node:os').homedir(), '.cargo', 'bin', name);
  return fs.existsSync(local) ? local : name;
}

function buildEndpoint() {
  execFileSync(cargoPath(), ['build', '--quiet', '--locked', '--manifest-path', 'e2ee/Cargo.toml',
    '--bin', 'voko-e2ee-canary-endpoint'], { cwd: root, stdio: 'inherit' });
  return path.join(root, 'e2ee', 'target', 'debug', process.platform === 'win32'
    ? 'voko-e2ee-canary-endpoint.exe' : 'voko-e2ee-canary-endpoint');
}

function endpoint(executable, options) {
  const child = spawn(executable, [`--role=${options.role}`, `--principal=${options.principal}`,
    `--device=${options.device}`, `--agent=${options.agent}`, `--group=${options.group}`,
    `--conversation=${options.conversation}`], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  const pending = [];
  lines.on('line', (line) => pending.shift()?.resolve(JSON.parse(line)));
  child.once('exit', (code) => { while (pending.length) pending.shift().reject(new Error(`crypto endpoint exited ${code}`)); });
  const request = (command) => new Promise((resolve, reject) => {
    pending.push({ resolve, reject });
    if (command) child.stdin.write(`${JSON.stringify(command)}\n`);
  }).then((value) => { if (!value.success) throw new Error(value.error || 'crypto endpoint failed'); return value; });
  return { ready: request(null), request, close() { child.stdin.end(); lines.close(); } };
}

async function requestJson(url, options, capture) {
  const body = options?.body == null ? undefined : JSON.stringify(options.body);
  if (body) capture.push(body);
  const response = await fetch(url, { method: options?.method || (body ? 'POST' : 'GET'),
    headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}),
      ...(options?.token ? { authorization: `Bearer ${options.token}` } : {}) }, body,
    signal: AbortSignal.timeout(options?.timeout || 15_000) });
  const text = await response.text();
  capture.push(text);
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error(`HTTP ${response.status}: invalid JSON`); }
  if (!response.ok || parsed.success === false) {
    const code = parsed?.error?.code || parsed?.code || 'HTTP_ERROR';
    throw new Error(`${code}: HTTP ${response.status}`);
  }
  return parsed.data ?? parsed;
}

function waitForEncryptedMessage(client, timeout = 20_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out waiting for encrypted IM message')); }, timeout);
    const onMessage = (message) => {
      if (Number(message.contentType) !== CONTENT_TYPE_E2EE) return;
      cleanup();
      try { resolve(JSON.parse(String(message.content?.content || ''))); }
      catch (error) { reject(new Error(`Invalid encrypted IM envelope: ${error.message}`)); }
    };
    const onError = (error) => { cleanup(); reject(error); };
    const cleanup = () => { clearTimeout(timer); client.off('message', onMessage); client.off('error', onError); };
    client.on('message', onMessage); client.on('error', onError);
  });
}

async function fetchEncryptedReply(baseUrl, guestToken, guestAgentId, serverAgentId, capture) {
  let cursor = 0;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const result = await requestJson(`${baseUrl}/guest/v1/messages/fetch`, { token: guestToken, timeout: 30_000,
      body: { agentId: guestAgentId, channelId: serverAgentId, messageSeq: cursor, onlyReplies: true, limit: 50, blockTimeout: 5 } }, capture);
    for (const message of result.messages || []) {
      cursor = Math.max(cursor, Number(message.messageSeq) || 0);
      if (Number(message.contentType) === CONTENT_TYPE_E2EE) return JSON.parse(message.content);
    }
  }
  throw new Error('Encrypted reply was not returned by Guest fetch');
}

function assertNoPlaintext(capture, plaintexts) {
  const wire = Buffer.from(capture.join('\n'));
  for (const plaintext of plaintexts) {
    if (wire.includes(Buffer.from(plaintext))) throw new Error('Canary plaintext appeared in captured AgentDID/IM wire data');
  }
}

(async () => {
  loadEnv(envFile);
  if (process.platform !== 'win32') throw new Error('Real internal Canary is currently restricted to Windows');
  const config = readLocalConfig();
  const ownerDevice = process.env.VOKO_E2EE_CANARY_OWNER_DEVICE_KEY_ID;
  const browserDevice = process.env.VOKO_E2EE_CANARY_BROWSER_DEVICE_KEY_ID;
  if (!ownerDevice || !browserDevice) throw new Error('Both Canary device key IDs are required');
  const baseUrl = String(process.env.VOKO_E2EE_CANARY_BASE_URL || require('../src/endpoints.json').api.baseUrl).replace(/\/+$/, '');
  const runId = `e2ee-real-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const group = `canary-${crypto.randomUUID()}`;
  const conversation = `canary-conversation-${crypto.randomUUID()}`;
  const capture = [];
  const plaintexts = [`CANARY_BROWSER_TO_LITE_${runId}`, `CANARY_LITE_TO_BROWSER_${runId}`];
  const executable = buildEndpoint();
  const guest = await requestJson(`${baseUrl}/guest/v1/sessions`, { method: 'POST', body: {} }, capture);
  const guestToken = guest.token;
  const guestAgentId = guest.agentId;
  const guestIdentity = await requestJson(`${baseUrl}/guest/v1/e2ee/identity`, { token: guestToken }, capture);
  const status = await requestJson(`${baseUrl}/api/external/v1/e2ee/canary/status`, { token: config.ownerToken }, capture);
  let creator = endpoint(executable, { role: 'creator', principal: guestIdentity.principalId,
    device: browserDevice, agent: config.targetAgentDid, group, conversation });
  let recipient = endpoint(executable, { role: 'recipient', principal: status.ownerScope,
    device: ownerDevice, agent: config.targetAgentDid, group, conversation });
  let imClient;
  try {
    const [creatorReady, recipientReady] = await Promise.all([creator.ready, recipient.ready]);
    await requestJson(`${baseUrl}/api/external/v1/e2ee/devices`, { token: config.ownerToken, body: {
      ownerDeviceKeyId: ownerDevice, keyEpoch: 1, credentialPublicKey: recipientReady.credentialPublicKey } }, capture);
    await requestJson(`${baseUrl}/api/external/v1/e2ee/key-packages`, { token: config.ownerToken, body: {
      agentId: config.serverAgentId, ownerDeviceKeyId: ownerDevice, keyEpoch: 1,
      keyPackage: recipientReady.keyPackage, expiresAtMs: Date.now() + 60 * 60 * 1000 } }, capture);
    const reservation = await requestJson(`${baseUrl}/guest/v1/e2ee/key-packages/reserve`, { token: guestToken,
      body: { agentId: config.serverAgentId, targetAgentDid: config.targetAgentDid } }, capture);
    const prepared = await creator.request({ op: 'prepare_add', key_package: reservation.keyPackage });
    const establishment = await requestJson(`${baseUrl}/guest/v1/e2ee/establishments`, { token: guestToken, body: {
      reservationId: reservation.reservationId, agentId: config.serverAgentId,
      groupId: Buffer.from(group).toString('base64url'), commit: prepared.commit, welcome: prepared.welcome } }, capture);
    await creator.request({ op: 'accept_add' });
    const pending = await requestJson(`${baseUrl}/api/external/v1/e2ee/establishments/pull`, { token: config.ownerToken,
      body: { agentId: config.serverAgentId, ownerDeviceKeyId: ownerDevice, limit: 20 } }, capture);
    const pulled = pending.establishments.find((item) => item.establishmentId === establishment.establishmentId);
    if (!pulled) throw new Error('AgentDID did not return the accepted establishment');
    await recipient.request({ op: 'join', welcome: pulled.welcome });
    const ack = await recipient.request({ op: 'encrypt', message_id: `${runId}-ack`, text: 'GROUP_ESTABLISHED' });
    await requestJson(`${baseUrl}/api/external/v1/e2ee/establishments/ack`, { token: config.ownerToken, body: {
      establishmentId: establishment.establishmentId, agentId: config.serverAgentId, ownerDeviceKeyId: ownerDevice,
      ack: Buffer.from(JSON.stringify(ack.envelope)).toString('base64url') } }, capture);
    const active = await requestJson(`${baseUrl}/guest/v1/e2ee/establishments/status`, { token: guestToken,
      body: { establishmentId: establishment.establishmentId } }, capture);
    const ackEnvelope = JSON.parse(Buffer.from(active.ack, 'base64url').toString('utf8'));
    if ((await creator.request({ op: 'decrypt', envelope: ackEnvelope })).text !== 'GROUP_ESTABLISHED') throw new Error('ACK decryption failed');

    imClient = new VokoIMClient({ uid: config.agentImUid, token: config.agentImToken,
      serverUrl: config.imServerUrl, autoReconnect: false, ackMode: 'auto' });
    imClient.on('error', () => {});
    await imClient.connect();
    const outbound = await creator.request({ op: 'encrypt', message_id: `${runId}-forward`, text: plaintexts[0] });
    const incoming = waitForEncryptedMessage(imClient);
    await requestJson(`${baseUrl}/guest/v1/messages`, { token: guestToken, body: { agentId: guestAgentId,
      toUid: config.serverAgentId, content: JSON.stringify(outbound.envelope), contentType: CONTENT_TYPE_E2EE,
      clientMsgNo: `${runId}-forward` } }, capture);
    const receivedEnvelope = await incoming;
    if ((await recipient.request({ op: 'decrypt', envelope: receivedEnvelope })).text !== plaintexts[0]) throw new Error('Guest→Lite plaintext mismatch');
    const reply = await recipient.request({ op: 'encrypt', message_id: `${runId}-reply`, text: plaintexts[1] });
    await imClient.sendRaw(guestIdentity.principalId, 1,
      encodeContent(CONTENT_TYPE_E2EE, { content: JSON.stringify(reply.envelope) }), { clientMsgNo: `${runId}-reply` });
    const returned = await fetchEncryptedReply(baseUrl, guestToken, guestAgentId, config.serverAgentId, capture);
    if ((await creator.request({ op: 'decrypt', envelope: returned })).text !== plaintexts[1]) throw new Error('Lite→Guest plaintext mismatch');

    const [creatorState, recipientState] = await Promise.all([
      creator.request({ op: 'snapshot' }), recipient.request({ op: 'snapshot' }),
    ]);
    creator.close(); recipient.close();
    creator = endpoint(executable, { role: 'creator', principal: guestIdentity.principalId,
      device: browserDevice, agent: config.targetAgentDid, group, conversation });
    recipient = endpoint(executable, { role: 'recipient', principal: status.ownerScope,
      device: ownerDevice, agent: config.targetAgentDid, group, conversation });
    await Promise.all([creator.ready, recipient.ready]);
    await creator.request({ op: 'restore', snapshot: creatorState.snapshot });
    await recipient.request({ op: 'restore', snapshot: recipientState.snapshot });
    assertNoPlaintext(capture, plaintexts);

    const reportDir = path.join(root, 'artifacts', 'real-tests', runId);
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(path.join(reportDir, 'summary.json'), JSON.stringify({ schemaVersion: 1, runId,
      sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      productionEnabled: false, serverAgentId: config.serverAgentId, contentType: CONTENT_TYPE_E2EE,
      checks: { agentDidHandshake: true, realWuKongImBidirectional: true, restartRecovery: true,
        plaintextFallbacks: 0, capturedWirePlaintextHits: 0 }, passed: true }, null, 2));
    console.log(`Real E2EE Canary passed; report=${reportDir}`);
  } finally {
    imClient?.disconnect(); creator?.close(); recipient?.close();
    if (guestToken) await requestJson(`${baseUrl}/guest/v1/sessions/current`, { method: 'DELETE', token: guestToken }, capture).catch(() => {});
  }
})().catch((error) => { console.error(`Real E2EE Canary failed: ${error.message}`); process.exitCode = 1; });
