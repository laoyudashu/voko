const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { initDatabase } = require('../build/core/database');
const { ProviderSessionCoordinator } = require('../build/core/provider-session-coordinator');
const { ProviderRuntimeRegistry } = require('../build/core/dispatcher/provider-runtime-registry');
const { ProviderEventGate } = require('../build/core/dispatcher/provider-event-gate');
const catalog = require('../build/core/dispatcher/provider-catalog');
const { getProviderModularRollout, providerModularModeForFamily } = require('../build/core/dispatcher/provider-modular-rollout');
const { createMessageSecurityContext } = require('../build/core/dispatcher/safety-prompt');
const { createDispatcher } = require('../build/core/dispatcher');
const { AcpAdapter } = require('../build/core/adapters/acp-adapter');
const { CliAdapter } = require('../build/core/adapters/cli-adapter');
const { withClineRuntimeLock } = require('../build/core/dispatcher/providers/cline-runtime-coordinator');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-provider-modular-'));
  const db = initDatabase(path.join(dir, 'voko.db'), { silent: true });
  t.after(() => {
    try { db.close(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

test('every Catalog transport owns creation and an explicit capability declaration', () => {
  for (const definition of catalog.listProviderTransports()) {
    assert.equal(typeof definition.create, 'function', definition.id);
    assert.equal(Object.hasOwn(definition, 'factoryKind'), false, definition.id);
    for (const capability of ['push', 'steer', 'streaming', 'asyncReply', 'sessionResume',
      'cancel', 'pause', 'progress', 'toolCall', 'humanApproval']) {
      assert.equal(typeof definition.capabilities[capability], 'boolean', `${definition.id}:${capability}`);
    }
  }
});

test('Catalog creation receives only transport-scoped configuration', () => {
  const definition = catalog.getProviderTransport('goose-cli');
  const provider = catalog.instantiateProviderTransport(definition, {
    db: null,
    getProviderConfig: id => id === 'goose-cli'
      ? { binPath: 'goose-custom', sessionPersistence: 'dispatcher' } : {},
  });
  assert.equal(provider._binPath, 'goose-custom');
  assert.equal(provider._bindingStore, null);
  assert.equal(Object.isFrozen(provider.providerCapabilities), true);
});

test('modular rollout defaults to Goose and supports config and environment overrides', (t) => {
  const db = fixture(t);
  const defaults = getProviderModularRollout(db, {});
  assert.equal(providerModularModeForFamily(defaults, 'goose'), 'enabled');
  assert.equal(providerModularModeForFamily(defaults, 'cline'), 'shadow');
  assert.equal(providerModularModeForFamily(defaults, 'cursor'), 'shadow');
  assert.equal(providerModularModeForFamily(defaults, 'github-copilot'), 'shadow');
  assert.equal(providerModularModeForFamily(defaults, 'hermes'), 'disabled');

  db.prepare('INSERT OR REPLACE INTO config(type,data,updated_at) VALUES(?,?,?)')
    .run('feature:provider_modular_dispatch_v1', JSON.stringify({
      mode: 'enabled', providerFamilies: ['goose'], familyModes: { hermes: 'shadow', cline: 'enabled' },
    }), Date.now());
  const configured = getProviderModularRollout(db, {});
  assert.equal(providerModularModeForFamily(configured, 'hermes'), 'shadow');
  assert.equal(providerModularModeForFamily(configured, 'cline'), 'enabled');
  assert.equal(providerModularModeForFamily(configured, 'goose'), 'enabled');
  assert.equal(getProviderModularRollout(db, { VOKO_PROVIDER_MODULAR_DISPATCH: 'disabled' }).mode, 'disabled');
});

test('generic ACP and CLI constructors honor Dispatcher-owned session persistence', (t) => {
  const db = fixture(t);
  for (const providerId of ['cline-acp', 'cline-cli', 'cursor-acp', 'cursor-cli',
    'github-copilot-acp', 'github-copilot-cli']) {
    const provider = catalog.instantiateProviderTransport(catalog.getProviderTransport(providerId), {
      db,
      getProviderConfig: () => ({ sessionPersistence: 'dispatcher' }),
    });
    assert.equal(provider._bindingStore, null, providerId);
    assert.equal(provider._sessionPersistence, 'dispatcher', providerId);
  }
});

test('generic CLI accepts only its own adapter binding unless a Provider opts into compatibility', () => {
  const provider = new CliAdapter({
    name: 'CLINE CLI', cmd: process.execPath, args: [], matchType: 'cline', adapterType: 'cline-cli',
  });
  const binding = { providerType: 'cline', adapterType: 'cline-cli', deliveryMode: 'cli', nativeSessionId: 's1' };
  assert.equal(provider.acceptsBinding(binding), true);
  assert.equal(provider.acceptsBinding({ ...binding, adapterType: 'cline-acp', deliveryMode: 'acp' }), false);
});

test('Cline ACP and CLI turns share one process-wide serial coordinator', async () => {
  const events = [];
  let active = 0;
  let maxActive = 0;
  const run = (name, delay) => withClineRuntimeLock(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    events.push(`${name}:start`);
    await new Promise(resolve => setTimeout(resolve, delay));
    events.push(`${name}:end`);
    active -= 1;
    return name;
  });
  const results = await Promise.all([run('acp', 20), run('cli', 1), run('agent-b', 1)]);
  assert.deepEqual(results, ['acp', 'cli', 'agent-b']);
  assert.equal(maxActive, 1);
  assert.deepEqual(events, ['acp:start', 'acp:end', 'cli:start', 'cli:end', 'agent-b:start', 'agent-b:end']);
});

test('Cline serial coordinator releases the next turn after failure', async () => {
  await assert.rejects(withClineRuntimeLock(async () => { throw new Error('failed'); }), /failed/);
  assert.equal(await withClineRuntimeLock(async () => 'recovered'), 'recovered');
});

test('Dispatcher-owned CLI session failure is attempted once and returned to Dispatcher', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-cli-attempt-'));
  const marker = path.join(dir, 'attempts.txt');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = `require('fs').appendFileSync(${JSON.stringify(marker)}, '1'); process.stderr.write('command not found'); process.exit(7)`;
  const provider = new CliAdapter({
    name: 'TEST CLI', cmd: process.execPath, args: ['-e', script], matchType: 'cline',
    adapterType: 'cline-cli', sessionPersistence: 'dispatcher', timeout: 5000,
  });
  await assert.rejects(() => provider.push({
    agentId: 'agent-a', fromUid: 'visitor-a', content: 'hello', messageId: 'message-a',
    providerBinding: {
      id: 'binding-a', bindingVersion: 1, providerType: 'cline', providerInstanceId: null,
      deliveryMode: 'cli', adapterType: 'cline-cli', nativeSessionId: 'session-a',
      sessionOrigin: 'voko_managed', channelId: 'visitor-a', channelType: 1,
    },
  }), error => error.deliveryOutcome === 'not_delivered');
  assert.equal(fs.readFileSync(marker, 'utf8'), '1');
});

test('Dispatcher-owned ACP does not replace a failed bound session inside the transport', async () => {
  const provider = new AcpAdapter({
    name: 'TEST ACP', cliPath: process.execPath, args: [], matchType: 'cline', adapterType: 'cline-acp',
    sessionPersistence: 'dispatcher',
  });
  let created = 0;
  provider._resumeSession = async () => null;
  const state = {
    sessions: new Map(), agentCtx: { buildSession: () => ({ start: async () => { created += 1; return { sessionId: 'new' }; } }) },
  };
  await assert.rejects(() => provider._ensureSession(state, 'agent-a', 'visitor-a', {
    agentId: 'agent-a', fromUid: 'visitor-a', content: 'hello', messageId: 'message-a',
    providerBinding: {
      id: 'binding-a', bindingVersion: 1, providerType: 'cline', providerInstanceId: null,
      deliveryMode: 'acp', adapterType: 'cline-acp', nativeSessionId: 'missing-session',
      sessionOrigin: 'voko_managed', channelId: 'visitor-a', channelType: 1,
    },
  }), error => error.deliveryOutcome === 'not_delivered');
  assert.equal(created, 0);
});

test('Session Coordinator persists managed receipts but never rewrites caller-owned bindings', (t) => {
  const db = fixture(t);
  const coordinator = new ProviderSessionCoordinator(db);
  coordinator.commitDelivery({
    agentId: 'agent-a', channelId: 'visitor-a', channelType: 1,
    providerType: 'goose', deliveryMode: 'cli', adapterType: 'goose-cli',
    receipt: { nativeSessionId: 'session-a' },
  });
  assert.equal(coordinator.getActive('agent-a', 'visitor-a', 1).nativeSessionId, 'session-a');

  const caller = {
    id: 'caller-route', bindingVersion: 1, providerType: 'goose', providerInstanceId: null,
    deliveryMode: 'precise', adapterType: 'precise-route', nativeSessionId: 'caller-session',
    sessionOrigin: 'caller', channelId: 'visitor-b', channelType: 1, strictSessionRoute: true,
  };
  coordinator.commitDelivery({
    agentId: 'agent-a', channelId: 'visitor-b', channelType: 1,
    providerType: 'goose', deliveryMode: 'cli', adapterType: 'goose-cli', binding: caller,
    receipt: { nativeSessionId: 'different-session' },
  });
  assert.equal(coordinator.getActive('agent-a', 'visitor-b', 1), null);
});

test('Session Coordinator stales only incompatible managed bindings', (t) => {
  const db = fixture(t);
  const coordinator = new ProviderSessionCoordinator(db);
  const managed = coordinator.saveManaged({
    agentId: 'agent-a', channelId: 'visitor-a', channelType: 1,
    providerType: 'goose', providerInstanceId: null, nativeSessionId: 'session-a',
    deliveryMode: 'cli', adapterType: 'goose-cli', expectedVersion: 0,
  });
  assert.equal(coordinator.resolveForTransport('agent-a', managed, {
    providerType: 'hermes', deliveryMode: 'http', adapterType: 'hermes-http',
  }), null);
  assert.equal(coordinator.getActive('agent-a', 'visitor-a', 1), null);
});

test('Runtime Registry normalizes missing availability fields and preserves stale generations', async () => {
  class Provider extends EventEmitter {
    constructor() { super(); this.starts = 0; this.stops = 0; }
    start() { this.starts += 1; }
    stop() { this.stops += 1; }
  }
  const provider = new Provider();
  const registry = new ProviderRuntimeRegistry({ 'goose-cli': provider });
  const events = [];
  registry.on('availability', event => events.push(event));
  await registry.startAll();
  provider.emit('availability', { available: true });
  provider.emit('availability', { available: false, generation: 1 });
  assert.deepEqual(events[0].operations, ['push', 'steer']);
  assert.equal(events[0].providerId, 'goose-cli');
  assert.equal(events[1].generation, 1);
  await registry.restart('goose-cli');
  assert.equal(provider.starts, 2);
  assert.equal(provider.stops, 1);
  await registry.stopAll();
});

test('Provider event gate rejects duplicates and late events after a terminal state', () => {
  const gate = new ProviderEventGate();
  const base = { providerId: 'goose-cli', agentId: 'agent-a', turnId: 'turn-a', occurredAt: Date.now() };
  assert.equal(gate.accept({ ...base, eventId: 'event-1', type: 'accepted' }), true);
  assert.equal(gate.accept({ ...base, eventId: 'event-1', type: 'accepted' }), false);
  assert.equal(gate.accept({ ...base, eventId: 'event-2', type: 'completed', terminal: true }), true);
  assert.equal(gate.accept({ ...base, eventId: 'event-3', type: 'reply' }), false);
  assert.equal(gate.accept({ ...base, eventId: 'event-4', type: 'status' }), true);
});

test('Dispatcher security context is immutable before entering a transport', () => {
  const context = createMessageSecurityContext('visitor');
  assert.equal(Object.isFrozen(context), true);
  assert.equal(Object.isFrozen(context.instructions), true);
  assert.throws(() => context.instructions.push('override'));
});

test('enabled Goose rollout commits a transport receipt through Dispatcher', async (t) => {
  const db = fixture(t);
  const now = Date.now();
  db.prepare(`INSERT INTO agents
    (id,agent_id,imUid,imToken,im_server_url,publish_status,backend_type,delivery_modes,access_mode,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run('row-a', 'agent-a', 'agent-uid', 'token', 'http://im', 'published', 'goose', '["cli","pull"]', 'private', now, now);
  const provider = new EventEmitter();
  provider.priority = 1;
  provider.match = () => true;
  provider.isAvailable = () => true;
  provider.push = async () => ({ nativeSessionId: 'goose-session-a', deliveryMode: 'cli', adapterType: 'goose-cli' });
  const dispatcher = createDispatcher({ db, providers: { 'goose-cli': provider } });
  dispatcher.dispatch('agent-a', { agentId: 'agent-a', fromUid: 'visitor-a', channelId: 'visitor-a',
    channelType: 1, content: 'hello', messageId: 'message-a' });
  await new Promise(resolve => setTimeout(resolve, 20));
  const binding = new ProviderSessionCoordinator(db).getActive('agent-a', 'visitor-a', 1);
  assert.equal(binding.nativeSessionId, 'goose-session-a');
  assert.equal(binding.adapterType, 'goose-cli');
});

test('family allowlist enables central receipts without changing other families', async (t) => {
  const db = fixture(t);
  db.prepare('INSERT OR REPLACE INTO config(type,data,updated_at) VALUES(?,?,?)')
    .run('feature:provider_modular_dispatch_v1', JSON.stringify({ mode: 'enabled', providerFamilies: ['hermes'] }), Date.now());
  const now = Date.now();
  db.prepare(`INSERT INTO agents
    (id,agent_id,imUid,imToken,im_server_url,publish_status,backend_type,delivery_modes,access_mode,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run('row-h', 'agent-h', 'agent-h-uid', 'token', 'http://im', 'published', 'hermes', '["http","pull"]', 'private', now, now);
  const provider = new EventEmitter();
  provider.priority = 10;
  provider.match = () => true;
  provider.isAvailable = () => true;
  provider.push = async () => ({ nativeSessionId: 'hermes:profile:visitor', providerInstanceId: 'profile',
    deliveryMode: 'http', adapterType: 'hermes-http' });
  const dispatcher = createDispatcher({ db, providers: { 'hermes-http': provider } });
  dispatcher.dispatch('agent-h', { agentId: 'agent-h', fromUid: 'visitor-h', channelId: 'visitor-h',
    channelType: 1, content: 'hello', messageId: 'message-h' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(new ProviderSessionCoordinator(db).getActive('agent-h', 'visitor-h', 1).adapterType, 'hermes-http');
});

test('Cline Cursor and Copilot fall back once without crossing Agent sessions', async (t) => {
  const db = fixture(t);
  db.prepare('INSERT OR REPLACE INTO config(type,data,updated_at) VALUES(?,?,?)')
    .run('feature:provider_modular_dispatch_v1', JSON.stringify({
      mode: 'enabled', providerFamilies: ['goose'],
      familyModes: { cline: 'enabled', cursor: 'enabled', 'github-copilot': 'enabled' },
    }), Date.now());
  const now = Date.now();
  const families = [
    ['cline', 'agent-cline'],
    ['cursor', 'agent-cursor'],
    ['github-copilot', 'agent-copilot'],
  ];
  const insert = db.prepare(`INSERT INTO agents
    (id,agent_id,imUid,imToken,im_server_url,publish_status,backend_type,delivery_modes,access_mode,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  for (const [family, agentId] of families) {
    insert.run(`row-${agentId}`, agentId, `im-${agentId}`, 'token', 'http://im', 'published', family,
      '["acp","cli","pull"]', 'private', now, now);
  }
  const attempts = [];
  const providers = {};
  for (const [family] of families) {
    const acpId = `${family}-acp`;
    const cliId = `${family}-cli`;
    providers[acpId] = {
      priority: 10,
      match: (_agentId, meta) => meta.backend_type === family,
      isAvailable: () => true,
      push: async payload => {
        attempts.push(`${payload.agentId}:acp:${payload.messageId}`);
        const error = new Error('ACP unavailable before delivery');
        error.deliveryOutcome = 'not_delivered';
        throw error;
      },
    };
    providers[cliId] = {
      priority: 1,
      match: (_agentId, meta) => meta.backend_type === family,
      isAvailable: () => true,
      push: async payload => {
        attempts.push(`${payload.agentId}:cli:${payload.messageId}`);
        return { nativeSessionId: `session-${payload.agentId}`, deliveryMode: 'cli', adapterType: cliId };
      },
    };
  }
  const dispatcher = createDispatcher({ db, providers });
  await Promise.all(families.map(async ([, agentId]) => {
    dispatcher.dispatch(agentId, {
      agentId, fromUid: `visitor-${agentId}`, channelId: `visitor-${agentId}`, channelType: 1,
      content: `hello-${agentId}`, messageId: `message-${agentId}`,
    });
  }));
  await new Promise(resolve => setTimeout(resolve, 50));

  assert.equal(attempts.length, 6);
  for (const [family, agentId] of families) {
    assert.deepEqual(attempts.filter(value => value.startsWith(`${agentId}:`)), [
      `${agentId}:acp:message-${agentId}`,
      `${agentId}:cli:message-${agentId}`,
    ]);
    const binding = new ProviderSessionCoordinator(db).getActive(agentId, `visitor-${agentId}`, 1);
    assert.equal(binding.providerType, family);
    assert.equal(binding.adapterType, `${family}-cli`);
    assert.equal(binding.nativeSessionId, `session-${agentId}`);
  }
});

test('shadow rollout never persists a Provider receipt', async (t) => {
  const db = fixture(t);
  db.prepare('INSERT OR REPLACE INTO config(type,data,updated_at) VALUES(?,?,?)')
    .run('feature:provider_modular_dispatch_v1', JSON.stringify({ mode: 'shadow', providerFamilies: ['goose'] }), Date.now());
  const now = Date.now();
  db.prepare(`INSERT INTO agents
    (id,agent_id,imUid,imToken,im_server_url,publish_status,backend_type,delivery_modes,access_mode,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run('row-s', 'agent-s', 'agent-s-uid', 'token', 'http://im', 'published', 'goose', '["cli","pull"]', 'private', now, now);
  const provider = new EventEmitter();
  provider.priority = 1;
  provider.match = () => true;
  provider.isAvailable = () => true;
  provider.push = async () => ({ nativeSessionId: 'shadow-session', deliveryMode: 'cli', adapterType: 'goose-cli' });
  const dispatcher = createDispatcher({ db, providers: { 'goose-cli': provider } });
  dispatcher.dispatch('agent-s', { agentId: 'agent-s', fromUid: 'visitor-s', channelId: 'visitor-s',
    channelType: 1, content: 'hello', messageId: 'message-s' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(new ProviderSessionCoordinator(db).getActive('agent-s', 'visitor-s', 1), null);
});
