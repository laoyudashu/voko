const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  A2AModule,
  A2A_SCHEMA_VERSION,
  initA2ADatabase,
  isA2AEnabled,
  resolveA2ADatabasePath,
} = require('../build/a2a');

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-a2a-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('A2A remains disabled unless explicitly enabled', () => {
  assert.equal(isA2AEnabled({}), false);
  assert.equal(isA2AEnabled({ VOKO_A2A_ENABLED: 'false' }), false);
  assert.equal(isA2AEnabled({ VOKO_A2A_ENABLED: '0' }), false);
  assert.equal(isA2AEnabled({ VOKO_A2A_ENABLED: 'true' }), true);
  assert.equal(isA2AEnabled({ VOKO_A2A_ENABLED: '1' }), true);
});

test('A2A database path is independent from the main VOKO database', () => {
  assert.equal(
    resolveA2ADatabasePath({
      env: { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' },
      platform: 'win32',
      homeDir: 'C:\\Users\\test',
    }),
    path.resolve('C:\\Users\\test\\AppData\\Roaming', 'voko', 'voko-a2a.db'),
  );
  assert.equal(
    resolveA2ADatabasePath({
      env: { XDG_CONFIG_HOME: '/tmp/config' },
      platform: 'linux',
      homeDir: '/home/test',
    }),
    path.join('/tmp/config', 'voko', 'voko-a2a.db'),
  );
  assert.equal(
    resolveA2ADatabasePath({ env: {}, platform: 'darwin', homeDir: '/Users/test' }),
    path.join('/Users/test', 'Library', 'Application Support', 'voko', 'voko-a2a.db'),
  );
});

test('disabled A2A module does not create or open a database', (t) => {
  const directory = temporaryDirectory(t);
  const databasePath = path.join(directory, 'voko-a2a.db');
  let opens = 0;
  const module = new A2AModule({
    enabled: false,
    databasePath,
    openDatabase() {
      opens++;
      throw new Error('must not open');
    },
  });

  assert.equal(module.start(), undefined);
  assert.equal(module.running, false);
  assert.equal(opens, 0);
  assert.equal(fs.existsSync(databasePath), false);
});

test('enabled A2A module owns and closes only its independent database', (t) => {
  const directory = temporaryDirectory(t);
  const mainDatabasePath = path.join(directory, 'voko.db');
  const a2aDatabasePath = path.join(directory, 'voko-a2a.db');
  const main = new DatabaseSync(mainDatabasePath);
  main.exec('CREATE TABLE main_marker (id INTEGER PRIMARY KEY)');
  main.close();
  const mainBefore = fs.readFileSync(mainDatabasePath);

  const module = new A2AModule({ enabled: true, databasePath: a2aDatabasePath });
  const stop = module.start();
  assert.equal(module.running, true);
  assert.equal(fs.existsSync(a2aDatabasePath), true);
  assert.deepEqual(fs.readFileSync(mainDatabasePath), mainBefore);

  stop();
  assert.equal(module.running, false);
  assert.doesNotThrow(() => {
    const reopened = new DatabaseSync(a2aDatabasePath);
    reopened.close();
  });
});

test('A2A database has its own version and no ordinary messaging tables', (t) => {
  const directory = temporaryDirectory(t);
  const databasePath = path.join(directory, 'voko-a2a.db');
  const db = initA2ADatabase(databasePath);

  assert.equal(db.prepare('PRAGMA user_version').get().user_version, A2A_SCHEMA_VERSION);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all().map(row => row.name);
  assert.deepEqual(tables, [
    'a2a_local_contexts',
    'a2a_local_inbox',
    'a2a_local_outbox',
    'a2a_local_tasks',
    'a2a_meta',
    'a2a_remote_task_results',
    'a2a_settings',
  ]);
  assert.equal(tables.includes('messages'), false);
  assert.equal(tables.includes('conversations'), false);
  db.close();
});

test('A2A source does not depend on the IM or ordinary conversation pipeline', () => {
  const sourceDirectory = path.join(__dirname, '..', 'src', 'a2a');
  const source = fs.readdirSync(sourceDirectory)
    .filter(name => /\.(ts|js)$/.test(name))
    .map(name => fs.readFileSync(path.join(sourceDirectory, name), 'utf8'))
    .join('\n');

  assert.doesNotMatch(source, /wukong|im-sdk|send-message|messenger|provider-routing/i);
});
