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
    { publicAgentId: 'agent-1', localAgentId: 'agent-1' },
    { publicAgentId: 'agent-2', localAgentId: 'agent-2' }]);
  assert.equal(first.mailboxUrl, 'https://did.example/api/internal/a2a-mailbox/v1');
  assert.deepEqual(first.registeredAgentIds, ['agent-1']); assert.deepEqual(first.rejectedAgentIds, ['legacy-alias']);
});
test('registration fingerprint includes the mailbox protocol revision', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'a2a', 'registration.ts'), 'utf8');
  assert.match(source, /registrationVersion: 6/);
});
test('public registration remains available when the A2A message bridge is disabled', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
  const syncDeclaration = source.indexOf('const syncA2ARegistration =');
  const bridgeGuard = source.indexOf('if (a2aModule.enabled && dispatcher)');
  assert.ok(syncDeclaration >= 0 && syncDeclaration < bridgeGuard);
  assert.match(source, /syncA2ARegistration,\s*\n/);
});
test('registration ignores the deprecated independently persisted public A2A choice', async t => {
  const a2aDb = setup(t); a2aDb.prepare("INSERT INTO a2a_agent_publication(agent_id,public_enabled,updated_at) VALUES('agent-1',0,?)").run(Date.now()); let body;
  const service = new A2ARegistrationService({ a2aDb, ownerEmail: 'owner@example.com', userAccessToken: 'ut_secret', apiBaseUrl: 'https://did.example',
    mainDb: { prepare() { return { all: () => [{ agent_id: 'agent-1' }] }; } }, fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body); return { ok: true, async json() { return { token: 'mbx_' + 'x'.repeat(40), mailboxPath: '/mailbox',
        gatewayKeyId: 'gateway-1', gatewayPublicKey: 'public-key' }; } }; } });
  await service.ensureRegistered(); assert.equal(Object.hasOwn(body.agents[0], 'publicEnabled'), false);
});
test('registration maps a local alias to the authoritative Agent UUID in its DID', async t => {
  const a2aDb = setup(t); let body;
  const service = new A2ARegistrationService({ a2aDb, ownerEmail: 'owner@example.com', userAccessToken: 'ut_secret', apiBaseUrl: 'https://did.example',
    mainDb: { prepare() { return { all: () => [{ agent_id: 'lawyer', did: 'did:wba:example.test:2b4a3c62efba4c97add96f09ee092462' }] }; } },
    fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return { ok: true, async json() { return { token: 'mbx_' + 'x'.repeat(40),
      mailboxPath: '/mailbox', gatewayKeyId: 'gateway-1', gatewayPublicKey: 'public-key' }; } }; } });
  await service.ensureRegistered(); assert.deepEqual(body.agents[0], { publicAgentId: '2b4a3c62-efba-4c97-add9-6f09ee092462',
    localAgentId: 'lawyer' });
});
test('registration refuses to create a device without a published Agent', async t => {
  const service = new A2ARegistrationService({ a2aDb: setup(t), ownerEmail: 'owner@example.com', userAccessToken: 'ut_secret', apiBaseUrl: 'https://did.example',
    mainDb: { prepare() { return { all: () => [] }; } }, fetchImpl: async () => assert.fail('must not call') });
  await assert.rejects(() => service.ensureRegistered(), /published Agent/);
});
test('registration classifies a server 404 as no eligible published Agent', async t => {
  const service = new A2ARegistrationService({ a2aDb: setup(t), ownerEmail: 'owner@example.com', userAccessToken: 'ut_secret', apiBaseUrl: 'https://did.example',
    mainDb: { prepare() { return { all: () => [{ agent_id: 'agent-1' }] }; } },
    fetchImpl: async () => ({ ok: false, status: 404 }) });
  await assert.rejects(() => service.ensureRegistered(), error => error.code === 'A2A_NO_ELIGIBLE_AGENT' && error.status === 404);
});
