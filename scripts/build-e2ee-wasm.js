'use strict';

const { copyFileSync, existsSync, mkdirSync, rmSync } = require('node:fs');
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
const rustVersion = output(rustup, ['run', 'stable', 'rustc', '--version']);
if (!/^rustc 1\.97\.1\b/.test(rustVersion)) {
  throw new Error(`Rust 1.97.1 stable is required; found: ${rustVersion}`);
}

execFileSync(rustup, ['target', 'add', 'wasm32-unknown-unknown', '--toolchain', 'stable'],
  { cwd: root, stdio: 'inherit' });
execFileSync(cargo, ['+stable', 'test', '--locked', '--target', 'wasm32-unknown-unknown', '-p', 'voko-e2ee-wasm'],
  { cwd: e2ee, stdio: 'inherit' });
execFileSync(cargo, ['+stable', 'build', '--locked', '--profile', 'web', '--target', 'wasm32-unknown-unknown', '-p', 'voko-e2ee-wasm'],
  { cwd: e2ee, stdio: 'inherit' });
execFileSync(bindgen, ['--target', 'web', '--out-dir', 'target/web-poc', '--out-name', 'voko_e2ee_wasm',
  'target/wasm32-unknown-unknown/web/voko_e2ee_wasm.wasm'], { cwd: e2ee, stdio: 'inherit' });
execFileSync(bindgen, ['--target', 'nodejs', '--out-dir', 'target/node-runtime', '--out-name', 'voko_e2ee_wasm',
  'target/wasm32-unknown-unknown/web/voko_e2ee_wasm.wasm'], { cwd: e2ee, stdio: 'inherit' });
const nodeRuntimeDir = join(root, 'src', 'e2ee', 'wasm');
rmSync(nodeRuntimeDir, { recursive: true, force: true });
mkdirSync(nodeRuntimeDir, { recursive: true });
for (const name of ['voko_e2ee_wasm.js', 'voko_e2ee_wasm_bg.wasm']) {
  copyFileSync(join(e2ee, 'target', 'node-runtime', name), join(nodeRuntimeDir, name));
}
const outputDir = process.env.VOKO_E2EE_WEB_RELEASE_DIR
  ? resolve(process.env.VOKO_E2EE_WEB_RELEASE_DIR)
  : join(e2ee, 'target', 'web-release');
execFileSync(process.execPath, [join(root, 'scripts', 'e2ee-web-release.js'), outputDir],
  { cwd: root, stdio: 'inherit' });
console.log('E2EE v2 browser and Node WASM runtimes built with wasm-bindgen-cli 0.2.127.');
