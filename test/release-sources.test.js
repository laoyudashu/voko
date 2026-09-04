'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const pkg = require('../package.json');
const {
  NPM_LATEST_URL,
  sha512,
  validateNpmMetadata,
  verifyReleaseSources,
} = require('../scripts/verify-release-sources');

function metadataFor(tarball, overrides = {}) {
  return {
    version: pkg.version,
    engines: { node: pkg.engines.node },
    dist: {
      tarball: 'https://registry.npmjs.org/@voko/lite/-/lite-0.5.2.tgz',
      integrity: sha512(tarball),
    },
    ...overrides,
  };
}

test('published release verification checks the official npm tarball integrity', async () => {
  const tarball = Buffer.from('verified release tarball');
  const metadata = metadataFor(tarball);
  const calls = [];
  const result = await verifyReleaseSources(async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url) === NPM_LATEST_URL) {
      return { ok: true, json: async () => metadata };
    }
    return { ok: true, arrayBuffer: async () => tarball };
  });

  assert.equal(result.version, pkg.version);
  assert.equal(result.integrity, metadata.dist.integrity);
  assert.deepEqual(calls.map(({ url }) => url), [NPM_LATEST_URL, metadata.dist.tarball]);
  assert.equal(calls.every(({ options }) => options.redirect === 'error'), true);
});

test('published release verification rejects non-registry tarballs', () => {
  const tarball = Buffer.from('release tarball');
  const metadata = metadataFor(tarball);
  metadata.dist.tarball = 'https://example.com/voko-lite.tgz';
  assert.throws(() => validateNpmMetadata(metadata), /official registry origin/);
});

test('published release verification rejects a mismatched tarball', async () => {
  const metadata = metadataFor(Buffer.from('expected'));
  await assert.rejects(() => verifyReleaseSources(async (url) => (
    String(url) === NPM_LATEST_URL
      ? { ok: true, json: async () => metadata }
      : { ok: true, arrayBuffer: async () => Buffer.from('tampered') }
  )), /integrity mismatch/);
});
