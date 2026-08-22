'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('production E2EE startup has a module-scoped filesystem dependency', () => {
  const source = fs.readFileSync('src/index.ts', 'utf8');
  assert.match(source, /const fs = require\('fs'\);/);
  assert.match(source, /fs\.mkdirSync\(path\.dirname\(e2eePath\)/);
  assert.match(source, /publish_status='published'/);
  assert.match(source, /serverAgentIdFromDid\(row\.did\)/);
});

test('an unavailable production E2EE runtime never acknowledges and drops ciphertext', () => {
  const source = fs.readFileSync('src/index.ts', 'utf8');
  assert.match(source, /E2EE_RUNTIME_UNAVAILABLE/);
  assert.match(source, /data\?\.nack\?\.\(error\)/);
  assert.doesNotMatch(source, /未启用或初始化失败，拒绝密文消息'[\s\S]{0,120}data\?\.ack/);
});
