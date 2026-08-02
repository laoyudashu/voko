const { test } = require('node:test');
const assert = require('node:assert/strict');
const { initDatabase, createDatabaseAPI } = require('../build/core/database');
const { createHandlers } = require('../build/index');

test('provider loading initializes the complete requested family only', async (t) => {
  const db = initDatabase(':memory:', { silent: true });
  const handlers = createHandlers({
    db,
    databaseAPI: createDatabaseAPI(db),
    backendTypes: ['openclaw'],
    startProviders: false,
  });
  t.after(async () => {
    await handlers.dispatcher?.stop?.();
    db.close();
  });

  assert.ok(handlers.dispatcher.providers['openclaw-ws']);
  assert.ok(handlers.dispatcher.providers['openclaw-cli']);
  assert.equal(handlers.dispatcher.providers['hermes-http'], undefined);
  assert.equal(handlers.dispatcher.providers['codex-cli'], undefined);
});

test('provider loading includes all main and fallback channels in a family', async (t) => {
  const db = initDatabase(':memory:', { silent: true });
  const handlers = createHandlers({
    db,
    databaseAPI: createDatabaseAPI(db),
    backendTypes: ['opencode', 'cursor'],
    startProviders: false,
  });
  t.after(async () => {
    await handlers.dispatcher?.stop?.();
    db.close();
  });

  assert.ok(handlers.dispatcher.providers['opencode-attach']);
  assert.ok(handlers.dispatcher.providers['opencode-acp']);
  assert.ok(handlers.dispatcher.providers['opencode-cli']);
  assert.ok(handlers.dispatcher.providers['cursor-acp']);
  assert.ok(handlers.dispatcher.providers['cursor-cli']);
  assert.equal(handlers.dispatcher.providers['openclaw-ws'], undefined);
});

test('a provider family can be loaded once after an agent changes backend', async (t) => {
  const db = initDatabase(':memory:', { silent: true });
  const handlers = createHandlers({
    db,
    databaseAPI: createDatabaseAPI(db),
    backendTypes: [],
    startProviders: false,
  });
  t.after(async () => {
    await handlers.dispatcher?.stop?.();
    db.close();
  });

  await Promise.all([
    handlers.dispatcher.ensureBackend('cursor'),
    handlers.dispatcher.ensureBackend('cursor'),
  ]);
  assert.ok(handlers.dispatcher.providers['cursor-acp']);
  assert.ok(handlers.dispatcher.providers['cursor-cli']);
  assert.equal(Object.keys(handlers.dispatcher.providers).filter(key => key.startsWith('cursor-')).length, 2);
});
