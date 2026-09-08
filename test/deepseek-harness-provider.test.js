const test = require('node:test');
const assert = require('node:assert/strict');
const { DeepSeekHarnessHttpProvider, loopbackBaseUrl } = require('../build/core/dispatcher/providers/deepseek-harness-http');
const { DeepSeekHarnessCliProvider } = require('../build/core/dispatcher/providers/deepseek-harness-cli');

function harness(options = {}) {
  let sessionId, requestId, preset = 'workspace-write';
  const calls = [];
  const remote = {
    async call(method, args) {
      calls.push({ method, args });
      if (method === 'agentPresets/list') return { presets: [{ id: 'standard' }] };
      if (method === 'session/create') { sessionId = args.request.sessionId; return { sessionId }; }
      if (method === 'commands/list') return [{ name: 'permission' }];
      if (method === 'commands/execute') {
        if (options.commandFails) return { result: { kind: 'error' } };
        preset = args.line.split(' ')[1]; return { result: { kind: 'success' } };
      }
      if (method === 'session/prompt') {
        requestId = args.request.requestId;
        if (options.promptLost) throw new Error('connection lost');
        return { accepted: true };
      }
      if (method === 'session/cancel') return {};
      if (method === 'session/page') return { records: [event('user/message', 3, { turn: 7, source: { rpcId: requestId } })], hasMore: false };
      throw new Error(`unexpected ${method}`);
    },
    async snapshot(id) {
      const records = requestId ? [event('user/message', 3, { turn: 7, source: { rpcId: requestId } }),
        event('assistant/message', 4, { turn: 7, message: { content: [{ type: 'text', text: 'DSH reply' }] } }),
        event('turn/end', 5, { turn: 7, reason: { kind: 'completed' } })] : [];
      return { header: { id, agentPreset: 'standard', cwd: '/tmp' }, cursor: 5,
        records: options.paginated ? records.slice(1) : records, hasMore: !!(requestId && options.paginated),
        projections: { values: { permissions: options.missingProjection ? undefined :
          { currentValue: options.drift ? 'danger-full-access' : preset } } } };
    },
  };
  const provider = new DeepSeekHarnessHttpProvider({ remote, startServer: false, cwd: '/tmp',
    db: { prepare: () => ({ get: () => ({ backend_instance_id: 'standard' }) }) } });
  return { provider, remote, calls };
}
function event(type, seq, data) { return { type: 'event', event: { type, seq, data } }; }
function payload(preset = 'workspace-write') {
  return { agentId: 'a1', fromUid: 'v', content: 'hello', turnId: 'turn-1',
    providerSecurityPolicy: { config: { permissionPreset: preset } } };
}
function binding(receipt) { return { ...receipt, providerType: 'deepseek-harness', sessionOrigin: 'voko_managed', strictSessionRoute: true }; }

test('DSH applies permission before prompt and correlates client requestId across pages', async () => {
  const h = harness({ paginated: true });
  await h.provider.start();
  let reply; h.provider.on('agent.reply', e => { reply = e; });
  const receipt = await h.provider.push(payload());
  assert.equal(reply.content, 'DSH reply');
  assert.match(receipt.nativeSessionId, /^voko-/);
  assert.deepEqual(h.calls.map(c => c.method), ['agentPresets/list', 'session/create', 'commands/list', 'commands/execute', 'session/prompt', 'session/page']);
  assert.equal(h.calls.find(c => c.method === 'session/prompt').args.request.requestId, 'turn-1');
  assert.equal(h.calls.find(c => c.method === 'session/create').args.request.cwd, '/tmp');
});
for (const failure of ['commandFails', 'missingProjection', 'drift']) {
  test(`DSH ${failure} blocks submission`, async () => {
    const h = harness({ [failure]: true });
    await assert.rejects(h.provider.push(payload()));
    assert.equal(h.calls.some(c => c.method === 'session/prompt'), false);
  });
}
test('DSH rejects custom preset before creating a session', async () => {
  const h = harness(); await assert.rejects(h.provider.push(payload('custom')));
  assert.equal(h.calls.length, 0);
});
test('DSH restores its fixed-policy session without switching permission', async () => {
  const h = harness(); const receipt = await h.provider.push(payload()); h.calls.length = 0;
  await h.provider.push({ ...payload(), providerBinding: binding(receipt) });
  assert.equal(h.calls.some(c => c.method === 'commands/execute' || c.method === 'session/create'), false);
  await assert.rejects(h.provider.push({ ...payload('other'), providerBinding: binding(receipt) }));
  await assert.rejects(h.provider.push({ ...payload(), providerBinding: { ...binding(receipt), sessionOrigin: 'owner_imported' } }));
});
test('DSH unknown prompt admission is not safe to retry', async () => {
  const h = harness({ promptLost: true });
  await assert.rejects(h.provider.push(payload()), e => e.deliveryOutcome === 'outcome_unknown');
});
test('DSH API accepts only loopback HTTP', () => {
  assert.equal(loopbackBaseUrl('http://localhost:3080/path'), 'http://localhost:3080');
  assert.throws(() => loopbackBaseUrl('https://example.com'));
});
test('DSH CLI cannot restore HTTP session', async () => {
  const provider = new DeepSeekHarnessCliProvider();
  await assert.rejects(provider.push({ ...payload(), providerBinding: { nativeSessionId: 'existing' } }), e => e.deliveryOutcome === 'not_delivered');
});

test('DSH queued delivery rechecks submission validity before sending', async () => {
  const h = harness();
  await assert.rejects(h.provider.push({ ...payload(), assertSubmissionCurrent() { throw new Error('revoked'); } }), /revoked/);
  assert.equal(h.calls.some(c => c.method === 'session/prompt'), false);
});
test('DSH permission drift after admission yields unknown outcome and requests cancellation', async () => {
  const h = harness(); const snapshot = h.remote.snapshot;
  h.remote.snapshot = async id => { const s = await snapshot(id);
    if (h.calls.some(c => c.method === 'session/prompt')) s.projections.values.permissions.currentValue = 'danger-full-access';
    return s;
  };
  await assert.rejects(h.provider.push(payload()), e => e.deliveryOutcome === 'outcome_unknown');
  assert.equal(h.calls.at(-1).method, 'session/cancel');
});
