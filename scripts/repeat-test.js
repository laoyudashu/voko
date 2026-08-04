#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const countArg = process.argv.find((arg) => arg.startsWith('--count='));
const count = Number(countArg?.split('=')[1] || 10);
if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('count must be an integer from 1 to 100');
const suiteArg = process.argv.find((arg) => arg.startsWith('--suite='));
const suite = suiteArg?.split('=')[1] || 'ci';
const suites = {
  ci: ['run', 'test:ci'],
  targeted: ['run', 'test:targeted'],
  unit: ['run', 'test:unit'],
  component: ['run', 'test:component'],
};
if (!suites[suite]) throw new Error(`suite must be one of: ${Object.keys(suites).join(', ')}`);
const reportArg = process.argv.find((arg) => arg.startsWith('--report='));
const reportPath = reportArg
  ? path.resolve(process.cwd(), reportArg.slice('--report='.length))
  : path.join(process.cwd(), 'test-reports', `repeat-${suite}.json`);
function npmInvocation() {
  const execPath = process.env.npm_execpath;
  if (execPath && fs.existsSync(execPath)) return [process.execPath, execPath];
  if (process.platform === 'win32') {
    const bundledCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (fs.existsSync(bundledCli)) return [process.execPath, bundledCli];
  }
  return [process.platform === 'win32' ? 'npm.cmd' : 'npm'];
}
const [npmCommand, ...npmPrefixArgs] = npmInvocation();
const startedAt = new Date().toISOString();
const iterations = [];
let exitCode = 0;
for (let iteration = 1; iteration <= count; iteration += 1) {
  const iterationStarted = Date.now();
  console.log(`[repeat-test] ${suite} iteration ${iteration}/${count}`);
  const result = spawnSync(npmCommand, [...npmPrefixArgs, ...suites[suite]], {
    cwd: process.cwd(), stdio: 'inherit', windowsHide: true, shell: false,
    env: { ...process.env, VOKO_TEST_ITERATION: String(iteration) },
  });
  if (result.error) throw result.error;
  const status = result.status ?? 1;
  iterations.push({ iteration, status, durationMs: Date.now() - iterationStarted });
  if (status !== 0) { exitCode = status || 1; break; }
}
const report = {
  suite,
  count,
  startedAt,
  finishedAt: new Date().toISOString(),
  passed: iterations.filter((item) => item.status === 0).length,
  failed: iterations.filter((item) => item.status !== 0).length,
  iterations,
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`[repeat-test] report=${reportPath}`);
if (exitCode) process.exit(exitCode);
