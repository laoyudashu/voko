const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', 'src', 'core');

function source(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('background provider processes do not detach into a Windows console', () => {
  for (const relativePath of [
    'adapters/acp-adapter.ts',
    'adapters/cli-spawner.ts',
    'dispatcher/providers/hermes-http.ts',
    'dispatcher/providers/openclaw-ws.ts',
    'dispatcher/providers/opencode-attach.ts',
    'gateway-setup.js',
  ]) {
    const text = source(relativePath);
    assert.doesNotMatch(text, /detached:\s*true/, relativePath);
  }

  for (const relativePath of [
    'adapters/acp-adapter.ts',
    'adapters/cli-spawner.ts',
    'dispatcher/providers/hermes-http.ts',
    'dispatcher/providers/openclaw-ws.ts',
    'dispatcher/providers/opencode-attach.ts',
    'gateway-setup.js',
  ]) {
    const text = source(relativePath);
    assert.match(text, /windowsHide:\s*true/, relativePath);
  }
});

test('Windows process-tree cleanup is also hidden', () => {
  for (const relativePath of [
    'adapters/cli-spawner.ts',
    'dispatcher/providers/hermes-http.ts',
    'dispatcher/providers/openclaw-ws.ts',
  ]) {
    const text = source(relativePath);
    const taskkillCalls = text.match(/execFileSync\('taskkill',[\s\S]*?\}\);/g) || [];
    assert.ok(taskkillCalls.length > 0, `${relativePath}: expected taskkill cleanup`);
    for (const call of taskkillCalls) {
      assert.match(call, /windowsHide:\s*true/, relativePath);
    }
  }
});
