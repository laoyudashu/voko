'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkAuditRules, deterministicSignals } = require('../build/core/audit');

const credentials = [
  ['github', 'ghp_example' + 'ab12'.repeat(6), 'ghp_' + 'cd34'.repeat(7)],
  ['openai', 'sk-example-' + 'ab12'.repeat(6), 'sk-' + 'cd34'.repeat(7)],
  ['bearer', 'Authorization: Bearer example' + 'ab12'.repeat(6), 'Authorization: Bearer ' + 'cd34'.repeat(7)],
  ['database URL', 'postgres://example:synthetic-value@', 'postgres://account:synthetic-value@'],
];
for (const [name, placeholder, credential] of credentials) {
  test(`credential exceptions only apply to each ${name} match`, () => {
    assert.equal(deterministicSignals(placeholder, 'outbound'), null);
    for (const content of [placeholder + ' ' + credential, credential + ' ' + placeholder, placeholder + ' ' + placeholder + ' ' + credential]) {
      assert.equal(deterministicSignals(content, 'outbound').category, 'credential_exposure');
    }
  });
}

test('oversized audit input is rejected before consulting any custom rule', () => {
  let queries = 0;
  const db = { prepare() { queries++; throw new Error('Custom rules must not be consulted'); } };
  for (const message of ['a'.repeat(128 * 1024 + 1), '界'.repeat(44 * 1024), ' '.repeat(128 * 1024 + 1)]) {
    const result = checkAuditRules(message, 'inbound', db);
    assert.equal(result.verdict, 'deny');
    assert.equal(result.reasonCode, 'message_too_large');
  }
  assert.equal(queries, 0);
});

test('audit limit retains normal Unicode, exact-size input and custom rule priority', () => {
  const db = { prepare: () => ({ all: () => [
    { id: 'permit', keyword: '安全讨论', action: 'allow', is_default: 0 },
    { id: 'deny', keyword: 'blocked', action: 'hard_deny', is_default: 0 },
  ] }) };
  assert.equal(checkAuditRules('安全讨论', 'inbound', db).action, 'allow');
  assert.equal(checkAuditRules('安全讨论 blocked', 'inbound', db).action, 'hard_deny');
  assert.equal(checkAuditRules('a'.repeat(128 * 1024), 'inbound', db).verdict, 'allow');
});
