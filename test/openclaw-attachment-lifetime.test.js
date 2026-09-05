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

test('ambiguous late session finals retain both turns rather than removing newer attachments', async t => {
  const { provider, payload, sends } = fixture(t);
  await provider.push(payload);
  // Exercise the same release callback used by the active-turn timeout, without waiting 130 seconds.
  provider._activeAgentTurns.get(payload.agentId).release();
  await provider.push({ ...payload, messageId: 'newer-turn' });
  provider._emitAgentReplyFromSession(sends[1].session, 'late session-only final', { turnId: 'newer-turn' });
  assert.equal(fs.existsSync(sends[0].path), true);
  assert.equal(fs.existsSync(sends[1].path), true);
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
