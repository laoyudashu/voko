const test = require('node:test');
const assert = require('node:assert/strict');
const { createParser } = require('../build/core/adapters/cli-parsers');

function parse(lines) {
  let reply = '';
  const parser = createParser({ format: 'aider-output', onText: chunk => { reply += chunk; } });
  for (const line of ['Aider v0.86.2', 'Repo-map: disabled', '', ...lines]) parser.handleLine(line);
  parser.finish();
  return reply.trim();
}

test('Aider excludes a session cost label wrapped onto its own line on Windows', () => {
  assert.equal(parse([
    'voko-challenge',
    'Tokens: 123 sent, 19 received. Cost: $0.000079 message, $0.000079 \r',
    'session.\r',
  ]), 'voko-challenge');
});

test('Aider preserves session. when it is part of the answer', () => {
  assert.equal(parse(['The requested word is:', 'session.', 'Tokens: 20 sent, 8 received.']),
    'The requested word is:\nsession.');
});

test('Aider only treats session. as the immediate continuation of an unfinished cost', () => {
  assert.equal(parse(['Tokens: 123 sent, 19 received. Cost: $0.000079 message, $0.000079 session.', 'session.']), 'session.');
  assert.equal(parse(['Cost: $0.000079', 'another answer', 'session.']), 'another answer\nsession.');
});
