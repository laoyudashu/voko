const { test } = require('node:test');
const assert = require('node:assert');
const { renderLanguageSwitcher } = require('../src/web/language-switcher');

test('language switcher preserves the current path and query parameters', () => {
  const html = renderLanguageSwitcher('zh');
  assert.match(html, /data-voko-language-select="1"/);
  assert.match(html, /<option value="zh" selected>中文<\/option>/);
  assert.match(html, /<option value="en">English<\/option>/);
  assert.doesNotMatch(html, /data-voko-lang=/);
  assert.match(html, /new URL\(location\.href\)/);
  assert.match(html, /searchParams\.set\("lang",select\.value\)/);
  assert.match(html, /voko\.languageSwitchDraft/);
  assert.match(html, /!el\.hasAttribute\("data-voko-language-select"\)/);
  assert.match(html, /one-time-code/);
  assert.match(html, /password\|passwd\|code\|token\|secret\|key/);
});
