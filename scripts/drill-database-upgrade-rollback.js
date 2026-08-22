'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const requested = process.argv.find((value) => value.startsWith('--input='))?.slice(8);
if (!requested) throw new Error('Usage: node scripts/drill-database-upgrade-rollback.js --input=<backup.db>');
const source = path.resolve(requested);
if (!fs.statSync(source).isFile()) throw new Error('Database backup is not a file');

const { initDatabase, SCHEMA_VERSION } = require(path.join(root, 'build', 'core', 'database'));
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-db-rollback-drill-'));
const working = path.join(temporaryRoot, 'working.db');
const pristine = path.join(temporaryRoot, 'pristine.db');

function verify(databasePath) {
  const db = initDatabase(databasePath, { silent: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get()?.integrity_check;
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version || 0);
    if (integrity !== 'ok') throw new Error(`Database integrity check failed: ${integrity}`);
    if (version !== SCHEMA_VERSION) throw new Error(`Unexpected schema version ${version}`);
    return { integrity, version };
  } finally {
    db.close();
  }
}

try {
  fs.copyFileSync(source, working);
  fs.copyFileSync(source, pristine);
  const upgraded = verify(working);

  fs.copyFileSync(pristine, working);
  const rolledBack = verify(working);
  console.log(JSON.stringify({ passed: true, source: path.basename(source), upgraded, rolledBack }));
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
