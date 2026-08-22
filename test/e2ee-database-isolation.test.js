'use strict';
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');
const { CanaryStore } = require('../build/e2ee/canary-store');

test('E2EE state migrates idempotently into its independent database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'voko-e2ee-isolation-'));
  const main = new DatabaseSync(join(dir, 'voko.db'));
  const isolated = new DatabaseSync(join(dir, 'voko-e2ee.db'));
  try {
    const legacy = new CanaryStore(main);
    const scope = { groupId:'g',localAgentId:'a',targetAgentDid:'did:a',senderDeviceKeyId:'d',conversationScope:'c' };
    legacy.reserve(scope,'m','digest');
    const target = new CanaryStore(isolated);
    assert.deepEqual(target.migrateLegacy(main), { sessions:1, receipts:1 });
    assert.deepEqual(target.migrateLegacy(main), { sessions:0, receipts:0 });
    assert.ok(target.session('g'));
  } finally { main.close(); isolated.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('Lite bootstrap rejects reusing the main database for E2EE state', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname,'..','src','index.ts'),'utf8');
  assert.match(source, /VOKO_E2EE_DB_PATH must differ from the main database/);
  assert.match(source, /voko-e2ee\.db/);
});
