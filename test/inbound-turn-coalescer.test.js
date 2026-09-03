const test = require('node:test');
const assert = require('node:assert/strict');

const { InboundTurnCoalescer, buildMergedTurn } = require('../build/core/inbound-turn-coalescer');

function item(messageId, content, scope = 'scope-1', attachments = []) {
  return { messageId, content, scope, timestamp: Date.now(), attachments };
}

test('default quiet window keeps network-serialized visitor messages in one turn', async () => {
  const flushed = [];
  const coalescer = new InboundTurnCoalescer({
    scopeKey: value => value.scope,
    hardWindowMs: 2000,
    flush: batch => { flushed.push(batch); },
  });
  const first = coalescer.enqueue(item('m1', 'first'));
  await new Promise(resolve => setTimeout(resolve, 900));
  const second = coalescer.enqueue(item('m2', 'second'));
  await Promise.all([first, second]);
  assert.equal(flushed.length, 1);
  assert.deepEqual(flushed[0].sourceMessageIds, ['m1', 'm2']);
});

test('coalesces consecutive messages in one scope into one provider turn', async () => {
  const flushed = [];
  const coalescer = new InboundTurnCoalescer({
    scopeKey: value => value.scope,
    quietWindowMs: 10,
    hardWindowMs: 50,
    flush: batch => { flushed.push(batch); return buildMergedTurn(batch); },
  });
  const results = await Promise.all([
    coalescer.enqueue(item('m1', 'first')),
    coalescer.enqueue(item('m2', 'second')),
    coalescer.enqueue(item('m3', 'third')),
  ]);
  assert.equal(flushed.length, 1);
  assert.deepEqual(flushed[0].sourceMessageIds, ['m1', 'm2', 'm3']);
  assert.match(results[0].result.content, /^3 consecutive messages were received\./);
  assert.doesNotMatch(results[0].result.content, /visitor/i);
  assert.match(results[0].result.content, /\[Message 1\]\nfirst/);
  assert.match(results[0].result.content, /\[Message 3\]\nthird/);
  assert.deepEqual(results.map(result => result.isReplyOwner), [false, false, true]);
});

test('isolates scopes and preserves attachment ordering', async () => {
  const flushed = [];
  const coalescer = new InboundTurnCoalescer({
    scopeKey: value => value.scope,
    quietWindowMs: 10,
    flush: batch => { flushed.push(batch); return buildMergedTurn(batch); },
  });
  const attachment = (name) => ({ path: `/tmp/${name}`, name, mediaType: 'text/plain', size: 1, sha256: name });
  const results = await Promise.all([
    coalescer.enqueue(item('a1', 'one', 'a', [attachment('one.txt')])),
    coalescer.enqueue(item('b1', 'other', 'b')),
    coalescer.enqueue(item('a2', 'two', 'a', [attachment('two.txt')])),
  ]);
  assert.equal(flushed.length, 2);
  assert.deepEqual(results[0].result.attachments.map(value => value.name), ['one.txt', 'two.txt']);
  assert.deepEqual(results[0].result.attachments.map(value => value.sourceMessageId), ['a1', 'a2']);
  assert.deepEqual(results[0].result.messageSegments.map(value => value.attachmentIndexes), [[0], [1]]);
  assert.equal(results[1].result.content, 'other');
});

test('hard deadline closes a continuously active turn', async () => {
  const flushed = [];
  const coalescer = new InboundTurnCoalescer({
    scopeKey: value => value.scope,
    quietWindowMs: 100,
    hardWindowMs: 20,
    flush: batch => { flushed.push(batch); },
  });
  const pending = coalescer.enqueue(item('m1', 'first'));
  await new Promise(resolve => setTimeout(resolve, 12));
  const second = coalescer.enqueue(item('m2', 'second'));
  await Promise.all([pending, second]);
  assert.equal(flushed.length, 1);
  assert.deepEqual(flushed[0].sourceMessageIds, ['m1', 'm2']);
});

test('character and attachment caps split turns without dropping content', async () => {
  const attachment = name => ({ path: `/tmp/${name}`, name, mediaType: 'text/plain', size: 1, sha256: name });
  for (const limits of [{ maxCharacters: 5 }, { maxAttachments: 1 }]) {
    const flushed = [];
    const coalescer = new InboundTurnCoalescer({
      scopeKey: value => value.scope,
      quietWindowMs: 100,
      ...limits,
      flush: batch => { flushed.push(batch); },
    });
    const first = coalescer.enqueue(item('m1', '12345', 'scope-1', limits.maxAttachments ? [attachment('a')] : []));
    const second = coalescer.enqueue(item('m2', '6', 'scope-1', limits.maxAttachments ? [attachment('b')] : []));
    await coalescer.flushAll();
    await Promise.all([first, second]);
    assert.deepEqual(flushed.map(batch => batch.sourceMessageIds), [['m1'], ['m2']]);
  }
});

test('flushes the current turn before accepting an item that exceeds a limit', async () => {
  const flushed = [];
  const coalescer = new InboundTurnCoalescer({
    scopeKey: value => value.scope,
    quietWindowMs: 100,
    maxMessages: 2,
    flush: batch => { flushed.push(batch); return batch.turnId; },
  });
  const first = coalescer.enqueue(item('m1', 'first'));
  const second = coalescer.enqueue(item('m2', 'second'));
  const third = coalescer.enqueue(item('m3', 'third'));
  await coalescer.flushAll();
  await Promise.all([first, second, third]);
  assert.deepEqual(flushed.map(batch => batch.sourceMessageIds), [['m1', 'm2'], ['m3']]);
});

test('serializes split provider turns within the same scope', async () => {
  let releaseFirst;
  const firstBlocked = new Promise(resolve => { releaseFirst = resolve; });
  const events = [];
  const coalescer = new InboundTurnCoalescer({
    scopeKey: value => value.scope,
    quietWindowMs: 100,
    maxMessages: 1,
    flush: async batch => {
      events.push(`start:${batch.sourceMessageIds[0]}`);
      if (batch.sourceMessageIds[0] === 'm1') await firstBlocked;
      events.push(`finish:${batch.sourceMessageIds[0]}`);
    },
  });
  const first = coalescer.enqueue(item('m1', 'first'));
  const second = coalescer.enqueue(item('m2', 'second'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['start:m1']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['start:m1', 'finish:m1', 'start:m2', 'finish:m2']);
});

test('flushAll submits pending turns during graceful shutdown', async () => {
  const flushed = [];
  const coalescer = new InboundTurnCoalescer({
    scopeKey: value => value.scope,
    quietWindowMs: 60_000,
    flush: batch => { flushed.push(batch); },
  });
  const pending = coalescer.enqueue(item('m1', 'shutdown'));
  await coalescer.flushAll();
  await pending;
  assert.equal(coalescer.pendingCount, 0);
  assert.equal(flushed.length, 1);
});
