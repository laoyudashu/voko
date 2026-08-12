'use strict'; const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path'); const test = require('node:test');
test('A2A tasks have a dedicated UI and do not enter visitor conversations', () => { const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'index.js'), 'utf8');
  assert.match(source, /R\.get\('\/a2a-tasks'/); assert.match(source, /a2a_local_tasks/); assert.match(source, /listOutboundTasks/);
  const route = source.match(/R\.get\('\/a2a-tasks'[\s\S]*?\n  \}\);/)[0];
  assert.match(source, /isolated from visitor conversations/); assert.doesNotMatch(route, /FROM messages|FROM conversations|INSERT INTO messages/);
});
