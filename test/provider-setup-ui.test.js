const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'provider-setup.ts'), 'utf8');

test('Windows provider login launches in the interactive desktop instead of hidden PowerShell', () => {
  assert.match(source, /spawn\('powershell\.exe'/);
  assert.match(source, /'-NoExit', '-EncodedCommand'/);
  assert.match(source, /Buffer\.from\(script, 'utf16le'\)/);
  assert.match(source, /windowsHide:\s*false/);
  assert.doesNotMatch(source, /-NonInteractive/);
  assert.doesNotMatch(source, /Start-Process/);
});
