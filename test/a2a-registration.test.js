'use strict';
const assert = require('node:assert/strict'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const test = require('node:test');
const { A2ARegistrationService, initA2ADatabase } = require('../build/a2a');
function setup(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-registration-')); const db = initA2ADatabase(path.join(dir, 'a.db'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }); return db; }
test('registration binds published owner Agents and reuses unchanged configuration', async t => {
  const a2aDb = setup(t); let calls = 0; let body;
  const service = new A2ARegistrationService({ a2aDb, ownerEmail: 'owner@example.com', userAccessToken: 'ut_secret', apiBaseUrl: 'https://did.example',
    mainDb: { prepare() { return { all: () => [{ agent_id: 'agent-1' }, { agent_id: 'agent-2' }] }; } },
    fetchImpl: async (_url, options) => { calls += 1; body = JSON.parse(options.body); return { ok: true, status: 200, async json() { return {
      token: 'mbx_' + 'x'.repeat(40), mailboxPath: '/api/internal/a2a-mailbox/v1', gatewayKeyId: 'gateway-1', gatewayPublicKey: 'public-key',
      registeredAgentIds: ['agent-1'], rejectedAgentIds: ['legacy-alias'] }; } }; } });
  const first = await service.ensureRegistered(); const second = await service.ensureRegistered();
  assert.equal(calls, 1); assert.equal(first.token, second.token); assert.deepEqual(body.agents, [
    { publicAgentId: 'agent-1', localAgentId: 'agent-1' }, { publicAgentId: 'agent-2', localAgentId: 'agent-2' }]);
  assert.equal(first.mailboxUrl, 'https://did.example/api/internal/a2a-mailbox/v1');
  assert.deepEqual(first.registeredAgentIds, ['agent-1']); assert.deepEqual(first.rejectedAgentIds, ['legacy-alias']);
});
test('registration fingerprint includes the mailbox protocol revision', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'a2a', 'registration.ts'), 'utf8');
  assert.match(source, /registrationVersion: 2/);
});
test('registration refuses to create a device without a published Agent', async t => {
  const service = new A2ARegistrationService({ a2aDb: setup(t), ownerEmail: 'owner@example.com', userAccessToken: 'ut_secret', apiBaseUrl: 'https://did.example',
    mainDb: { prepare() { return { all: () => [] }; } }, fetchImpl: async () => assert.fail('must not call') });
  await assert.rejects(() => service.ensureRegistered(), /published Agent/);
});
