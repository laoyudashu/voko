'use strict';

const { createHash } = require('node:crypto');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { basename, join, resolve } = require('node:path');
const { execFileSync } = require('node:child_process');

const PROTOCOL_VERSION = 'voko.e2ee/1';
const CONTENT_TYPE = 13;
const FORMAT_VERSION = 1;

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function gitValue(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function createManifest({ root, assets, sourceCommit, sourceTimestamp }) {
  const lock = readFileSync(join(root, 'e2ee', 'Cargo.lock'));
  const rows = {};
  for (const file of assets) {
    const bytes = readFileSync(file);
    rows[basename(file)] = { sha256: sha256(bytes), size: bytes.length };
  }
  return {
    formatVersion: FORMAT_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    contentType: CONTENT_TYPE,
    sourceCommit: sourceCommit || gitValue(root, ['rev-parse', 'HEAD']),
    sourceTimestamp: Number(sourceTimestamp || gitValue(root, ['show', '-s', '--format=%ct', 'HEAD'])),
    cargoLockSha256: sha256(lock),
    assets: rows,
  };
}

function exportRelease({ root, inputDir, outputDir, sourceCommit, sourceTimestamp }) {
  const names = ['voko_e2ee_wasm.js', 'voko_e2ee_wasm_bg.wasm'];
  const inputs = names.map((name) => join(inputDir, name));
  mkdirSync(outputDir, { recursive: true });
  for (let i = 0; i < names.length; i += 1) {
    writeFileSync(join(outputDir, names[i]), readFileSync(inputs[i]));
  }
  const manifest = createManifest({ root, assets: inputs, sourceCommit, sourceTimestamp });
  writeFileSync(join(outputDir, 'voko-e2ee-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function verifyRelease(directory) {
  const manifest = JSON.parse(readFileSync(join(directory, 'voko-e2ee-manifest.json'), 'utf8'));
  if (manifest.formatVersion !== FORMAT_VERSION || manifest.protocolVersion !== PROTOCOL_VERSION
      || manifest.contentType !== CONTENT_TYPE || !manifest.sourceCommit || !manifest.cargoLockSha256) {
    throw new Error('Invalid VOKO E2EE web release manifest');
  }
  for (const [name, expected] of Object.entries(manifest.assets || {})) {
    const bytes = readFileSync(join(directory, name));
    if (bytes.length !== expected.size || sha256(bytes) !== expected.sha256) {
      throw new Error(`VOKO E2EE web release asset mismatch: ${name}`);
    }
  }
  if (Object.keys(manifest.assets || {}).length !== 2) throw new Error('Incomplete VOKO E2EE web release');
  return manifest;
}

if (require.main === module) {
  const root = resolve(__dirname, '..');
  const outputArg = process.argv[2];
  if (!outputArg) throw new Error('Usage: node scripts/e2ee-web-release.js <output-directory>');
  const outputDir = resolve(outputArg);
  exportRelease({ root, inputDir: join(root, 'e2ee', 'target', 'web-poc'), outputDir });
  verifyRelease(outputDir);
  console.log(`Verified VOKO E2EE web release: ${outputDir}`);
}

module.exports = { CONTENT_TYPE, PROTOCOL_VERSION, createManifest, exportRelease, verifyRelease };
