const test = require('node:test');
const assert = require('node:assert/strict');

const qwenCommand = require('../build/core/dispatcher/qwen-office-command');
const traeCommand = require('../build/core/dispatcher/trae-command');
const { QwenOfficeCliProvider } = require('../build/core/dispatcher/providers/qwen-office-cli');
const { TraeAcpProvider } = require('../build/core/dispatcher/providers/trae-acp');
const { withTraeRuntimeLock } = require('../build/core/dispatcher/providers/trae-runtime-coordinator');

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

test('Trae resolver checks the official per-user Windows CLI install before PATH', () => {
  const request = traeCommand.traeCliRuntimeRequest('acp', { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' }, 'win32');
  assert.deepEqual(request.candidates.slice(0,3), [
    { kind:'explicit', path:'C:\\Users\\tester\\AppData\\Local\\trae-cli\\bin\\traecli.exe' },
    { kind:'explicit', path:'C:\\Users\\tester\\AppData\\Local\\trae-cli\\bin\\trae-cli.exe' },
    { kind:'explicit', path:'C:\\Users\\tester\\AppData\\Local\\trae-cli\\bin\\trae-agent.exe' },
  ]);
  assert.deepEqual(request.candidates[3], { kind:'native', command:'traecli.exe' });
});

test('Trae readiness distinguishes an installed CLI from a configured model', () => {
  const resolver={resolve(){return{available:true,executable:'traecli.exe',argvPrefix:[]};}};
  assert.deepEqual(traeCommand.getTraeCliReadiness(resolver,()=>({status:1,stdout:'model: no effective model configured',stderr:''})),
    {executable:true,ready:false,reason:'model_not_configured'});
  assert.deepEqual(traeCommand.getTraeCliReadiness(resolver,()=>({status:0,stdout:'OK',stderr:''})),
    {executable:true,ready:true,reason:'ready'});
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

test('QwenWork CLI provider exposes an explicitly acknowledged safe loopback test', async () => {
  const provider = new QwenOfficeCliProvider({ binPath: 'C:\\tools\\qoderclicn.exe' });
  assert.equal((await provider.runLoopbackTest('agent-1', {})).code, 'LOOPBACK_CONFIRMATION_REQUIRED');
  assert.equal((await provider.runLoopbackTest('agent-1', { acknowledgeCost: true, challenge: 'unsafe' })).code, 'LOOPBACK_CHALLENGE_INVALID');
});

test('Trae ACP provider uses the separate traecli ACP server and never the desktop launcher', () => {
  const provider = new TraeAcpProvider({ binPath: 'C:\\tools\\traecli.exe' });
  assert.equal(provider._adapterType, 'traecli-acp');
  assert.deepEqual(provider._cliArgs, [
    'acp', 'serve',
    '--permission-mode', 'plan',
    '--disallowed-tool', 'Bash',
    '--disallowed-tool', 'Edit',
    '--disallowed-tool', 'Write',
  ]);
  assert.equal(provider._cliArgs.includes('--yolo'), false);
  assert.equal(provider._runtimeRequest.providerId, 'traecli-acp');
  assert.equal(provider.acceptsBinding({
    providerType: 'trae', adapterType: 'traecli-acp', deliveryMode: 'acp', nativeSessionId: 's1',
  }), true);
});

test('Trae ACP serializes prompts per Agent without blocking other Agent processes', async () => {
  let activeA = 0;
  let maxA = 0;
  let activeTotal = 0;
  let maxTotal = 0;
  const run = (agentId) => withTraeRuntimeLock(agentId, async () => {
    activeTotal += 1;
    maxTotal = Math.max(maxTotal, activeTotal);
    if (agentId === 'agent-a') {
      activeA += 1;
      maxA = Math.max(maxA, activeA);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (agentId === 'agent-a') activeA -= 1;
    activeTotal -= 1;
  });

  await Promise.all([run('agent-a'), run('agent-a'), run('agent-b')]);
  assert.equal(maxA, 1);
  assert.equal(maxTotal, 2);
});
