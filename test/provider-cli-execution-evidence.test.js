const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runCli, classifyCliFailure } = require('../build/core/adapters/cli-spawner');
const { CliAdapter } = require('../build/core/adapters/cli-adapter');
const { DeliveryExecutor } = require('../build/core/dispatcher/delivery-executor');

const payload = { agentId: 'synthetic-agent', fromUid: 'synthetic-visitor', content: 'synthetic task', messageId: 'synthetic-turn' };

async function withBackup(invoke) {
  let backupCalls = 0;
  const targets = [{ providerId: 'cli', target: {} }, { providerId: 'backup', target: {} }];
  const result = await new DeliveryExecutor().execute({
    next: excluded => targets.find(candidate => !excluded.has(candidate.target)),
    invoke: candidate => candidate.providerId === 'cli' ? invoke() : Promise.resolve(backupCalls++),
    classify: error => error.deliveryOutcome || 'outcome_unknown',
  });
  return { result, backupCalls };
}

test('a real CLI that already wrote a file cannot retry based on auth or missing-command diagnostics', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-cli-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const diagnostic of ['401 Unauthorized', 'ENOENT command not found', 'request rejected by safety policy']) {
    const marker = path.join(root, 'executed');
    const { result, backupCalls } = await withBackup(async () => {
      const exit = await runCli({ cmd: process.execPath, args: ['-e',
        `require('fs').writeFileSync(process.argv[1], 'executed'); process.stderr.write(process.argv[2]); process.exit(1)`, marker, diagnostic],
        logOutput: false, tag: 'synthetic-evidence', timeout: 5000 });
      throw Object.assign(new Error('synthetic nonzero exit'), { deliveryOutcome: classifyCliFailure(exit) });
    });
    assert.equal(fs.readFileSync(marker, 'utf8'), 'executed');
    assert.equal(result.outcome, 'outcome_unknown', diagnostic);
    assert.equal(backupCalls, 0, diagnostic);
  }
});

test('a genuine missing executable carries pre-spawn evidence and permits configured backup', async () => {
  const { result, backupCalls } = await withBackup(() => runCli({
    cmd: path.join(os.tmpdir(), 'voko-never-existing-executable-evidence'), logOutput: false,
  }));
  assert.equal(result.outcome, 'delivered');
  assert.equal(backupCalls, 1);
});

test('generic override and managed-session retry cannot promote a launched CLI failure', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-cli-managed-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const marker = path.join(root, 'count');
  const provider = new CliAdapter({ name: 'synthetic-cli', cmd: process.execPath, cwd: root,
    args: ['-e', `require('fs').appendFileSync(process.argv[1], 'x'); process.stderr.write('session not found; 401 Unauthorized'); process.exit(1)`, marker],
    matchType: 'grok', adapterType: 'grok-cli', timeout: 5000,
    classifyResult: () => 'not_delivered',
  });
  await assert.rejects(provider.push({ ...payload, providerBinding: {
    id: 'binding', providerType: 'grok', adapterType: 'grok-cli', deliveryMode: 'cli',
    nativeSessionId: 'synthetic-session', strictSessionRoute: false,
  } }), error => error.deliveryOutcome === 'outcome_unknown');
  assert.equal(fs.readFileSync(marker, 'utf8'), 'x');
});

test('generic catch preserves unknown even when a post-run hook reports ENOENT', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-cli-catch-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const provider = new CliAdapter({ name: 'synthetic-catch', cmd: process.execPath, cwd: root,
    args: ['-e', "process.stdout.write('completed')"], matchType: 'grok', adapterType: 'grok-cli', timeout: 5000,
    parser: 'silent',
  });
  // The post-run output policy is evaluated inside the adapter's result try/catch.
  Object.defineProperty(provider, '_requireOutput', { get() {
    throw Object.assign(new Error('synthetic ENOENT'), { code: 'ENOENT', deliveryOutcome: 'outcome_unknown' });
  } });
  await assert.rejects(provider.push(payload), error => error.deliveryOutcome === 'outcome_unknown');
});
