#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const pkg = require('../package.json');

const NPM_LATEST_URL = 'https://registry.npmjs.org/@voko%2Flite/latest';
const NPM_REGISTRY_ORIGIN = 'https://registry.npmjs.org';

function sha512(buffer) {
  return `sha512-${crypto.createHash('sha512').update(buffer).digest('base64')}`;
}

async function fetchOk(fetchImpl, url, type) {
  const response = await fetchImpl(url, { cache: 'no-store', redirect: 'error' });
  if (!response.ok) throw new Error(`${type} returned HTTP ${response.status}`);
  return response;
}

function validateNpmMetadata(metadata, expectedVersion = pkg.version) {
  if (!metadata || typeof metadata !== 'object') throw new Error('npm metadata is not an object');
  if (metadata.version !== expectedVersion) {
    throw new Error(`npm version ${metadata.version || 'missing'} does not match ${expectedVersion}`);
  }
  if (metadata.engines?.node !== pkg.engines.node) {
    throw new Error(`npm minNodeVersion ${metadata.engines?.node || 'missing'} does not match ${pkg.engines.node}`);
  }
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(String(metadata.dist?.integrity || ''))) {
    throw new Error('npm integrity is invalid');
  }
  let tarballUrl;
  try {
    tarballUrl = new URL(metadata.dist?.tarball);
  } catch {
    throw new Error('npm tarball URL is invalid');
  }
  if (tarballUrl.origin !== NPM_REGISTRY_ORIGIN || tarballUrl.protocol !== 'https:') {
    throw new Error('npm tarball escapes the official registry origin');
  }
  return { metadata, tarballUrl };
}

async function verifyReleaseSources(fetchImpl = fetch) {
  const metadataResponse = await fetchOk(fetchImpl, NPM_LATEST_URL, 'npm metadata');
  const { metadata, tarballUrl } = validateNpmMetadata(await metadataResponse.json());
  const tarballResponse = await fetchOk(fetchImpl, tarballUrl.href, 'npm tarball');
  const tarball = Buffer.from(await tarballResponse.arrayBuffer());
  if (sha512(tarball) !== metadata.dist.integrity) throw new Error('npm tarball integrity mismatch');
  return {
    version: metadata.version,
    minNodeVersion: metadata.engines.node,
    tarballUrl: tarballUrl.href,
    tarballBytes: tarball.length,
    integrity: metadata.dist.integrity,
  };
}

if (require.main === module) {
  verifyReleaseSources()
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => {
      console.error(`[verify-release-sources] ${error.message}`);
      process.exitCode = 1;
    });
}

module.exports = { NPM_LATEST_URL, NPM_REGISTRY_ORIGIN, sha512, validateNpmMetadata, verifyReleaseSources };
