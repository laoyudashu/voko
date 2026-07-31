/**
 * i18n/loader.js — 字典加载与合并
 *
 * 纯 CommonJS，零依赖。字典为 JSON，按 namespace 分文件，启动时同步读取并
 * 合并为一张 flat dotted-key 表，按 locale 缓存。
 *
 * 目录结构：
 *   locales/zh/{common,web,register,console,cli,mcp,visitor,db,errors}.json
 *   locales/en/...
 *
 * 新增 namespace：在 NAMESPACES 加一项 + 建 zh/en 对应 JSON 即可。
 * 新增语言：建 locales/<lang>/ 目录，复制 zh/ 下 JSON 翻译。
 */

const fs = require('fs');
const path = require('path');

const LOCALES_DIR = path.join(__dirname, 'locales');

// 所有 namespace。加载时按此顺序合并（后者覆盖前者，但 key 不跨 namespace 重复，故顺序无关）。
const NAMESPACES = ['common', 'web', 'register', 'console', 'cli', 'mcp', 'visitor', 'db', 'errors', 'bug-report'];

// 浏览器端子集（避免把 web.json ~450 key 全塞给页面）
const CLIENT_NAMESPACES = ['common'];

const _cache = new Map(); // locale → merged flat dict

function _readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null; // 文件缺失或语法错（en 初期可能为空对象或不存在）→ 跳过
  }
}

/** 合并某 locale 下所有 namespace 为一张 flat 表（带缓存）。 */
function loadMergedDict(locale) {
  if (_cache.has(locale)) return _cache.get(locale);
  const merged = {};
  const dir = path.join(LOCALES_DIR, locale);
  for (const ns of NAMESPACES) {
    const json = _readJson(path.join(dir, ns + '.json'));
    if (json) Object.assign(merged, json);
  }
  _cache.set(locale, merged);
  return merged;
}

/**
 * 浏览器端 bundle：common 子集。
 * 非 zh 语言缺失的 key 回退到 zh（保证客户端永远能渲染出文本）。
 */
function getClientBundle(locale) {
  const merged = {};
  for (const ns of CLIENT_NAMESPACES) {
    const json = _readJson(path.join(LOCALES_DIR, locale, ns + '.json'));
    if (json) Object.assign(merged, json);
  }
  if (locale !== 'zh') {
    for (const ns of CLIENT_NAMESPACES) {
      const zhJson = _readJson(path.join(LOCALES_DIR, 'zh', ns + '.json'));
      if (zhJson) for (const k of Object.keys(zhJson)) if (!(k in merged)) merged[k] = zhJson[k];
    }
  }
  return merged;
}

/** 清除缓存（热更新 / 测试用）。 */
function clearCache() { _cache.clear(); }

module.exports = { loadMergedDict, getClientBundle, clearCache, NAMESPACES, CLIENT_NAMESPACES };
