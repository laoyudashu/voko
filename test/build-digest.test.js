'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  BUILD_MANIFEST,
  computeTreeDigest,
  readBuildManifest,
  writeBuildManifest,
} = require('../src/core/build-digest');
const lifecycle = require('../build/core/process-lifecycle');

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-build-digest-'));
  fs.mkdirSync(path.join(directory, 'web'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'index.js'), 'require("./web")\n');
  fs.writeFileSync(path.join(directory, 'web', 'index.js'), 'module.exports = 1\n');
  return directory;
}

test('build digest covers sibling runtime files and ignores metadata', t => {
  const directory = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const identity = { packageName: '@voko/lite', packageVersion: '0.5.0' };
  const before = computeTreeDigest(directory, identity).digest;
  fs.chmodSync(path.join(directory, 'web', 'index.js'), 0o600);
  fs.utimesSync(path.join(directory, 'web', 'index.js'), new Date(1), new Date(1));
  assert.equal(computeTreeDigest(directory, identity).digest, before);
  fs.writeFileSync(path.join(directory, 'web', 'index.js'), 'module.exports = 2\n');
  assert.notEqual(computeTreeDigest(directory, identity).digest, before);
});

test('manifest is deterministic and excludes itself', t => {
  const directory = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const identity = { packageName: '@voko/lite', packageVersion: '0.5.0' };
  const first = writeBuildManifest(directory, identity);
  const second = writeBuildManifest(directory, identity);
  assert.equal(second.digest, first.digest);
  assert.equal(second.fileCount, first.fileCount);
  assert.equal(readBuildManifest(directory).digest, first.digest);
});

test('runtime reads valid manifest, rejects invalid manifest, and falls back only when absent', t => {
  const directory = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const entryPath = path.join(directory, 'index.js');
  const legacy = lifecycle.computeBuildDigest(entryPath);
  assert.match(legacy, /^[a-f0-9]{64}$/);
  const manifest = writeBuildManifest(directory, { packageName: '@voko/lite', packageVersion: '0.5.0' });
  assert.equal(lifecycle.computeBuildDigest(entryPath), manifest.digest);
  fs.writeFileSync(path.join(directory, BUILD_MANIFEST), '{"formatVersion":999}\n');
  assert.equal(lifecycle.computeBuildDigest(entryPath), null);
});
