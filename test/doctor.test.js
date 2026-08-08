'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { initDatabase, SCHEMA_VERSION } = require('../build/core/database');
const { runDoctor, formatDoctor } = require('../build/core/doctor');

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-doctor-test-'));
  const dbPath = path.join(dir, 'voko.db');
  const db = initDatabase(dbPath, { silent: true });
  const now = Date.now();
  db.prepare("INSERT OR REPLACE INTO config (type, data, updated_at) VALUES ('current_user_email', ?, ?)")
    .run(JSON.stringify('doctor@example.test'), now);
  db.prepare("INSERT OR REPLACE INTO config (type, data, updated_at) VALUES ('user_access_token', ?, ?)")
    .run(JSON.stringify({ token: 'doctor-secret-value' }), now);
  db.prepare("INSERT OR REPLACE INTO config (type, data, updated_at) VALUES ('runtime', ?, ?)")
    .run(JSON.stringify({
      instanceId: 'doctor-instance', pid: process.pid, port: 32123, ts: now,
      agents: [{ agentId: 'doctor-agent', imConnected: true, automaticDeliveryReady: false, automaticReadyModes: [], activeAutomaticMode: null, pullReady: true }],
    }), now);
  db.prepare(`
    INSERT INTO agents
      (id, agent_id, imUid, imToken, im_server_url, owner_email, publish_status,
       access_mode, backend_type, delivery_modes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'published', 'public', ?, ?, ?, ?)
  `).run(
    'doctor-agent-row', 'doctor-agent', 'doctor-im', 'doctor-token', 'wss://example.test',
    'doctor@example.test', 'others', JSON.stringify(['pull']), now, now,
  );
  db.close();
  return { dir, dbPath };
}

test('doctor reports an isolated healthy runtime without exposing secrets', async (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));
  const result = await runDoctor({
    dbPath: fixture.dbPath,
    mcpConfigPaths: [],
    deps: {
      readInstanceMetadata: () => ({ instanceId: 'doctor-instance', pid: process.pid, port: 32123 }),
      isInstanceAlive: () => true,
    },
    fetchImpl: async () => ({ ok: true, status: 200 }),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.healthy, true);
  assert.equal(result.summary.errors, 0);
  assert.match(formatDoctor(result), /VOKO Doctor/);
  assert.doesNotMatch(JSON.stringify(result), /doctor-secret-value/);
  assert.ok(result.checks.some((check) => check.id === 'integrity' && check.status === 'ok'));
  assert.ok(result.checks.some((check) => check.id === 'runtime' && check.status === 'ok'));
});

test('doctor reports a missing database with a machine-readable error code', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-doctor-missing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = await runDoctor({ dbPath: path.join(dir, 'missing.db') });
  assert.equal(result.exitCode, 2);
  assert.equal(result.success, false);
  assert.equal(result.checks.find((check) => check.id === 'database')?.status, 'error');
});

test('doctor deep mode probes configured endpoints without starting a provider', async (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));
  const calls = [];
  const result = await runDoctor({
    dbPath: fixture.dbPath,
    mcpConfigPaths: [],
    deep: true,
    deps: {
      readInstanceMetadata: () => ({ instanceId: 'doctor-instance', pid: process.pid, port: 32123 }),
      isInstanceAlive: () => true,
    },
    fetchImpl: async (url) => {
      calls.push(url);
      return { ok: true, status: 200 };
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(calls.length, 4); // local health + API + IM + OSS
  assert.ok(result.checks.some((check) => check.id === 'remote-api' && check.status === 'ok'));
  assert.ok(result.checks.some((check) => check.id === 'im-api' && check.status === 'ok'));
  assert.ok(result.checks.some((check) => check.id === 'oss' && check.status === 'ok'));
});

test('doctor CLI supports --json and does not initialize a missing database', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-doctor-cli-'));
  try {
    const dbPath = path.join(dir, 'missing.db');
    const result = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'build', 'index.js'), 'doctor', '--json', '--db', dbPath,
    ], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 2);
    const report = JSON.parse(result.stdout);
    assert.equal(report.dbPath, dbPath);
    assert.equal(fs.existsSync(dbPath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor uses the current schema version from the database module', () => {
  assert.equal(typeof SCHEMA_VERSION, 'number');
  assert.ok(SCHEMA_VERSION >= 1);
});

test('doctor reports stale MCP configuration without exposing its contents', async (t) => {
  const fixture = makeFixture();
  const configPath = path.join(fixture.dir, 'goose-config.yaml');
  fs.writeFileSync(configPath, 'extensions:\n  voko:\n    uri: http://localhost:3002/mcp\n    token: do-not-print-this-token\n');
  t.after(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));
  const result = await runDoctor({ dbPath: fixture.dbPath, mcpConfigPaths: [{ client: 'Goose', path: configPath }] });
  const check = result.checks.find((item) => item.id === 'mcp-config');
  assert.equal(check.status, 'warn');
  assert.match(JSON.stringify(check), /STALE_MCP_PORT/);
  assert.match(JSON.stringify(check), /Goose/);
  assert.doesNotMatch(JSON.stringify(result), /do-not-print-this-token/);
});

test('doctor --fix-mcp migrates an unambiguous legacy VOKO entry and keeps a backup', async (t) => {
  const fixture = makeFixture();
  const configPath = path.join(fixture.dir, 'client.json');
  fs.writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      voko: { url: 'http://localhost:3002/mcp', headers: { Authorization: 'Bearer secret-that-must-not-leak' } },
      other: { command: 'other-agent', args: [] },
    },
  }, null, 2));
  t.after(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));

  const result = await runDoctor({
    dbPath: fixture.dbPath,
    mcpConfigPaths: [{ client: 'Test Client', path: configPath }],
    fixMcp: true,
  });

  assert.equal(result.mcpMigration.changed, 1);
  assert.equal(result.mcpMigration.errors, 0);
  assert.equal(result.mcpMigration.clients[0].status, 'updated');
  assert.ok(fs.existsSync(`${configPath}.voko-mcp.bak`));
  const migrated = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepEqual(migrated.mcpServers.voko, { command: 'voko', args: ['mcp'] });
  assert.deepEqual(migrated.mcpServers.other, { command: 'other-agent', args: [] });
  assert.doesNotMatch(JSON.stringify(result), /secret-that-must-not-leak/);
  assert.equal(result.checks.find((item) => item.id === 'mcp-config')?.status, 'ok');
});
