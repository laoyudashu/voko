#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const outputDir = path.resolve(process.argv[2] || 'playwright-report/e2e-runtime');
fs.mkdirSync(outputDir, { recursive: true });
const outputPrefix = `${outputDir}${path.sep}`;

const entries = fs.readdirSync(os.tmpdir(), { withFileTypes: true })
  .filter(entry => entry.isDirectory() && entry.name.startsWith('voko-e2e-'))
  .map(entry => ({ entry, fullPath: path.join(os.tmpdir(), entry.name) }))
  .filter(({ fullPath }) => fullPath !== outputDir && !outputPrefix.startsWith(`${fullPath}${path.sep}`))
  .sort((a, b) => fs.statSync(b.fullPath).mtimeMs - fs.statSync(a.fullPath).mtimeMs);

let copied = 0;
for (const { entry, fullPath } of entries.slice(0, 5)) {
  const destination = path.join(outputDir, entry.name);
  fs.mkdirSync(destination, { recursive: true });
  for (const name of ['voko.log', 'e2e.db']) {
    const source = path.join(fullPath, name);
    if (!fs.existsSync(source)) continue;
    fs.copyFileSync(source, path.join(destination, name));
    copied += 1;
  }
}

const manifests = fs.readdirSync(os.tmpdir(), { withFileTypes: true })
  .filter(entry => entry.isFile() && /^voko-e2e-services-.*\.json$/.test(entry.name))
  .map(entry => path.join(os.tmpdir(), entry.name));
for (const source of manifests) {
  fs.copyFileSync(source, path.join(outputDir, path.basename(source)));
  copied += 1;
}

if (!copied) fs.writeFileSync(path.join(outputDir, 'README.txt'), 'No retained VOKO E2E runtime artifacts were found.\n');
console.log(`[e2e] collected ${copied} runtime artifact(s) into ${outputDir}`);
