const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const codeBuddyCommand = require('../build/core/dispatcher/codebuddy-command');
const { CodeBuddyAcpProvider } = require('../build/core/dispatcher/providers/codebuddy-acp');
const catalog = require('../build/core/dispatcher/provider-catalog');

test('CodeBuddy is an independent ACP Provider with Pull fallback', () => {
  const family = catalog.getProviderFamily('codebuddy');
  assert.equal(family.type, 'codebuddy');
  assert.equal(family.requiresInstance, false);
  assert.deepEqual(family.defaultDeliveryModes, ['acp', 'pull']);
  assert.deepEqual(family.transports.map((item) => item.id), ['codebuddy-acp']);
  assert.equal(catalog.getProviderFamily('codebuddy-code').type, 'codebuddy');
  assert.equal(catalog.getProviderTransport('codebuddy-acp').mode, 'acp');
});

test('CodeBuddy resolver targets only the official standalone package', () => {
  const request = codeBuddyCommand.codeBuddyRuntimeRequest('acp', {}, 'win32');
  assert.equal(request.providerId, 'codebuddy-acp');
  assert.equal(request.mode, 'acp');
  assert.deepEqual(request.candidates.slice(0, 2), [
    { kind: 'node-package-bin', command: 'codebuddy', packageName: '@tencent-ai/codebuddy-code', binName: 'codebuddy' },
    { kind: 'node-package-bin', command: 'cbc', packageName: '@tencent-ai/codebuddy-code', binName: 'cbc' },
  ]);
  assert.equal(request.candidates.some((candidate) => String(candidate.path || '').includes('WorkBuddy')), false);
});

test('CodeBuddy version probe uses the resolved script instead of a Windows command shim', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-codebuddy-version-'));
  const script = path.join(dir, 'codebuddy.js');
  fs.writeFileSync(script, 'console.log("2.137.1")');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const resolver = { resolve: () => ({
    available: true, executable: process.execPath,
    argvPrefix: [script], pathEntries: [],
  }) };
  assert.equal(codeBuddyCommand.probeCodeBuddyCliVersion(resolver), '2.137.1');
});

test('CodeBuddy resolves the official package from a custom npm global prefix outside PATH', (t) => {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-codebuddy-prefix-'));
  const packageRoot = path.join(prefix, 'node_modules', '@tencent-ai', 'codebuddy-code');
  const script = path.join(packageRoot, 'bin', 'codebuddy');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: '@tencent-ai/codebuddy-code', bin: { codebuddy: './bin/codebuddy' },
  }));
  fs.writeFileSync(script, '#!/usr/bin/env node');
  t.after(() => fs.rmSync(prefix, { recursive: true, force: true }));

  const request = codeBuddyCommand.codeBuddyRuntimeRequest('acp', {
    PATH: '', NPM_CONFIG_PREFIX: prefix,
  }, 'win32');
  assert.deepEqual(request.candidates[2], {
    kind: 'explicit', path: fs.realpathSync(script), interpreter: 'node',
  });
});

test('CodeBuddy rejects a package bin that escapes the custom npm prefix package root', (t) => {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-codebuddy-prefix-'));
  const packageRoot = path.join(prefix, 'node_modules', '@tencent-ai', 'codebuddy-code');
  const outside = path.join(prefix, 'node_modules', 'outside.js');
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: '@tencent-ai/codebuddy-code', bin: { codebuddy: '../../outside.js' },
  }));
  fs.writeFileSync(outside, '#!/usr/bin/env node');
  t.after(() => fs.rmSync(prefix, { recursive: true, force: true }));

  assert.equal(codeBuddyCommand.discoverGlobalCodeBuddyBin({ NPM_CONFIG_PREFIX: prefix }, 'win32'), null);
});

test('CodeBuddy ACP disables tools and ambient MCP configuration', () => {
  const provider = new CodeBuddyAcpProvider({ binPath: 'C:\\tools\\codebuddy.exe' });
  assert.equal(provider._adapterType, 'codebuddy-acp');
  assert.equal(provider._bindingProviderType, 'codebuddy');
  assert.deepEqual(provider._cliArgs, [
    '--acp', '--permission-mode', 'dontAsk', '--tools', '', '--strict-mcp-config',
  ]);
  assert.equal(provider._cliArgs.includes('--dangerously-skip-permissions'), false);
  assert.equal(provider.acceptsBinding({
    providerType: 'codebuddy', adapterType: 'codebuddy-acp', deliveryMode: 'acp', nativeSessionId: 'session-1',
  }), true);
  assert.equal(provider.acceptsBinding({
    providerType: 'workbuddy', adapterType: 'workbuddy-http', deliveryMode: 'http', nativeSessionId: 'session-1',
  }), false);
});
