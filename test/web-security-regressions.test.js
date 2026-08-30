'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { jsonForInlineScript } = require('../build/web/html-security');
const { parseCookie } = require('../build/core/i18n');

test('inline JSON cannot terminate script or HTML elements', () => {
  const value = { text: '</script><img src=x onerror=alert(1)>&\u2028\u2029' };
  const encoded = jsonForInlineScript(value);

  assert.deepEqual(JSON.parse(encoded), value);
  assert.doesNotMatch(encoded, /[<>&\u2028\u2029]/u);
  assert.match(encoded, /\\u003c\/script\\u003e/);
});

test('cookie parsing cannot mutate an object prototype', () => {
  const cookies = parseCookie('__proto__=polluted; constructor=bad; voko_lang=en');

  assert.equal(Object.getPrototypeOf(cookies), null);
  assert.equal(cookies.__proto__, undefined);
  assert.equal(cookies.constructor, undefined);
  assert.equal(cookies.voko_lang, 'en');
  assert.equal({}.polluted, undefined);
});

test('web routes encode reflected query state and use a private upload directory', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'index.js'), 'utf8');

  assert.match(source, /status='\+encodeURIComponent\(st\)/);
  assert.match(source, /start='\+encodeURIComponent\(fstart\)/);
  assert.match(source, /direction='\+encodeURIComponent\(dir\)/);
  assert.match(source, /mkdtempSync\(path\.join\(require\('os'\)\.tmpdir\(\), 'voko-upload-'\)\)/);
  assert.match(source, /writeFileSync\(tmpPath, filedata, \{ flag: 'wx', mode: 0o600 \}\)/);
  assert.match(source, /jsonForInlineScript\(\{actionStatus:/);
  assert.match(source, /text:esc\(req\.query\.(?:ok|warn|err)\)/);
  assert.match(source, /AGENT_ID='\+jsonForInlineScript\(agentId\)/);
  assert.match(source, /var aid='\+jsonForInlineScript\(agentId\)/);
  assert.match(source, /id="web-conversation-start" value="0"/);
  assert.match(source, /window\.__vokoConversationDraftActive=true/);
  assert.match(source, /webConversationStart:webConversationStart==='1'/);
  assert.doesNotMatch(source, /post\("\/api\/routing-conversations\/create"/);
  assert.match(source, /location\.href='\+jsonForInlineScript\(returnPath\)/);
  assert.doesNotMatch(source, /AGENT_ID='\+JSON\.stringify\(agentId\)/);
  assert.doesNotMatch(source, /var aid='\+JSON\.stringify\(agentId\)/);
});
