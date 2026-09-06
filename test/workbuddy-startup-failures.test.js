const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { WorkBuddyHttpProvider } = require('../build/core/dispatcher/providers/workbuddy-http');

test('WorkBuddy missing working directory rejects startup without crashing the host', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-workbuddy-spawn-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const modulePath = require.resolve('../build/core/dispatcher/providers/workbuddy-http');
  const script = `
    const {WorkBuddyHttpProvider}=require(process.argv[1]);
    const p=new WorkBuddyHttpProvider({binPath:process.execPath,cwd:process.argv[2],startupTimeoutMs:1000});
    p._ensureServer().then(()=>process.exit(2),async e=>{
      const result={code:e.code,outcome:e.deliveryOutcome,stage:e.providerStage,message:e.message,
        serverCleared:p._server===null,port:p._port};
      await p.stop(); console.log(JSON.stringify(result));
    });
  `;
  const result = spawnSync(process.execPath, ['-e', script, modulePath, path.join(root, 'missing-private-directory')],
    { encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const error = JSON.parse(result.stdout);
  assert.equal(error.code, 'WORKBUDDY_SPAWN_FAILED');
  assert.equal(error.outcome, 'not_delivered');
  assert.equal(error.stage, 'startup');
  assert.match(error.message, /ENOENT/);
  assert.doesNotMatch(error.message, /missing-private-directory/);
  assert.equal(error.serverCleared, true);
  assert.equal(error.port, 0);
});

test('WorkBuddy cannot report ready when the child exits during its health check', async t => {
  const child = new EventEmitter();
  Object.assign(child, { exitCode: null, signalCode: null, stderr: { resume() {} } });
  let provider;
  provider = new WorkBuddyHttpProvider({
    binPath: process.execPath,
    spawnImpl: () => child,
    fetchImpl: async url => {
      if (String(url).endsWith('/api/v1/health')) {
        child.signalCode = 'SIGTERM';
        child.emit('exit', null, 'SIGTERM');
        return new Response(JSON.stringify({ status: 'ok' }));
      }
      const paths = ['/api/v1/runs', '/api/v1/runs/{runId}', '/api/v1/runs/{runId}/stream',
        '/api/v1/runs/{runId}/cancel', '/api/v1/acp/connect', '/api/v1/acp'];
      return new Response(JSON.stringify({ paths: Object.fromEntries(paths.map(p => [p, {}])) }));
    },
  });
  t.after(() => provider.stop());
  const changes = [];
  provider.notifyAvailability = event => changes.push(event);
  await assert.rejects(provider._ensureServer(), e => {
    assert.equal(e.code, 'WORKBUDDY_PROCESS_EXITED');
    assert.equal(e.deliveryOutcome, 'not_delivered');
    assert.match(e.message, /SIGTERM/);
    return true;
  });
  assert.equal(changes.some(e => e.available), false);
  assert.equal(provider._server, null);
  assert.equal(provider._port, 0);
});

test('WorkBuddy startup timeout retains a safe readiness reason and clears the child', async t => {
  const child = new EventEmitter();
  Object.assign(child, { exitCode: null, stderr: { resume() {} } });
  const provider = new WorkBuddyHttpProvider({
    binPath: process.execPath,
    startupTimeoutMs: 1000,
    spawnImpl: () => child,
    fetchImpl: async () => { throw new Error('private-provider-response', { cause: { code: 'ECONNREFUSED' } }); },
  });
  t.after(() => provider.stop());
  await assert.rejects(provider._ensureServer(), e => {
    assert.equal(e.code, 'WORKBUDDY_STARTUP_TIMEOUT');
    assert.equal(e.deliveryOutcome, 'not_delivered');
    assert.equal(e.providerStage, 'startup');
    assert.match(e.message, /ECONNREFUSED/);
    assert.doesNotMatch(e.message, /private-provider-response/);
    return true;
  });
  assert.equal(provider._server, null);
  assert.equal(provider._port, 0);
});
