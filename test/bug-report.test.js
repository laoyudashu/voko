const test = require('node:test');
const assert = require('node:assert/strict');

const { createBugReportClient } = require('../build/core/bug-report');
const { version: packageVersion } = require('../package.json');

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
      clientVersion: packageVersion,
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

test('bug report query uses the current email and user access token', async () => {
  const originalFetch = global.fetch;
  let body, headers;
  global.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    headers = options.headers;
    return { ok: true, json: async () => ({ success: true, status: 'pending' }) };
  };
  try {
    const db = {
      prepare(sql) {
        return { get(_type) {
          if (sql.includes('type = ?') && _type === 'current_user_email') return { data: JSON.stringify('owner@example.com') };
          if (sql.includes('type = ?')) return { data: JSON.stringify({ 'owner@example.com': { user_access_token: 'user-token' } }) };
          return undefined;
        } };
      },
    };
    const report = createBugReportClient({ apiBaseUrl: 'https://api.example.com', db });
    await report({ action: 'query' });
    assert.deepEqual(body, { action: 'query' });
    assert.equal(headers.Authorization, 'Bearer user-token');
  } finally {
    global.fetch = originalFetch;
  }
});

test('anonymous bug reports optionally keep a normalized email for later account history', async () => {
  const originalFetch = global.fetch;
  const bodies = [];
  global.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ success: true }) };
  };
  try {
    const report = createBugReportClient({ apiBaseUrl: 'https://api.example.com', db: null });
    await report({ action: 'submit', title: 'With email', description: 'Failed', ownerEmail: ' Owner@Example.COM ' });
    await report({ action: 'submit', title: 'Anonymous', description: 'Failed' });
    assert.equal(bodies[0].ownerEmail, 'owner@example.com');
    assert.equal(bodies[1].ownerEmail, '');
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
    assert.equal((await report({ action: 'submit', title: 'Broken', description: 'Failed', ownerEmail: 'not-an-email' })).success, false);
    assert.equal((await report({ action: 'query' })).success, false);
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
