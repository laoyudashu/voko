#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TEST_DIR = path.join(ROOT, 'test');
const IN_PROCESS_TESTS = new Set(['lite-core-services.test.js']);
// build/ 是所有组件测试的共享只读产物；原子构建测试必须单独运行，避免
// 它在替换 build 树时与其他测试同时读取。其余隔离文件可并发运行，明显
// 缩短 Windows 上多个真实子进程生命周期测试叠加造成的门禁时间。
const BUILD_MUTATING_TESTS = new Set(['lite-build-atomic.test.js']);
const PROCESS_SENSITIVE_TESTS = new Set([
  'dynamic-port.test.js',
  'lite-fatal-lifecycle.test.js',
  'lite-process-lifecycle.test.js',
]);
const TEST_CONCURRENCY = Math.max(1, Number(process.env.VOKO_TEST_CONCURRENCY) || 4);

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
const buildMutatingFiles = testFiles
  .filter(name => BUILD_MUTATING_TESTS.has(name));
const processSensitiveFiles = testFiles
  .filter(name => PROCESS_SENSITIVE_TESTS.has(name));
const isolatedFiles = testFiles
  .filter(name => !IN_PROCESS_TESTS.has(name) && !BUILD_MUTATING_TESTS.has(name) && !PROCESS_SENSITIVE_TESTS.has(name))
  .map(name => path.join('test', name));

if (buildMutatingFiles.length) {
  run(['--test', '--test-concurrency=1', ...buildMutatingFiles.map(name => path.join('test', name))]);
}
if (processSensitiveFiles.length) {
  run(['--test', '--test-concurrency=1', ...processSensitiveFiles.map(name => path.join('test', name))]);
}
run(['--test', `--test-concurrency=${TEST_CONCURRENCY}`, ...isolatedFiles]);
for (const name of IN_PROCESS_TESTS) {
  run(['--test', '--experimental-test-isolation=none', path.join('test', name)]);
}
