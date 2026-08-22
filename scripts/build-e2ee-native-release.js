#!/usr/bin/env node
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function readRegularFile(filePath, errorCode) {
  const noFollow = Number(fs.constants.O_NOFOLLOW || 0);
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(errorCode);
    return fs.readFileSync(fd);
  } catch (error) {
    if (error instanceof Error && error.message === errorCode) throw error;
    throw new Error(errorCode);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

function buildNativeRelease({ root, privateKeyFile, outputDirectory, platform = process.platform, arch = process.arch }) {
  if (!privateKeyFile) throw new Error('E2EE_RELEASE_PRIVATE_KEY_REQUIRED');
  const privateKey = readRegularFile(privateKeyFile, 'E2EE_RELEASE_PRIVATE_KEY_REQUIRED');
  execFileSync(process.env.CARGO || 'cargo', ['build','--locked','--release','--manifest-path','e2ee/Cargo.toml',
    '--bin','voko-e2ee-canary-endpoint'], { cwd:root,stdio:'inherit',windowsHide:true });
  const source = path.join(root,'e2ee','target','release',`voko-e2ee-canary-endpoint${platform === 'win32' ? '.exe' : ''}`);
  if (!fs.statSync(source).isFile()) throw new Error('E2EE_NATIVE_BUILD_MISSING');
  fs.mkdirSync(outputDirectory,{ recursive:true });
  const name = `voko-e2ee-endpoint-${platform}-${arch}${platform === 'win32' ? '.exe' : ''}`;
  const executable = path.join(outputDirectory,name);
  fs.copyFileSync(source,executable);
  const publicKey = crypto.createPublicKey(privateKey);
  const unsigned = { formatVersion:1,protocolVersion:'voko.e2ee/1',platform,arch,
    executableSha256:crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex'),
    keyId:crypto.createHash('sha256').update(publicKey.export({ type:'spki',format:'der' })).digest('base64url').slice(0,24) };
  const signature = crypto.sign(null,Buffer.from(JSON.stringify(unsigned)),privateKey).toString('base64');
  const manifestPath = `${executable}.manifest.json`;
  fs.writeFileSync(manifestPath,`${JSON.stringify({ ...unsigned,signature },null,2)}\n`);
  return { executable,manifestPath,publicKeyPem:publicKey.export({ type:'spki',format:'pem' }).toString() };
}

if (require.main === module) {
  const root = path.resolve(__dirname,'..');
  const result = buildNativeRelease({ root,privateKeyFile:path.resolve(String(process.env.VOKO_E2EE_RELEASE_PRIVATE_KEY_FILE || '')),
    outputDirectory:path.resolve(process.argv[2] || path.join(root,'e2ee','target','native-release')) });
  console.log(`Signed E2EE native release: ${result.executable}`);
  console.log(result.publicKeyPem.trim());
}
module.exports = { buildNativeRelease };
