'use strict';
const assert = require('node:assert/strict'); const fs = require('node:fs'); const os = require('node:os');
const path = require('node:path'); const test = require('node:test');
const { A2APublicationStore, initA2ADatabase } = require('../build/a2a');
test('A2A publication defaults on and persists an explicit opt-out independently', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-publication-')); const db = initA2ADatabase(path.join(dir, 'a.db'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }); const store = new A2APublicationStore(db);
  assert.equal(store.isPublicEnabled('agent-1'), true); store.setPublicEnabled('agent-1', false);
  assert.equal(store.isPublicEnabled('agent-1'), false); store.setPublicEnabled('agent-1', true);
  assert.equal(store.isPublicEnabled('agent-1'), true);
});
