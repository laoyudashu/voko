'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');
const { exportRelease, verifyRelease } = require('../scripts/e2ee-web-release');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'voko-e2ee-release-'));
  const inputDir = join(root, 'input');
  const outputDir = join(root, 'output');
  mkdirSync(join(root, 'e2ee'), { recursive: true });
  mkdirSync(inputDir);
  writeFileSync(join(root, 'e2ee', 'Cargo.lock'), 'locked dependencies\n');
  writeFileSync(join(inputDir, 'voko_e2ee_wasm.js'), 'export default function init() {}\n');
  writeFileSync(join(inputDir, 'voko_e2ee_wasm_bg.wasm'), Buffer.from([0, 97, 115, 109]));
  return { root, inputDir, outputDir };
}

test('E2EE web release is deterministic and pins protocol, source and every asset', () => {
  const f = fixture();
  try {
    const options = { ...f, sourceCommit: 'abc123', sourceTimestamp: 1234567890 };
    const first = exportRelease(options);
    const firstBytes = readFileSync(join(f.outputDir, 'voko-e2ee-manifest.json'));
    const second = exportRelease(options);
    assert.deepEqual(second, first);
    assert.deepEqual(readFileSync(join(f.outputDir, 'voko-e2ee-manifest.json')), firstBytes);
    assert.equal(first.protocolVersion, 'voko.e2ee/2');
    assert.equal(first.contentType, 13);
    assert.equal(Object.keys(first.assets).length, 2);
    assert.deepEqual(verifyRelease(f.outputDir), first);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('E2EE web release verification fails closed after an asset is changed', () => {
  const f = fixture();
  try {
    exportRelease({ ...f, sourceCommit: 'abc123', sourceTimestamp: 1234567890 });
    writeFileSync(join(f.outputDir, 'voko_e2ee_wasm.js'), 'tampered');
    assert.throws(() => verifyRelease(f.outputDir), /asset mismatch/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
