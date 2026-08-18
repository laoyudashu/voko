const test = require('node:test');
const assert = require('node:assert/strict');

const { validateImUidExists } = require('../build/core/im-user-validation');

test('IM UID validation accepts the exact directory identity regardless of user type', async () => {
  const calls = [];
  for (const isHuman of [0, 1]) {
    const result = await validateImUidExists('recipient uid', {
      baseUrl: 'https://im.example.test',
      fetchImpl: async (url) => {
        calls.push(url);
        return { ok: true, status: 200, json: async () => ({ uid: 'recipient uid', is_human: isHuman }) };
      },
    });
    assert.deepEqual(result, { exists: true });
  }
  assert.equal(calls[0], 'https://im.example.test/api/users/recipient%20uid');
});

test('IM UID validation rejects a missing or mismatched identity', async () => {
  const missing = await validateImUidExists('missing', {
    baseUrl: 'https://im.example.test',
    fetchImpl: async () => ({ ok: false, status: 404 }),
  });
  assert.deepEqual(missing, { exists: false, reason: 'not_found' });

  const mismatch = await validateImUidExists('expected', {
    baseUrl: 'https://im.example.test',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ uid: 'different', is_human: 0 }) }),
  });
  assert.deepEqual(mismatch, { exists: false, reason: 'identity_mismatch' });
});

test('IM UID validation fails closed when the directory is unavailable', async () => {
  await assert.rejects(validateImUidExists('recipient-1', {
    baseUrl: 'https://im.example.test',
    fetchImpl: async () => ({ ok: false, status: 401 }),
  }), /HTTP 401/);
});
