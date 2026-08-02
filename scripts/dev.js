#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SOURCE_DIR = path.join(ROOT, 'src');
const BUILD_DIR = path.join(ROOT, 'build');
const BUILD_SCRIPT = path.join(__dirname, 'build-ts.js');
const ENTRY = path.join(BUILD_DIR, 'index.js');
const TSC = require.resolve('typescript/bin/tsc');
const BUILD_INFO = path.join(BUILD_DIR, '.dev.tsbuildinfo');
const ASSET_EXTENSIONS = new Set(['.json', '.html', '.txt']);
const CODE_EXTENSIONS = new Set(['.js', '.ts']);
const DEBOUNCE_MS = 200;

let runtime = null;
let watcher = null;
let building = false;
let pending = false;
let closing = false;
let debounceTimer = null;
const changedFiles = new Set();

function runNode(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      stdio: 'inherit',
      windowsHide: true,
      ...options,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

function walkFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(fullPath));
    else files.push(fullPath);
  }
  return files;
}

function outputPath(sourcePath) {
  const relative = path.relative(SOURCE_DIR, sourcePath);
  const extension = path.extname(relative);
  if (sourcePath.endsWith('.d.ts')) return null;
  if (CODE_EXTENSIONS.has(extension)) {
    return path.join(BUILD_DIR, relative.slice(0, -extension.length) + '.js');
  }
  if (ASSET_EXTENSIONS.has(extension)) return path.join(BUILD_DIR, relative);
  return null;
}

function buildIsCurrent() {
  if (!fs.existsSync(ENTRY)) return false;
  return walkFiles(SOURCE_DIR).every((sourcePath) => {
    const destination = outputPath(sourcePath);
    if (!destination) return true;
    if (!fs.existsSync(destination)) return false;
    return fs.statSync(destination).mtimeMs >= fs.statSync(sourcePath).mtimeMs;
  });
}

async function fullBuild() {
  const result = await runNode([BUILD_SCRIPT]);
  if (result.code !== 0) throw new Error(`Build exited with code ${result.code}`);
}

async function incrementalCompile() {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  const result = await runNode([
    TSC,
    '--incremental',
    '--tsBuildInfoFile', BUILD_INFO,
    '--outDir', BUILD_DIR,
    '--pretty', 'false',
  ]);
  if (result.code !== 0) throw new Error(`TypeScript exited with code ${result.code}`);
}

function syncAsset(relative) {
  const source = path.join(SOURCE_DIR, relative);
  const destination = path.join(BUILD_DIR, relative);
  if (!fs.existsSync(source)) {
    fs.rmSync(destination, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function removeDeletedOutput(relative) {
  const source = path.join(SOURCE_DIR, relative);
  if (fs.existsSync(source)) return;
  const destination = outputPath(source);
  if (destination) fs.rmSync(destination, { force: true });
}

async function applyChanges(files) {
  let needsCompile = false;
  for (const relative of files) {
    const extension = path.extname(relative);
    if (ASSET_EXTENSIONS.has(extension)) syncAsset(relative);
    if (CODE_EXTENSIONS.has(extension) || relative.endsWith('.d.ts')) {
      removeDeletedOutput(relative);
      needsCompile = true;
    }
  }
  if (needsCompile) await incrementalCompile();
}

async function stopRuntime() {
  if (!runtime) return;
  const child = runtime;
  const result = await runNode([ENTRY, 'stop']);
  const exited = await waitForRuntimeExit(child, 5000);
  if (!exited) {
    console.error(`[dev] Lite PID ${child.pid} did not exit after stop; terminating its process tree.`);
    terminateRuntimeTree(child);
    if (!await waitForRuntimeExit(child, 5000)) {
      throw new Error(`Lite PID ${child.pid} is still running after forced termination`);
    }
  }
  if (result.code !== 0 && child.exitCode === null) {
    throw new Error(`Stop command exited with code ${result.code}`);
  }
  if (runtime === child) runtime = null;
}

function waitForRuntimeExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

function terminateRuntimeTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 10000,
    });
    return;
  }
  try { child.kill('SIGKILL'); } catch {}
}

function startRuntime(openMainPage = false) {
  const args = [ENTRY, 'start'];
  if (!openMainPage) args.push('--no-open');
  runtime = spawn(process.execPath, args, {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: true,
    env: {
      ...process.env,
      // Provider CLIs must not launch OAuth/login tabs during unattended delivery.
      BROWSER: 'none',
    },
  });
  runtime.once('error', (error) => {
    console.error('[dev] Runtime failed:', error.message);
  });
  runtime.once('exit', (code, signal) => {
    runtime = null;
    if (!closing && !building) {
      if (code === 0 && !signal) {
        console.log('[dev] Existing VOKO instance remains active; continuing to watch for source changes.');
      } else {
        console.error(`[dev] Runtime exited (${signal || code}). Waiting for a source change.`);
      }
    }
  });
}

async function rebuildAndRestart() {
  if (building || closing) {
    pending = !closing;
    return;
  }
  building = true;
  const files = [...changedFiles];
  changedFiles.clear();
  try {
    console.log(`[dev] Updating ${files.length} changed file${files.length === 1 ? '' : 's'}...`);
    await applyChanges(files);
    if (closing) return;
    await stopRuntime();
    if (closing) return;
    startRuntime(false);
    console.log('[dev] Runtime restarted.');
  } catch (error) {
    console.error('[dev] Update failed:', error.message);
  } finally {
    building = false;
    if ((pending || changedFiles.size > 0) && !closing) {
      pending = false;
      void rebuildAndRestart();
    }
  }
}

function scheduleRebuild(_eventType, filename) {
  if (closing || !filename) return;
  changedFiles.add(String(filename));
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    void rebuildAndRestart();
  }, DEBOUNCE_MS);
}

async function shutdown() {
  if (closing) return;
  closing = true;
  clearTimeout(debounceTimer);
  watcher?.close();
  while (building) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await stopRuntime();
  process.exit(0);
}

async function main() {
  if (buildIsCurrent()) {
    console.log('[dev] Build is current; skipping initial build.');
  } else {
    console.log('[dev] Build is missing or stale; running initial build...');
    await fullBuild();
  }
  // Only the initial dev startup may open the canonical Lite page.
  // Hot reloads always restart with --no-open.
  startRuntime(true);
  watcher = fs.watch(SOURCE_DIR, { recursive: true }, scheduleRebuild);
  console.log('[dev] Watching src/ for incremental changes. Press Ctrl+C to stop.');
}

process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });

main().catch((error) => {
  console.error('[dev] Startup failed:', error.message);
  process.exit(1);
});
