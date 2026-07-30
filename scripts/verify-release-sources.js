#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const pkg = require('../package.json');
const endpoints = require('../src/endpoints.json');

const NPM_LATEST_URL = 'https://registry.npmjs.org/@voko%2Flite/latest';

function sha512(buffer) {
  return `sha512-${crypto.createHash('sha512').update(buffer).digest('base64')}`;
}

function validateManifest(manifest, expectedVersion = pkg.version) {
  if (!manifest || typeof manifest !== 'object') throw new Error('OSS manifest is not an object');
  if (manifest.version !== expectedVersion) {
    throw new Error(`OSS version ${manifest.version || 'missing'} does not match ${expectedVersion}`);
  }
  if (manifest.minNodeVersion !== pkg.engines.node) {
    throw new Error(`OSS minNodeVersion ${manifest.minNodeVersion || 'missing'} does not match ${pkg.engines.node}`);
  }
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(String(manifest.integrity || ''))) {
    throw new Error('OSS integrity is invalid');
  }
  if (!/^lite\/[A-Za-z0-9._-]+\.tgz$/.test(String(manifest.tarball || ''))) {
    throw new Error('OSS tarball path is invalid');
  }
  return manifest;
}

async function fetchOk(fetchImpl, url, type) {
  const response = await fetchImpl(url, { cache: 'no-store', redirect: 'error' });
  if (!response.ok) throw new Error(`${type} returned HTTP ${response.status}`);
  return response;
}

async function verifyReleaseSources(fetchImpl = fetch) {
  const baseUrl = new URL(endpoints.update.baseUrl);
  const manifestUrl = new URL(endpoints.update.liteManifest, `${baseUrl.href.replace(/\/?$/, '/')}`);
  const npmResponse = await fetchOk(fetchImpl, NPM_LATEST_URL, 'npm metadata');
  const npmMetadata = await npmResponse.json();
  if (npmMetadata.version !== pkg.version) {
    throw new Error(`npm version ${npmMetadata.version || 'missing'} does not match ${pkg.version}`);
  }

  const manifestResponse = await fetchOk(fetchImpl, manifestUrl, 'OSS manifest');
  const manifest = validateManifest(await manifestResponse.json());
  const tarballUrl = new URL(manifest.tarball, `${baseUrl.href.replace(/\/?$/, '/')}`);
  if (tarballUrl.origin !== baseUrl.origin || !tarballUrl.pathname.startsWith(baseUrl.pathname)) {
    throw new Error('OSS tarball escapes the configured update origin or path');
  }

  const tarballResponse = await fetchOk(fetchImpl, tarballUrl, 'OSS tarball');
  const tarball = Buffer.from(await tarballResponse.arrayBuffer());
  if (sha512(tarball) !== manifest.integrity) throw new Error('OSS tarball integrity mismatch');
  return {
    version: manifest.version,
    minNodeVersion: manifest.minNodeVersion,
    tarballUrl: tarballUrl.href,
    tarballBytes: tarball.length,
    integrity: manifest.integrity,
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

module.exports = { NPM_LATEST_URL, sha512, validateManifest, verifyReleaseSources };
