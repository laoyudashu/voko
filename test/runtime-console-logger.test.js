const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { withRuntimeTimestamp } = require('../build/index');
const { resolveVokoLogDirectory } = require('../build/core/log-path');
const { _makeLogger } = require('../build/core/adapters/cli-spawner');

test('runtime logs use an explicit isolated directory without changing production defaults', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-log-path-'));
  try {
    assert.equal(resolveVokoLogDirectory({ VOKO_LOG_DIR: root }, 'darwin', '/Users/example'), root);
    assert.equal(resolveVokoLogDirectory({}, 'darwin', '/Users/example'),
      '/Users/example/Library/Application Support/voko');
    assert.equal(resolveVokoLogDirectory({ APPDATA: 'C:\\Data' }, 'win32', 'C:\\Users\\example'),
      path.win32.join('C:\\Data', 'voko'));
    assert.equal(resolveVokoLogDirectory({ XDG_CONFIG_HOME: '/cfg' }, 'linux', '/home/example'), '/cfg/voko');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runtime log arguments receive one local timestamp', () => {
  const now = new Date(2026, 7, 18, 9, 8, 7, 6);
  assert.deepEqual(
    withRuntimeTimestamp(['[Lite] ready', { port: 3100 }], now),
    ['[2026-08-18 09:08:07]', '[Lite] ready', { port: 3100 }],
  );
});

test('runtime logger does not duplicate an existing timestamp', () => {
  const args = ['[09:08:07][IM 心跳] connected'];
  assert.strictEqual(withRuntimeTimestamp(args), args);
});

test('machine-readable CLI output remains free of runtime timestamps', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'build', 'index.js'), '--version'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^voko \d+\.\d+\.\d+\s*$/);
  assert.doesNotMatch(result.stdout, /^\[\d{4}-\d{2}-\d{2}/);
});

test('raw CLI diagnostics use debug rather than the runtime error level', () => {
  const debug=[];const errors=[];
  const originalDebug=console.debug;const originalError=console.error;
  console.debug=(...args)=>debug.push(args.join(' '));
  console.error=(...args)=>errors.push(args.join(' '));
  try{
    _makeLogger('runtime-level-test')('provider diagnostic');
    assert.deepEqual(debug,['provider diagnostic']);
    assert.deepEqual(errors,[]);
  }finally{console.debug=originalDebug;console.error=originalError;}
});
