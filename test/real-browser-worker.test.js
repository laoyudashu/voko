'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { markerOccurrence, parseArgs } = require('../scripts/real-browser-worker');

test('parseArgs accepts values and boolean flags', () => {
  assert.deepEqual(parseArgs(['--url', 'https://example.test', '--headed', '--width', '900']), {
    url: 'https://example.test',
    headed: true,
    width: '900',
  });
});

test('markerOccurrence distinguishes the sent visitor message from the Agent reply', () => {
  assert.equal(markerOccurrence('canary other canary', 'canary'), 2);
  assert.equal(markerOccurrence('nothing', 'canary'), 0);
});
