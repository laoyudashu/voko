'use strict';
const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path'); const test = require('node:test');
test('capability UI exposes VOKO and public A2A publication without protocol-only fields', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'index.js'), 'utf8');
  const route = source.match(/R\.get\('\/agents\/:agentId\/caps'[\s\S]*?\n  \}\);/)[0];
  assert.match(route, /publish_voko/); assert.match(route, /publish_a2a/); assert.match(route, /name="publishA2A"/);
  assert.match(route, /cap-description/); assert.match(route, /cap-tags/); assert.match(route, /cap-examples/);
  assert.match(route, /crypto\.randomUUID\(\)/); assert.doesNotMatch(route, /nativeSessionId|protocolVersion/);
});
