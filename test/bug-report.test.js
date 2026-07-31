const test = require('node:test');
const assert = require('node:assert/strict');

const { createBugReportClient } = require('../build/core/bug-report');

test('bug report submit adds detected Agent metadata without authentication', async () => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ success: true, reportId: 'BR-1', queryToken: 'token' }) };
  };
  const db = {
    prepare() {
      return { get: () => ({ agent_id: 'agent-1', backend_type: 'openclaw', owner_email: 'owner@example.com' }) };
    },
  };
  try {
    const report = createBugReportClient({ apiBaseUrl: 'https://api.example.com/', db });
    const result = await report({ action: 'submit', title: 'Broken', description: 'It failed', agentId: 'agent-1' });
    assert.equal(result.success, true);
    assert.equal(request.url, 'https://api.example.com/api/external/v1/bug-report');
    assert.equal(request.options.headers.Authorization, undefined);
    assert.deepEqual(JSON.parse(request.options.body), {
      action: 'submit',
      title: 'Broken',
      description: 'It failed',
      steps: '',
      expected: '',
      actual: '',
      severity: 'medium',
      category: 'bug',
      clientVersion: '0.4.0',
      platform: process.platform,
      agentId: 'agent-1',
      agentType: 'openclaw',
      ownerEmail: 'owner@example.com',
      source: 'lite',
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('bug report query only sends report credentials', async () => {
  const originalFetch = global.fetch;
  let body;
  global.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return { ok: true, json: async () => ({ success: true, status: 'pending' }) };
  };
  try {
    const report = createBugReportClient({ apiBaseUrl: 'https://api.example.com', db: null });
    await report({ action: 'query', reportId: 'BR-2', queryToken: 'private-token', ownerEmail: 'ignored@example.com' });
    assert.deepEqual(body, { action: 'query', reportId: 'BR-2', queryToken: 'private-token' });
  } finally {
    global.fetch = originalFetch;
  }
});

test('bug report validates required fields before network access', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => assert.fail('fetch should not be called');
  try {
    const report = createBugReportClient({ apiBaseUrl: 'https://api.example.com', db: null });
    assert.equal((await report({ action: 'submit', title: '', description: '' })).success, false);
    assert.equal((await report({ action: 'query', reportId: 'BR-3' })).success, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('bug report preserves structured server error code and message', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 429,
    json: async () => ({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many reports' } }),
  });
  try {
    const report = createBugReportClient({ apiBaseUrl: 'https://api.example.com', db: null });
    assert.deepEqual(
      await report({ action: 'submit', title: 'Broken', description: 'It failed' }),
      { success: false, error: 'Too many reports', code: 'RATE_LIMITED' },
    );
  } finally {
    global.fetch = originalFetch;
  }
});
