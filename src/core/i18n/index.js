/**
 * i18n/index.js — 轻量多语言核心
 *
 * 零依赖。设计要点：
 *   - t(key, params?, locale?)  查表 + {name} 插值 + 复数 + 回退（当前 locale → zh → 返回 key）
 *   - makeT(locale)             返回绑定 locale 的 (key,params)=>t，供 Express 的 req.t 使用
 *   - setLocale/getLocale       进程级默认 locale（CLI 启动一次，全进程共享）
 *   - detectWebLocale(req,res)  URL ?lang → Cookie → Accept-Language → 默认；命中 ?lang 时写 Cookie
 *   - detectCliLocale(argv,env) --lang → VOKO_LANG → LANG/LC_ALL → 默认
 *   - getClientBundle(locale)   浏览器端子集（供 SSR 注入 <script>）
 *
 * 两类 locale 必须分离：
 *   - 运营者（Web/CLI）：本模块的 setLocale / detectWebLocale
 *   - 访客（系统消息）：由调用方查 user_cache.locale 后传给 t(...,locale)，不走进程级默认
 *
 * 占位符语法：{name}（不用 ${name}，避免与 JS 模板字符串和 JSON 歧义）。
 * missing key：VOKO_I18N_DEBUG=1 时打 warn，否则静默返回 key 本身（保证页面不崩）。
 */

const { loadMergedDict, getClientBundle } = require('./loader');
const { pluralRule } = require('./plurals');

const DEFAULT_LOCALE = 'zh';
const SUPPORTED_LOCALES = ['zh', 'en', 'ja'];

let _currentLocale = DEFAULT_LOCALE;

function getLocale() { return _currentLocale; }

function setLocale(locale) {
  if (locale && SUPPORTED_LOCALES.includes(locale)) _currentLocale = locale;
}

/**
 * 翻译。
 * @param {string} key    dotted key，如 'errors.unknown' / 'web.payments.title'
 * @param {object} params 插值参数，如 { port: 3100 }；含 count 时触发复数
 * @param {string} locale 覆盖 locale（访客消息按访客 locale 渲染时用）；省略则用进程默认
 * @returns {string} 永远返回非空字符串
 */
function t(key, params, locale) {
  const loc = (locale && SUPPORTED_LOCALES.includes(locale)) ? locale : _currentLocale;
  const dict = loadMergedDict(loc);
  let val = dict[key];

  // 回退到 zh
  if (val == null && loc !== DEFAULT_LOCALE) {
    val = loadMergedDict(DEFAULT_LOCALE)[key];
  }
  if (val == null) {
    if (process.env.VOKO_I18N_DEBUG) console.warn('[i18n] missing key:', key);
    return key;
  }

  // 复数：值为 {one,other} 对象
  if (val && typeof val === 'object') {
    const branch = (params && 'count' in params) ? pluralRule(loc, params.count) : 'other';
    val = (val[branch] != null ? val[branch] : (val.other != null ? val.other : ''));
  }
  if (typeof val !== 'string') val = String(val);

  // 插值 {name}
  if (params) {
    val = val.replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? String(params[k]) : '{' + k + '}'));
  }
  return val;
}

/** 返回绑定 locale 的 t，避免每处都传 locale。 */
function makeT(locale) {
  const loc = (locale && SUPPORTED_LOCALES.includes(locale)) ? locale : DEFAULT_LOCALE;
  return (key, params) => t(key, params, loc);
}

// ── Cookie 解析（不装 cookie-parser，保持零依赖） ───────────────────
function parseCookie(header) {
  const out = Object.create(null);
  if (!header) return out;
  for (const pair of String(header).split(';')) {
    const i = pair.indexOf('=');
    if (i < 0) continue;
    const k = pair.slice(0, i).trim();
    let v = pair.slice(i + 1).trim();
    if (k && k !== '__proto__' && k !== 'prototype' && k !== 'constructor') {
      try { v = decodeURIComponent(v); } catch (_) {}
      // out has a null prototype and prototype-mutating property names are rejected above.
      out[k] = v;
    }
  }
  return out;
}

/**
 * Web locale 检测。优先级：?lang= → Cookie voko_lang → Accept-Language → 默认 zh。
 * 命中 ?lang 时同步写 Cookie（一年），让用户偏好持久化。
 */
function detectWebLocale(req, res) {
  const headers = (req && req.headers) || {};
  const query = req && req.query;

  // 1. ?lang=en
  const q = query && query.lang;
  if (q && SUPPORTED_LOCALES.includes(q)) {
    if (res && typeof res.setHeader === 'function') {
      res.setHeader('Set-Cookie', `voko_lang=${q}; Max-Age=31536000; Path=/; SameSite=Lax`);
    }
    return q;
  }
  // 2. Cookie
  const cookies = parseCookie(headers.cookie);
  if (cookies.voko_lang && SUPPORTED_LOCALES.includes(cookies.voko_lang)) return cookies.voko_lang;
  // 3. Accept-Language（只看首选项语种）
  const al = String(headers['accept-language'] || '');
  if (/^en/i.test(al)) return 'en';
  if (/^zh/i.test(al)) return 'zh';
  // 4. 默认
  return DEFAULT_LOCALE;
}

/**
 * CLI locale 检测。优先级：--lang → VOKO_LANG → LANG/LC_ALL/LC_MESSAGES → 默认 zh。
 * Windows 注册表读取 GetUserDefaultLocaleName 暂不支持（环境变量通常已由系统设好）。
 */
function detectCliLocale(argv, env) {
  argv = argv || [];
  env = env || {};
  // 1. --lang en
  const i = argv.indexOf('--lang');
  if (i >= 0 && argv[i + 1] && SUPPORTED_LOCALES.includes(argv[i + 1])) return argv[i + 1];
  // 2. VOKO_LANG
  if (env.VOKO_LANG && SUPPORTED_LOCALES.includes(env.VOKO_LANG)) return env.VOKO_LANG;
  // 3. POSIX 语言环境变量
  const langEnv = env.LC_ALL || env.LC_MESSAGES || env.LANG || '';
  const m = langEnv.match(/^(en|zh)[-_]/i);
  if (m) return m[1].toLowerCase();
  return DEFAULT_LOCALE;
}

// ── 系统消息可见前缀（messenger echo 识别 + 发送端 locale 化共用）──
// 设计：前缀本身按 locale 本地化（zh「【系统消息】」/ en「[System]」），识别层匹配
// 所有前缀变体。这样既绕开了 clientMsgNo（SDK 强制 Guid，不可预设）和 content 全文
// 匹配（有误判风险），又让英文访客看到 [System] 而非中文前缀。加语言时在此加一项即可。
const SYSTEM_MESSAGE_PREFIXES = { zh: '【系统消息】', en: '[System]' };
const SYSTEM_MESSAGE_PREFIX_LIST = Object.values(SYSTEM_MESSAGE_PREFIXES);

/** 收消息侧用：content 是否为系统消息（任一语言前缀开头）。 */
function isSystemMessageContent(content) {
  if (typeof content !== 'string') return false;
  const c = content.trim();
  return SYSTEM_MESSAGE_PREFIX_LIST.some(p => c.startsWith(p));
}

/** 发消息侧用：按 locale 取系统消息可见前缀（含尾部分隔：中文「】」自带分隔，英文加空格）。 */
function systemMessagePrefix(locale) {
  const p = SYSTEM_MESSAGE_PREFIXES[locale] || SYSTEM_MESSAGE_PREFIXES[DEFAULT_LOCALE];
  return p.endsWith('】') ? p : p + ' ';
}

module.exports = {
  t, makeT, setLocale, getLocale,
  detectWebLocale, detectCliLocale, getClientBundle,
  parseCookie,
  isSystemMessageContent, systemMessagePrefix, SYSTEM_MESSAGE_PREFIXES,
  SUPPORTED_LOCALES, DEFAULT_LOCALE,
};
