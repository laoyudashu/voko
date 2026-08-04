#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const testDir = path.join(root, 'test');
const matrix = JSON.parse(fs.readFileSync(path.join(testDir, 'test-matrix.json'), 'utf8'));
const inProcessTests = new Set(['lite-core-services.test.js']);
const layer = process.argv[2] || 'all';
const allFiles = fs.readdirSync(testDir).filter((name) => name.endsWith('.test.js')).sort();
const unit = new Set(matrix.unit);
const unknown = matrix.unit.filter((name) => !allFiles.includes(name));
if (unknown.length) throw new Error(`test matrix references missing files: ${unknown.join(', ')}`);

let selected;
if (layer === 'unit') selected = allFiles.filter((name) => unit.has(name));
else if (layer === 'component') selected = allFiles.filter((name) => !unit.has(name));
else if (layer === 'all') selected = allFiles;
else throw new Error(`unknown test layer: ${layer}`);

if (!selected.length) throw new Error(`test layer is empty: ${layer}`);

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

const isolated = selected.filter((name) => !inProcessTests.has(name));
if (isolated.length) run(['--test', '--test-concurrency=1', ...isolated.map((name) => path.join('test', name))]);
for (const name of selected.filter((file) => inProcessTests.has(file))) {
  run(['--test', '--experimental-test-isolation=none', path.join('test', name)]);
}
