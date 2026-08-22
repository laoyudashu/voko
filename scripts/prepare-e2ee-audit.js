'use strict';

const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync } = require('node:fs');
const { resolve, relative } = require('node:path');
const { execFileSync } = require('node:child_process');

const root = resolve(__dirname, '..');
const outputArg = process.argv.find((arg) => arg.startsWith('--output='));
const output = resolve(root, outputArg ? outputArg.slice('--output='.length) : 'e2ee-audit-bundle.json');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const tracked = git('ls-files', 'e2ee', 'docs/e2ee-security-model.md', 'docs/e2ee-resource-budget.md',
  'scripts/*e2ee*', '.github/workflows/ci.yml').split(/\r?\n/).filter(Boolean)
  .filter((file) => !file.startsWith('e2ee/target/'));
const files = tracked.map((file) => ({
  path: file.replaceAll('\\', '/'),
  sha256: createHash('sha256').update(readFileSync(resolve(root, file))).digest('hex'),
}));
const cargoLock = readFileSync(resolve(root, 'e2ee', 'Cargo.lock'), 'utf8');
const versionOf = (name) => cargoLock.match(new RegExp(`name = "${name}"\\r?\\nversion = "([^"]+)"`))?.[1] ?? null;
const readiness = JSON.parse(readFileSync(resolve(root, 'e2ee', 'release-gates.json'), 'utf8'));
const manifest = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  commit: git('rev-parse', 'HEAD'),
  dirty: git('status', '--porcelain').length > 0,
  securityClaim: readiness.securityClaim,
  productionEnabled: readiness.productionEnabled,
  pinnedDependencies: { rust: '1.97.1', openmls: versionOf('openmls'), openmlsRustCrypto: versionOf('openmls_rust_crypto') },
  threatModel: 'docs/e2ee-security-model.md',
  resourceBudget: 'docs/e2ee-resource-budget.md',
  requiredReviewAreas: [
    'credential and DID authorization binding', 'KeyPackage single-use and establishment ordering',
    'canonical AAD and outer-route comparison', 'single-writer state and fixed-ciphertext outbox',
    'Vault, OS credential store and rollback anchors', 'recovery and device revocation',
    'attachments, group operation metadata and optional A2A extension', 'browser code trust and transparency witnesses',
  ],
  excludedFromProductionClaim: [
    'active production VOKO message path', 'ordinary A2A mailbox', 'owner intervention email plaintext',
    'unverified cloud Provider endpoint',
  ],
  gates: readiness.gates,
  files,
};
writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'w' });
console.log(`E2EE audit manifest written to ${relative(root, output)} (${files.length} files).`);
if (manifest.dirty) console.warn('Warning: audit manifest was generated from a dirty worktree; regenerate from the review commit.');
