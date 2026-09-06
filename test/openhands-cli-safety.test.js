const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { OpenHandsCliProvider } = require('../build/core/dispatcher/providers/openhands-cli');

test('OpenHands CLI refuses construction when its required safety hook is missing', () => {
  const exists = fs.existsSync;
  fs.existsSync = (candidate) => String(candidate).endsWith(path.join('openhands-python', 'sitecustomize.py'))
    ? false : exists(candidate);
  try {
    assert.throws(() => new OpenHandsCliProvider(), /VOKO_OPENHANDS_CLI_SAFETY_UNAVAILABLE/);
  } finally {
    fs.existsSync = exists;
  }
});

const candidates = process.env.VOKO_TEST_PYTHON
  ? [[process.env.VOKO_TEST_PYTHON]]
  : process.platform === 'win32' ? [['py', '-3'], ['python'], ['python3']] : [['python3'], ['python']];
const python = candidates.find(([command, ...args]) => {
  const result = spawnSync(command, [...args, '--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  return result.status === 0 && /Python 3\./.test(result.stdout + result.stderr);
});

function runFixture(t, moduleSource, main, safe = true) {
  assert.ok(python, 'Python 3 is required to exercise the OpenHands Python safety hook');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-openhands-safety-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hook = path.join(__dirname, '..', 'src', 'core', 'dispatcher', 'providers', 'openhands-python', 'sitecustomize.py');
  fs.copyFileSync(hook, path.join(root, 'sitecustomize.py'));
  for (const directory of ['openhands', 'openhands/sdk', 'openhands/sdk/agent']) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
    fs.writeFileSync(path.join(root, directory, '__init__.py'), '');
  }
  fs.writeFileSync(path.join(root, 'openhands/sdk/agent/base.py'), moduleSource);
  const [command, ...args] = python;
  return spawnSync(command, [...args, '-c', main], {
    cwd: root, encoding: 'utf8', timeout: 10000, windowsHide: true,
    env: { ...process.env, PYTHONPATH: root, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1',
      VOKO_OPENHANDS_CLI_SAFE: safe ? '1' : '0' },
  });
}

function assertBlocked(result) {
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /BUSINESS_MAIN_CONTINUED/);
  assert.match(result.stderr, /VOKO_OPENHANDS_CLI_SAFETY_UNAVAILABLE/);
  assert.doesNotMatch(result.stderr, /fixture-private-diagnostic/);
}

test('OpenHands CLI refuses startup when the SDK import fails', (t) => {
  assertBlocked(runFixture(t, 'raise RuntimeError("fixture-private-diagnostic")', 'print("BUSINESS_MAIN_CONTINUED")'));
});

test('OpenHands CLI refuses startup when the SDK initializer is missing', (t) => {
  assertBlocked(runFixture(t, 'class AgentBase: pass', 'print("BUSINESS_MAIN_CONTINUED")'));
});

for (const [name, tools] of [
  ['unknown tool registry', 'None'],
  ['unsupported tool object', '{"terminal": object()}'],
  ['ineffective tool copy', '{"terminal": type("Tool", (), {"executor": object(), "model_copy": lambda self, **kwargs: self})()}'],
]) {
  test(`OpenHands CLI blocks ${name} before business execution`, (t) => {
    assertBlocked(runFixture(t, `class AgentBase:\n def _initialize(self, state):\n  self._tools = ${tools}\n`,
      'from openhands.sdk.agent.base import AgentBase\nAgentBase()._initialize(None)\nprint("BUSINESS_MAIN_CONTINUED")'));
  });
}

test('OpenHands CLI preserves tool schemas and removes every executor', (t) => {
  const result = runFixture(t, `
class Tool:
 def __init__(self, executor): self.executor = executor
 def model_copy(self, update): return Tool(update['executor'])
original = Tool(object())
class AgentBase:
 def _initialize(self, state):
  self._tools = {'terminal': original, 'file': Tool(object())}
  return state
`, `from openhands.sdk.agent.base import AgentBase, original
a = AgentBase()
assert a._initialize('state') == 'state'
assert set(a._tools) == {'terminal', 'file'}
assert all(t.executor is None for t in a._tools.values())
assert original.executor is not None
print('SAFE_READY')`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'SAFE_READY');
});

test('OpenHands ACP startup does not load CLI-only safety hooks', (t) => {
  const result = runFixture(t, 'raise RuntimeError("fixture-private-diagnostic")', 'print("ACP_READY")', false);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'ACP_READY');
});
