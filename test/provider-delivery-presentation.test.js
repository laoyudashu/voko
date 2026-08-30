const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyProviderDeliveryPresentation } = require('../build/core/provider-delivery-presentation');

test('maps provider delivery evidence to the seven shared UI states', () => {
  const cases = [
    [{ installed: true, verificationStatus: 'loopback_verified' }, 'verified', null],
    [{ installed: true, status: 'ready', verificationStatus: 'preflight_passed' }, 'pending_verification', 'verify'],
    [{ installed: true, authenticationStatus: 'logged_out' }, 'login_expired', 'setup'],
    [{ installed: true, verificationStatus: 'quota_exhausted' }, 'quota_exhausted', 'resolve'],
    [{ installed: true, verificationStatus: 'timeout' }, 'timeout', 'retry'],
    [{ installed: true, verificationStatus: 'parse_failed' }, 'failed', 'resolve'],
    [{ installed: false, reason: 'not_found' }, 'not_installed', 'setup'],
  ];
  for (const [input, state, action] of cases) {
    const result = classifyProviderDeliveryPresentation(input);
    assert.equal(result.state, state);
    assert.equal(result.action, action);
  }
});

test('WorkBuddy shallow availability does not depend on CodeBuddy login evidence', () => {
  const result = classifyProviderDeliveryPresentation({
    installed: true,
    status: 'ready',
    authenticationStatus: 'unknown',
    verificationStatus: 'preflight_passed',
    detail: 'CodeBuddy account state is intentionally not used',
  });
  assert.equal(result.state, 'pending_verification');
  assert.equal(result.action, 'verify');
});
