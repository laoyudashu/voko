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
test('mailbox errors preserve safe machine codes used by retry classification', async () => {
  const client = new A2AMailboxClient({ baseUrl: 'https://did.example/mailbox', token: 'x'.repeat(32),
    fetchImpl: async () => ({ ok: false, status: 409, async json() {
      return { error: { code: 'A2A_EVENT_SEQUENCE_GAP', expectedSequence: 2 } };
    } }) });
  await assert.rejects(() => client.sendEvent({}), error => error.status === 409
    && error.code === 'A2A_EVENT_SEQUENCE_GAP' && error.expectedSequence === 2);
});
test('event reconciliation uses the authenticated mailbox endpoint', async () => {
  const calls = []; const client = new A2AMailboxClient({ baseUrl: 'https://did.example/mailbox', token: 'x'.repeat(32),
    fetchImpl: async (url, options) => { calls.push({ url, options }); return { ok: true, status: 200,
      async json() { return { found: true, taskId: 'task-1', gatewaySequence: 3 }; } }; } });
  assert.deepEqual(await client.findEvent('event:1'), { found: true, taskId: 'task-1', gatewaySequence: 3 });
  assert.equal(calls[0].url, 'https://did.example/mailbox/events/event%3A1'); assert.equal(calls[0].options.method, 'GET');
});
test('outbound cancellation remains scoped to one local Agent', async () => {
  const calls = []; const client = new A2AMailboxClient({ baseUrl: 'https://did.example/mailbox', token: 'x'.repeat(32),
    fetchImpl: async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return { ok: true, status: 200,
      async json() { return { cancelOutcome: 'accepted' }; } }; } });
  await client.cancelOutboundTask('agent-1', 'task-1');
  assert.equal(calls[0].url, 'https://did.example/mailbox/outbound/tasks/task-1:cancel');
  assert.deepEqual(calls[0].body, { localAgentId: 'agent-1' });
});
