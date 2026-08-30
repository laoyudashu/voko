'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('real E2EE matrices never temporarily publish private Agents', () => {
  for (const file of ['real-matrix.js', 'real-attachment-matrix.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', file), 'utf8');
    assert.doesNotMatch(source, /set_agent_status[\s\S]{0,160}visibility/,
      `${file} must use durable cross-owner access instead of visibility overrides`);
  }
});
