const test = require('node:test');
const assert = require('node:assert/strict');
const { E2eeDirectoryClient } = require('../build/e2ee/directory-client');

function response(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
}

test('directory client authenticates requests and preserves trusted conversation scope', async () => {
  const calls = [];
  const client = new E2eeDirectoryClient({ baseUrl: 'https://example.test', token: 'ut_secret', fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return response({ success: true, data: { establishments: [{ establishmentId: 'est-1', creatorPrincipalId: 'principal-1',
      keyPackageRef: Buffer.alloc(32, 1).toString('base64url'), keyEpoch: 2,
      groupId: Buffer.from('group').toString('base64url'), conversationScope: Buffer.from('conversation').toString('base64url'),
      commit: Buffer.from('commit').toString('base64url'), welcome: Buffer.from('welcome').toString('base64url'),
      state: 'commit_accepted', conversationMode:'e2ee_available',ownerEpoch:1,bindingGeneration:1,policyRevision:1,mlsEpoch:0,
      expiresAt: new Date(Date.now() + 60_000).toISOString() }] } });
  } });
  const rows = await client.pullEstablishments({ agentId: 'agent-1', ownerDeviceKeyId: 'device-1' });
  assert.equal(Buffer.from(rows[0].conversationScope, 'base64url').toString(), 'conversation');
  assert.equal(calls[0].url, 'https://example.test/api/external/v1/e2ee/establishments/pull');
  assert.equal(calls[0].init.headers.authorization, 'Bearer ut_secret');
});

test('directory client fails closed on a missing conversation scope', async () => {
  const client = new E2eeDirectoryClient({ baseUrl: 'https://example.test', token: 'ut_secret', fetchImpl: async () =>
    response({ success: true, data: { establishments: [{ establishmentId: 'est-1' }] } }) });
  await assert.rejects(client.pullEstablishments({ agentId: 'agent-1', ownerDeviceKeyId: 'device-1' }),
    /E2EE_DIRECTORY_INVALID_CREATOR_PRINCIPAL_ID|E2EE_DIRECTORY_INVALID_CONVERSATION_SCOPE/);
});

test('directory client rejects insecure remote origins', () => {
  assert.throws(() => new E2eeDirectoryClient({ baseUrl: 'http://example.test', token: 'ut_secret' }), /HTTPS_REQUIRED/);
});

test('directory client exposes bounded Retry-After for production backoff', async () => {
  const client = new E2eeDirectoryClient({ baseUrl:'https://example.test',token:'ut_secret',fetchImpl:async () =>
    response({ success:false,error:{ code:'RATE_LIMITED' } },429,{ 'retry-after':'12' }) });
  await assert.rejects(client.registerDevice({ ownerDeviceKeyId:'device',keyEpoch:1,credentialPublicKey:'key' }), error => {
    assert.equal(error.status,429);
    assert.equal(error.retryAfterMs,12_000);
    return true;
  });
});
