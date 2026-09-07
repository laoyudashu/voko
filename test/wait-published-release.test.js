'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { waitForPublishedRelease } = require('../scripts/wait-published-release');

function clock() {
  let time = 0;
  return { now: () => time, sleep: async ms => { time += ms; }, log() {} };
}

test('registry verification tolerates delayed availability and checks the prepared artifact', async () => {
  let calls = 0;
  const result = await waitForPublishedRelease({ ...clock(), expectedIntegrity: 'sha512-fixture',
    verify: async () => {
      if (++calls < 4) throw new Error('npm metadata returned HTTP 404');
      return { version: '0.5.4', integrity: 'sha512-fixture' };
    } });
  assert.equal(calls, 4);
  assert.equal(result.version, '0.5.4');
});

test('registry timeout stays bounded and instructs recovery without republishing', async () => {
  let calls = 0;
  await assert.rejects(waitForPublishedRelease({ ...clock(), expectedIntegrity: 'sha512-fixture',
    timeoutMs: 100, intervalMs: 30, verify: async () => { calls++; throw new Error('not available'); } }),
  /timed out; do not republish/);
  assert.equal(calls, 4);
});

test('a different published artifact fails immediately', async () => {
  let calls = 0;
  await assert.rejects(waitForPublishedRelease({ ...clock(), expectedIntegrity: 'sha512-fixture',
    verify: async () => { calls++; return { integrity: 'sha512-other' }; } }), /differs from prepared/);
  assert.equal(calls, 1);
});
