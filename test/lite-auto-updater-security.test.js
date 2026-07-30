const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const autoUpdater = require('../build/core/auto-updater');
const pkg = require('../package.json');
const originalAppData = process.env.APPDATA;
const tempDirs = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-update-security-'));
  tempDirs.push(dir);
  return dir;
}

function integrity(buffer) {
  return `sha512-${crypto.createHash('sha512').update(buffer).digest('base64')}`;
}

function createPending(root, overrides = {}) {
  process.env.APPDATA = root;
  const stagedDir = path.join(root, 'voko', 'staged-update');
  fs.mkdirSync(stagedDir, { recursive: true });
  const payload = Buffer.from('verified-voko-lite-package');
  const tarballPath = path.join(stagedDir, 'voko-lite-99.0.0.tgz');
  fs.writeFileSync(tarballPath, payload);
  const pending = {
    targetVersion: '99.0.0',
    tarballPath,
    integrity: integrity(payload),
    minNodeVersion: '22.5.0',
    packageName: pkg.name,
    downloadedAt: Date.now(),
    ...overrides,
  };
  fs.writeFileSync(path.join(stagedDir, 'pending.json'), JSON.stringify(pending));
  return { stagedDir, tarballPath, pending, payload };
}

afterEach(() => {
  if (originalAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = originalAppData;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Lite staged update security', () => {
  it('validates manifest schema and minimum Node version shape', () => {
    assert.equal(autoUpdater._test.validateManifest({
      version: '1.2.3',
      tarball: 'lite/voko-lite.tgz',
      integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
      minNodeVersion: '22.5.0',
    }), true);
    assert.equal(autoUpdater._test.validateManifest({
      version: 'latest',
      tarball: 'lite/voko-lite.tgz',
      integrity: 'sha512-invalid',
    }), false);
  });

  it('rejects tarballs outside the staged directory', () => {
    const root = tempDir();
    const { stagedDir, pending, payload } = createPending(root);
    const outside = path.join(root, 'outside.tgz');
    fs.writeFileSync(outside, payload);
    const result = autoUpdater._test.validatePendingUpgrade(
      { ...pending, tarballPath: outside },
      stagedDir,
      '22.5.0',
    );
    assert.deepEqual(result, { ok: false, reason: 'path-outside-staged-dir' });
  });

  it('rechecks integrity immediately before install and never spawns npm for tampered files', () => {
    const root = tempDir();
    const { stagedDir, tarballPath } = createPending(root);
    fs.appendFileSync(tarballPath, 'tampered');
    let spawnCalls = 0;
    const applied = autoUpdater._test.applyPendingUpgradeInternal({
      globalInstall: true,
      stagedDir,
      nodeVersion: '22.5.0',
      spawn: () => {
        spawnCalls++;
        return { status: 0 };
      },
    });
    assert.equal(applied, false);
    assert.equal(spawnCalls, 0);
    assert.equal(fs.existsSync(path.join(stagedDir, 'pending.json')), false);
  });

  it('rejects incompatible Node versions before install', () => {
    const root = tempDir();
    const { stagedDir } = createPending(root, { minNodeVersion: '99.0.0' });
    let spawnCalls = 0;
    const applied = autoUpdater._test.applyPendingUpgradeInternal({
      globalInstall: true,
      stagedDir,
      nodeVersion: '22.5.0',
      spawn: () => {
        spawnCalls++;
        return { status: 0 };
      },
    });
    assert.equal(applied, false);
    assert.equal(spawnCalls, 0);
  });

  it('installs a valid verified package with scripts disabled', () => {
    const root = tempDir();
    const { stagedDir, tarballPath } = createPending(root);
    const calls = [];
    const applied = autoUpdater._test.applyPendingUpgradeInternal({
      globalInstall: true,
      stagedDir,
      nodeVersion: '22.5.0',
      spawn: (...args) => {
        calls.push(args);
        return { status: 0 };
      },
    });
    assert.equal(applied, true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][1], ['install', '-g', '--ignore-scripts', tarballPath]);
    assert.equal(fs.existsSync(tarballPath), false);
    assert.equal(fs.existsSync(path.join(stagedDir, 'pending.json')), false);
  });

  it('uses the platform-specific npm executable without invoking a shell', () => {
    assert.equal(autoUpdater._test.resolveNpmCommand('win32'), 'npm.cmd');
    assert.equal(autoUpdater._test.resolveNpmCommand('darwin'), 'npm');
    assert.equal(autoUpdater._test.resolveNpmCommand('linux'), 'npm');

    const root = tempDir();
    const { stagedDir } = createPending(root);
    const calls = [];
    const applied = autoUpdater._test.applyPendingUpgradeInternal({
      globalInstall: true,
      stagedDir,
      nodeVersion: '22.5.0',
      platform: 'win32',
      spawn: (...args) => {
        calls.push(args);
        return { status: 0 };
      },
    });

    assert.equal(applied, true);
    assert.equal(calls[0][0], 'npm.cmd');
    assert.equal(calls[0][2].shell, undefined);
  });
});
