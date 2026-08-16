'use strict';

const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const file = resolve(__dirname, '..', 'e2ee', 'release-gates.json');
const manifest = JSON.parse(readFileSync(file, 'utf8'));
const allowed = new Set(['passed', 'pending_local', 'pending_external', 'failed']);
if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.gates) || typeof manifest.productionEnabled !== 'boolean') {
  throw new Error('Invalid E2EE release-gate manifest');
}
const ids = new Set();
for (const gate of manifest.gates) {
  if (!gate.id || ids.has(gate.id) || !allowed.has(gate.status) || !gate.evidence) {
    throw new Error(`Invalid or duplicate E2EE gate: ${gate.id || '<missing>'}`);
  }
  ids.add(gate.id);
}
const open = manifest.gates.filter((gate) => gate.status !== 'passed');
if (manifest.productionEnabled && open.length > 0) {
  throw new Error(`E2EE production cannot be enabled with open gates: ${open.map((gate) => gate.id).join(', ')}`);
}
console.log(`E2EE readiness: ${manifest.gates.length - open.length}/${manifest.gates.length} gates passed; production=${manifest.productionEnabled}.`);
for (const gate of open) console.log(`- ${gate.id}: ${gate.status} (${gate.evidence})`);
if (process.argv.includes('--production') && (!manifest.productionEnabled || open.length > 0)) {
  console.error('E2EE production activation is blocked.');
  process.exitCode = 1;
}
