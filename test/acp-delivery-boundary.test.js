const test = require('node:test');
const assert = require('node:assert/strict');
const { AcpAdapter } = require('../build/core/adapters/acp-adapter');

const payload = { agentId: 'agent-a', fromUid: 'visitor-a', content: '7+8?', messageId: 'message-a' };

function fixture() {
  return new AcpAdapter({ name: 'BOUNDARY ACP', cliPath: process.execPath,
    args: [], matchType: 'fixture', adapterType: 'fixture-acp' });
}

test('ACP initialization failures are not delivered and never reach session/prompt', async () => {
  for (const failure of [new Error('connection timed out'), new Error('initialize rejected'), 'transport closed']) {
    const provider = fixture();
    let sessions = 0;
    const events = [];
    provider.notifyProviderEvent = event => events.push(event);
    provider._ensureAgent = async () => { throw failure; };
    provider._ensureSession = async () => { sessions++; throw new Error('must not create session'); };
    await assert.rejects(provider.push(payload), error => error instanceof Error
      && error.deliveryOutcome === 'not_delivered');
    assert.equal(sessions, 0);
    assert.equal(events.at(-1).type, 'failed');
    assert.equal(events.at(-1).payload.outcome, 'not_delivered');
    assert.equal(provider._sessionTurnTails.size, 0);
  }
});

test('ACP initialization preserves an explicitly uncertain outcome', async () => {
  const provider = fixture();
  provider._ensureAgent = async () => { throw Object.assign(new Error('uncertain transport'), {
    deliveryOutcome: 'outcome_unknown',
  }); };
  await assert.rejects(provider.push(payload), error => error.deliveryOutcome === 'outcome_unknown');
});

test('ACP disconnect after session/prompt remains outcome_unknown and is not replayed', async () => {
  const provider = fixture();
  let prompts = 0;
  const session = { sessionId: 'session-a', prompt() { prompts++; return Promise.reject(new Error('connection closed')); },
    nextUpdate() { return Promise.resolve(null); } };
  const state = { sessions: new Map([['acp:agent-a:visitor-a', session]]) };
  provider._ensureAgent = async () => state;
  provider._ensureSession = async () => session;
  await assert.rejects(provider.push(payload), error => error.deliveryOutcome === 'outcome_unknown');
  assert.equal(prompts, 1);
  assert.equal(state.sessions.size, 0);
  assert.equal(provider._sessionTurnTails.size, 0);
});
