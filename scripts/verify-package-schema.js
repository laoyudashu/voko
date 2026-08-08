'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SOURCE_DATABASE = path.join(ROOT, 'src', 'core', 'database.ts');
const BUILD_DATABASE = path.join(ROOT, 'build', 'core', 'database.js');

function readSchemaVersion(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`missing database build input: ${path.relative(ROOT, file)}`);
  }
  const source = fs.readFileSync(file, 'utf8');
  const match = source.match(/\bconst\s+SCHEMA_VERSION\s*=\s*(\d+)\s*;/);
  if (!match) {
    throw new Error(`SCHEMA_VERSION was not found in ${path.relative(ROOT, file)}`);
  }
  return Number(match[1]);
}

const sourceVersion = readSchemaVersion(SOURCE_DATABASE);
const buildVersion = readSchemaVersion(BUILD_DATABASE);

if (sourceVersion !== buildVersion) {
  throw new Error(
    `schema version mismatch: source=${sourceVersion}, build=${buildVersion}; `
      + 'run npm run build:ts before packing',
  );
}

console.log(`[package-schema] source/build schema v${sourceVersion} are synchronized`);
