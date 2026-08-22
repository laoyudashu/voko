const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('A2A bridge aggregates repeated loop errors and reports recovery', () => {
  const runtime = fs.readFileSync(path.join(__dirname, '..', 'src', 'a2a', 'bridge-runtime.ts'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
  assert.match(runtime, /errorSummaryMs = 5 \* 60 \* 1000/);
  assert.match(runtime, /message !== lastError/);
  assert.match(runtime, /相同错误在过去周期内重复/);
  assert.match(runtime, /服务已恢复，此前连续失败/);
  assert.match(runtime, /onRecovery\?: \(code: string\) => void/);
  assert.match(index, /onRecovery: \(code: string\) => console\.warn\(`\[A2A Bridge\]/);
});
