'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('production text probe exercises the formal guest-to-Lite encrypted path', () => {
  const source = fs.readFileSync('scripts/real-e2ee-production-text.js','utf8');
  for (const fragment of ['/guest/v1/e2ee/key-packages/reserve','/guest/v1/e2ee/establishments',
    '/guest/v1/messages','contentType:CONTENT_TYPE_E2EE','plaintextFallbacks:0']) assert.ok(source.includes(fragment));
  assert.doesNotMatch(source,/e2ee\/canary\/status|VOKO_E2EE_INTERNAL_RUNTIME/);
  assert.match(source,/if \(!String\(line\)\.trim\(\)\) return;/,
    'blank native endpoint output must not consume a pending command response');
});
