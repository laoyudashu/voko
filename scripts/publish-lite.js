#!/usr/bin/env node
/**
 * publish-lite.js — 把 @voko/lite 发布到 OSS（自动升级的下载源）
 *
 * 流程（复用 package.json 的构建步骤，但不走 npm publish）：
 *   1. TypeScript 编译并复制运行时资源到 build
 *   2. npm pack 生成 voko-lite-<ver>.tgz（含 build）
 *   3. 上传 tgz + lite-latest.json 到 OSS（updates/lite/）
 *
 * OSS 凭证：环境变量 OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET（与 src/server/oss.js 一致）
 *
 * 仅在源仓库内运行（require 了未发布的 ../src/server/oss）。用法：
 *   node scripts/publish-lite.js            构建+上传
 *   node scripts/publish-lite.js --dry-run  只构建+打包，不上传
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const ENDPOINTS = require('../src/endpoints.json');

/**
 * OSS 凭证只允许通过发布环境变量提供，避免从运行时数据库读取长期密钥。
 */
function ensureOssCredentials() {
  if (!process.env.OSS_ACCESS_KEY_ID || !process.env.OSS_ACCESS_KEY_SECRET) {
    throw new Error('OSS_ACCESS_KEY_ID and OSS_ACCESS_KEY_SECRET are required');
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const pkgPath = path.join(ROOT, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  const version = pkg.version;
  console.log(`[publish-lite] 版本 ${version}，dryRun=${dryRun}`);

  // 1. TypeScript 编译 + 资源复制
  console.log('[publish-lite] 构建 src → build ...');
  execSync('npm run package:build', { cwd: ROOT, stdio: 'inherit' });

  // 2. package.json 始终指向 build，无需发布期间临时改写
  console.log('[publish-lite] npm pack ...');
  const out = execSync('npm pack --ignore-scripts', { cwd: ROOT, encoding: 'utf-8' }).trim();
  const tgzName = out.split('\n').pop().trim();
  console.log(`[publish-lite] 打包: ${tgzName}`);

  const tgzPath = path.join(ROOT, tgzName);
  const tgzBuffer = fs.readFileSync(tgzPath);
  const integrity = 'sha512-' + crypto.createHash('sha512').update(tgzBuffer).digest('base64');

  if (dryRun) {
    console.log('[publish-lite] --dry-run：跳过上传');
    console.log('  tgz:', tgzPath, `(${(tgzBuffer.length / 1024 / 1024).toFixed(1)} MB)`);
    console.log('  integrity:', integrity);
    try { fs.unlinkSync(tgzPath); } catch (_) {}
    return;
  }

  ensureOssCredentials();
  const { uploadToOSS } = require('../build/server/oss');

  // 3. 上传 tgz + manifest
  // OSS object key 必须含 baseUrl 的路径段（updates），公开 URL 才与 auto-updater
  // 读取的 baseUrl + 相对路径 一致。manifest.tarball 存相对 baseUrl 的路径。
  const UPDATE_PATH = new URL(ENDPOINTS.update.baseUrl).pathname.replace(/^\/+|\/+$/g, '') || 'updates';
  const tarballRel = `lite/${tgzName}`;
  const tarballKey = `${UPDATE_PATH}/${tarballRel}`;
  const manifestKey = `${UPDATE_PATH}/${(ENDPOINTS.update && ENDPOINTS.update.liteManifest) || 'lite/lite-latest.json'}`;
  console.log(`[publish-lite] 上传 ${tarballKey} ...`);
  await uploadToOSS(tarballKey, tgzBuffer, 'application/gzip');

  const manifest = {
    version,
    tarball: tarballRel,
    integrity,
    minNodeVersion: (pkg.engines && pkg.engines.node) || '>=22.5.0',
    publishedAt: Date.now(),
  };
  console.log(`[publish-lite] 上传 ${manifestKey} ...`);
  await uploadToOSS(manifestKey, JSON.stringify(manifest, null, 2), 'application/json');

  // 清理本地 tgz
  try { fs.unlinkSync(tgzPath); } catch (_) {}
  console.log(`[publish-lite] ✅ 发布完成：${version}`);
  console.log('  manifest:', JSON.stringify(manifest));
}

main().catch((e) => {
  console.error('[publish-lite] ❌ 失败:', e.message);
  process.exit(1);
});
