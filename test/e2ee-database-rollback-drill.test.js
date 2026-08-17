const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { initDatabase, SCHEMA_VERSION } = require('../build/core/database');

test('database rollback drill upgrades and restores only temporary copies', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-db-drill-test-'));
  const source = path.join(dir, 'backup.db');
  const db = initDatabase(source, { silent: true });
  db.close();
  const before = fs.readFileSync(source);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const output = execFileSync(process.execPath, [
    'scripts/drill-database-upgrade-rollback.js', `--input=${source}`,
  ], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
  const result = JSON.parse(output);

  assert.equal(result.passed, true);
  assert.equal(result.upgraded.version, SCHEMA_VERSION);
  assert.equal(result.rolledBack.integrity, 'ok');
  assert.deepEqual(fs.readFileSync(source), before);
});
