'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BUILD_MANIFEST = '.voko-build.json';
const FORMAT_VERSION = 1;
const ALGORITHM = 'sha256';

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

function lengthBuffer(value) {
  const buffer = Buffer.allocUnsafe(8);
  buffer.writeBigUInt64BE(BigInt(value));
  return buffer;
}

function computeTreeDigest(buildDirectory, packageIdentity = {}) {
  const root = path.resolve(buildDirectory);
  const files = walk(root)
    .map(filePath => ({
      filePath,
      relative: path.relative(root, filePath).split(path.sep).join('/'),
    }))
    .filter(file => file.relative !== BUILD_MANIFEST)
    .sort((left, right) => Buffer.from(left.relative).compare(Buffer.from(right.relative)));
  const hash = crypto.createHash(ALGORITHM);
  const seed = Buffer.from(JSON.stringify({
    packageName: String(packageIdentity.packageName || ''),
    packageVersion: String(packageIdentity.packageVersion || ''),
  }), 'utf8');
  hash.update(lengthBuffer(seed.length));
  hash.update(seed);
  for (const file of files) {
    const relative = Buffer.from(file.relative, 'utf8');
    const content = fs.readFileSync(file.filePath);
    hash.update(lengthBuffer(relative.length));
    hash.update(relative);
    hash.update(lengthBuffer(content.length));
    hash.update(content);
  }
  return { digest: hash.digest('hex'), fileCount: files.length };
}

function writeBuildManifest(buildDirectory, packageIdentity = {}) {
  const result = computeTreeDigest(buildDirectory, packageIdentity);
  const manifest = {
    formatVersion: FORMAT_VERSION,
    algorithm: ALGORITHM,
    digest: result.digest,
    fileCount: result.fileCount,
    packageName: String(packageIdentity.packageName || ''),
    packageVersion: String(packageIdentity.packageVersion || ''),
  };
  fs.writeFileSync(path.join(buildDirectory, BUILD_MANIFEST), `${JSON.stringify(manifest)}\n`);
  return manifest;
}

function readBuildManifest(buildDirectory) {
  const manifestPath = path.join(path.resolve(buildDirectory), BUILD_MANIFEST);
  if (!fs.existsSync(manifestPath)) return { state: 'missing', digest: null };
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const valid = manifest?.formatVersion === FORMAT_VERSION
      && manifest?.algorithm === ALGORITHM
      && /^[a-f0-9]{64}$/.test(String(manifest?.digest || ''))
      && Number.isSafeInteger(manifest?.fileCount) && manifest.fileCount > 0;
    return valid
      ? { state: 'valid', digest: manifest.digest, manifest }
      : { state: 'invalid', digest: null };
  } catch {
    return { state: 'invalid', digest: null };
  }
}

module.exports = {
  ALGORITHM,
  BUILD_MANIFEST,
  FORMAT_VERSION,
  computeTreeDigest,
  readBuildManifest,
  writeBuildManifest,
};
