#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PACKAGE_DIR = path.join(__dirname, '..');
const SOURCE_DIR = path.join(PACKAGE_DIR, 'src');
const BUILD_DIR = path.join(PACKAGE_DIR, 'build');
const LOCK_DIR = path.join(PACKAGE_DIR, '.build-lock');
const STAGE_DIR = path.join(PACKAGE_DIR, `.build-stage-${process.pid}-${Date.now()}`);
const ASSET_EXTS = new Set(['.json', '.html', '.txt', '.py']);
const LOCK_TIMEOUT_MS = 120_000;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock() {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(LOCK_DIR);
      fs.writeFileSync(
        path.join(LOCK_DIR, 'owner.json'),
        JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
      );
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const owner = JSON.parse(
          fs.readFileSync(path.join(LOCK_DIR, 'owner.json'), 'utf8'),
        );
        if (!isProcessAlive(owner.pid)) {
          fs.rmSync(LOCK_DIR, { recursive: true, force: true });
          continue;
        }
      } catch {
        const age = Date.now() - fs.statSync(LOCK_DIR).mtimeMs;
        if (age > LOCK_TIMEOUT_MS) {
          fs.rmSync(LOCK_DIR, { recursive: true, force: true });
          continue;
        }
      }
      sleep(100);
    }
  }
  throw new Error('等待另一个 Lite TypeScript 构建完成超时');
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

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: PACKAGE_DIR,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} 退出码 ${result.status}`);
  }
}

function validateStage() {
  const missing = [];
  for (const sourceFile of walkFiles(SOURCE_DIR)) {
    const relative = path.relative(SOURCE_DIR, sourceFile);
    const extension = path.extname(sourceFile);
    if (sourceFile.endsWith('.d.ts')) continue;
    if (extension === '.ts' || extension === '.js') {
      const output = path.join(STAGE_DIR, relative.slice(0, -extension.length) + '.js');
      if (!fs.existsSync(output)) missing.push(path.relative(STAGE_DIR, output));
    } else if (ASSET_EXTS.has(extension)) {
      const output = path.join(STAGE_DIR, relative);
      if (!fs.existsSync(output)) missing.push(relative);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Lite 构建产物不完整，缺少: ${missing.slice(0, 10).join(', ')}`);
  }
}

function promoteStage() {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  const stagedRelativePaths = new Set();
  for (const sourceFile of walkFiles(STAGE_DIR)) {
    const relative = path.relative(STAGE_DIR, sourceFile);
    stagedRelativePaths.add(relative.toLowerCase());
    const destination = path.join(BUILD_DIR, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.voko-next-${process.pid}`;
    fs.copyFileSync(sourceFile, temporary);
    try {
      fs.renameSync(temporary, destination);
    } catch {
      // Some Windows filesystem filters do not allow replace-on-rename.
      // The fallback still keeps the old file present until the final copy.
      fs.copyFileSync(temporary, destination);
      fs.rmSync(temporary, { force: true });
    }
  }

  // New files are installed before stale files are removed, so a running Lite
  // never observes the previous build being recursively deleted.
  for (const existingFile of walkFiles(BUILD_DIR)) {
    const relative = path.relative(BUILD_DIR, existingFile);
    if (!stagedRelativePaths.has(relative.toLowerCase())) {
      fs.rmSync(existingFile, { force: true });
    }
  }
}

function main() {
  acquireLock();
  try {
    fs.mkdirSync(STAGE_DIR, { recursive: true });
    const tscPath = require.resolve('typescript/bin/tsc');
    run(process.execPath, [tscPath, '--outDir', STAGE_DIR]);
    run(process.execPath, [
      path.join(__dirname, 'copy-assets.js'),
      'src',
      path.basename(STAGE_DIR),
    ]);
    validateStage();
    promoteStage();
    console.log('[build-ts] 完整构建已更新到 build/');
  } finally {
    fs.rmSync(STAGE_DIR, { recursive: true, force: true });
    fs.rmSync(LOCK_DIR, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error('[build-ts] 构建失败:', error instanceof Error ? error.message : error);
  process.exit(1);
}
