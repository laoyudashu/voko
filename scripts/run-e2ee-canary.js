'use strict';

const { execFileSync } = require('node:child_process');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join, resolve } = require('node:path');

const root = resolve(__dirname, '..');
const outputArg = process.argv.find((value) => value.startsWith('--output='));
const output = resolve(root, outputArg ? outputArg.slice('--output='.length) : 'e2ee-canary-summary.json');
const cargoName = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
const localCargo = join(homedir(), '.cargo', 'bin', cargoName);
const cargo = process.env.CARGO || (existsSync(localCargo) ? localCargo : cargoName);

if (!['win32', 'darwin'].includes(process.platform)) {
  throw new Error('The internal E2EE-TOFU Canary is currently limited to Windows and macOS test devices.');
}

function run(command, args) {
  execFileSync(command, args, { cwd: root, env: process.env, stdio: 'inherit', windowsHide: true });
}

const manifest = JSON.parse(readFileSync(join(root, 'e2ee', 'release-gates.json'), 'utf8'));
if (manifest.productionEnabled !== false) throw new Error('Internal Canary requires productionEnabled=false.');

run(process.execPath, ['scripts/check-e2ee-readiness.js']);
run(cargo, ['test', '--locked', '--manifest-path', 'e2ee/Cargo.toml', '-p', 'voko-e2ee-core']);
if (process.platform === 'darwin') run(process.execPath, ['scripts/run-e2ee-platform-gate.js']);
run(process.execPath, ['scripts/build-e2ee-wasm.js']);
run(process.execPath, ['scripts/test-e2ee-wasm-browser.js']);
run(process.execPath, ['scripts/test-e2ee-cross-process.js']);
run(cargo, ['test', '--locked', '--manifest-path', 'e2ee/Cargo.toml', '-p', 'voko-e2ee-core', '--test', 'fake_im']);
if (process.platform === 'darwin') run(process.execPath, ['scripts/test-e2ee-macos-faults.js']);
run(cargo, ['run', '--quiet', '--locked', '--manifest-path', 'e2ee/Cargo.toml',
  '--bin', 'voko-e2ee-canary-acceptance', '--', `--output=${output}`]);

const summary = JSON.parse(readFileSync(output, 'utf8'));
summary.sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
summary.checks = [
  'readiness', 'core_protocol', 'browser_wasm_build', 'browser_wasm', 'browser_lite_cross_process',
  'fake_im_faults',
  ...(process.platform === 'darwin' ? ['macos_keychain', 'macos_sigkill_recovery'] : []),
  `${process.platform}_canary_acceptance`,
];
writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`);
if (!summary.passed || summary.productionEnabled !== false) throw new Error('Invalid Canary evidence.');
console.log(`E2EE internal Canary gate passed; evidence=${output}`);
