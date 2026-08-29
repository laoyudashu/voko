'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs } = require('../scripts/real-browser-worker');

test('parseArgs accepts values and boolean flags', () => {
  assert.deepEqual(parseArgs(['--url', 'https://example.test', '--headed', '--width', '900']), {
    url: 'https://example.test',
    headed: true,
    width: '900',
  });
});
