const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { verifyNativeE2eeRelease } = require('../build/e2ee/native-release');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'voko-e2ee-native-'));
  t.after(() => fs.rmSync(dir,{ recursive:true,force:true }));
  const executable = path.join(dir,'endpoint.bin');
  const manifestPath = path.join(dir,'endpoint.manifest.json');
  fs.writeFileSync(executable,'verified endpoint');
  const { publicKey,privateKey } = crypto.generateKeyPairSync('ed25519');
  const manifest = { formatVersion:1,protocolVersion:'voko.e2ee/1',platform:process.platform,arch:process.arch,
    executableSha256:crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex'),keyId:'release-1' };
  const signature = crypto.sign(null,Buffer.from(JSON.stringify(manifest)),privateKey).toString('base64');
  fs.writeFileSync(manifestPath,JSON.stringify({ ...manifest,signature }));
  return { executable,manifestPath,publicKeyPem:publicKey.export({ type:'spki',format:'pem' }).toString() };
}

test('production native endpoint requires an exact signed platform artifact', t => {
  const current = fixture(t);
  assert.equal(verifyNativeE2eeRelease(current),path.resolve(current.executable));
  fs.appendFileSync(current.executable,'tampered');
  assert.throws(() => verifyNativeE2eeRelease(current),/E2EE_NATIVE_ASSET_MISMATCH/);
});

test('manifest signature and platform mismatch fail closed', t => {
  const current = fixture(t);
  const manifest = JSON.parse(fs.readFileSync(current.manifestPath,'utf8'));
  manifest.signature = Buffer.alloc(64).toString('base64');
  fs.writeFileSync(current.manifestPath,JSON.stringify(manifest));
  assert.throws(() => verifyNativeE2eeRelease(current),/E2EE_NATIVE_SIGNATURE_INVALID/);
  assert.throws(() => verifyNativeE2eeRelease({ ...fixture(t),platform:process.platform === 'win32' ? 'linux' : 'win32' }),
    /E2EE_NATIVE_MANIFEST_INVALID/);
});
