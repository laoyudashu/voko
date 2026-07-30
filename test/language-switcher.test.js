const { test } = require('node:test');
const assert = require('node:assert');
const { renderLanguageSwitcher } = require('../src/web/language-switcher');

test('language switcher preserves the current path and query parameters', () => {
  const html = renderLanguageSwitcher('zh');
  assert.match(html, /data-voko-lang="en"/);
  assert.match(html, /new URL\(location\.href\)/);
  assert.match(html, /searchParams\.set\("lang",a\.dataset\.vokoLang\)/);
  assert.match(html, /voko\.languageSwitchDraft/);
  assert.match(html, /one-time-code/);
  assert.match(html, /password\|passwd\|code\|token\|secret\|key/);
});
