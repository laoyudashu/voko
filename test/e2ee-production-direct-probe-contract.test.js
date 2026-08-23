'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'real-e2ee-direct-v2-production.js'), 'utf8');

test('production Direct v2 probe uses an anonymous bound web device and the Chatroom proxy', () => {
  assert.match(source, /deviceId, platform: 'chromium'/);
  assert.match(source, /\/api\/e2ee\/identity\?targetImUid=/);
  assert.match(source, /protocolMode=\$\{PROTOCOL_MODE\}/);
  assert.match(source, /protocolMode: PROTOCOL_MODE/);
  assert.match(source, /E2EE_PRODUCTION_WEB_DEVICE_BINDING_INVALID/);
});

test('production Direct v2 probe covers text, creator refresh, attachment and VOKO restart', () => {
  for (const check of ["checks.push('text')", "checks.push('creator_refresh')",
    "checks.push('attachment')", "checks.push('voko_restart')"]) assert.match(source, new RegExp(check.replace(/[()]/g, '\\$&')));
  assert.match(source, /op: 'snapshot'/);
  assert.match(source, /op: 'restore', snapshot/);
  assert.match(source, /voko\.e2ee\.attachment-message\/1/);
  assert.match(source, /VOKO_E2EE_PRODUCTION_RESTART_GATE/);
  assert.match(source, /process\.stdin\.pause\(\)/);
});

test('production Direct v2 replies are correlated by durable receipt rather than model wording', () => {
  assert.match(source, /FROM e2ee_production_receipts r/);
  assert.match(source, /row\?\.state !== 'completed'/);
  assert.match(source, /row\?\.reply_message_id !== replyMessageId/);
  assert.match(source, /Number\(row\?\.delivery_attempts\) !== 1/);
  assert.match(source, /row\?\.protocol_mode !== PROTOCOL_MODE/);
  assert.match(source, /reply\.plaintext\.includes\('\[端到端加密消息\]'\)/);
  assert.doesNotMatch(source, /reply\.plaintext\.includes\(expected\)/);
});

test('production Direct v2 probe never logs guest credentials or plaintext replies', () => {
  assert.doesNotMatch(source, /console\.(?:log|error)\([^\n]*(?:session\.token|session\.cookie|reply\.plaintext)/);
  assert.match(source, /plaintextFallbacks: 0/);
});

test('production Direct v2 probe verifies the emergency disable gate without exposing credentials', () => {
  assert.match(source, /VOKO_E2EE_PRODUCTION_EXPECT_DISABLED/);
  assert.match(source, /error\?\.status === 404/);
  assert.match(source, /error\?\.code === 'E2EE_DIRECT_V2_DISABLED'/);
  assert.match(source, /check: 'direct_disabled'/);
  assert.match(source, /E2EE_DIRECT_DISABLE_GATE_OPEN/);
});
