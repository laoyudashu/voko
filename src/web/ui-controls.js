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
.voko-command-inline{display:inline-flex;align-items:center;gap:2px;max-width:100%;white-space:nowrap;vertical-align:middle}.voko-command-inline code{min-width:0;max-width:calc(100% - 30px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.voko-command-inline .voko-copy-button{flex:none}.voko-command-inline.is-long{display:flex;width:100%;margin:6px 0}.voko-command-inline.is-long code{flex:0 1 auto}
.home-access-copy-item{width:100%;margin:0;padding:0;min-height:0;border:0;border-radius:0;background:transparent;color:inherit;font:inherit;cursor:pointer}
.home-access-copy-item:hover:not(:disabled){color:#1a73e8;background:transparent}
.home-access-copy-item:disabled{cursor:not-allowed}
.home-access-copy-item.is-copied{color:#168447}
.home-access-copy-item.is-copied .home-copy-action-icon{color:#168447;background:#edf9f1}
.voko-message-dialog{width:min(400px,calc(100vw - 32px));border:0;border-radius:14px;padding:0;color:#1a1a2e;box-shadow:0 18px 60px rgba(21,31,46,.28)}
.voko-message-dialog::backdrop{background:rgba(24,34,48,.48);backdrop-filter:blur(2px)}
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

function messageDialog(esc, closeLabel) {
  const e = esc || ((value) => String(value == null ? '' : value));
  return '<dialog id="voko-message-dialog" class="voko-message-dialog"><div style="padding:24px 26px 18px;text-align:center"><div style="display:flex;align-items:center;justify-content:center;width:44px;height:44px;margin:0 auto 12px;border-radius:50%;background:#e8f0fe;color:#1a73e8;font-size:22px;font-weight:800" aria-hidden="true">i</div><p data-role="voko-message-text" style="margin:0;color:#667085;font-size:14px;line-height:1.7;white-space:pre-wrap;word-break:break-word"></p></div><div style="display:flex;justify-content:flex-end;padding:12px 20px;background:#f7f9fc;border-top:1px solid #e8ebef"><button type="button" data-role="voko-message-close" class="btn-sm" style="margin:0">'+e(closeLabel||'OK')+'</button></div></dialog><script>(function(){var d=document.getElementById("voko-message-dialog");if(!d)return;window.showVokoMessage=function(text){d.querySelector("[data-role=voko-message-text]").textContent=String(text||"");d.showModal()};d.querySelector("[data-role=voko-message-close]").addEventListener("click",function(){d.close()});d.addEventListener("click",function(e){if(e.target===d)d.close()})})();</script>';
}

module.exports = { COPY_ICON, COPIED_ICON, UI_CONTROL_CSS, copyButton, copyControlScript, messageDialog };
