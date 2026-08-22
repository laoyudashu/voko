'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('production E2EE startup has a module-scoped filesystem dependency', () => {
  const source = fs.readFileSync('src/index.ts', 'utf8');
  assert.match(source, /const fs = require\('fs'\);/);
  assert.match(source, /fs\.mkdirSync\(path\.dirname\(e2eePath\)/);
  assert.match(source, /publish_status='published'/);
  assert.match(source, /serverAgentIdFromDid\(row\.did\)/);
});
