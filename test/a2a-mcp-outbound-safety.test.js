'use strict'; const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path'); const test = require('node:test');
test('A2A outbound MCP delivery is gated before the Mailbox client', () => { const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'mcp', 'tools.ts'), 'utf8');
  const handler = source.match(/async a2a_send_message[\s\S]*?\n    },/)[0]; assert.ok(handler.indexOf('assertAllowed') < handler.indexOf('sendOutbound'));
  assert.match(handler, /'outbound'/); assert.match(handler, /A2A_SAFETY_REJECTED/);
});
