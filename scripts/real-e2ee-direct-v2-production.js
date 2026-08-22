'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { DatabaseSync } = require('node:sqlite');

const root = path.resolve(__dirname, '..');
const CONTENT_TYPE_E2EE = 13;
const PROTOCOL_MODE = 'direct_v2';
const CHUNK_BYTES = 1024 * 1024;
const COOKIE_NAME = 'voko_guest_session_v2';

function localAgent() {
  const dbPath = process.env.VOKO_E2EE_PRODUCTION_TEST_DB
    || path.join(process.env.APPDATA || '', 'voko', 'voko.db');
  const agentId = process.env.VOKO_E2EE_PRODUCTION_TEST_AGENT_ID || 'gym';
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare(`SELECT agent_id,did,"imUid" AS im_uid FROM agents
      WHERE agent_id=? AND publish_status='published' AND did IS NOT NULL`).get(agentId);
    if (!row?.did || !row?.im_uid) throw new Error('E2EE_PRODUCTION_TEST_AGENT_UNAVAILABLE');
    return { localAgentId: String(row.agent_id), targetAgentDid: String(row.did),
      targetImUid: String(row.im_uid) };
  } finally { db.close(); }
}

function verifyLocalReceipt(messageId, replyMessageId, localAgentId, channelId) {
  const dbPath = process.env.VOKO_E2EE_PRODUCTION_TEST_E2EE_DB
    || path.join(process.env.APPDATA || '', 'voko', 'voko-e2ee.db');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare(`SELECT r.state,r.local_agent_id,r.channel_id,r.reply_message_id,
      r.delivery_attempts,s.protocol_mode FROM e2ee_production_receipts r
      JOIN e2ee_production_sessions s ON s.group_id=r.group_id WHERE r.message_id=?`).get(messageId);
    if (row?.state !== 'completed' || row?.local_agent_id !== localAgentId
        || row?.channel_id !== channelId || row?.reply_message_id !== replyMessageId
        || Number(row?.delivery_attempts) !== 1 || row?.protocol_mode !== PROTOCOL_MODE) {
      throw new Error('E2EE_DIRECT_PRODUCTION_RECEIPT_MISMATCH');
    }
  } finally { db.close(); }
}

function endpoint(scope) {
  const executable = process.env.VOKO_E2EE_PRODUCTION_TEST_ENDPOINT
    || path.join(root, 'e2ee', 'target', 'native-release', 'voko-e2ee-endpoint-win32-x64.exe');
  if (!path.isAbsolute(executable) || !fs.existsSync(executable)) {
    throw new Error('E2EE_PRODUCTION_TEST_ENDPOINT_MISSING');
  }
  const child = spawn(executable, [
    '--role=creator', `--principal=${scope.principal}`, `--device=${scope.device}`,
    `--agent=${scope.agent}`, `--group=${scope.group}`, `--conversation=${scope.conversation}`,
    `--owner-scope=${scope.principal}`, '--key-epoch=1'
  ], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  const pending = [];
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-2048); });
  lines.on('line', line => {
    if (!String(line).trim()) return;
    const next = pending.shift();
    if (!next) return;
    try { next.resolve(JSON.parse(line)); } catch (error) { next.reject(error); }
  });
  child.once('exit', code => {
    while (pending.length) pending.shift().reject(new Error(
      `E2EE endpoint exited ${code}${stderr ? ': ' + stderr.trim().slice(0, 160) : ''}`));
  });
  const request = command => new Promise((resolve, reject) => {
    pending.push({ resolve, reject });
    if (command) child.stdin.write(`${JSON.stringify(command)}\n`);
  }).then(result => {
    if (!result?.success) throw new Error(result?.error || 'E2EE endpoint failed');
    return result;
  });
  return { ready: request(null), request, close() { child.stdin.end(); lines.close(); } };
}

async function jsonRequest(url, options = {}) {
  const body = options.body == null ? undefined : JSON.stringify(options.body);
  const response = await fetch(url, {
    method: options.method || (body ? 'POST' : 'GET'),
    headers: {
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(options.origin ? { origin: options.origin, referer: `${options.origin}/` } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers || {})
    },
    body,
    signal: AbortSignal.timeout(options.timeoutMs || 30_000)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.success === false) {
    const code = data?.error?.code || data?.code || `HTTP_${response.status}`;
    throw Object.assign(new Error(code), { status: response.status, code });
  }
  return { data: data?.data ?? data, response };
}

function cookieFrom(response) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  const pair = values.map(value => String(value).split(';')[0])
    .find(value => value.startsWith(`${COOKIE_NAME}=`));
  if (!pair) throw new Error('E2EE_PRODUCTION_WEB_SESSION_COOKIE_MISSING');
  return pair;
}

function tokenFromCookie(cookie) {
  const separator = cookie.indexOf('=');
  const token = separator > 0 ? decodeURIComponent(cookie.slice(separator + 1)) : '';
  if (!token.startsWith('gst_')) throw new Error('E2EE_PRODUCTION_WEB_SESSION_TOKEN_INVALID');
  return token;
}

function b64text(value) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

async function createWebSession(chatroomBase, deviceId) {
  const { data, response } = await jsonRequest(`${chatroomBase}/api/guest/session`, {
    origin: chatroomBase,
    body: { deviceId, platform: 'chromium', clientVersion: 'direct-v2-production-probe' },
    headers: {
      'x-voko-device-id': deviceId,
      'x-voko-device-platform': 'chromium',
      'x-voko-client-version': 'direct-v2-production-probe'
    }
  });
  const cookie = cookieFrom(response);
  if (!data?.imUid || data?.deviceId !== deviceId) throw new Error('E2EE_PRODUCTION_WEB_DEVICE_BINDING_INVALID');
  return { cookie, token: tokenFromCookie(cookie), identity: data };
}

async function waitForReply(gatewayBase, token, callerAgentId, targetAgentId, endpointHandle,
  cursor, ignoredMessageIds, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data } = await jsonRequest(`${gatewayBase}/guest/v1/messages/fetch`, {
      token, timeoutMs: 35_000, body: {
        agentId: callerAgentId, channelId: targetAgentId, messageSeq: cursor.value,
        onlyReplies: true, limit: 50, blockTimeout: 20
      }
    });
    for (const message of data.items || []) {
      cursor.value = Math.max(cursor.value, Number(message.messageSeq) || 0);
      if (Number(message.contentType) !== CONTENT_TYPE_E2EE || !String(message.content || '').trim()) continue;
      let envelope;
      try { envelope = JSON.parse(message.content); } catch { continue; }
      if (!envelope?.messageId || ignoredMessageIds.has(String(envelope.messageId))) continue;
      const opened = await endpointHandle.request({ op: 'decrypt', envelope });
      return { plaintext: String(opened.text || ''), messageSeq: Number(message.messageSeq) || 0,
        messageId: String(envelope.messageId) };
    }
  }
  throw new Error('E2EE_DIRECT_PRODUCTION_REPLY_TIMEOUT');
}

async function postEncrypted(chatroomBase, cookie, identity, encrypted) {
  const { data } = await jsonRequest(`${chatroomBase}/api/e2ee/messages`, {
    origin: chatroomBase, cookie, body: {
      agentId: identity.callerAgentId, toUid: identity.target.agentId,
      content: JSON.stringify(encrypted.envelope), contentType: CONTENT_TYPE_E2EE,
      clientMsgNo: encrypted.messageId
    }
  });
  return data;
}

async function sendExpected({ chatroomBase, gatewayBase, cookie, token, identity, endpointHandle,
  cursor, ignoredMessageIds, expected, label, localAgentId }) {
  const messageId = `e2ee-${crypto.randomUUID()}`;
  const encrypted = await endpointHandle.request({ op: 'encrypt', message_id: messageId,
    text: `请只回复以下测试码，不要添加其他内容：${expected}` });
  ignoredMessageIds.add(messageId);
  await postEncrypted(chatroomBase, cookie, identity, { ...encrypted, messageId });
  const reply = await waitForReply(gatewayBase, token, identity.callerAgentId,
    identity.target.agentId, endpointHandle, cursor, ignoredMessageIds);
  ignoredMessageIds.add(reply.messageId);
  if (!reply.plaintext.trim() || reply.plaintext.includes('[端到端加密消息]')) {
    throw new Error(`E2EE_DIRECT_${label}_REPLY_INVALID`);
  }
  verifyLocalReceipt(messageId, reply.messageId, localAgentId, identity.principalId);
  return reply;
}

function u32(value) {
  const out = Buffer.alloc(4); out.writeUInt32BE(value); return out;
}

function u64(value) {
  const out = Buffer.alloc(8); out.writeBigUInt64BE(BigInt(value)); return out;
}

function encryptAttachment(plaintext) {
  if (!Buffer.isBuffer(plaintext) || plaintext.length < 1 || plaintext.length > 25 * CHUNK_BYTES) {
    throw new Error('E2EE_ATTACHMENT_SIZE_INVALID');
  }
  const key = crypto.randomBytes(32);
  const fileId = crypto.randomBytes(16);
  const noncePrefix = crypto.randomBytes(8);
  const count = Math.ceil(plaintext.length / CHUNK_BYTES);
  const chunks = [];
  const ciphertextHashes = [];
  for (let index = 0; index < count; index += 1) {
    const chunk = plaintext.subarray(index * CHUNK_BYTES, Math.min((index + 1) * CHUNK_BYTES, plaintext.length));
    const nonce = Buffer.concat([noncePrefix, u32(index)]);
    const aad = Buffer.concat([Buffer.from('voko.e2ee.attachment/1'), fileId,
      u32(index), u32(count), u64(plaintext.length)]);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad, { plaintextLength: chunk.length });
    const ciphertext = Buffer.concat([cipher.update(chunk), cipher.final(), cipher.getAuthTag()]);
    chunks.push(ciphertext.toString('base64url'));
    ciphertextHashes.push(crypto.createHash('sha256').update(ciphertext).digest('base64url'));
  }
  return {
    key: key.toString('base64url'),
    publicPackage: {
      version: 'voko.e2ee.attachment/1', fileId: fileId.toString('base64url'),
      noncePrefix: noncePrefix.toString('base64url'), plaintextSize: plaintext.length,
      chunkSize: CHUNK_BYTES, ciphertextHashes
    },
    uploadBytes: Buffer.from(JSON.stringify({
      version: 'voko.e2ee.attachment/1', fileId: fileId.toString('base64url'),
      noncePrefix: noncePrefix.toString('base64url'), plaintextSize: plaintext.length,
      chunkSize: CHUNK_BYTES, ciphertextHashes, chunks
    }))
  };
}

async function uploadEncryptedAttachment(chatroomBase, cookie, identity, runId, expected) {
  const plaintext = Buffer.from(`VOKO Direct v2 attachment verification. Reply only: ${expected}\n`, 'utf8');
  const encrypted = encryptAttachment(plaintext);
  const uploadName = `${runId}.e2ee`;
  const { data: sign } = await jsonRequest(`${chatroomBase}/api/uploads/authorize`, {
    origin: chatroomBase, cookie,
    headers: { 'idempotency-key': crypto.randomUUID() },
    body: { filename: uploadName, dir: 'chat/e2ee', size: encrypted.uploadBytes.length,
      contentType: 'application/octet-stream', targetScopeType: 'private',
      targetScopeId: identity.target.imUid }
  });
  const form = new FormData();
  for (const [key, value] of Object.entries(sign.fields || {})) form.append(key, String(value));
  form.append('file', new Blob([encrypted.uploadBytes], { type: 'application/octet-stream' }), uploadName);
  const uploaded = await fetch(sign.endpoint, { method: 'POST', body: form,
    signal: AbortSignal.timeout(60_000) });
  if (!uploaded.ok) throw new Error(`E2EE_ATTACHMENT_UPLOAD_HTTP_${uploaded.status}`);
  await jsonRequest(`${chatroomBase}/api/uploads/${encodeURIComponent(sign.uploadId)}/complete`, {
    origin: chatroomBase, cookie, body: {}
  });
  const messageId = `e2ee-${crypto.randomUUID()}`;
  await jsonRequest(`${chatroomBase}/api/uploads/${encodeURIComponent(sign.uploadId)}/bind`, {
    origin: chatroomBase, cookie, body: { referenceType: 'e2ee_message', referenceId: messageId }
  });
  return { messageId, manifest: JSON.stringify({
    type: 'voko.e2ee.attachment-message/1', uploadId: sign.uploadId,
    fileName: 'direct-v2-proof.txt', mediaType: 'text/plain', kind: 'file',
    size: plaintext.length, width: 0, height: 0,
    package: { ...encrypted.publicPackage, key: encrypted.key }
  }) };
}

async function waitForRestartSignal() {
  console.log(JSON.stringify({ phase: 'restart_ready', safeToRestartVoko: true }));
  await new Promise(resolve => {
    process.stdin.resume();
    process.stdin.once('data', resolve);
  });
}

(async () => {
  if (process.platform !== 'win32') throw new Error('E2EE_DIRECT_PRODUCTION_PROBE_REQUIRES_WINDOWS');
  const chatroomBase = String(process.env.VOKO_E2EE_CHATROOM_BASE_URL || 'https://im.vokovoko.com').replace(/\/+$/, '');
  const gatewayBase = String(process.env.VOKO_E2EE_PRODUCTION_TEST_BASE_URL
    || require('../src/endpoints.json').api.baseUrl).replace(/\/+$/, '');
  const agent = localAgent();
  const runId = `direct-v2-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const webDeviceId = `web-probe-${crypto.randomUUID()}`;
  const browserDeviceKeyId = `browser-probe-${crypto.randomUUID()}`;
  const session = await createWebSession(chatroomBase, webDeviceId);
  const identityUrl = `${chatroomBase}/api/e2ee/identity?targetImUid=${encodeURIComponent(agent.targetImUid)}&protocolMode=${PROTOCOL_MODE}`;
  let identity;
  try {
    ({ data: identity } = await jsonRequest(identityUrl, { cookie: session.cookie }));
  } catch (error) {
    if (process.env.VOKO_E2EE_PRODUCTION_EXPECT_DISABLED === '1'
        && error?.status === 404 && error?.code === 'E2EE_DIRECT_V2_DISABLED') {
      console.log(JSON.stringify({ passed: true, check: 'direct_disabled', plaintextFallbacks: 0 }));
      return;
    }
    throw error;
  }
  if (process.env.VOKO_E2EE_PRODUCTION_EXPECT_DISABLED === '1') {
    throw new Error('E2EE_DIRECT_DISABLE_GATE_OPEN');
  }
  if (identity?.target?.protocolMode !== PROTOCOL_MODE || !identity?.target?.directEligible
      || identity?.target?.agentDid !== agent.targetAgentDid) {
    throw new Error('E2EE_DIRECT_PRODUCTION_IDENTITY_INVALID');
  }
  const scopeText = `direct:${browserDeviceKeyId}:${identity.target.agentId}:${identity.target.imUid}`;
  const scope = {
    principal: identity.principalId, device: browserDeviceKeyId,
    agent: identity.target.agentDid, group: b64text(crypto.randomUUID()),
    conversation: b64text(scopeText)
  };
  let creator = endpoint(scope);
  const cursor = { value: 0 };
  const ignoredMessageIds = new Set();
  const checks = [];
  try {
    await creator.ready;
    const { data: reservation } = await jsonRequest(`${chatroomBase}/api/e2ee/key-packages/reserve`, {
      origin: chatroomBase, cookie: session.cookie, body: {
        agentId: identity.target.agentId, targetAgentDid: identity.target.agentDid,
        protocolMode: PROTOCOL_MODE
      }
    });
    if (reservation.protocolMode !== PROTOCOL_MODE) throw new Error('E2EE_DIRECT_RESERVATION_MODE_INVALID');
    const prepared = await creator.request({ op: 'prepare_add', key_package: reservation.keyPackage });
    await creator.request({ op: 'accept_add' });
    const { data: establishment } = await jsonRequest(`${chatroomBase}/api/e2ee/establishments`, {
      origin: chatroomBase, cookie: session.cookie, body: {
        reservationId: reservation.reservationId, agentId: identity.target.agentId,
        groupId: scope.group, conversationScope: scope.conversation,
        commit: prepared.commit, welcome: prepared.welcome, protocolMode: PROTOCOL_MODE
      }
    });
    let active;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      ({ data: active } = await jsonRequest(`${chatroomBase}/api/e2ee/establishments/status`, {
        origin: chatroomBase, cookie: session.cookie,
        body: { establishmentId: establishment.establishmentId, protocolMode: PROTOCOL_MODE }
      }));
      if (active.state === 'active' && active.ack) break;
      if (!['commit_accepted', 'active'].includes(String(active.state))) {
        throw new Error(`E2EE_DIRECT_ESTABLISHMENT_${active.state}`);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (active?.state !== 'active' || !active.ack) throw new Error('E2EE_DIRECT_ESTABLISHMENT_TIMEOUT');
    const ack = JSON.parse(Buffer.from(active.ack, 'base64url').toString('utf8'));
    if ((await creator.request({ op: 'decrypt', envelope: ack })).text !== 'GROUP_ESTABLISHED') {
      throw new Error('E2EE_DIRECT_ACK_INVALID');
    }
    ignoredMessageIds.add(String(ack.messageId));
    checks.push('establishment');

    const firstExpected = `DIRECT_V2_TEXT_OK_${crypto.randomBytes(5).toString('hex')}`;
    await sendExpected({ chatroomBase, gatewayBase, cookie: session.cookie, token: session.token,
      identity, endpointHandle: creator, cursor, ignoredMessageIds, expected: firstExpected,
      label: 'TEXT', localAgentId: agent.localAgentId });
    checks.push('text');

    const snapshot = (await creator.request({ op: 'snapshot' })).snapshot;
    creator.close();
    creator = endpoint(scope);
    await creator.ready;
    await creator.request({ op: 'restore', snapshot });
    const refreshExpected = `DIRECT_V2_REFRESH_OK_${crypto.randomBytes(5).toString('hex')}`;
    await sendExpected({ chatroomBase, gatewayBase, cookie: session.cookie, token: session.token,
      identity, endpointHandle: creator, cursor, ignoredMessageIds, expected: refreshExpected,
      label: 'REFRESH', localAgentId: agent.localAgentId });
    checks.push('creator_refresh');

    const attachmentExpected = `DIRECT_V2_ATTACHMENT_OK_${crypto.randomBytes(5).toString('hex')}`;
    const attachment = await uploadEncryptedAttachment(chatroomBase, session.cookie, identity, runId, attachmentExpected);
    const encryptedAttachment = await creator.request({ op: 'encrypt', message_id: attachment.messageId,
      text: attachment.manifest });
    ignoredMessageIds.add(attachment.messageId);
    await postEncrypted(chatroomBase, session.cookie, identity,
      { ...encryptedAttachment, messageId: attachment.messageId });
    const attachmentReply = await waitForReply(gatewayBase, session.token, identity.callerAgentId,
      identity.target.agentId, creator, cursor, ignoredMessageIds, 180_000);
    ignoredMessageIds.add(attachmentReply.messageId);
    if (!attachmentReply.plaintext.trim()) throw new Error('E2EE_DIRECT_ATTACHMENT_REPLY_EMPTY');
    verifyLocalReceipt(attachment.messageId, attachmentReply.messageId,
      agent.localAgentId, identity.principalId);
    checks.push('attachment');

    if (process.env.VOKO_E2EE_PRODUCTION_RESTART_GATE === '1') {
      await waitForRestartSignal();
      const restartExpected = `DIRECT_V2_RESTART_OK_${crypto.randomBytes(5).toString('hex')}`;
      await sendExpected({ chatroomBase, gatewayBase, cookie: session.cookie, token: session.token,
        identity, endpointHandle: creator, cursor, ignoredMessageIds, expected: restartExpected,
        label: 'RESTART', localAgentId: agent.localAgentId });
      checks.push('voko_restart');
    }

    console.log(JSON.stringify({ passed: true, agentId: agent.localAgentId,
      protocolVersion: 'voko.e2ee/1', protocolMode: PROTOCOL_MODE,
      checks, plaintextFallbacks: 0 }));
  } finally {
    creator?.close();
  }
})().catch(error => {
  console.error(`Direct v2 production probe failed: ${error.code || error.message}`);
  process.exitCode = 1;
});
