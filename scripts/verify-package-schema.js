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

const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const nativePackages = Object.entries(packageJson.optionalDependencies || {})
  .filter(([name]) => name.startsWith('@voko/e2ee-'));
if (nativePackages.length !== 5 || nativePackages.some(([, version]) => version !== packageJson.version)) {
  throw new Error(`E2EE platform packages must all use the Lite release version ${packageJson.version}`);
}

console.log(`[package-schema] source/build schema v${sourceVersion} are synchronized`);
