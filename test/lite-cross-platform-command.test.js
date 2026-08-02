const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

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

  assert.match(source, /const cmd = isNodeScript \? process\.execPath : cliPath/);
  assert.doesNotMatch(source, /process\.platform === 'win32' \? process\.execPath : 'node'/);
});

test('automation that starts the Lite HTTP server always disables browser opening', () => {
  const files = [
    path.join(ROOT, 'scripts', 'smoke-standalone.js'),
    path.join(ROOT, 'test', 'lite-fatal-lifecycle.test.js'),
    path.join(ROOT, 'test', 'lite-process-lifecycle.test.js'),
  ];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    assert.match(source, /--no-open/, file);
  }
});

test('dev opens the canonical Lite page once and suppresses restart/provider popups', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'dev.js'), 'utf8');
  assert.match(source, /startRuntime\(true\)/);
  assert.match(source, /startRuntime\(false\)/);
  assert.match(source, /if \(!openMainPage\) args\.push\('--no-open'\)/);
  assert.match(source, /BROWSER:\s*'none'/);
  assert.match(source, /waitForRuntimeExit\(child,\s*5000\)/);
  assert.match(source, /taskkill\.exe/);
});

test('macOS ps output parsing is locale-stable and accepts single-digit dates', () => {
  const lifecycle = require('../build/core/process-lifecycle');
  assert.deepEqual(
    lifecycle._test.parsePsProcessOutput(
      321,
      '  1 Mon Jul  7 09:08:06 2026 /usr/local/bin/node /opt/voko/build/index.js start\n',
    ),
    {
      pid: 321,
      parentPid: 1,
      creationId: 'Mon Jul 7 09:08:06 2026',
      executablePath: '',
      commandLine: '/usr/local/bin/node /opt/voko/build/index.js start',
    },
  );
  assert.equal(
    lifecycle._test.parsePsProcessOutput(321, 'localized or malformed output'),
    null,
  );
});

test('Unix CLI cleanup uses an isolated process group without pgrep', () => {
  const source = fs.readFileSync(
    path.join(LITE_SRC, 'core', 'adapters', 'cli-spawner.ts'),
    'utf8',
  );
  assert.match(source, /detached:\s*!isWin/);
  assert.match(source, /process\.kill\(-pid,\s*'SIGTERM'\)/);
  assert.doesNotMatch(source, /execFileSync\('pgrep'/);
});

test('loopback proxy bypass preserves existing hosts and adds every local address', () => {
  const { ensureLoopbackNoProxy } = require('../build/core/loopback-env');
  const env = { NO_PROXY: 'internal.example,localhost' };
  assert.equal(ensureLoopbackNoProxy(env), env);
  assert.equal(env.NO_PROXY, 'internal.example,localhost,127.0.0.1,::1');
  assert.equal(env.no_proxy, env.NO_PROXY);
});

test('Linux browser opening requires a graphical session', () => {
  const source = fs.readFileSync(path.join(LITE_SRC, 'index.ts'), 'utf8');
  assert.match(source, /platform === 'linux'/);
  assert.match(source, /env\.DISPLAY \|\| env\.WAYLAND_DISPLAY/);
  assert.match(source, /env\.SSH_CONNECTION/);
  assert.match(source, /if \(!hasGraphicalSession\(\)\) return false/);
});

test('Unix process-group cleanup terminates descendants', {
  skip: process.platform === 'win32',
  timeout: 10000,
}, async () => {
  const { killTree } = require('../build/core/adapters/cli-spawner');
  const child = spawn(process.execPath, [
    '-e',
    "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.stdout.write(String(c.pid)+'\\n');setInterval(()=>{},1000)",
  ], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  assert.ok(child.pid);
  const descendantPid = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('descendant pid timeout')), 3000);
    child.stdout.once('data', data => {
      clearTimeout(timer);
      resolve(Number(String(data).trim()));
    });
  });
  assert.ok(descendantPid);
  killTree(child.pid);
  await new Promise(resolve => child.once('exit', resolve));
  assert.notEqual(child.exitCode, 0);
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      process.kill(descendantPid, 0);
      await new Promise(resolve => setTimeout(resolve, 50));
    } catch {
      return;
    }
  }
  assert.fail(`descendant process ${descendantPid} is still alive`);
});
