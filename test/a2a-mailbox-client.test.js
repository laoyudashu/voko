'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { A2AMailboxClient, normalizeMailboxBaseUrl } = require('../build/a2a');
test('mailbox URL requires HTTPS except loopback development', () => {
  assert.equal(normalizeMailboxBaseUrl('https://did.example/a2a/'), 'https://did.example/a2a');
  assert.equal(normalizeMailboxBaseUrl('http://127.0.0.1:3001/a2a'), 'http://127.0.0.1:3001/a2a');
  assert.throws(() => normalizeMailboxBaseUrl('http://did.example/a2a'), /HTTPS/);
});
test('claim and ack use only the dedicated mailbox endpoints', async () => {
  const calls = []; const fetchImpl = async (url, options) => { calls.push({ url, options }); return {
    ok: true, status: 200, async json() { return url.endsWith('/claim') ? { leaseId: 'lease-1', items: [] } : { acknowledged: true }; } }; };
  const client = new A2AMailboxClient({ baseUrl: 'https://did.example/internal/a2a-mailbox/v1', token: 'x'.repeat(32), fetchImpl });
  assert.deepEqual(await client.claim(), { leaseId: 'lease-1', items: [] }); await client.acknowledge('lease-1', 'event-1');
  assert.deepEqual(calls.map(call => call.url), ['https://did.example/internal/a2a-mailbox/v1/claim', 'https://did.example/internal/a2a-mailbox/v1/ack']);
  assert.equal(calls[0].options.headers.authorization, `Bearer ${'x'.repeat(32)}`);
});
test('mailbox errors expose status but never the device token', async () => {
  const token = 'secret-device-token-that-must-not-leak';
  const client = new A2AMailboxClient({ baseUrl: 'https://did.example/mailbox', token,
    fetchImpl: async () => ({ ok: false, status: 401 }) });
  await assert.rejects(() => client.claim(), error => error.status === 401 && !error.message.includes(token));
});
