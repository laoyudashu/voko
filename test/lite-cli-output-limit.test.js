const test = require('node:test');
const assert = require('node:assert/strict');

const { runCli } = require('../build/core/adapters/cli-spawner');

test('CLI output is terminated once it exceeds the configured safety limit', async () => {
  await assert.rejects(
    runCli({
      cmd: process.execPath,
      args: ['-e', "process.stdout.write('x'.repeat(4096))"],
      maxOutputBytes: 128,
      timeout: 5000,
      tag: 'output-limit-test',
    }),
    /128 bytes/,
  );
});
