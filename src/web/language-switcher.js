const LANGUAGES = [
  { code: 'zh', label: '中文' },
  { code: 'en', label: 'English' },
];

function renderLanguageSwitcher(locale) {
  const current = LANGUAGES.some((item) => item.code === locale) ? locale : 'zh';
  const items = LANGUAGES.map((item) => {
    if (item.code === current) {
      return '<span aria-current="true">' + item.label + '</span>';
    }
    return '<a href="?lang=' + item.code + '" data-voko-lang="' + item.code + '" hreflang="' + item.code + '">' + item.label + '</a>';
  });
  return '<span data-voko-language-switcher="1">' + items.join(' <span aria-hidden="true">|</span> ') + '</span>'
    + '<script>(function(){if(window.__vokoLanguageSwitcher)return;window.__vokoLanguageSwitcher=1;'
    + 'var draftKey="voko.languageSwitchDraft";'
    + 'function safeField(el){var type=(el.type||"").toLowerCase(),name=(el.name||el.id||"").toLowerCase();'
    + 'return el.matches("input,textarea,select")&&!["password","file","hidden","submit","button"].includes(type)&&el.autocomplete!=="one-time-code"&&!/(password|passwd|code|token|secret|key)/.test(name)}'
    + 'function saveDraft(){try{var values=[];document.querySelectorAll("input,textarea,select").forEach(function(el,i){if(!safeField(el))return;values.push({i:i,id:el.id||"",name:el.name||"",type:el.type||"",value:el.value,checked:!!el.checked})});'
    + 'sessionStorage.setItem(draftKey,JSON.stringify({path:location.pathname,values:values}))}catch(_){}}'
    + 'function restoreDraft(){try{var d=JSON.parse(sessionStorage.getItem(draftKey)||"null");sessionStorage.removeItem(draftKey);if(!d||d.path!==location.pathname)return;'
    + 'var fields=document.querySelectorAll("input,textarea,select");d.values.forEach(function(v){var el=v.id?document.getElementById(v.id):fields[v.i];if(!el||!safeField(el))return;if(el.type==="checkbox"||el.type==="radio")el.checked=v.checked;else el.value=v.value})}catch(_){}}'
    + 'restoreDraft();'
    + 'document.addEventListener("click",function(e){var a=e.target.closest("[data-voko-lang]");if(!a)return;'
    + 'e.preventDefault();saveDraft();var u=new URL(location.href);u.searchParams.set("lang",a.dataset.vokoLang);location.href=u.toString()})})();</script>';
}

function renderLanguageFooter(locale, style) {
  const footerStyle = style || 'margin-top:20px;font-size:13px;color:#888;display:flex;justify-content:flex-end';
  return '<div class="info-bar" style="' + footerStyle + '">' + renderLanguageSwitcher(locale) + '</div>';
}

module.exports = { renderLanguageSwitcher, renderLanguageFooter };
