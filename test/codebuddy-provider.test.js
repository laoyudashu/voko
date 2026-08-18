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
