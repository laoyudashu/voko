'use strict';

const { existsSync } = require('node:fs');
const { homedir } = require('node:os');
const { join, resolve } = require('node:path');
const { execFileSync } = require('node:child_process');

const root = resolve(__dirname, '..');
const e2ee = join(root, 'e2ee');
const localCargo = join(homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo');
const localRustup = join(homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'rustup.exe' : 'rustup');
const localBindgen = join(homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'wasm-bindgen.exe' : 'wasm-bindgen');
const cargo = process.env.CARGO || (existsSync(localCargo) ? localCargo : 'cargo');
const rustup = process.env.RUSTUP || (existsSync(localRustup) ? localRustup : 'rustup');
const bindgen = process.env.WASM_BINDGEN || (existsSync(localBindgen) ? localBindgen : 'wasm-bindgen');

function output(command, args) {
  try { return execFileSync(command, args, { cwd: root, encoding: 'utf8' }).trim(); }
  catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`Missing E2EE WASM prerequisite: ${command}`);
    throw error;
  }
}

const bindgenVersion = output(bindgen, ['--version']);
if (!/\b0\.2\.127\b/.test(bindgenVersion)) {
  throw new Error(`wasm-bindgen-cli 0.2.127 is required; found: ${bindgenVersion}`);
}

execFileSync(rustup, ['target', 'add', 'wasm32-unknown-unknown', '--toolchain', '1.97.1'],
  { cwd: root, stdio: 'inherit' });
execFileSync(cargo, ['+1.97.1', 'test', '--locked', '--target', 'wasm32-unknown-unknown', '-p', 'voko-e2ee-wasm'],
  { cwd: e2ee, stdio: 'inherit' });
execFileSync(cargo, ['+1.97.1', 'build', '--locked', '--release', '--target', 'wasm32-unknown-unknown', '-p', 'voko-e2ee-wasm'],
  { cwd: e2ee, stdio: 'inherit' });
execFileSync(bindgen, ['--target', 'web', '--out-dir', 'target/web-poc', '--out-name', 'voko_e2ee_wasm',
  'target/wasm32-unknown-unknown/release/voko_e2ee_wasm.wasm'], { cwd: e2ee, stdio: 'inherit' });
console.log('E2EE browser WASM artifacts built with wasm-bindgen-cli 0.2.127.');
