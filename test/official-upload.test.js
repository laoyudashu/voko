const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('official upload authorizes, uploads opaque fields, completes and binds without a local OSS secret', async () => {
  process.env.VOKO_E2E_API_BASE_URL = 'https://api.example';
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/authorize')) return { ok: true, status: 201, json: async () => ({ success: true, data: {
      uploadId: 'upload-1', endpoint: 'https://bucket.example', fields: { key: 'staging/one', policy: 'opaque', 'x-oss-security-token': 'temporary', 'Content-Type': 'application/octet-stream' }
    } }) };
    if (String(url) === 'https://bucket.example') return { ok: true, status: 204 };
    if (String(url).endsWith('/complete')) return { ok: true, status: 200, json: async () => ({ success: true, data: { url: 'https://files.example/final' } }) };
    if (String(url).endsWith('/bind')) return { ok: true, status: 200, json: async () => ({ success: true, data: { status: 'bound' } }) };
    throw new Error(`unexpected URL ${url}`);
  };
  try {
    const { uploadToOSS } = require('../build/server/oss');
    const url = await uploadToOSS('chat/files/report.txt', Buffer.from('safe'), 'text/plain', null, {
      userAccessToken: 'ut_test', agentId: 'agent-1', purpose: 'agent_attachment', fileName: 'report.txt',
      targetScopeType: 'private', targetScopeId: 'peer-1'
    });
    assert.equal(url, 'https://files.example/final');
    assert.equal(calls.length, 4);
    assert.equal(calls[0].options.headers.Authorization, 'Bearer ut_test');
    assert.deepEqual(JSON.parse(calls[0].options.body).targetScopeType, 'private');
    assert.deepEqual(JSON.parse(calls[0].options.body).targetScopeId, 'peer-1');
    assert.equal(calls[1].options.headers?.Authorization, undefined);
    assert.match(String(calls[1].options.body), /FormData/);
    assert.equal(calls[1].options.body.get('file').type, 'application/octet-stream');
  } finally { global.fetch = originalFetch; delete process.env.VOKO_E2E_API_BASE_URL; }
});

test('runtime source no longer reads long-term OSS credentials and sanitizes legacy database values', () => {
  const oss = fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'oss.ts'), 'utf8');
  const database = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'database.ts'), 'utf8');
  assert.doesNotMatch(oss, /OSS_ACCESS_KEY_ID|OSS_ACCESS_KEY_SECRET/);
  assert.match(database, /已清除本地数据库中的废弃 OSS 长期凭证/);
});

test('private attachment completion returns a local authenticated download path', async () => {
  process.env.VOKO_E2E_API_BASE_URL = 'https://api.example';
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).endsWith('/authorize')) return { ok: true, status: 201, json: async () => ({ success: true, data: {
      uploadId: 'upload-private', endpoint: 'https://bucket.example', fields: { key: 'staging/private' }
    } }) };
    if (String(url) === 'https://bucket.example') return { ok: true, status: 204 };
    if (String(url).endsWith('/complete')) return { ok: true, status: 200, json: async () => ({ success: true,
      data: { access: 'private', downloadPath: '/api/uploads/upload-private/download' } }) };
    if (String(url).endsWith('/bind')) return { ok: true, status: 200, json: async () => ({ success: true, data: { status: 'bound' } }) };
    throw new Error(`unexpected URL ${url}`);
  };
  try {
    const { uploadToOSS } = require('../build/server/oss');
    const url = await uploadToOSS('chat/files/private.txt', Buffer.from('safe'), 'text/plain', null, {
      userAccessToken: 'ut_test', agentId: 'agent-1', purpose: 'agent_attachment', fileName: 'private.txt',
      targetScopeType: 'private', targetScopeId: 'peer-1'
    });
    assert.equal(url, '/api/uploads/upload-private/download');
  } finally { global.fetch = originalFetch; delete process.env.VOKO_E2E_API_BASE_URL; }
});

test('local web keeps ordinary private downloads and exposes only locally decrypted E2EE v2 attachments', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
  const web = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'index.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'message-content.js'), 'utf8');
  assert.match(index, /\/api\/uploads\/:uploadId\/download/);
  assert.match(index, /getUploadDownload/);
  assert.match(renderer, /\^\\\/api\\\/uploads/);
  assert.match(index, /\/api\/e2ee-v2\/attachments\/:messageId/);
  assert.match(index, /e2eeRuntime\.attachment/);
  assert.doesNotMatch(web, /\/api\/e2ee\/attachments/);
  assert.doesNotMatch(web, /authorizeAttachmentDownload\(info\.uploadId/);
});

test('official upload paths translate local agent ids to canonical server agent ids', () => {
  const { resolveServerAgentIdForLocalAgent } = require('../build/core/agent-invitations');
  const db = {
    prepare() {
      return { get: localAgentId => localAgentId === 'gym'
        ? { did: 'did:wba:example.test:2b4a3c62efba4c97add96f09ee092462' }
        : undefined };
    },
  };
  assert.equal(resolveServerAgentIdForLocalAgent(db, 'gym'), '2b4a3c62-efba-4c97-add9-6f09ee092462');
  assert.throws(() => resolveServerAgentIdForLocalAgent(db, 'missing'), /Agent 不存在/);

  const context = fs.readFileSync(path.join(__dirname, '..', 'src', 'context.ts'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
  assert.match(context, /agentId: serverAgentId, purpose: 'agent_attachment'/);
  assert.match(index, /getUploadDownload\(req\.params\.uploadId, token, serverAgentId/);
  assert.match(index, /purpose: 'agent_icon'/);
});
