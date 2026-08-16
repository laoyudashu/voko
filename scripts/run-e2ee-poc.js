'use strict';

const { existsSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const requested = process.argv[2];
const operation = requested === 'bench' ? 'bench' : requested === 'wasm' ? 'check' : 'test';
const executable = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
const localCargo = join(homedir(), '.cargo', 'bin', executable);
const cargo = existsSync(localCargo) ? localCargo : executable;
const workspace = requested === 'wasm' ? join(__dirname, '..', 'e2ee') : join(__dirname, '..');
const manifest = requested === 'wasm' ? 'Cargo.toml' : join('e2ee', 'Cargo.toml');
const args = [operation, '--manifest-path', manifest];
if (operation === 'bench') args.push('--bench', 'direct_message');
if (requested === 'wasm') args.push('--target', 'wasm32-unknown-unknown');
if (requested === 'stress') args.push('--release', '--test', 'stress', '--', '--ignored');
if (requested === 'fake-im') args.push('--test', 'fake_im');

const result = spawnSync(cargo, args, {
  cwd: workspace,
  env: process.env,
  stdio: 'inherit',
  shell: false,
});

if (result.error && result.error.code === 'ENOENT') {
  console.error('Rust/Cargo is required for the isolated E2EE PoC: https://rustup.rs/');
  process.exit(2);
}
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
