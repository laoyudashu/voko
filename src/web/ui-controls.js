'use strict';

const COPY_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><rect x="9" y="9" width="10" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M15 9V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const COPIED_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path d="m5 12 4 4L19 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const UI_CONTROL_CSS = `
button,.btn{min-height:40px;padding:8px 18px;font-size:14px;line-height:1.4;border-radius:6px}
.btn-sm{min-height:32px;padding:5px 10px;font-size:13px;line-height:1.4;border-radius:6px}
.btn-xs{min-height:26px;padding:2px 7px;font-size:11px;line-height:1.4;border-radius:6px}
.voko-copy-button{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;min-width:28px;min-height:28px;margin:0;padding:0;border:0;border-radius:6px;background:transparent;color:#667085;cursor:pointer;transition:color .15s ease,background .15s ease,transform .15s ease}
.voko-copy-button:hover:not(:disabled){color:#1677e8;background:#f2f7ff;transform:none}
.voko-copy-button:focus-visible{outline:2px solid #84adff;outline-offset:1px}
.voko-copy-button.is-copied{color:#168447;background:#edf9f1;transform:scale(1.05)}
.voko-copy-button:disabled{opacity:.4;cursor:not-allowed}
.home-access-copy-item{width:100%;margin:0;padding:0;min-height:0;border:0;border-radius:0;background:transparent;color:inherit;font:inherit;cursor:pointer}
.home-access-copy-item:hover:not(:disabled){color:#1a73e8;background:transparent}
.home-access-copy-item:disabled{cursor:not-allowed}
.home-access-copy-item.is-copied{color:#168447}
.home-access-copy-item.is-copied .home-copy-action-icon{color:#168447;background:#edf9f1}
`;

function copyButton(options = {}) {
  const esc = options.esc || ((value) => String(value == null ? '' : value));
  const attrs = options.attrs ? ' ' + options.attrs : '';
  const className = options.className ? ' ' + options.className : '';
  const label = esc(options.label || 'Copy');
  return '<button type="button" class="voko-copy-button' + className + '" title="' + label + '" aria-label="' + label + '"' + attrs + '>' + COPY_ICON + '</button>';
}

function copyControlScript() {
  return '<script>(function(){if(window.__VOKO_COPY_READY__)return;window.__VOKO_COPY_READY__=true;var copyIcon='+JSON.stringify(COPY_ICON)+',copiedIcon='+JSON.stringify(COPIED_ICON)+';function fallback(value){var area=document.createElement("textarea");area.value=value;area.setAttribute("readonly","");area.style.position="fixed";area.style.opacity="0";document.body.appendChild(area);area.select();var ok=false;try{ok=document.execCommand("copy")}catch(_){}area.remove();return ok}window.vokoCopyText=async function(value,button){var ok=false;if(navigator.clipboard&&navigator.clipboard.writeText){try{await navigator.clipboard.writeText(String(value||""));ok=true}catch(_){}}if(!ok)ok=fallback(String(value||""));if(ok&&button){var iconSelector=button.getAttribute("data-voko-copy-icon-target"),icon=iconSelector?button.querySelector(iconSelector):button;if(!icon)icon=button;clearTimeout(button._vokoCopyTimer);icon.innerHTML=copiedIcon;button.classList.add("is-copied");button._vokoCopyTimer=setTimeout(function(){icon.innerHTML=copyIcon;button.classList.remove("is-copied")},1400)}return ok};document.addEventListener("click",function(event){var button=event.target.closest&&event.target.closest("[data-voko-copy-value],[data-voko-copy-target]");if(!button||button.disabled)return;var value=button.getAttribute("data-voko-copy-value");if(value===null){var target=document.querySelector(button.getAttribute("data-voko-copy-target"));value=target?("value" in target?target.value:target.textContent):""}window.vokoCopyText(value,button)})})();</script>';
}

module.exports = { COPY_ICON, COPIED_ICON, UI_CONTROL_CSS, copyButton, copyControlScript };
