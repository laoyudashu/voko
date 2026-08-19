import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

interface NativeReleaseManifest {
  formatVersion: 1;
  protocolVersion: 'voko.e2ee/1';
  platform: NodeJS.Platform;
  arch: string;
  executableSha256: string;
  keyId: string;
  signature: string;
}

function canonical(manifest: NativeReleaseManifest): Buffer {
  return Buffer.from(JSON.stringify({ formatVersion:manifest.formatVersion,protocolVersion:manifest.protocolVersion,
    platform:manifest.platform,arch:manifest.arch,executableSha256:manifest.executableSha256,keyId:manifest.keyId }), 'utf8');
}

export function verifyNativeE2eeRelease(input: { executable: string; manifestPath: string; publicKeyPem: string;
  platform?: NodeJS.Platform; arch?: string }): string {
  const executable = path.resolve(String(input.executable || ''));
  const manifestPath = path.resolve(String(input.manifestPath || ''));
  if (!path.isAbsolute(executable) || !path.isAbsolute(manifestPath) || !fs.statSync(executable).isFile()
      || !fs.statSync(manifestPath).isFile()) throw new Error('E2EE_NATIVE_RELEASE_MISSING');
  let manifest: NativeReleaseManifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath,'utf8')); }
  catch { throw new Error('E2EE_NATIVE_MANIFEST_INVALID'); }
  const keys = Object.keys(manifest as any).sort().join(',');
  if (keys !== ['arch','executableSha256','formatVersion','keyId','platform','protocolVersion','signature'].sort().join(',')
      || manifest.formatVersion !== 1 || manifest.protocolVersion !== 'voko.e2ee/1'
      || manifest.platform !== (input.platform || process.platform) || manifest.arch !== (input.arch || process.arch)
      || !/^[a-f0-9]{64}$/.test(manifest.executableSha256) || !/^[A-Za-z0-9._-]{1,64}$/.test(manifest.keyId)
      || !/^[A-Za-z0-9+/=]+$/.test(manifest.signature)) throw new Error('E2EE_NATIVE_MANIFEST_INVALID');
  const actual = crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(actual,'hex'),Buffer.from(manifest.executableSha256,'hex'))) {
    throw new Error('E2EE_NATIVE_ASSET_MISMATCH');
  }
  let verified = false;
  try { verified = crypto.verify(null,canonical(manifest),input.publicKeyPem,Buffer.from(manifest.signature,'base64')); }
  catch { verified = false; }
  if (!verified) throw new Error('E2EE_NATIVE_SIGNATURE_INVALID');
  return executable;
}

module.exports = { verifyNativeE2eeRelease, canonical };
