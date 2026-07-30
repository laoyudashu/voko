#!/usr/bin/env node
/**
 * 把 src/ 下的非 JS 资源文件（如 endpoints.json 和 i18n 字典）复制到构建目录。
 */
const fs = require('fs');
const path = require('path');

const sourceName = process.argv[2] || 'src';
const destinationName = process.argv[3] || 'build';
const SRC = path.join(__dirname, '..', sourceName);
const DIST = path.join(__dirname, '..', destinationName);
const ASSET_EXTS = new Set(['.json', '.html', '.txt']);

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

if (!fs.existsSync(DIST)) {
  console.warn(`[copy-assets] ${destinationName}/ 不存在，跳过`);
  process.exit(0);
}

let count = 0;
for (const file of walk(SRC)) {
  if (!ASSET_EXTS.has(path.extname(file))) continue; // .js 由 TypeScript 编译；.md 等不发布
  const rel = path.relative(SRC, file);
  const dest = path.join(DIST, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(file, dest);
  count++;
  console.log(`[copy-assets] ${rel}`);
}
console.log(`[copy-assets] 已复制 ${count} 个资源文件到 ${destinationName}/`);
