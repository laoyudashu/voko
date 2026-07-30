const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const LITE_SRC = path.join(ROOT, 'src');

test('Goose command uses the native PATH executable on every supported platform', () => {
  const { resolveGooseCommand } = require('../build/core/dispatcher/goose-command');

  assert.equal(resolveGooseCommand({}, 'win32'), 'goose.exe');
  assert.equal(resolveGooseCommand({}, 'darwin'), 'goose');
  assert.equal(resolveGooseCommand({}, 'linux'), 'goose');
});

test('Goose command honors a trimmed platform-specific override', () => {
  const { resolveGooseCommand } = require('../build/core/dispatcher/goose-command');

  assert.equal(resolveGooseCommand({ VOKO_GOOSE_BIN: ' C:\\Tools\\goose.exe ' }), 'C:\\Tools\\goose.exe');
  assert.equal(resolveGooseCommand({ VOKO_GOOSE_BIN: ' /opt/goose/bin/goose ' }), '/opt/goose/bin/goose');
});

test('Goose visitor content is sent over stdin and never placed in command arguments', () => {
  const source = fs.readFileSync(
    path.join(LITE_SRC, 'core', 'dispatcher', 'providers', 'goose-cli.ts'),
    'utf8',
  );

  assert.match(source, /const args = \['run', '-i', '-'/);
  assert.match(source, /stdinInput: notification/);
  assert.doesNotMatch(source, /\['run', '-t', notification/);
});

test('Lite runtime contains no developer-machine Goose path', () => {
  const files = [
    path.join(LITE_SRC, 'index.ts'),
    path.join(LITE_SRC, 'core', 'dispatcher', 'providers', 'goose-cli.ts'),
    path.join(LITE_SRC, 'core', 'dispatcher', 'providers', 'goose-acp.ts'),
  ];

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /[A-Za-z]:[\\/]github[\\/]goose/i, file);
  }
});

test('ACP JavaScript launch uses the current Node executable on every platform', () => {
  const source = fs.readFileSync(
    path.join(LITE_SRC, 'core', 'adapters', 'acp-adapter.ts'),
    'utf8',
  );

  assert.match(source, /const cmd = isNodeScript \? process\.execPath : this\._cliPath/);
  assert.doesNotMatch(source, /process\.platform === 'win32' \? process\.execPath : 'node'/);
});
