const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveHermesCommand } = require('../build/core/dispatcher/hermes-command');
const { resolveWorkBuddyRuntime } = require('../build/core/dispatcher/workbuddy-command');

test('Hermes respects PATH and explicit selection before fallback installations', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const command = path.join(root, process.platform === 'win32' ? 'hermes.exe' : 'hermes');
  fs.writeFileSync(command, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const env = { ...process.env, VOKO_HERMES_BIN: '', PATH: root };
  // Windows CI may return the long path for an 8.3 TEMP directory alias.
  assert.equal(fs.realpathSync(resolveHermesCommand(env)), fs.realpathSync(command));
  assert.equal(resolveHermesCommand({ ...env, VOKO_HERMES_BIN: '/explicit/missing/hermes' }), '/explicit/missing/hermes');
});

for (const platform of ['win32', 'linux', 'darwin']) {
  test(`WorkBuddy does not replace invalid explicit configuration on ${platform}`, () => {
    const runtime = resolveWorkBuddyRuntime({ platform, configuredCommand: path.join(os.tmpdir(), 'missing-voko-binary', 'codebuddy') });
    assert.equal(runtime.command, null);
    assert.equal(runtime.source, 'unavailable');
  });
}

for (const name of ['opencode', 'dumate']) {
  test(`${name} reports a real spawn error without crashing or waiting for readiness timeout`, () => {
    const modulePath = require.resolve(`../build/core/dispatcher/providers/${name === 'opencode' ? 'opencode-attach' : 'dumate-http'}`);
    const className = name === 'opencode' ? 'OpenCodeAttachProvider' : 'DuMateHttpProvider';
    const script = `
      const {${className}: P}=require(process.argv[1]);
      const p=new P({resolveBackendPort:()=> '1'});
      p._cmd='__voko_missing_startup_test__';
      const started=Date.now();
      (${name === 'opencode' ? 'p._ensureServer()' : "p._ensureState(p._routeForAgent('startup-test'),'startup-test')"})
        .then(()=>process.exit(2),async error=>{await p.stop();console.log(JSON.stringify({message:error.message,ms:Date.now()-started}));});
    `;
    const result = spawnSync(process.execPath, ['-e', script, modulePath], { encoding: 'utf8', timeout: 6000, windowsHide: true });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const failure = JSON.parse(result.stdout.trim());
    assert.match(failure.message, /ENOENT/);
    assert.ok(failure.ms < 4000);
  });
}

test('Hermes surfaces an early process exit', async t => {
  const Provider = require('../build/core/dispatcher/providers/hermes-http');
  const previous = process.env.VOKO_HERMES_BIN;
  process.env.VOKO_HERMES_BIN = process.execPath;
  t.after(() => { if (previous === undefined) delete process.env.VOKO_HERMES_BIN; else process.env.VOKO_HERMES_BIN = previous; });
  const provider = new Provider(null, null, { profiles: { probe: { apiKey: 'test' } } });
  const startup = provider._launchGateway('probe');
  const deadline = Date.now() + 3000;
  while (!startup.failure() && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
  assert.match(startup.failure(), /exit=|bad option/);
});
