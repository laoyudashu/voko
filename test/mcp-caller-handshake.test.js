const assert = require('node:assert/strict');
const test = require('node:test');

const {
  completeMcpCallerHandshake,
  isMcpCallerHandshakeEnabled,
  issueMcpCallerHandshake,
  resetMcpCallerHandshakes,
  resolveMcpCallerHandshake,
} = require('../build/core/mcp-caller-handshake');

test.beforeEach(() => resetMcpCallerHandshakes());

test('MCP caller handshake is default-off', () => {
  assert.equal(isMcpCallerHandshakeEnabled({}), false);
  assert.equal(isMcpCallerHandshakeEnabled({ VOKO_MCP_IDENTITY_HANDSHAKE: '1' }), true);
});

test('challenge binds only its original MCP connection', () => {
  const issued = issueMcpCallerHandshake('mcp-a', { now: 1_000 });
  completeMcpCallerHandshake(issued.challenge, {
    providerType: 'codex',
    providerInstanceId: 'default',
    nativeSessionId: 'thread-a',
    evidence: 'provider_env',
  }, { now: 2_000 });

  assert.deepEqual(resolveMcpCallerHandshake('mcp-a', 3_000), {
    providerType: 'codex',
    providerInstanceId: 'default',
    instanceId: 'default',
    nativeSessionId: 'thread-a',
    evidence: 'provider_bridge',
    expiresAt: 2_000 + 12 * 60 * 60 * 1000,
  });
  assert.equal(resolveMcpCallerHandshake('mcp-b', 3_000), null);
  assert.throws(() => completeMcpCallerHandshake(issued.challenge, {
    providerType: 'codex', nativeSessionId: 'thread-b', evidence: 'provider_env',
  }, { now: 3_000 }), /invalid or expired/);
});

test('expired and untrusted challenges cannot create bindings', () => {
  const expired = issueMcpCallerHandshake('mcp-a', { now: 1_000, ttlMs: 5_000 });
  assert.throws(() => completeMcpCallerHandshake(expired.challenge, {
    providerType: 'codex', nativeSessionId: 'thread-a', evidence: 'provider_env',
  }, { now: 6_001 }), /invalid or expired/);

  const untrusted = issueMcpCallerHandshake('mcp-b', { now: 10_000 });
  assert.throws(() => completeMcpCallerHandshake(untrusted.challenge, {
    providerType: 'codex', nativeSessionId: 'thread-b', evidence: 'user_input',
  }, { now: 11_000 }), /Trusted Provider caller context/);
  assert.equal(resolveMcpCallerHandshake('mcp-b', 11_000), null);
});
