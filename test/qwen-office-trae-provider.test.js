const test = require('node:test');
const assert = require('node:assert/strict');

const qwenCommand = require('../build/core/dispatcher/qwen-office-command');
const traeCommand = require('../build/core/dispatcher/trae-command');
const { QwenOfficeCliProvider } = require('../build/core/dispatcher/providers/qwen-office-cli');
const { TraeAcpProvider } = require('../build/core/dispatcher/providers/trae-acp');

test('QwenWork resolver prefers an explicit binary and keeps the runtime request shell-free', () => {
  const explicit = 'C:\\test\\qoderclicn.exe';
  assert.equal(qwenCommand.resolveQwenOfficeCommand({ VOKO_QWENWORK_CLI_BIN: explicit }, 'win32'), explicit);
  const request = qwenCommand.qwenOfficeRuntimeRequest('cli', { VOKO_QWENWORK_CLI_BIN: explicit }, 'win32');
  assert.equal(request.providerId, 'qwen-office-cli');
  assert.deepEqual(request.candidates, [{ kind: 'explicit', path: explicit }]);
});

test('QwenWork readiness separates executable discovery from CLI authentication', () => {
  const readiness = qwenCommand.getQwenOfficeReadiness('C:\\does-not-exist\\qoderclicn.exe');
  assert.deepEqual(readiness, {
    executable: false,
    loggedIn: false,
    ready: false,
    reason: 'not_found',
  });
});

test('Trae resolver prefers an explicit traecli binary and exposes ACP mode', () => {
  const explicit = 'C:\\tools\\traecli.exe';
  assert.equal(traeCommand.resolveTraeCliCommand({ VOKO_TRAECLI_BIN: explicit }, 'win32'), explicit);
  const request = traeCommand.traeCliRuntimeRequest('acp', { VOKO_TRAECLI_BIN: explicit }, 'win32');
  assert.equal(request.providerId, 'traecli-acp');
  assert.equal(request.mode, 'acp');
  assert.deepEqual(request.candidates, [{ kind: 'explicit', path: explicit }]);
});

test('QwenWork CLI provider uses stream-json, no tools, and a stable binding adapter', () => {
  const provider = new QwenOfficeCliProvider({ binPath: 'C:\\tools\\qoderclicn.exe' });
  assert.equal(provider._adapterType, 'qwen-office-cli');
  assert.equal(provider._bindingProviderType, 'qwen-office');
  assert.equal(provider._parserName, 'gemini-stream-json');
  assert.deepEqual(provider._args.slice(0, 8), [
    '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--permission-mode', 'dont_ask', '--tools',
  ]);
  assert.equal(provider._args[8], '');
  assert.equal(provider.acceptsBinding({
    providerType: 'qwen-office', adapterType: 'qwen-office-cli', deliveryMode: 'cli', nativeSessionId: 's1',
  }), true);
});

test('Trae ACP provider uses the separate traecli ACP server and never the desktop launcher', () => {
  const provider = new TraeAcpProvider({ binPath: 'C:\\tools\\traecli.exe' });
  assert.equal(provider._adapterType, 'traecli-acp');
  assert.deepEqual(provider._cliArgs, ['acp', 'serve', '--yolo']);
  assert.equal(provider._runtimeRequest.providerId, 'traecli-acp');
  assert.equal(provider.acceptsBinding({
    providerType: 'trae', adapterType: 'traecli-acp', deliveryMode: 'acp', nativeSessionId: 's1',
  }), true);
});
