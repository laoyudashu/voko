/**
 * i18n/client.js — 浏览器端精简 t() + data-i18n DOM 扫描
 *
 * 双用：① 作为浏览器内联脚本（由 SSR 注入 <script>），读 window.__I18N__ / __LOCALE__；
 *      ② 作为 Node 模块 require（用于读取源码内联进页面）。
 *
 * 字典 bundle 由服务端 getClientBundle() 注入到 window.__I18N__（已含 zh 回退）。
 * 用法：
 *   - 静态文本：<span data-i18n="common.btn.ok">确定</span>（DOMContentLoaded 自动填充）
 *   - 动态文本：el.innerHTML = '<h2>' + t('console.conversations') + '</h2>'
 *   - placeholder：<input data-i18n-placeholder="common.placeholder.email">
 */
(function () {
  var DEFAULT_LOCALE = 'zh';

  function dict() { return (typeof window !== 'undefined' ? window.__I18N__ : null) || {}; }
  function locale() { return (typeof window !== 'undefined' ? window.__LOCALE__ : null) || DEFAULT_LOCALE; }

  function t(key, params) {
    var val = dict()[key];
    if (val == null) return key;
    // 复数
    if (val && typeof val === 'object') {
      var branch = (params && 'count' in params) ? (locale() === 'en' && Number(params.count) === 1 ? 'one' : 'other') : 'other';
      val = val[branch] != null ? val[branch] : (val.other != null ? val.other : '');
    }
    if (typeof val !== 'string') val = String(val);
    // 插值 {name}
    if (params) {
      val = val.replace(/\{(\w+)\}/g, function (_, k) {
        return params[k] != null ? params[k] : '{' + k + '}';
      });
    }
    return val;
  }

  function applyI18n(scope) {
    var root = scope || (typeof document !== 'undefined' ? document : null);
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
    });
  }

  var api = { t: t, applyI18n: applyI18n };

  if (typeof window !== 'undefined') {
    window.t = t;
    window.applyI18n = applyI18n;
    if (typeof document !== 'undefined') {
      document.addEventListener('DOMContentLoaded', function () { applyI18n(document); });
    }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
