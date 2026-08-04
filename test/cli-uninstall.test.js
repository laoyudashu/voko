const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { describe, it } = require('node:test');
const uninstall = require('../build/core/uninstall');

function temp(name) { return fs.mkdtempSync(path.join(os.tmpdir(), `voko-uninstall-${name}-`)); }
function stopped(overrides = {}) {
  return async () => ({ wasRunning: false, stopped: true, gracefulRequested: false, port: null, remainingPids: [], ...overrides });
}

describe('voko uninstall', () => {
  it('CLI dry-run emits one JSON document and creates no database', () => {
    const root = temp('cli'); const dbPath = path.join(root, 'missing', 'voko.db');
    const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'build', 'index.js'), 'uninstall', '--dry-run', '--json'], {
      encoding: 'utf8', env: { ...process.env, VOKO_DB_PATH: dbPath, HOME: root, USERPROFILE: root, APPDATA: path.join(root, 'appdata') },
    });
    assert.strictEqual(run.status, 0, run.stderr); assert.strictEqual(JSON.parse(run.stdout).phase, 'preview');
    assert.strictEqual(fs.existsSync(dbPath), false); fs.rmSync(root, { recursive: true, force: true });
  });

  it('previews without stopping or deleting anything', async () => {
    const root = temp('preview'); const data = path.join(root, 'voko'); fs.mkdirSync(data);
    fs.writeFileSync(path.join(data, 'voko.db'), 'keep'); let stopCalls = 0;
    const result = await uninstall.runUninstall({ dryRun: true, purge: true, dataPath: data, defaultDataPath: data,
      dbPath: path.join(data, 'voko.db'), stop: async () => { stopCalls++; }, home: root, entryPath: path.join(root, 'build', 'index.js') });
    assert.strictEqual(result.phase, 'preview'); assert.strictEqual(stopCalls, 0);
    assert.strictEqual(fs.existsSync(path.join(data, 'voko.db')), true); fs.rmSync(root, { recursive: true, force: true });
  });

  it('preserves data by default after an idempotent stop', async () => {
    const root = temp('preserve'); const data = path.join(root, 'voko'); fs.mkdirSync(data);
    fs.writeFileSync(path.join(data, 'voko.db'), 'keep');
    const result = await uninstall.runUninstall({ dataPath: data, defaultDataPath: data, dbPath: path.join(data, 'voko.db'),
      stop: stopped(), home: root, entryPath: path.join(root, 'build', 'index.js') });
    assert.strictEqual(result.success, true); assert.strictEqual(result.data.preserved, true);
    assert.strictEqual(fs.readFileSync(path.join(data, 'voko.db'), 'utf8'), 'keep'); fs.rmSync(root, { recursive: true, force: true });
  });

  it('aborts before purge when VOKO cannot be fully stopped', async () => {
    const root = temp('running'); const data = path.join(root, 'voko'); fs.mkdirSync(data);
    const result = await uninstall.runUninstall({ purge: true, yes: true, dataPath: data, defaultDataPath: data,
      dbPath: path.join(data, 'voko.db'), stop: stopped({ stopped: false, remainingPids: [4242] }), home: root,
      entryPath: path.join(root, 'build', 'index.js') });
    assert.strictEqual(result.code, 'UNINSTALL_STOP_FAILED'); assert.strictEqual(fs.existsSync(data), true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('requires confirmation in non-interactive JSON mode', async () => {
    const root = temp('confirm'); const data = path.join(root, 'voko'); fs.mkdirSync(data);
    const result = await uninstall.runUninstall({ purge: true, json: true, dataPath: data, defaultDataPath: data,
      dbPath: path.join(data, 'voko.db'), stop: stopped(), home: root, entryPath: path.join(root, 'build', 'index.js') });
    assert.strictEqual(result.code, 'PURGE_CONFIRMATION_REQUIRED'); assert.strictEqual(fs.existsSync(data), true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('purges only the validated default directory with --yes', async () => {
    const root = temp('purge'); const data = path.join(root, 'voko'); fs.mkdirSync(data);
    fs.writeFileSync(path.join(data, 'voko.db'), 'delete');
    const result = await uninstall.runUninstall({ purge: true, yes: true, dataPath: data, defaultDataPath: data,
      dbPath: path.join(data, 'voko.db'), stop: stopped(), home: root, entryPath: path.join(root, 'build', 'index.js') });
    assert.strictEqual(result.data.purged, true); assert.strictEqual(fs.existsSync(data), false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('refuses custom database paths and broad targets', async () => {
    const root = temp('unsafe'); const data = path.join(root, 'voko'); fs.mkdirSync(data);
    const result = await uninstall.runUninstall({ purge: true, yes: true, dataPath: data, defaultDataPath: data,
      dbPath: path.join(root, 'custom.db'), stop: stopped(), home: root, entryPath: path.join(root, 'build', 'index.js') });
    assert.strictEqual(result.code, 'PURGE_CUSTOM_PATH_UNSUPPORTED');
    assert.deepStrictEqual(uninstall.validatePurgeTarget(root, root, root), { safe: false, reason: 'broad_path' });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('resolves platform data directories and refuses links', () => {
    assert.strictEqual(uninstall.defaultDataDirectory('win32', { APPDATA: 'C:\\Data' }, 'C:\\Home'), path.join('C:\\Data', 'voko'));
    assert.strictEqual(uninstall.defaultDataDirectory('darwin', {}, '/Users/test'), path.join('/Users/test', 'Library', 'Application Support', 'voko'));
    assert.strictEqual(uninstall.defaultDataDirectory('linux', { XDG_CONFIG_HOME: '/cfg' }, '/home/test'), path.join('/cfg', 'voko'));
    const root = temp('link'); const real = path.join(root, 'real'); const link = path.join(root, 'voko'); fs.mkdirSync(real);
    try {
      fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
      assert.deepStrictEqual(uninstall.validatePurgeTarget(link, link, root), { safe: false, reason: 'link' });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('detects VOKO MCP entries without returning secrets or changing the file', () => {
    const root = temp('mcp'); const config = path.join(root, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ mcpServers: { voko: { command: 'voko', args: ['mcp'], env: { SECRET_TOKEN: 'do-not-return' } }, other: { command: 'other' } } }));
    const before = fs.readFileSync(config, 'utf8'); const result = uninstall.inspectIntegrations(root, {});
    assert.strictEqual(result.mcp.length, 1); assert.strictEqual(result.mcp[0].entryName, 'voko');
    assert.strictEqual(JSON.stringify(result).includes('do-not-return'), false); assert.strictEqual(fs.readFileSync(config, 'utf8'), before);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
