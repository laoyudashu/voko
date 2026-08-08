'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const entry = path.join(__dirname, '..', 'build', 'index.js');

test('voko probe requires explicit confirmation before sending a real message', () => {
  const result = spawnSync(process.execPath, [
    entry, 'probe', '--agent-id', 'agent-under-test', '--visitor-id', 'visitor-under-test',
  ], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /CONFIRM_REQUIRED/);
  assert.doesNotMatch(result.stdout, /voko-probe-/);
});

test('voko probe help is available without a running runtime', () => {
  const result = spawnSync(process.execPath, [entry, 'probe', '--help'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--agent-id/);
  assert.match(result.stdout, /--confirm/);
});
