#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TEST_DIR = path.join(ROOT, 'test');
const IN_PROCESS_TESTS = new Set(['lite-core-services.test.js']);

function run(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

const testFiles = fs.readdirSync(TEST_DIR)
  .filter(name => name.endsWith('.test.js'))
  .sort();
const isolatedFiles = testFiles
  .filter(name => !IN_PROCESS_TESTS.has(name))
  .map(name => path.join('test', name));

run(['--test', '--test-concurrency=1', ...isolatedFiles]);
for (const name of IN_PROCESS_TESTS) {
  run(['--test', '--experimental-test-isolation=none', path.join('test', name)]);
}
