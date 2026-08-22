const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('E2EE attachment Canary stays separate from the production attachment path', () => {
  const script = fs.readFileSync('scripts/test-e2ee-attachment-fake-oss.js', 'utf8');
  const index = fs.readFileSync('src/index.ts', 'utf8');
  assert.match(script, /E2EE_ATTACHMENT_SERVER_MUST_NOT_SEE/);
  assert.match(script, /fault\.mode = '500'/);
  assert.match(script, /fault\.mode = 'timeout'/);
  assert.match(script, /fault\.mode = 'corrupt'/);
  assert.doesNotMatch(index, /voko-e2ee-attachment-endpoint/);
  assert.doesNotMatch(index, /test-e2ee-attachment-fake-oss/);
});

test('real attachment Canary requires an acknowledged private non-production Bucket', () => {
  const script = fs.readFileSync('scripts/test-e2ee-attachment-real-oss.js', 'utf8');
  assert.match(script, /VOKO_E2EE_TEST_OSS_ACKNOWLEDGE_DEDICATED/);
  assert.match(script, /Production OSS Bucket cannot be used/);
  assert.match(script, /'x-oss-object-acl': 'private'/);
  assert.doesNotMatch(script, /console\.(?:log|error).*accessKeySecret/i);
});
