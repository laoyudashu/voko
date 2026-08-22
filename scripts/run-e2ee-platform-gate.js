'use strict';

const { existsSync, writeFileSync } = require('node:fs');
const { homedir, platform, arch } = require('node:os');
const { join, resolve } = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const root = resolve(__dirname, '..');
const executable = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
const localCargo = join(homedir(), '.cargo', 'bin', executable);
const cargo = process.env.CARGO || (existsSync(localCargo) ? localCargo : executable);
const outputArg = process.argv.find((value) => value.startsWith('--output='));
const output = resolve(root, outputArg ? outputArg.slice(9) : 'e2ee-platform-summary.json');
const startedAt = new Date();
const result = spawnSync(cargo, [
  'test', '--locked', '--manifest-path', 'e2ee/Cargo.toml', '-p', 'voko-e2ee-core',
  '--test', 'system_key_real', '--', '--ignored', '--nocapture',
], { cwd: root, env: process.env, encoding: 'utf8', shell: false });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
const rust = spawnSync(cargo, ['--version'], { encoding: 'utf8', shell: false });
const summary = {
  schemaVersion: 1,
  passed: result.status === 0,
  platform: platform(),
  arch: arch(),
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  cargoVersion: String(rust.stdout || '').trim(),
  startedAt: startedAt.toISOString(),
  durationMs: Date.now() - startedAt.getTime(),
  test: 'real_system_credential_store_survives_reopen_and_revokes',
};
writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`);
console.log(`E2EE platform evidence written: ${output}`);
process.exit(result.status ?? 1);
