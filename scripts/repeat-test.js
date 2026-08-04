#!/usr/bin/env node

const { spawnSync } = require('node:child_process');

const countArg = process.argv.find((arg) => arg.startsWith('--count='));
const count = Number(countArg?.split('=')[1] || 10);
if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('count must be an integer from 1 to 100');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
for (let iteration = 1; iteration <= count; iteration += 1) {
  console.log(`[repeat-test] CI iteration ${iteration}/${count}`);
  const result = spawnSync(npmCommand, ['run', 'test:ci'], {
    cwd: process.cwd(), stdio: 'inherit', windowsHide: true, shell: false,
    env: { ...process.env, VOKO_TEST_ITERATION: String(iteration) },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
