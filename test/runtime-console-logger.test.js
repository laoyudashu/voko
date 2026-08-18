const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const { withRuntimeTimestamp } = require('../build/index');

test('runtime log arguments receive one local timestamp', () => {
  const now = new Date(2026, 7, 18, 9, 8, 7, 6);
  assert.deepEqual(
    withRuntimeTimestamp(['[Lite] ready', { port: 3100 }], now),
    ['[2026-08-18 09:08:07]', '[Lite] ready', { port: 3100 }],
  );
});

test('runtime logger does not duplicate an existing timestamp', () => {
  const args = ['[09:08:07][IM 心跳] connected'];
  assert.strictEqual(withRuntimeTimestamp(args), args);
});

test('machine-readable CLI output remains free of runtime timestamps', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'build', 'index.js'), '--version'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^voko \d+\.\d+\.\d+\s*$/);
  assert.doesNotMatch(result.stdout, /^\[\d{4}-\d{2}-\d{2}/);
});
