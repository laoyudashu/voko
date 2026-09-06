const test = require('node:test');
const assert = require('node:assert/strict');
const { initDatabase } = require('../build/core/database');
const { MessageHandler } = require('../build/core/messenger');

function fixture(deliver) {
  const db = initDatabase(':memory:', { silent: true });
  const handler = new MessageHandler(db, { deliver });
  handler.receiptRequests.set('agent-1\0source-1', { peerUid: 'agent-peer' });
  handler.receiptSourceAliases.set('agent-1\0server-1', 'source-1');
  return { handler, close: () => { handler.closeTurnReceipts?.(); db.close(); } };
}

test('failed terminal receipt retains correlation until delivery succeeds', async () => {
  const attempts = [];
  const f = fixture(async (...args) => {
    attempts.push(args);
    return attempts.length === 1 ? { success: false, error: 'ECONNRESET' } : { success: true };
  });
  try {
    await f.handler._sendTurnReceipt('agent-1', 'agent-peer', ['server-1'], 'turn-1', 'COMPLETED', 'reply', null, 'reply-1');
    assert.equal(f.handler.receiptRequests.has('agent-1\0source-1'), true);
    await f.handler.retryPendingTurnReceipts(Date.now() + 31_000);
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[0], attempts[1], 'retry the identical receipt, not the Provider or a new sequence');
    assert.deepEqual(attempts[1][7]._voko.turnReceipt.sourceMessageIds, ['source-1']);
    assert.equal(f.handler.receiptRequests.size, 0);
    assert.equal(f.handler.receiptSourceAliases.size, 0);
    await f.handler.retryPendingTurnReceipts(Date.now() + 61_000);
    assert.equal(attempts.length, 2);
  } finally { f.close(); }
});

test('thrown delivery failures are contained and retried without leaking error text', async () => {
  let calls = 0;
  const f = fixture(async () => { if (++calls === 1) throw Object.assign(new Error('private error details'), { code: 'ECONNRESET' }); return { success: true }; });
  const warnings = [], originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    await f.handler._sendTurnReceipt('agent-1', 'agent-peer', ['server-1'], 'turn-1', 'FAILED', 'provider', 'PROVIDER_AUTH_REQUIRED');
    await f.handler.retryPendingTurnReceipts(Date.now() + 31_000);
    assert.equal(calls, 2);
    assert.equal(f.handler.pendingTerminalReceipts.size, 0);
    assert.match(warnings.join(' '), /code=ECONNRESET/);
    assert.doesNotMatch(warnings.join(' '), /private error details/);
  } finally { console.warn = originalWarn; f.close(); }
});

test('overlapping recovery ticks cannot send the same pending receipt twice', async () => {
  let calls = 0, finish;
  const f = fixture(async () => ++calls === 1 ? { success: false } : new Promise(resolve => { finish = resolve; }));
  try {
    await f.handler._sendTurnReceipt('agent-1', 'agent-peer', ['server-1'], 'turn-1', 'COMPLETED', 'reply');
    const recovery = f.handler.retryPendingTurnReceipts(Date.now() + 31_000);
    await f.handler.retryPendingTurnReceipts(Date.now() + 31_000);
    assert.equal(calls, 2);
    finish({ success: true });
    await recovery;
    assert.equal(f.handler.receiptRequests.size, 0);
  } finally { f.close(); }
});

test('shutdown prevents a late failed send from scheduling more delivery', async () => {
  let calls = 0, finish;
  const f = fixture(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
  try {
    const pending = f.handler._sendTurnReceipt('agent-1', 'agent-peer', ['server-1'], 'turn-1', 'COMPLETED', 'reply');
    f.handler.closeTurnReceipts();
    finish({ success: false });
    await pending;
    await f.handler.retryPendingTurnReceipts(Date.now() + 31_000);
    assert.equal(calls, 1);
    assert.equal(f.handler.pendingTerminalReceipts.size, 0);
    assert.equal(f.handler.receiptRequests.size, 0);
  } finally { f.close(); }
});

test('permanent failure stops after five attempts and clears expired correlation', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return { success: false, error: 'PEER_NOT_FOUND' }; });
  try {
    await f.handler._sendTurnReceipt('agent-1', 'agent-peer', ['server-1'], 'turn-1', 'COMPLETED', 'reply');
    for (let i = 0; i < 8; i++) await f.handler.retryPendingTurnReceipts(Date.now() + 31_000);
    assert.equal(calls, 5);
    assert.equal(f.handler.pendingTerminalReceipts.size, 0);
    assert.equal(f.handler.receiptRequests.size, 0);
    assert.equal(f.handler.receiptSourceAliases.size, 0);
  } finally { f.close(); }
});

test('ten-minute expiry prevents delayed retries even if the timer was suspended', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return { success: false }; });
  try {
    await f.handler._sendTurnReceipt('agent-1', 'agent-peer', ['server-1'], 'turn-1', 'COMPLETED', 'reply');
    await f.handler.retryPendingTurnReceipts(Date.now() + 600_001);
    assert.equal(calls, 1);
    assert.equal(f.handler.receiptRequests.size, 0);
  } finally { f.close(); }
});

test('late success of an older terminal receipt does not discard its replacement', async () => {
  let calls = 0, finishOld;
  const f = fixture(async () => {
    calls++;
    if (calls === 1) return new Promise(resolve => { finishOld = resolve; });
    return calls === 2 ? { success: false } : { success: true };
  });
  try {
    const old = f.handler._sendTurnReceipt('agent-1', 'agent-peer', ['server-1'], 'turn-1', 'DELIVERY_UNKNOWN', 'reply');
    await f.handler._sendTurnReceipt('agent-1', 'agent-peer', ['server-1'], 'turn-1', 'COMPLETED', 'reply');
    finishOld({ success: true });
    await old;
    assert.equal(f.handler.receiptRequests.size, 1);
    await f.handler.retryPendingTurnReceipts(Date.now() + 31_000);
    assert.equal(calls, 3);
    assert.equal(f.handler.receiptRequests.size, 0);
  } finally { f.close(); }
});
