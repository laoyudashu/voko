'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { resolvePackagedE2eeRelease } = require('../build/e2ee/platform-package');
const { stagePackage } = require('../scripts/stage-e2ee-platform-package');

test('resolves only the E2EE package matching the current platform and architecture', () => {
  let requested = '';
  const result = resolvePackagedE2eeRelease({ platform:'darwin',arch:'arm64',resolvePackageJson(request) {
    requested = request;
    return path.posix.join('/packages','darwin-arm64','package.json');
  } });
  assert.equal(requested,'@voko/e2ee-darwin-arm64/package.json');
  assert.deepEqual(result,{
    packageName:'@voko/e2ee-darwin-arm64',
    executable:path.posix.join('/packages','darwin-arm64','bin','voko-e2ee-endpoint'),
    manifestPath:path.posix.join('/packages','darwin-arm64','bin','voko-e2ee-endpoint.manifest.json'),
  });
});

test('returns null when the platform package is unavailable or unsupported', () => {
  assert.equal(resolvePackagedE2eeRelease({ platform:'freebsd',arch:'x64' }),null);
  assert.equal(resolvePackagedE2eeRelease({ platform:'linux',arch:'x64',resolvePackageJson() {
    const error = new Error('missing'); error.code = 'MODULE_NOT_FOUND'; throw error;
  } }),null);
});

test('uses the Windows executable suffix', () => {
  const result = resolvePackagedE2eeRelease({ platform:'win32',arch:'x64',resolvePackageJson() {
    return path.win32.join('C:\\packages','win32-x64','package.json');
  } });
  assert.equal(path.win32.basename(result.executable),'voko-e2ee-endpoint.exe');
});

test('stages one platform-constrained package without embedding a trust key', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'voko-e2ee-package-'));
  try {
    const endpoint = path.join(root,'source-endpoint');
    const manifest = path.join(root,'source-endpoint.manifest.json');
    const output = path.join(root,'output');
    fs.writeFileSync(endpoint,'native');
    fs.writeFileSync(manifest,JSON.stringify({ platform:'linux',arch:'arm64' }));
    stagePackage({ endpoint,manifest,output,version:'1.2.3' });
    const pkg = JSON.parse(fs.readFileSync(path.join(output,'package.json'),'utf8'));
    assert.equal(pkg.name,'@voko/e2ee-linux-arm64');
    assert.deepEqual(pkg.os,['linux']);
    assert.deepEqual(pkg.cpu,['arm64']);
    assert.equal(Object.hasOwn(pkg,'publicKey'),false);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(output,'bin','voko-e2ee-endpoint')).mode & 0o111,0o111);
    }
  } finally {
    fs.rmSync(root,{ recursive:true,force:true });
  }
});

test('main package pins every native package to the Lite release version', () => {
  const pkg = require('../package.json');
  const nativePackages = Object.entries(pkg.optionalDependencies || {})
    .filter(([name]) => name.startsWith('@voko/e2ee-'));
  assert.equal(nativePackages.length,5);
  assert.equal(nativePackages.every(([,version]) => version === pkg.version),true);
});
