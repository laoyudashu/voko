#!/usr/bin/env node
/**
 * i18n-check.js — 字典 key 对齐检查（P7 硬化）
 *
 * 扫描 src/web + src/core 的 t('key')/T('key')/L('key') 调用，提取 used keys，
 * 对比 locales/zh + locales/en 字典，报：
 *   - missing in zh/en：代码用了但字典缺（页面会显示 key 字符串）
 *   - only in zh/en：两侧不对齐（一侧缺翻译）
 *   - unused：字典有但代码没用（visitor/cli/mcp/errors 等间接引用 namespace 会有，仅警告）
 *
 * 用法：node scripts/i18n-check.js   （CI 非零退出码 = 有缺失/不对齐）
 */
const fs = require('fs');
const path = require('path');

const LITE = path.join(__dirname, '..');
const localesDir = path.join(LITE, 'src', 'core', 'i18n', 'locales');
const namespaces = ['common', 'web', 'register', 'console', 'release', 'cli', 'mcp', 'visitor', 'db', 'errors', 'bug-report'];

function loadKeys(locale) {
  const keys = new Set();
  for (const ns of namespaces) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(localesDir, locale, ns + '.json'), 'utf8'));
      Object.keys(j).forEach(k => keys.add(k));
    } catch (_) {}
  }
  return keys;
}

const zhKeys = loadKeys('zh');
const enKeys = loadKeys('en');

// 收集待扫描文件：src/web/*.js + src/core/**/*.js（递归）
const files = [];
function walk(dir) {
  for (const f of fs.readdirSync(dir)) {
    if (f === 'i18n') continue; // 跳过 i18n 基础设施（client.js 注释含示例 t()）
    const fp = path.join(dir, f);
    const st = fs.statSync(fp);
    if (st.isDirectory()) walk(fp);
    else if (f.endsWith('.js') || f.endsWith('.ts')) files.push(fp);
  }
}
walk(path.join(LITE, 'src')); // 全部业务 .js（web/core/cli/mcp/server，跳过 i18n 基础设施）

const usedKeys = new Set();
const re = /\b[tTL]\(['"]([a-z][a-z0-9_]*\.[a-z0-9_.]+)['"]/g;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  let m;
  while ((m = re.exec(src))) { if (!m[1].endsWith('.')) usedKeys.add(m[1]); } // 跳过动态前缀（db.xxx. ）
}

const missZh = [...usedKeys].filter(k => !zhKeys.has(k)).sort();
const missEn = [...usedKeys].filter(k => !enKeys.has(k)).sort();
const onlyZh = [...zhKeys].filter(k => !enKeys.has(k)).sort();
const onlyEn = [...enKeys].filter(k => !zhKeys.has(k)).sort();
const unused = [...zhKeys].filter(k => !usedKeys.has(k)).sort();

console.log('scanned files:', files.length, '| used keys:', usedKeys.size, '| zh:', zhKeys.size, '| en:', enKeys.size);
const show = (title, arr, n = 40) => {
  console.log('\n=== ' + title + ' (' + arr.length + ') ===');
  arr.slice(0, n).forEach(k => console.log('  ' + k));
  if (arr.length > n) console.log('  ... +' + (arr.length - n) + ' more');
};
show('missing in zh', missZh);
show('missing in en', missEn);
show('only in zh (en 缺)', onlyZh);
show('only in en (zh 缺)', onlyEn);
show('unused (警告：visitor/cli/mcp/errors 等间接 namespace 会有)', unused);

const ok = missZh.length === 0 && missEn.length === 0 && onlyZh.length === 0 && onlyEn.length === 0;
console.log('\n' + (ok ? '✅ zh/en 对齐且代码用到的 key 都存在' : '⚠️ 有缺失/不对齐（unused 仅警告）'));
process.exit(ok ? 0 : 1);
