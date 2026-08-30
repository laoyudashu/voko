const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'provider-setup.ts'), 'utf8');

test('Windows provider login launches in the interactive desktop instead of hidden PowerShell', () => {
  assert.match(source, /spawn\('powershell\.exe'/);
  assert.match(source, /WindowTitle='VOKO Provider Login'/);
  assert.match(source, /Start-Process -FilePath powershell\.exe/);
  assert.match(source, /'-NoProfile','-NoExit','-EncodedCommand'/);
  assert.match(source, /'-WindowStyle', 'Hidden'/);
  assert.match(source, /Buffer\.from\(interactiveScript, 'utf16le'\)/);
  assert.match(source, /WindowStyle Normal/);
  assert.match(source, /'\.voko', 'provider-login'/);
  assert.match(source, /-WorkingDirectory \$env:VOKO_PROVIDER_SETUP_CWD/);
  assert.doesNotMatch(source, /spawn\('cmd\.exe'/);
  assert.doesNotMatch(source, /startCommand/);
});

test('WorkBuddy login opens the interactive CLI because slash login is not a CLI argument', () => {
  assert.match(source, /launchDetached\(launch\.command, \[\.\.\.launch\.argsPrefix\]\)/);
  assert.doesNotMatch(source, /argsPrefix, '\/login'/);
  assert.match(source, /interactionRequired: true/);
});

test('Windows WorkBuddy install runs npm through Node instead of spawning npm.cmd', () => {
  assert.match(source, /path\.join\(path\.dirname\(process\.execPath\), 'node_modules', 'npm', 'bin', 'npm-cli\.js'\)/);
  assert.match(source, /npmCommand = process\.execPath/);
  assert.match(source, /npmArgs = \[npmCli, \.\.\.npmArgs\]/);
  assert.doesNotMatch(source, /execFileAsync\(npmCommand, \['install'/);
});

test('installed WorkBuddy state is returned to the UI', () => {
  assert.match(source, /componentStatus: 'installed'/);
});
