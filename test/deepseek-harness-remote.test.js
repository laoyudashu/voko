const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { WebSocketServer } = require('ws');
const { DeepSeekHarnessRemote } = require('../build/core/dispatcher/deepseek-harness-remote');

test('DSH Remote uses cookie authentication, named args and closes snapshot streams', async t => {
  const server = http.createServer((req, res) => {
    if (req.url === '/?token=fixture') { res.writeHead(303, { 'set-cookie': 'session=fixture; HttpOnly', location: '/' }); return res.end(); }
    assert.equal(req.headers.cookie, 'session=fixture');
    let data = ''; req.on('data', chunk => { data += chunk; }); req.on('end', () => {
      const request = JSON.parse(data);
      assert.equal(req.url, '/api/session/create');
      assert.equal(request.method, 'session/create');
      assert.deepEqual(request.payload, { args: { request: { agentPreset: 'standard' } } });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: { sessionId: 's1' } } }));
    });
  });
  const wss = new WebSocketServer({ server });
  let closed;
  const done = new Promise(resolve => { closed = resolve; });
  wss.on('connection', (socket, req) => {
    assert.equal(req.headers.cookie, 'session=fixture');
    socket.on('close', closed);
    socket.on('message', data => {
      const frame = JSON.parse(data);
      if (frame.type !== 'open') return;
      assert.equal(frame.endpoint, 'session/follow');
      assert.equal(frame.payload.args.request.address.sessionId, 's1');
      socket.send(JSON.stringify({ type: 'item', streamId: frame.streamId,
        value: { type: 'snapshot', header: { id: 's1' }, cursor: 0, records: [] } }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const client of wss.clients) client.terminate(); wss.close(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const remote = new DeepSeekHarnessRemote(base);
  await assert.rejects(remote.authenticate('http://example.com/?token=fixture'));
  await remote.authenticate(base + '/?token=fixture');
  assert.deepEqual(await remote.call('session/create', { request: { agentPreset: 'standard' } }), { sessionId: 's1' });
  assert.equal((await remote.snapshot('s1')).header.id, 's1');
  await done;
});

test('DSH Remote does not expose server error text or authentication URL in failures', async () => {
  const remote = new DeepSeekHarnessRemote('http://127.0.0.1:3091', async (_url, options) => {
    const request = JSON.parse(options.body);
    return new Response(JSON.stringify({ type: 'server-response', rpcId: request.rpcId,
      result: { ok: false, error: { code: 'denied', message: 'secret-fixture' } } }));
  });
  await assert.rejects(remote.call('session/create', {}), e => e.rpcCode === 'denied' && !e.message.includes('secret-fixture'));
});
