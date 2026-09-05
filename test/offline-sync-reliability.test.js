const { test } = require('node:test');
const assert = require('node:assert/strict');
const { initDatabase, enqueueDbWrite, waitForDbQueue } = require('../build/core/database');
const { syncOfflineMessages, createOfflineSyncCoordinator } = require('../build/core/offline-sync');
const { setCheckpoint, getCheckpoint } = require('../build/core/checkpoint-store');

const KEY = JSON.stringify(['agent-a', 'visitor-a']);
function fixture(t, dbPath = ':memory:') {
  const db = initDatabase(dbPath, { silent: true });
  let closed = false;
  const close = () => { if (!closed) { db.close(); closed = true; } };
  t.after(close);
  const owner = (email = 'owner-a@example.test') => {
    db.prepare('INSERT OR REPLACE INTO config(type,data,updated_at) VALUES(?,?,0)')
      .run('user_access_token', JSON.stringify({ [email]: { user_access_token: 'synthetic-token', updated_at: 1 } }));
    db.prepare('INSERT OR REPLACE INTO config(type,data,updated_at) VALUES(?,?,0)')
      .run('current_user_email', JSON.stringify(email));
  };
  owner();
  db.prepare(`INSERT OR IGNORE INTO agents(id,agent_id,imUid,imToken,im_server_url,owner_email,publish_status,created_at,updated_at)
    VALUES('a','agent-a','agent-uid','synthetic-im-token','http://synthetic.invalid','owner-a@example.test','published',0,0)`).run();
  db.prepare(`INSERT OR IGNORE INTO conversations(user_uid,channel_id,channel_type,name,agent_id)
    VALUES('agent-uid','visitor-a',1,'Synthetic visitor','agent-a')`).run();
  const handled = [], forwarded = [], encrypted = [], requests = [];
  const persist = (data) => db.prepare(`INSERT OR IGNORE INTO messages
    (id,from_uid,to_uid,content,channel_id,channel_type,agent_id,timestamp,is_me,status,message_seq)
    VALUES(?,?,?,?,?,1,'agent-a',0,0,'received',?)`)
    .run(data.messageId, data.fromUid, data.toUid, data.content, data.channelId, data.messageSeq);
  const handler = {
    handleAgentMessage(agentId, data, skipForward) {
      assert.equal(skipForward, true);
      handled.push(data.messageSeq);
      if (!persist(data).changes) return;
      return { agentId, ...data };
    },
    async handleEncryptedMessage(_agentId, data) {
      encrypted.push(data.messageSeq);
      return { handled: true, accepted: true };
    },
    forwardToAgent(...args) { forwarded.push(args[6]); },
  };
  const fetchPages = (messages, response) => t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const request = JSON.parse(options.body);
    requests.push(request.start_message_seq);
    if (response) return response(request, options);
    return { ok: true, json: async () => ({ messages: messages.filter(m => m.message_seq >= request.start_message_seq).slice(0, 100) }) };
  });
  return { db, close, owner, handler, handled, forwarded, encrypted, requests, fetchPages, persist,
    checkpoint: () => Number(getCheckpoint(db, 'offline_messages', KEY)?.committedValue),
    setCheckpoint: (seq) => setCheckpoint(db, 'offline_messages', KEY, 'sequence', seq) };
}
function message(seq, type = 1) {
  return { message_id: `message-${seq}`, message_seq: seq, from_uid: 'visitor-a', content: `synthetic ${seq}`, content_type: type };
}

// Capture messages, never connection credentials or message bodies.
function captureLogs(t) {
  const errors = [], logs = [];
  t.mock.method(console, 'error', (...args) => errors.push(args.map(String).join(' ')));
  t.mock.method(console, 'log', (...args) => logs.push(args.map(String).join(' ')));
  return { errors, logs };
}

test('DB queue returns this job failure and still runs subsequent jobs, including ignored failures', async (t) => {
  captureLogs(t);
  const events = [];
  const failed = enqueueDbWrite(() => { events.push('failed'); throw new Error('synthetic write failure'); });
  assert.ok(failed && typeof failed.then === 'function', 'enqueue must return its own job Promise');
  await assert.rejects(failed, /synthetic write failure/);
  assert.equal(await enqueueDbWrite(() => { events.push('success'); return 42; }), 42);
  enqueueDbWrite(() => { throw new Error('synthetic ignored failure'); });
  await waitForDbQueue();
  assert.deepEqual(events, ['failed', 'success']);
});

for (const failure of ['BEGIN IMMEDIATE', 'write', 'COMMIT']) {
  test(`ordinary forwarding stays zero when ${failure} fails; sync reports failure and rolls back`, async (t) => {
    const f = fixture(t);
    const { errors, logs } = captureLogs(t);
    f.fetchPages([message(1), message(2)]);
    const proxy = new Proxy(f.db, {
      get(target, key) {
        if (key === 'exec') return (sql) => {
          if (sql === failure) throw new Error(`synthetic ${failure} failure`);
          return target.exec(sql);
        };
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const original = f.handler.handleAgentMessage;
    if (failure === 'write') {
      f.handler.handleAgentMessage = (...args) => {
        const result = original(...args);
        if (args[1].messageSeq === 2) throw new Error('synthetic write failure');
        return result;
      };
    }
    assert.equal(await syncOfflineMessages(proxy, f.handler), 0);
    assert.deepEqual(f.forwarded, []);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0);
    assert.ok(errors.some(line => line.includes('[离线同步] 失败:')));
    assert.ok(!logs.some(line => line.includes('[离线同步] 完成')));
    assert.equal(await enqueueDbWrite(() => 9), 9, 'queue remains usable after failed transaction');
    assert.equal(f.checkpoint(), 0, 'failed transaction must not advance scan progress');
    f.handler.handleAgentMessage = original;
    assert.equal(await syncOfflineMessages(f.db, f.handler), 2);
    assert.deepEqual(f.forwarded, ['message-1', 'message-2']);
  });
}

test('checkpoint wins over stored MAX and a transient encrypted gap stops later ordinary and encrypted work', async (t) => {
  const f = fixture(t);
  f.setCheckpoint(100);
  f.persist({ messageId: 'message-102', fromUid: 'visitor-a', toUid: 'agent-uid', content: 'synthetic', channelId: 'visitor-a', messageSeq: 102 });
  f.fetchPages([message(101, 13), message(102), message(103, 13), message(104)]);
  let accept = false;
  f.handler.handleEncryptedMessage = async (_id, data) => {
    f.encrypted.push(data.messageSeq);
    return { handled: true, accepted: accept, code: 'E2EE_V2_DIRECTORY_UNAVAILABLE' };
  };
  await syncOfflineMessages(f.db, f.handler);
  assert.deepEqual(f.requests, [101]);
  assert.deepEqual(f.encrypted, [101]);
  assert.deepEqual(f.handled, []);
  assert.equal(f.checkpoint(), 100);
  accept = true;
  await syncOfflineMessages(f.db, f.handler);
  assert.deepEqual(f.requests, [101, 101]);
  assert.deepEqual(f.encrypted, [101, 101, 103]);
  assert.deepEqual(f.handled, [102, 104]);
  assert.equal(f.checkpoint(), 104);
  assert.deepEqual(f.forwarded, ['message-104'], 'saved message is scanned without executing it again');
});

test('mixed unordered and duplicate messages are processed by sequence; permanent rejection and natural gaps advance', async (t) => {
  const f = fixture(t);
  f.setCheckpoint(100);
  f.fetchPages([message(109), message(105, 13), message(101), message(101), message(108, 13)]);
  const order = [];
  const ordinary = f.handler.handleAgentMessage;
  f.handler.handleAgentMessage = (...args) => { order.push(args[1].messageSeq); return ordinary(...args); };
  f.handler.handleEncryptedMessage = async (_id, data) => {
    order.push(data.messageSeq);
    return { handled: true, accepted: false, code: 'E2EE_V2_ENVELOPE_INVALID' };
  };
  await syncOfflineMessages(f.db, f.handler);
  assert.deepEqual(order, [101, 105, 108, 109]);
  assert.equal(f.checkpoint(), 109);
  assert.deepEqual(f.forwarded, ['message-101', 'message-109']);
  await syncOfflineMessages(f.db, f.handler);
  assert.deepEqual(order, [101, 105, 108, 109], 'already scanned page must not execute twice');
});

test('legacy cursor is authoritative over MAX, but MAX-only bootstrap does not replay historical messages', async (t) => {
  const f = fixture(t);
  f.persist({ messageId: 'historical-102', fromUid: 'visitor-a', toUid: 'agent-uid', content: 'synthetic', channelId: 'visitor-a', messageSeq: 102 });
  f.fetchPages([]);
  await syncOfflineMessages(f.db, f.handler);
  assert.deepEqual(f.requests, [103]);
  assert.equal(f.checkpoint(), 102, 'bootstrap must persist even before a page is accepted');
  f.db.prepare('DELETE FROM sync_checkpoints WHERE namespace=? AND scope_key=?').run('offline_messages', KEY);
  f.db.prepare('INSERT OR REPLACE INTO config(type,data,updated_at) VALUES(?,?,0)')
    .run('offline_sync_cursors', JSON.stringify({ [KEY]: 100 }));
  await syncOfflineMessages(f.db, f.handler);
  assert.deepEqual(f.requests, [103, 101]);
  assert.equal(f.checkpoint(), 100);
});

test('ordinary work before transient E2EE commits, and a blocked channel does not stop another channel', async (t) => {
  const f = fixture(t);
  f.db.prepare(`INSERT OR IGNORE INTO conversations(user_uid,channel_id,channel_type,name,agent_id)
    VALUES('agent-uid','visitor-b',1,'Other synthetic visitor','agent-a')`).run();
  f.fetchPages([], (request) => ({ ok: true, json: async () => ({ messages:
    request.channel_id === 'visitor-a' ? [message(1), message(2, 13), message(3)] : [message(4)] }) }));
  f.handler.handleEncryptedMessage = async (_id, data) => {
    assert.deepEqual(f.forwarded, ['message-1'], 'earlier ordinary block commits and forwards before encrypted processing');
    return { handled: true, accepted: false, code: 'E2EE_V2_DIRECTORY_UNAVAILABLE' };
  };
  await syncOfflineMessages(f.db, f.handler);
  assert.deepEqual(f.handled, [1, 4]);
  assert.equal(f.checkpoint(), 1);
});

for (const size of [0, 99, 100, 101, 250]) {
  test(`bounded paging drains ${size} available messages once`, async (t) => {
    const f = fixture(t);
    f.fetchPages(Array.from({ length: size }, (_, i) => message(i + 1)));
    assert.equal(await syncOfflineMessages(f.db, f.handler), size);
    assert.equal(f.forwarded.length, size);
    assert.equal(new Set(f.forwarded).size, size);
    assert.equal(f.requests.length, Math.floor(size / 100) + 1);
    await syncOfflineMessages(f.db, f.handler);
    assert.equal(f.forwarded.length, size);
  });
}

test('page budget requests continuation and the next run uses the committed cursor', async (t) => {
  const f = fixture(t);
  f.fetchPages(Array.from({ length: 250 }, (_, i) => message(i + 1)));
  const continuations = [];
  const options = { maxPagesPerChannel: 1, requestContinuation: (...args) => continuations.push(args) };
  assert.equal(await syncOfflineMessages(f.db, f.handler, undefined, options), 100);
  assert.deepEqual(continuations, [['agent-a', 'owner-a@example.test']]);
  assert.equal(await syncOfflineMessages(f.db, f.handler, undefined, options), 100);
  assert.equal(await syncOfflineMessages(f.db, f.handler, undefined, options), 50);
  assert.equal(continuations.length, 2);
  assert.deepEqual(f.requests, [1, 101, 201]);
  assert.equal(new Set(f.forwarded).size, 250);
});

test('a repeated full page exits without re-executing or scheduling a spin', async (t) => {
  const f = fixture(t);
  const page = Array.from({ length: 100 }, (_, i) => message(i + 1));
  f.fetchPages([], () => ({ ok: true, json: async () => ({ messages: page }) }));
  const continuations = [];
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  await syncOfflineMessages(f.db, f.handler, undefined, { requestContinuation: id => continuations.push(id) });
  assert.deepEqual(f.requests, [1, 101]);
  assert.equal(f.forwarded.length, 100);
  assert.deepEqual(continuations, []);
  assert.ok(warnings.some(line => line.includes('游标未前进')));
});

test('switching owners during a later page response prevents any further handling or continuation', async (t) => {
  const f = fixture(t);
  f.fetchPages([], request => {
    if (request.start_message_seq > 1) f.owner('owner-b@example.test');
    return { ok: true, json: async () => ({ messages: Array.from({ length: 100 }, (_, i) => message(request.start_message_seq + i)) }) };
  });
  const continuations = [];
  await syncOfflineMessages(f.db, f.handler, undefined, { requestContinuation: id => continuations.push(id) });
  assert.deepEqual(f.requests, [1, 101]);
  assert.equal(f.forwarded.length, 100);
  assert.deepEqual(continuations, []);
});

test('request cancellation is propagated to fetch and does not schedule more work', async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  let observedSignal;
  f.fetchPages([], async (_request, options) => {
    observedSignal = options.signal;
    assert.ok(observedSignal, 'fetch must receive an abort signal');
    controller.abort();
    observedSignal.throwIfAborted();
  });
  await syncOfflineMessages(f.db, f.handler, undefined, { signal: controller.signal });
  assert.ok(observedSignal?.aborted);
  assert.deepEqual(f.handled, []);
  assert.equal(f.requests.length, 1);
});

test('a transient checkpoint survives database close and reopen without replaying accepted ordinary work', async (t) => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-offline-restart-'));
  const dbPath = path.join(dir, 'synthetic.db');
  let first, second;
  try {
    first = fixture(t, dbPath);
    first.fetchPages([message(1), message(2, 13), message(3)]);
    first.handler.handleEncryptedMessage = async () => ({ accepted: false, code: 'E2EE_V2_DIRECTORY_UNAVAILABLE' });
    await syncOfflineMessages(first.db, first.handler);
    assert.deepEqual(first.forwarded, ['message-1']);
    first.close();
    second = fixture(t, dbPath);
    second.fetchPages([message(1), message(2, 13), message(3)]);
    await syncOfflineMessages(second.db, second.handler);
    assert.deepEqual(second.requests, [2]);
    assert.deepEqual(second.encrypted, [2]);
    assert.deepEqual(second.forwarded, ['message-3']);
    assert.equal(second.checkpoint(), 3);
  } finally {
    first?.close(); second?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function coordinatorTimers() {
  let id = 0;
  const pending = new Map();
  return {
    setTimeout(fn) { pending.set(++id, fn); return id; },
    clearTimeout(key) { pending.delete(key); },
    tick() { const entries = [...pending]; pending.clear(); for (const [, fn] of entries) fn(); },
    count() { return pending.size; },
  };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('real coordinator automatically drains continuations within a one-page budget', async (t) => {
  const f = fixture(t), timers = coordinatorTimers();
  f.fetchPages(Array.from({ length: 250 }, (_, i) => message(i + 1)));
  const coordinator = createOfflineSyncCoordinator(f.db, f.handler, {
    ...timers, windowMs: 0, cooldownMs: 0, syncOptions: { maxPagesPerChannel: 1 },
  });
  t.after(() => coordinator.stop());
  coordinator.onAllReady();
  await settle();
  assert.equal(f.forwarded.length, 100);
  assert.equal(timers.count(), 1);
  timers.tick(); await settle();
  assert.equal(f.forwarded.length, 200);
  timers.tick(); await settle();
  assert.equal(f.forwarded.length, 250);
  assert.deepEqual(f.requests, [1, 101, 201]);
  assert.equal(timers.count(), 0);
});

for (const change of ['owner', 'stop']) {
  test(`coordinator cancels queued continuation on ${change}`, async (t) => {
    const f = fixture(t), timers = coordinatorTimers();
    f.fetchPages(Array.from({ length: 250 }, (_, i) => message(i + 1)));
    const coordinator = createOfflineSyncCoordinator(f.db, f.handler, {
      ...timers, windowMs: 0, cooldownMs: 0, syncOptions: { maxPagesPerChannel: 1 },
    });
    t.after(() => coordinator.stop());
    coordinator.onAllReady(); await settle();
    assert.equal(timers.count(), 1);
    if (change === 'owner') f.owner('owner-b@example.test');
    else coordinator.stop();
    timers.tick(); await settle();
    assert.deepEqual(f.requests, [1]);
    assert.equal(f.forwarded.length, 100);
    assert.equal(timers.count(), 0);
  });
}

test('coordinator stop aborts an active network request', async (t) => {
  const f = fixture(t), timers = coordinatorTimers();
  let aborted = false;
  f.fetchPages([], (_request, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => { aborted = true; reject(options.signal.reason); }, { once: true });
  }));
  const coordinator = createOfflineSyncCoordinator(f.db, f.handler, { ...timers, cooldownMs: 0 });
  coordinator.onAllReady();
  coordinator.stop();
  await settle();
  assert.ok(aborted);
  assert.equal(timers.count(), 0);
  assert.deepEqual(f.handled, []);
});

for (const failure of ['http', 'network', 'json', 'timeout']) {
  test(`a channel ${failure} failure is bounded and the next channel can still sync`, async (t) => {
    const f = fixture(t);
    f.db.prepare(`INSERT INTO conversations(user_uid,channel_id,channel_type,name,agent_id)
      VALUES('agent-uid','visitor-b',1,'Other synthetic visitor','agent-a')`).run();
    const keeper = setTimeout(() => {}, 100);
    t.after(() => clearTimeout(keeper));
    f.fetchPages([], async (request, options) => {
      if (request.channel_id === 'visitor-b') return { ok: true, json: async () => ({ messages: [message(1)] }) };
      if (failure === 'http') return { ok: false, status: 503 };
      if (failure === 'network') throw new Error('synthetic network failure');
      if (failure === 'json') return { ok: true, json: async () => { throw new SyntaxError('synthetic invalid JSON'); } };
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    });
    await syncOfflineMessages(f.db, f.handler, undefined, { requestTimeoutMs: 5 });
    assert.deepEqual(f.requests, [1, 1]);
    assert.deepEqual(f.forwarded, ['message-1']);
  });
}

for (const rejection of ['missing', 'thrown']) {
  test(`a ${rejection} encrypted handler keeps the checkpoint and blocks later work`, async (t) => {
    const f = fixture(t);
    f.fetchPages([message(1, 13), message(2)]);
    if (rejection === 'missing') delete f.handler.handleEncryptedMessage;
    else f.handler.handleEncryptedMessage = async () => { throw new Error('synthetic E2EE handler failure'); };
    await syncOfflineMessages(f.db, f.handler);
    assert.equal(f.checkpoint(), 0);
    assert.deepEqual(f.handled, []);
  });
}

test('encrypted sender echoes and missing message IDs advance without entering the inbound handler', async (t) => {
  const f = fixture(t);
  f.fetchPages([{ ...message(1, 13), from_uid: 'agent-uid' }, { message_seq: 2 }, message(3)]);
  await syncOfflineMessages(f.db, f.handler);
  assert.deepEqual(f.encrypted, []);
  assert.deepEqual(f.handled, [3]);
  assert.equal(f.checkpoint(), 3);
});

test('invalid sequence pages fail closed without advancing or processing reordered data', async (t) => {
  const f = fixture(t);
  f.fetchPages([], () => ({ ok: true, json: async () => ({ messages: [message(1), { ...message(2), message_seq: null }, message(3)] }) }));
  await syncOfflineMessages(f.db, f.handler);
  assert.equal(f.checkpoint(), 0);
  assert.deepEqual(f.handled, []);
});
