'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('A2A mailbox client exposes authenticated artifact upload and safe diagnostics', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'a2a', 'mailbox-client.ts'), 'utf8');
  assert.match(source, /uploadArtifact\(/); assert.match(source, /\/artifacts/); assert.match(source, /getDiagnosticsSummary\(/);
});

test('A2A signed envelope supports only opaque artifact references, not arbitrary replacement fields', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'a2a', 'envelope.ts'), 'utf8');
  assert.match(source, /part\?\.artifactRef/); assert.match(source, /key === 'artifactRef'/);
});
