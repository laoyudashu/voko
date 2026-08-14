'use strict';
const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path'); const test = require('node:test');
test('capability UI follows the A2A 1.0 Agent Card and Skill field hierarchy', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'index.js'), 'utf8');
  const route = source.match(/R\.get\('\/agents\/:agentId\/caps'[\s\S]*?\n  \}\);/)[0];
  assert.doesNotMatch(route, /publish_voko/); assert.doesNotMatch(route, /publish_a2a/); assert.doesNotMatch(route, /name="publishA2A"/);
  assert.match(route, /capsValidationScript/); assert.match(route, /caps\.no_changes/); assert.match(route, /event\.preventDefault/);
  assert.match(route, /name="agentDescription"/);
  assert.match(route, /web\.agent\.caps\.protocol_version/); assert.match(route, /web\.agent\.caps\.default_input_modes/);
  assert.match(route, /cap-description/); assert.match(route, /cap-tags/); assert.match(route, /cap-examples/);
  assert.match(route, /crypto\.randomUUID\(\)/); assert.doesNotMatch(route, /nativeSessionId/);
  assert.match(route, /capsMsg/);
  assert.match(route, /<h2 class="a2a-section-title">Skills<\/h2><button type="button" id="caps-add"/);
  assert.doesNotMatch(route, /<p>'\+T\('web\.agent\.caps\.intro'\)/);
  const post = source.match(/case'declare_caps':[\s\S]*?case'set_pricing'/)[0];
  assert.match(post, /update_agent_profile/); assert.match(post, /agentDescription/);
  assert.match(post, /\/agents\/.*\/caps/); assert.match(post, /registeredAgentIds/); assert.match(post, /declared_a2a/);
});

test('basic Agent edit page does not render the Agent Card description field', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'index.js'), 'utf8');
  const editRoute = source.match(/R\.get\('\/agents\/:agentId\/edit'[\s\S]*?\n  \}\);/)[0];
  assert.doesNotMatch(editRoute, /name="description"/);
  assert.match(editRoute, /short_description/);
});
