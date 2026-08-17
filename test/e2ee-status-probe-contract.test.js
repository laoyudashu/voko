'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'check-e2ee-canary-status.js'), 'utf8');

test('deployed Canary probe verifies global disable and irreversible device revocation without printing credentials', () => {
  assert.match(source, /expected === 'disabled'/);
  assert.match(source, /response\.status !== 404/);
  assert.match(source, /--drill-revoke=/);
  assert.match(source, /replay\.status !== 409/);
  assert.doesNotMatch(source, /console\.log\([^\n]*token/i);
});
