'use strict';
const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path'); const test = require('node:test');
test('capability UI exposes VOKO and public A2A publication without protocol-only fields', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'index.js'), 'utf8');
  const route = source.match(/R\.get\('\/agents\/:agentId\/caps'[\s\S]*?\n  \}\);/)[0];
  assert.match(route, /publish_voko/); assert.match(route, /publish_a2a/); assert.match(route, /name="publishA2A"/);
  assert.match(route, /status_published/); assert.match(route, /status_unpublished/); assert.match(route, /registeredAgentIds/);
  assert.match(route, /a2a-public-info/); assert.match(route, /data-a2a-copy/); assert.match(route, /verify-a2a-card/);
  assert.match(route, /<details class="a2a-public-info">/); assert.doesNotMatch(route, /<details class="a2a-public-info" open/);
  assert.match(route, /capsValidationScript/); assert.match(route, /caps\.no_changes/); assert.match(route, /event\.preventDefault/);
  assert.match(route, /cap-description/); assert.match(route, /cap-tags/); assert.match(route, /cap-examples/);
  assert.match(route, /crypto\.randomUUID\(\)/); assert.doesNotMatch(route, /nativeSessionId|protocolVersion/);
  assert.match(route, /capsMsg/);
  const post = source.match(/case'declare_caps':[\s\S]*?case'set_pricing'/)[0];
  assert.match(post, /\/agents\/.*\/caps/); assert.match(post, /registeredAgentIds/); assert.match(post, /declared_a2a/);
});
