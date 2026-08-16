'use strict';

const { existsSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const executable = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
const localCargo = join(homedir(), '.cargo', 'bin', executable);
const cargo = existsSync(localCargo) ? localCargo : executable;
const forwarded = process.argv.slice(2);
if (!forwarded.some((value) => value.startsWith('--duration='))) forwarded.push('--duration=30m');
if (!forwarded.some((value) => value.startsWith('--output='))) forwarded.push('--output=e2ee-stability-summary.json');
const result = spawnSync(cargo, [
  'run', '--release', '--locked', '--manifest-path', join('e2ee', 'Cargo.toml'),
  '--bin', 'voko-e2ee-stability', '--', ...forwarded,
], { cwd: join(__dirname, '..'), env: process.env, stdio: 'inherit', shell: false, windowsHide: true });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
