const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const OpenClawWsProvider = require('../build/core/dispatcher/providers/openclaw-ws');
const { cleanupExpiredProviderAttachmentStaging, STAGING_MAX_AGE_MS } = require('../build/core/dispatcher/provider-attachments');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-ws-lifetime-'));
  t.mock.method(os, 'tmpdir', () => root);
  t.mock.method(OpenClawWsProvider.prototype, 'loadConfig', () => true);
  t.mock.method(OpenClawWsProvider.prototype, 'startConfigWatcher', () => {});
  const provider = new OpenClawWsProvider(null, null);
  provider.connected = true;
  provider.ws = { readyState: 1, removeAllListeners() {}, close() { this.readyState = 3; } };
  provider.attachmentRetentionMs = 1000;
  const bytes = Buffer.from('synthetic delayed attachment');
  const original = path.join(root, 'input.txt');
  fs.writeFileSync(original, bytes);
  const payload = { agentId: 'agent-a', fromUid: 'visitor', messageId: 'turn-a', content: 'read later', attachments: [{
    path: original, name: 'input.txt', mediaType: 'text/plain', size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  }] };
  t.after(() => {
    provider.destroy();
    for (const retained of provider._turnAttachments?.values() || []) retained.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const sends = [];
  provider.sendToSession = async (session, prompt, metadata) => {
    sends.push({ session, path: prompt.match(/local_path=([^\n]+)/)[1], turnId: metadata.turnId });
  };
  return { provider, payload, sends };
}

test('WS accepted receipt preserves staged paths for delayed reads and correlated final cleans them', async t => {
  const { provider, payload, sends } = fixture(t);
  const receipt = await provider.push(payload);
  assert.equal(receipt.attachmentDelivery.transportDelivered, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fs.readFileSync(sends[0].path, 'utf8'), 'synthetic delayed attachment');
  provider._emitAgentReplyFromSession(sends[0].session, 'synthetic final', { turnId: 'turn-a' });
  assert.equal(fs.existsSync(sends[0].path), false);
});

test('WS final cleans only that Agent turn, including identical response text', async t => {
  const { provider, payload, sends } = fixture(t);
  await provider.push(payload);
  await provider.push({ ...payload, agentId: 'agent-b', messageId: 'turn-b' });
  provider._emitAgentReplyFromSession(sends[0].session, 'done', { turnId: 'turn-a' });
  assert.equal(fs.existsSync(sends[0].path), false);
  assert.equal(fs.existsSync(sends[1].path), true);
  provider._emitAgentReplyFromSession(sends[1].session, 'done', { turnId: 'turn-b' });
  assert.equal(fs.existsSync(sends[1].path), false);
});

test('WS unknown send and disconnect retain files until bounded expiry', async t => {
  const { provider, payload, sends } = fixture(t);
  provider.attachmentRetentionMs = 30;
  const originalSend = provider.sendToSession;
  provider.sendToSession = async (...args) => {
    await originalSend(...args);
    throw Object.assign(new Error('synthetic uncertain write'), { deliveryOutcome: 'outcome_unknown' });
  };
  await assert.rejects(provider.push(payload), /synthetic uncertain write/);
  provider.disconnect();
  assert.equal(fs.existsSync(sends[0].path), true);
  await new Promise(resolve => setTimeout(resolve, 65));
  assert.equal(fs.existsSync(sends[0].path), false);
});

test('the existing staging-age sweep reclaims retained files after runtime restart', async t => {
  const { provider, payload, sends } = fixture(t);
  await provider.push(payload);
  provider.destroy();
  assert.equal(fs.existsSync(sends[0].path), true);
  const stagingRoot = path.dirname(path.dirname(sends[0].path));
  cleanupExpiredProviderAttachmentStaging(stagingRoot, Date.now() + STAGING_MAX_AGE_MS + 1000);
  assert.equal(fs.existsSync(sends[0].path), false);
});

test('WS subscription failure before chat submission cleans immediately', async t => {
  const { provider, payload, sends } = fixture(t);
  const originalSend = provider.sendToSession;
  provider.sendToSession = async (...args) => {
    await originalSend(...args);
    throw Object.assign(new Error('synthetic subscription rejection'), { deliveryOutcome: 'not_delivered' });
  };
  await assert.rejects(provider.push(payload), /subscription rejection/);
  assert.equal(fs.existsSync(sends[0].path), false);
});

for (const disconnected of [false, true]) for (const oldHasFiles of [true, false]) for (const explicit of [true, false]) test(`real chat final preserves newer attachments after an unknown turn (disconnect=${disconnected}, oldFiles=${oldHasFiles}, explicit=${explicit})`, async t => {
  const { provider, payload } = fixture(t);
  delete provider.sendToSession;
  provider._supportsSessionSubscribe = () => false;
  const requests = []; provider.send = request => { requests.push(request); };
  const replies = []; provider.on('agent.reply', reply => replies.push(reply));
  await provider.push({ ...payload, messageId: 'old-empty', attachments: oldHasFiles ? payload.attachments : [] });
  provider._activeAgentTurns.get(payload.agentId).release();
  if (disconnected) {
    provider.disconnect(); provider.connected = true;
    provider.ws = { readyState: 1, removeAllListeners() {}, close() { this.readyState = 3; } };
  }
  await provider.push({ ...payload, messageId: 'new-files' });
  const sent = requests.filter(request => request.method === 'chat.send').at(-1);
  const stagedPath = JSON.parse(sent.params.message).content.match(/local_path=([^\n]+)/)[1];
  const sessionKey = sent.params.sessionKey;
  provider._handleChatEvent({ payload: { state: 'final', sessionKey,
    ...(explicit ? { turnId: 'old-empty' } : {}), runId: 'old-run',
    message: { role: 'assistant', content: [{ type: 'text', text: 'old final' }] } } });
  assert.equal(fs.existsSync(stagedPath), true);
  assert.equal(provider._activeAgentTurns.get(payload.agentId)?.turnId, 'new-files');
  if (explicit) assert.equal(replies.at(-1)?.turnId, 'old-empty');
  else assert.deepEqual(replies, []);
  provider._handleChatEvent({ payload: { state: 'final', sessionKey, turnId: 'new-files',
    message: { role: 'assistant', content: [{ type: 'text', text: 'new final' }] } } });
  assert.equal(fs.existsSync(stagedPath), false);
});

test('a completed turn duplicate cannot release the next turn, whose same-text final remains valid', async t => {
  const { provider, payload } = fixture(t);
  delete provider.sendToSession; provider._supportsSessionSubscribe = () => false;
  const requests = []; provider.send = request => requests.push(request);
  const replies = []; provider.on('agent.reply', reply => replies.push(reply));
  await provider.push({ ...payload, messageId: 'completed-old', attachments: [] });
  const sessionKey = requests.find(request => request.method === 'chat.send').params.sessionKey;
  const final = (runId, replyId) => ({ payload: { state: 'final', sessionKey, runId,
    message: { id: replyId, role: 'assistant', content: [{ type: 'text', text: 'identical final text' }] } } });
  const oldFinal = final('old-run', 'old-reply'); provider._handleChatEvent(oldFinal);
  await provider.push({ ...payload, messageId: 'new-files' });
  const sent = requests.filter(request => request.method === 'chat.send').at(-1);
  const stagedPath = JSON.parse(sent.params.message).content.match(/local_path=([^\n]+)/)[1];
  provider._handleChatEvent(oldFinal);
  assert.equal(fs.existsSync(stagedPath), true);
  assert.equal(provider._activeAgentTurns.get(payload.agentId)?.turnId, 'new-files');
  const newFinal = final('new-run', 'new-reply'); newFinal.payload.turnId = 'new-files';
  provider._handleChatEvent(newFinal);
  assert.equal(fs.existsSync(stagedPath), false);
  assert.deepEqual(replies.map(reply => reply.turnId), ['completed-old', 'new-files']);
});

test('a session-only final can finish a single turn but cannot prove its attachment read is complete', async t => {
  const { provider, payload } = fixture(t);
  delete provider.sendToSession; provider._supportsSessionSubscribe = () => false;
  const requests = []; provider.send = request => requests.push(request);
  await provider.push(payload);
  const sent = requests.find(request => request.method === 'chat.send');
  const stagedPath = JSON.parse(sent.params.message).content.match(/local_path=([^\n]+)/)[1];
  provider._handleChatEvent({ payload: { state: 'final', sessionKey: sent.params.sessionKey, runId: 'backend-only-id',
    message: { role: 'assistant', content: [{ type: 'text', text: 'legacy final' }] } } });
  assert.equal(fs.existsSync(stagedPath), true);
});


test('unknown session metadata is bounded and rejects new sessions before submission at capacity', async t => {
  const { provider } = fixture(t); let sends = 0; provider.send = () => { sends++; };
  for (let i = 0; i < 1000; i++) await provider.sendChatSend(`agent:synthetic:visitor-${i}`, 'synthetic', { turnId: `turn-${i}` });
  await assert.rejects(() => provider.sendChatSend('agent:synthetic:overflow', 'synthetic', { turnId: 'overflow' }),
    error => error.code === 'PROVIDER_SESSION_CAPACITY' && error.deliveryOutcome === 'not_delivered');
  assert.equal(sends, 1000);
  assert.equal(provider._sessionTurns.size, 1000);
  // Existing unknown sessions retain their state and cannot misattribute old finals.
  await provider.sendChatSend('agent:synthetic:visitor-0', 'synthetic', { turnId: 'new-turn' });
  assert.equal(provider._replyIdentity({ payload: {} }, 'agent:synthetic:visitor-0').ambiguous, true);
  assert.equal(sends, 1001);
  provider._handleChatEvent({ payload: { state: 'final', sessionKey: 'agent:synthetic:visitor-1', turnId: 'turn-1',
    message: { role: 'assistant', content: [{ type: 'text', text: 'completed' }] } } });
  await provider.sendChatSend('agent:synthetic:overflow', 'synthetic', { turnId: 'overflow' });
  assert.equal(sends, 1002, 'a confirmed, unambiguous completed session makes room for a new one');
});
