'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { CanaryStore } = require('../build/e2ee/canary-store');

test('Canary state survives SQLite restart as ciphertext and revocation stays locked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'voko-e2ee-canary-'));
  const path = join(dir, 'canary.db');
  const scope = { groupId:'restart-group',localAgentId:'agent',targetAgentDid:'did:voko:agent',
    senderDeviceKeyId:'browser',conversationScope:'conversation' };
  let db = new DatabaseSync(path); let store = new CanaryStore(db);
  const sealed = Buffer.from('VOKO-REC-001-not-plaintext');
  store.provision(scope,sealed); db.close();
  assert.doesNotMatch(readFileSync(path).toString('latin1'),/private message|private reply/);
  db = new DatabaseSync(path); store = new CanaryStore(db);
  assert.deepEqual(Buffer.from(store.session(scope.groupId).encrypted_state),sealed);
  store.emergencyDisable(); db.close();
  db = new DatabaseSync(path); store = new CanaryStore(db);
  assert.equal(store.session(scope.groupId).status,'locked');assert.equal(store.isEmergencyDisabled(),true);
  db.close(); rmSync(dir,{recursive:true,force:true});
});
