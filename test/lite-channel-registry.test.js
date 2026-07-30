const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const liteBuild = path.join(__dirname, '..', 'build');
const registryPath = path.join(liteBuild, 'channels', 'registry.js');

function loadFreshRegistry() {
  delete require.cache[require.resolve(registryPath)];
  return require(registryPath);
}

async function withMockHandler(name, HandlerClass, run) {
  const handlerPath = path.join(liteBuild, 'server', `${name}-handler.js`);
  const resolved = require.resolve(handlerPath);
  const previous = require.cache[resolved];
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: HandlerClass,
  };
  try {
    await run();
  } finally {
    if (previous) require.cache[resolved] = previous;
    else delete require.cache[resolved];
  }
}

function createDatabaseApi(overrides = {}) {
  return {
    getEnabledChannel: () => null,
    updateOwnerInterventionReply: () => ({ success: true, contentChanged: true }),
    markAgentNotified: () => ({ success: true }),
    updateOwnerInterventionStatus: () => ({ success: true }),
    getOwnerInterventionByParentMsgId: () => null,
    getLatestPendingIntervention: () => null,
    getPendingByAgentAndVisitor: () => null,
    ...overrides,
  };
}

test('渠道 Registry 从 build 暴露固定且完整的渠道定义', () => {
  const registry = loadFreshRegistry();
  const names = registry.getRegisteredNames();
  assert.deepEqual(names, ['voko-email']);

  for (const name of names) {
    const definition = registry.getChannelDef(name);
    assert.equal(definition.name, name);
    assert.equal(typeof definition.displayName, 'string');
    assert.equal(typeof definition.handlerClass, 'string');
    assert.equal(typeof definition.extractConfig, 'function');
    assert.ok(Array.isArray(definition.configFields));
  }
});

test('主人回复通过 resume 回调成功后才标记已通知和 resolved', async () => {
  const calls = [];
  const registry = loadFreshRegistry();
  const databaseAPI = createDatabaseApi({
    updateOwnerInterventionReply: () => ({ success: true, contentChanged: true }),
    markAgentNotified: (id) => calls.push(['notified', id]),
    updateOwnerInterventionStatus: (id, status) => calls.push(['status', id, status]),
  });
  const onReply = registry.createOnOwnerReply('telegram', {
    databaseAPI,
    buildOwnerReplyPrompt: registry.buildOwnerReplyPrompt,
    resumeOwnerIntervention: async (_intervention, prompt) => {
      calls.push(['resume', prompt]);
      return { success: true };
    },
  });

  onReply({
    id: 'intervention-1',
    visitorId: 'visitor-1',
    sessionKey: 'agent:a:visitor-1',
    problem: '需要主人确认',
  }, '可以', 'reply-1');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls[0][0], 'resume');
  assert.deepEqual(calls.slice(1), [
    ['notified', 'intervention-1'],
    ['status', 'intervention-1', 'resolved'],
  ]);
});

test('voko-email 首次初始化与重新初始化都注入 agentEmailApi 和 db', async () => {
  const callbackSnapshots = [];
  class FakeVokoEmailHandler {
    constructor(_config, callbacks) {
      callbackSnapshots.push(callbacks);
    }
    async start() {}
    async stop() {}
  }

  await withMockHandler('voko-email', FakeVokoEmailHandler, async () => {
    const registry = loadFreshRegistry();
    const agentEmailApi = { send: async () => ({ success: true }) };
    const db = { prepare: () => ({ get: () => null, run: () => ({}) }) };
    const databaseAPI = createDatabaseApi({
      getEnabledChannel: (name) => name === 'voko-email' ? { enabled: true, config: {} } : null,
    });
    const deps = {
      databaseAPI,
      buildOwnerReplyPrompt: registry.buildOwnerReplyPrompt,
      agentEmailApi,
      db,
    };

    registry.initializeAllChannels(deps);
    registry.reinitializeChannel('voko-email', deps);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(callbackSnapshots.length, 2);
    for (const callbacks of callbackSnapshots) {
      assert.equal(callbacks.agentEmailApi, agentEmailApi);
      assert.equal(callbacks.db, db);
    }
  });
});
