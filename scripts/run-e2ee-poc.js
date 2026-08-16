'use strict';

const { existsSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const operation = process.argv[2] === 'bench' ? 'bench' : 'test';
const executable = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
const localCargo = join(homedir(), '.cargo', 'bin', executable);
const cargo = existsSync(localCargo) ? localCargo : executable;
const args = [operation, '--manifest-path', join('e2ee', 'Cargo.toml')];
if (operation === 'bench') args.push('--bench', 'direct_message');

const result = spawnSync(cargo, args, {
  cwd: join(__dirname, '..'),
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
