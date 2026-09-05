'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHttpTransport } = require('../build/mcp/transport/http');

// Invoke the real Express router handler without opening a port or mocking its implementation.
async function request(body, handlers = {}) {
  let calls = 0;
  const transport = createHttpTransport({ server: { _requestHandlers: new Map([
    ['tools/list', handlers.list || (() => { calls++; return { tools: [] }; })],
    ['tools/call', handlers.call || (() => { calls++; return { content: [] }; })],
  ]) } });
  let status = 200, response;
  const res = { status(value) { status = value; return this; }, json(value) { response = value; return this; }, end() { return this; } };
  const handler = transport.stack.find(layer => layer.route?.path === '/').route.stack[0].handle;
  await handler({ body, headers: {} }, res);
  return { status, response, calls };
}

for (const id of [0, '', 1, 'request']) {
  test(`JSON-RPC preserves valid request id ${JSON.stringify(id)}`, async () => {
    for (const method of ['initialize', 'tools/list', 'tools/call']) {
      const result = await request({ jsonrpc: '2.0', method, id, params: {} });
      assert.equal(result.status, 200);
      assert.equal(result.response.id, id);
      assert.ok(result.response.result);
    }
    const failure = await request({ jsonrpc: '2.0', method: 'tools/call', id }, { call: () => { throw new Error('synthetic failure'); } });
    assert.equal(failure.response.id, id);
    assert.equal(failure.response.error.code, -32603);
  });
}

test('missing id is a notification even for initialize and never invokes tools', async () => {
  for (const method of ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']) {
    const result = await request({ jsonrpc: '2.0', method });
    assert.equal(result.status, 202);
    assert.equal(result.response, undefined);
    assert.equal(result.calls, 0);
  }
});

for (const id of [null, 0.5, { value: 1 }, [], true]) {
  test(`invalid MCP request id ${JSON.stringify(id)} is rejected before execution`, async () => {
    for (const method of ['initialize', 'tools/list', 'tools/call']) {
      const result = await request({ jsonrpc: '2.0', method, id });
      assert.equal(result.response?.error?.code, -32600);
      assert.equal(result.response.id, null);
      assert.equal(result.calls, 0);
    }
  });
}
