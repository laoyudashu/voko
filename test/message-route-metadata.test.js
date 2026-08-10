'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ContentType, encodeContent, decodeContent } = require('../src/im-sdk/messages');
const { VokoWorkerAdapter } = require('../src/im-sdk/voko-worker-adapter');
const { VokoIMClient } = require('../src/im-sdk/client');

for (const [name, type, fields] of [
  ['text', ContentType.Text, { content: 'hello' }],
  ['image', ContentType.Image, { url: 'https://example.invalid/image.png' }],
  ['file', ContentType.File, { url: 'https://example.invalid/file', name: 'a.txt' }],
]) {
  test(`${name} payload preserves hidden VOKO route metadata`, () => {
    const metadata = { protocolVersion: 1, routeId: 'route-a', replyToRouteId: 'route-b',
      conversationKey: 'wire-a', conversationStart: true, conversationDisposition: 'created', canonicalConversationKey: 'wire-b' };
    const decoded = decodeContent(encodeContent(type, { ...fields, _voko: metadata }));
    assert.deepEqual(decoded._voko, metadata);
  });
}

test('worker normalization keeps only versioned route metadata outside visible content', () => {
  const adapter = Object.create(VokoWorkerAdapter.prototype);
  const normalized = adapter._normalizeMessage({ fromUid: 'peer', channelId: 'peer', contentType: 1,
    content: { contentObj: { type: 1, content: 'hello', _voko: {
      protocolVersion: 1, routeId: 'route-a', replyToRouteId: 'route-b', conversationKey: 'wire-a',
      conversationStart: true, conversationDisposition: 'reused', canonicalConversationKey: 'wire-b', ignored: 'secret' } } } });
  assert.equal(normalized.content, 'hello');
  assert.deepEqual(normalized._voko, { protocolVersion: 1, routeId: 'route-a', replyToRouteId: 'route-b',
    conversationKey: 'wire-a', conversationStart: true, conversationDisposition: 'reused', canonicalConversationKey: 'wire-b' });
  assert.equal(JSON.stringify(normalized.content).includes('route-a'), false);
});

test('client text, image and file helpers encode route metadata', async () => {
  const client = Object.create(VokoIMClient.prototype);
  const payloads = [];
  client.sendRaw = async (_channelId, _channelType, payload) => {
    payloads.push(decodeContent(payload));
    return { messageId: 'ok' };
  };
  const options = { _voko: { protocolVersion: 1, routeId: 'route-a' } };
  await client.sendText('peer', 1, 'hello', options);
  await client.sendImage('peer', 1, 'https://example.invalid/a.png', options);
  await client.sendFile('peer', 1, { url: 'https://example.invalid/a', name: 'a.txt' }, options);
  assert.equal(payloads.length, 3);
  for (const payload of payloads) assert.deepEqual(payload._voko, options._voko);
});

test('worker delivery forwards route metadata for every supported content kind', async () => {
  const seen = [];
  const adapter = Object.create(VokoWorkerAdapter.prototype);
  adapter.pool = {
    sendText: async (...args) => { seen.push(args); return { messageId: 'text' }; },
    sendImage: async (...args) => { seen.push(args); return { messageId: 'image' }; },
    sendFile: async (...args) => { seen.push(args); return { messageId: 'file' }; },
  };
  const metadata = { _voko: { protocolVersion: 1, routeId: 'route-a' } };
  assert.equal((await adapter.deliver('a', 'p', 'hello', 'text', 1, null, 'm1', metadata)).success, true);
  assert.equal((await adapter.deliver('a', 'p', 'https://example.invalid/a.png', 'image', 1, null, 'm2', metadata)).success, true);
  assert.equal((await adapter.deliver('a', 'p', JSON.stringify({ url: 'https://example.invalid/a' }), 'file', 1, null, 'm3', metadata)).success, true);
  assert.equal(seen.length, 3);
  for (const args of seen) assert.deepEqual(args.at(-1)._voko, metadata._voko);
});

test('compiled IM helpers preserve and forward route metadata', async () => {
  const builtMessages = require('../build/im-sdk/messages');
  const { VokoIMClient: BuiltClient } = require('../build/im-sdk/client');
  const { VokoWorkerAdapter: BuiltAdapter } = require('../build/im-sdk/voko-worker-adapter');
  const metadata = { _voko: { protocolVersion: 1, routeId: 'built-route' } };
  const client = Object.create(BuiltClient.prototype);
  const decoded = [];
  client.sendRaw = async (_channelId, _channelType, payload) => {
    decoded.push(builtMessages.decodeContent(payload)); return { messageId: 'ok' };
  };
  await client.sendText('p', 1, 'hello', metadata);
  await client.sendImage('p', 1, 'https://example.invalid/a.png', metadata);
  await client.sendFile('p', 1, { url: 'https://example.invalid/a' }, metadata);
  await client.sendText('p', 1, 'legacy');
  await client.sendImage('p', 1, { url: 'https://example.invalid/legacy.png' });
  await client.sendFile('p', 1, { url: 'https://example.invalid/legacy' });
  assert.equal(decoded.slice(0, 3).every((payload) => payload._voko.routeId === 'built-route'), true);
  assert.equal(decoded.slice(3).every((payload) => payload._voko === undefined), true);

  const adapter = Object.create(BuiltAdapter.prototype);
  const options = [];
  adapter.pool = {
    sendText: async (...args) => { options.push(args.at(-1)); return {}; },
    sendImage: async (...args) => { options.push(args.at(-1)); return {}; },
    sendFile: async (...args) => { options.push(args.at(-1)); return {}; },
  };
  await adapter.deliver('a', 'p', 'hello', 'text', 1, null, 'm1', metadata);
  await adapter.deliver('a', 'p', 'https://example.invalid/a.png', 'image', 1, null, 'm2', metadata);
  await adapter.deliver('a', 'p', '{"url":"https://example.invalid/a"}', 'file', 1, null, 'm3', metadata);
  await adapter.deliver('a', 'p', 'legacy', 'text', 1);
  await adapter.deliver('a', 'p', 'not-json', 'file', 1);
  assert.equal(options.slice(0, 3).every((value) => value._voko.routeId === 'built-route'), true);
  assert.equal(options.slice(3).every((value) => value._voko === undefined), true);
});

test('compiled worker strips unsupported metadata and reports delivery errors safely', async () => {
  const { VokoWorkerAdapter: BuiltAdapter } = require('../build/im-sdk/voko-worker-adapter');
  const adapter = Object.create(BuiltAdapter.prototype);
  const ack = () => {};
  const nack = () => {};
  const normalized = adapter._normalizeMessage({ fromUID: 'peer', toUID: 'agent', channelID: 'peer',
    channel: { channelType: 1 }, contentType: 1, content: { content: 'hello', _voko: {
      protocolVersion: 2, routeId: 'ignored' } }, header: {}, ack, nack });
  assert.equal(normalized._voko, null);
  assert.equal(normalized.ack, ack);
  assert.equal(normalized.nack, nack);
  adapter.pool = { sendText: async () => { const error = new Error('offline'); error.code = 'OFFLINE'; throw error; } };
  const failed = await adapter.deliver('a', 'p', 'hello', 'text', 1, null, 'm1');
  assert.equal(failed.success, false);
  assert.equal(failed.code, 'OFFLINE');
});
