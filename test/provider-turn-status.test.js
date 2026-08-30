const test = require('node:test');
const assert = require('node:assert/strict');

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
