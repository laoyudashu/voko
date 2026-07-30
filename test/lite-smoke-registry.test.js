'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const smoke = require(path.join(
  __dirname,
  '..',
  'build',
  'testing',
  'smoke-all.js',
));

test('Lite smoke registry contains executable test functions', () => {
  assert.ok(smoke.REGISTRY.length > 0);

  const invalid = smoke.REGISTRY
    .filter(item => typeof item.fn !== 'function')
    .map(item => item.id);

  assert.deepEqual(invalid, []);
});

test('Lite smoke full-mode shorthand keeps metadata and mode', () => {
  const shorthand = smoke.REGISTRY.find(item => item.id === 'F_get_status');

  assert.ok(shorthand);
  assert.equal(shorthand.mode, 'full');
  assert.equal(shorthand.input, '');
  assert.equal(shorthand.expected, '');
  assert.equal(typeof shorthand.fn, 'function');
});

test('Lite smoke CLI parser accepts formatted JSON after operational logs', () => {
  const output = [
    '[updateProfile] sending... {"did":"did:test"}',
    '{',
    '  "success": true,',
    '  "data": { "agentId": "agent-1" }',
    '}',
  ].join('\n');

  assert.deepEqual(smoke.parseCliJson(output), {
    success: true,
    data: { agentId: 'agent-1' },
  });
});
