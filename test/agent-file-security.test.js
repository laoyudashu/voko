'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveContainedFile } = require('../src/core/agent-files');

test('agent file resolver confines reads and writes to the real workspace', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-agent-file-'));
  const workspace = path.join(base, 'agent');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(workspace, 'SOUL.md'), 'ok');
  fs.writeFileSync(path.join(outside, 'secret.md'), 'secret');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  assert.equal(resolveContainedFile(workspace, 'SOUL.md'), path.join(workspace, 'SOUL.md'));
  assert.throws(() => resolveContainedFile(workspace, '../outside/secret.md'), /Invalid path/);
  assert.throws(() => resolveContainedFile(workspace, path.join(outside, 'secret.md')), /Invalid path/);
  assert.throws(() => resolveContainedFile(workspace, ''), /Invalid path/);

  try {
    fs.symlinkSync(outside, path.join(workspace, 'linked'), 'junction');
    assert.throws(() => resolveContainedFile(workspace, 'linked/secret.md'), /Invalid path/);
    assert.throws(() => resolveContainedFile(workspace, 'linked/new.md', true), /Invalid path/);
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
  }
});
