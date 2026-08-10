'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { AcpAdapter } = require('../build/core/adapters/acp-adapter');
const { OpenCodeAcpProvider } = require('../build/core/dispatcher/providers/opencode-acp');
const { OpenCodeCliProvider } = require('../build/core/dispatcher/providers/opencode-cli');
const { OpenCodeAttachProvider } = require('../build/core/dispatcher/providers/opencode-attach');
const {
  buildOpenCodeVisitorContent,
  isolatedOpenCodeEnv,
} = require('../build/core/dispatcher/providers/opencode-runtime');

function sessionDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE agent_session_handles (
      agent_id TEXT NOT NULL,
      visitor_id TEXT NOT NULL,
      adapter_type TEXT NOT NULL,
      session_handle TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(agent_id, visitor_id, adapter_type)
    )
  `);
  return db;
}

test('OpenCode child processes deny tools and project configuration', () => {
  const env = isolatedOpenCodeEnv();
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, 'true');
  for (const permission of ['*', 'read', 'edit', 'bash', 'task', 'skill', 'webfetch', 'external_directory']) {
    assert.equal(config.permission[permission], 'deny');
  }
});

test('OpenCode visitor prompts carry explicit role and session boundaries', () => {
  const prompt = buildOpenCodeVisitorContent('agent-a', 'visitor-b', 'hello');
  assert.match(prompt, /agent=agent-a; visitor=visitor-b/);
  assert.match(prompt, /text-only external visitor conversation/);
  assert.match(prompt, /Never access another visitor session/);
  assert.match(prompt, /Visitor message:\nhello/);
});

test('OpenCode CLI resumes the exact ACP native session instead of continuing the latest session', () => {
  const provider = new OpenCodeCliProvider();
  const args = provider._argsForSession('session-from-acp', false);
  assert.deepEqual(args.slice(-3), ['--session', 'session-from-acp', '{prompt}']);
  assert.equal(args.includes('--continue'), false);
  assert.equal(provider.acceptsBinding({ providerType: 'opencode' }, 'agent-a'), true);
  assert.equal(provider._sessionIdFromLine(JSON.stringify({ type: 'step_start', sessionID: 'session-from-acp' })), 'session-from-acp');
});

test('ACP session handles are isolated by agent, visitor, and adapter', () => {
  const db = sessionDb();
  try {
    const acp = new AcpAdapter({ db, adapterType: 'opencode-acp' });
    const other = new AcpAdapter({ db, adapterType: 'another-acp' });
    acp._saveSessionHandle('agent-a', 'visitor-a', 'session-a');
    acp._saveSessionHandle('agent-b', 'visitor-a', 'session-b');
    other._saveSessionHandle('agent-a', 'visitor-a', 'session-c');

    assert.equal(acp._loadSessionHandle('agent-a', 'visitor-a'), 'session-a');
    assert.equal(acp._loadSessionHandle('agent-b', 'visitor-a'), 'session-b');
    assert.equal(other._loadSessionHandle('agent-a', 'visitor-a'), 'session-c');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM agent_session_handles').get().count, 3);
  } finally {
    db.close();
  }
});

test('attach sessions cannot cross agent or visitor boundaries', () => {
  const db = sessionDb();
  try {
    const provider = new OpenCodeAttachProvider({ db });
    provider._saveSession('agent-a', 'visitor-a', 'session-a');
    provider._saveSession('agent-a', 'visitor-b', 'session-b');
    provider._saveSession('agent-b', 'visitor-a', 'session-c');

    assert.equal(provider._loadSession('agent-a', 'visitor-a'), 'session-a');
    assert.equal(provider._loadSession('agent-a', 'visitor-b'), 'session-b');
    assert.equal(provider._loadSession('agent-b', 'visitor-a'), 'session-c');
    assert.equal(provider._loadSession('agent-b', 'visitor-b'), null);
  } finally {
    db.close();
  }
});

test('attach reads the latest assistant text from its authenticated session only', async () => {
  const provider = new OpenCodeAttachProvider();
  provider._port = 4096;
  provider._password = 'test-password';
  const originalFetch = global.fetch;
  let requestedUrl = '';
  let authorization = '';
  global.fetch = async (url, options) => {
    requestedUrl = String(url);
    authorization = options.headers.Authorization;
    return new Response(JSON.stringify([
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'old' }] },
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'question' }] },
      { info: { role: 'assistant' }, parts: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: 'latest' }] },
    ]), { status: 200 });
  };
  try {
    assert.equal(await provider._loadLatestReply('session/a'), 'latest');
    assert.match(requestedUrl, /session\/session%2Fa\/message$/);
    assert.equal(authorization, `Basic ${Buffer.from('opencode:test-password').toString('base64')}`);
  } finally {
    global.fetch = originalFetch;
  }
});

test('attach does not retry an indeterminate timeout with a fresh session', async () => {
  const provider = new OpenCodeAttachProvider();
  let attempts = 0;
  let staleMarks = 0;
  provider._bindingStore = { markStale: () => { staleMarks++; } };
  provider._pushOnce = async () => {
    attempts++;
    throw new Error('cli timeout (120000ms)');
  };
  const binding = { id: 'binding-1', providerType: 'opencode' };
  await assert.rejects(() => provider.push({
    agentId: 'agent-a',
    fromUid: 'visitor-a',
    content: 'hello',
    messageId: 'message-a',
    timestamp: Date.now(),
    providerBinding: binding,
  }), /timeout/);
  assert.equal(attempts, 1);
  assert.equal(staleMarks, 0);
});

test('OpenCode ACP reports failure to Dispatcher instead of switching adapters internally', async () => {
  const provider = new OpenCodeAcpProvider();
  const calls = [];
  provider._pushViaAcp = async () => {
    calls.push('acp');
    const error = new Error('acp unavailable');
    error.deliveryOutcome = 'not_delivered';
    throw error;
  };
  await assert.rejects(() => provider.push({
    agentId: 'agent-a',
    fromUid: 'visitor-a',
    content: 'hello',
    messageId: 'message-a',
    timestamp: Date.now(),
  }), /acp unavailable/);
  assert.deepEqual(calls, ['acp']);
});
