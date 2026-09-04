const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { classifyProviderTurnFailure } = require('../build/core/provider-turn-status');

test('Provider failure evidence maps consistently for human chat status', () => {
  const cases = [
    [{ errorCode: 'AUTOMATIC_DELIVERY_DISABLED', outcome: 'not_delivered' }, 'automatic_delivery_disabled'],
    [{ code: 'PROVIDER_QUOTA_EXHAUSTED' }, 'quota_exhausted'],
    [{ code: 'PROVIDER_AUTH_REQUIRED' }, 'login_expired'],
    [{ error: 'request timed out', outcome: 'not_delivered' }, 'timeout'],
    [{ errorCode: 'UNKNOWN', outcome: 'outcome_unknown' }, 'outcome_unknown'],
    [{ errorCode: 'UNKNOWN', outcome: 'not_delivered' }, 'failed'],
  ];
  for (const [input, expected] of cases) assert.equal(classifyProviderTurnFailure(input), expected);
});

test('E2EE logs Provider execution and reply delivery as separate correlated stages', () => {
  const dispatcher = fs.readFileSync(path.join(__dirname, '../src/core/dispatcher/index.ts'), 'utf8');
  const runtime = fs.readFileSync(path.join(__dirname, '../src/e2ee/v2-runtime.ts'), 'utf8');
  assert.match(dispatcher, /\[ProviderTurn\][\s\S]*providerOutcome=/);
  assert.match(runtime, /\[DeliveryTurn\][\s\S]*deliveryState=/);
  assert.match(runtime, /terminal=\$\{deliveryState!==\'queued\'\}/);
});
