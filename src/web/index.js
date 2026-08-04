/**
 * VOKO Agent 网页版 — 最终架构
 *
 * 短页面 + 卡片导航网格 + 独立表单页，兼容截图 + HTML 树双模式。
 * 设计依据：AAG 规范、Agent-Friendly UX、Google Agent-Friendly Web
 */

const { Router } = require('express');
const { jsonForInlineScript } = require('./html-security');
const fs = require('fs');
const path = require('path');
const pkg = require('../../package.json');
const { createRegisterRouter } = require('./register');
const { createPaymentAuthRouter } = require('./payment-auth');
const { createGroupRouter } = require('./group');
const { rateLimit } = require('express-rate-limit');
const { MESSAGE_CONTENT_CSS, createMessageRenderer, messageLabels, messageRendererScript } = require('./message-content');
const { VOKO_API_URL } = require('../core/api-signature');
const { getCurrentUserEmail, getUserAccessToken } = require('../core/database');
const { getBackendTypes, getBackendTypeValues } = require('../core/agent-backend-types');
const { detectWebLocale, makeT, getClientBundle, SUPPORTED_LOCALES } = require('../core/i18n');
const { renderLanguageFooter, renderLanguageSwitcher } = require('./language-switcher');
const { renderSystemFooter } = require('./footer');
const ENDPOINTS = require('../endpoints.json');
const { normalizeOfficialPublicUrl } = require('../core/url-security');
const { refreshUserProfiles } = require('../core/user-profile-cache');
const { createRegistrationOrchestrator } = require('../core/registration-orchestrator');

// ═══════════════════════════════════════════════════════════════
//  CSS — 浅色 OCR 友好主题
// ═══════════════════════════════════════════════════════════════

const CSS = `@charset "UTF-8";*{box-sizing:border-box}body{font-family:'PingFang SC','Microsoft YaHei','Noto Sans SC','Hiragino Sans GB',sans-serif;background:#f5f7fa;color:#1a1a2e;margin:0;padding:20px;font-size:18px;line-height:1.7;max-width:1100px;margin-left:auto;margin-right:auto;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}a{color:#1a73e8;font-weight:600;padding:4px 2px;display:inline-block}h1{font-size:24px;border-bottom:3px solid #1a73e8;padding-bottom:8px;margin:0 0 10px 0}h2{font-size:20px;margin:18px 0 8px 0;color:#1a1a2e}h3{font-size:17px;margin:0 0 4px 0;color:#1a73e8}nav{font-size:14px;color:#666;margin-bottom:10px;padding:6px 0;border-bottom:1px solid #ddd}.table-wrap{width:100%;overflow-x:auto;margin:6px 0 12px 0}table{width:100%;min-width:500px;border-collapse:collapse;background:#fff;border-radius:6px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,0.06)}th,td{padding:10px 12px;text-align:left;border:1px solid #e0e0e0;font-size:15px;white-space:nowrap}th{background:#e8f0fe;font-weight:700;font-size:14px}tr:nth-child(even){background:#fafbfc}label{display:block;margin-top:10px;font-weight:700;font-size:15px;color:#1a1a2e}input,select,textarea{width:100%;max-width:460px;padding:10px 12px;margin-top:3px;background:#fff;color:#1a1a2e;border:2px solid #b0b0b0;border-radius:6px;font-size:16px;font-family:inherit;outline:none}input:focus,select:focus{border-color:#1a73e8;box-shadow:0 0 0 3px rgba(26,115,232,0.12)}button,.btn{display:inline-block;margin-top:10px;padding:10px 22px;min-width:100px;font-size:16px;font-weight:700;cursor:pointer;text-align:center;font-family:inherit;background:#1a73e8;color:#fff;border:2px solid #1557b0;border-radius:6px;text-decoration:none}button:hover{background:#1557b0}.btn-success{background:#0f9d58;border-color:#0b8043}.btn-success:hover{background:#0b8043}.btn-danger{background:#d93025;border-color:#b71c1c}.btn-danger:hover{background:#b71c1c}.online{color:#0f9d58;font-weight:700}.offline{color:#d93025;font-weight:700}.unknown{color:#888}.pending{color:#e37400;font-weight:600}.success{color:#0f9d58;font-weight:700;font-size:17px}.error{color:#d93025;font-weight:600}.meta{color:#888;font-size:14px}.card{background:#fff;border:1px solid #e0e0e0;border-radius:8px;padding:12px 16px;margin:10px 0;box-shadow:0 1px 2px rgba(0,0,0,0.04)}.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:13px;font-weight:700;border:1px solid}.badge-online{background:#e6f4ea;color:#0f9d58;border-color:#0f9d58}.badge-offline{background:#fce8e6;color:#d93025;border-color:#d93025}.badge-pending{background:#fef7e0;color:#e37400;border-color:#e37400}.info-bar{display:flex;flex-wrap:wrap;gap:6px 14px;background:#fff;border:1px solid #e0e0e0;border-radius:6px;padding:8px 12px;margin:0 0 10px 0;font-size:15px}.info-bar span{white-space:nowrap}.ops{display:grid;gap:8px;margin:6px 0 0 0;grid-template-columns:repeat(6,1fr)}@media(max-width:900px){.ops{grid-template-columns:repeat(4,1fr)}}@media(max-width:600px){.ops{grid-template-columns:repeat(3,1fr)}}@media(max-width:400px){.ops{grid-template-columns:repeat(2,1fr)}}.op-card{display:block;background:#fff;border:2px solid #e0e0e0;border-radius:8px;padding:10px 8px;text-align:center;text-decoration:none;color:#1a1a2e;font-weight:600;font-size:14px}.op-card:hover{border-color:#1a73e8;background:#e8f0fe}button.op-card{margin:0;min-width:0;width:100%}code{background:#f0f0f0;padding:1px 4px;border-radius:3px;font-size:14px}.info-line{margin:4px 0;font-size:15px}.info-line strong{display:inline-block;min-width:70px}.btn-sm{padding:8px 14px;min-width:auto;min-height:36px;font-size:14px;display:inline-block;margin:0;line-height:1.4}.btn-xs{padding:8px 14px;min-width:auto;min-height:36px;font-size:14px;font-weight:700;display:inline-block;margin:0;line-height:1.4;border-radius:4px;text-decoration:none}.btn-outline{background:#fff;color:#1a73e8;border-color:#1a73e8;text-decoration:none}.btn-outline:hover{background:#e8f0fe}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 16px}.form-grid .full{grid-column:1/-1}@media(max-width:700px){.form-grid{grid-template-columns:1fr}}.voko-select{position:relative;width:100%;max-width:460px}.voko-select-trigger{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;margin-top:3px;background:#fff;color:#1a1a2e;border:2px solid #b0b0b0;border-radius:6px;font-size:16px;font-family:inherit;cursor:pointer;user-select:none}.voko-select-trigger:focus{border-color:#1a73e8;box-shadow:0 0 0 3px rgba(26,115,232,0.12);outline:none}.voko-select-arrow{font-size:11px;color:#888;margin-left:8px}.voko-select-dropdown{display:none;position:absolute;top:100%;left:0;right:0;z-index:100;margin-top:4px;background:#fff;border:2px solid #b0b0b0;border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,0.12);overflow:hidden}.voko-select-search{width:100%;padding:10px 12px;margin:0;background:#fff;color:#1a1a2e;border:none;border-bottom:1px solid #e0e0e0;font-size:14px;font-family:inherit;outline:none;box-sizing:border-box}.voko-select-options{max-height:220px;overflow-y:auto;padding:4px 0}.voko-option{padding:9px 14px;font-size:15px;color:#1a1a2e;cursor:pointer}.voko-option:hover{background:#e8f0fe}.voko-option-empty{color:#999!important;cursor:default}`;

const EXTRA_CSS = `.audit-message{padding:10px 12px;margin:5px 0;border:1px solid #f0c7c3;border-left:4px solid #d93025;border-radius:7px;background:#fff8f7;font-size:14px}.audit-message-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.audit-message-result{padding:1px 7px;border-radius:9px;background:#fce8e6;color:#b3261e;font-size:12px;font-weight:700}.audit-message-row{margin-top:6px;color:#4d5156;word-break:break-word}.audit-message-row span{display:inline-block;min-width:72px;color:#7a828a}button:disabled{cursor:not-allowed;opacity:.55}.voko-spinner{display:inline-block;width:14px;height:14px;margin-right:7px;border:2px solid rgba(255,255,255,.45);border-top-color:#fff;border-radius:50%;vertical-align:-2px;animation:voko-spin .75s linear infinite}@keyframes voko-spin{to{transform:rotate(360deg)}}.edit-section-title{margin:8px 0 0;padding:0 0 7px;border-bottom:1px solid #e4e7ec;font-size:16px;font-weight:700;color:#344054}.voko-option-group{padding:7px 14px 4px;color:#667085;font-size:12px;font-weight:700;background:#f8fafc;cursor:default}.agent-icon-field{display:flex;align-items:center;gap:12px;margin-top:4px}.agent-icon-button{position:relative;width:84px;height:84px;min-width:84px;margin:0;padding:0;border:2px solid #d0d5dd;border-radius:16px;overflow:hidden;background:#f2f4f7}.agent-icon-button:hover,.agent-icon-button:focus{border-color:#1a73e8;background:#f2f4f7}.agent-icon-preview{display:block;width:100%;height:100%;object-fit:cover}.agent-icon-overlay{position:absolute;inset:auto 0 0;padding:3px 2px;background:rgba(0,0,0,.62);color:#fff;font-size:12px;line-height:1.4}.agent-icon-help{margin:0;max-width:350px}.agent-icon-status{display:block;margin-top:3px;font-size:13px}.agent-icon-status.success{font-size:13px}.agent-reauth-dialog{width:min(440px,calc(100% - 32px));padding:0;border:0;border-radius:14px;box-shadow:0 22px 70px rgba(15,23,42,.28)}.agent-reauth-dialog::backdrop{background:rgba(15,23,42,.48)}.agent-reauth-box{padding:24px}.agent-reauth-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.agent-reauth-head h2{margin:0;font-size:20px}.agent-reauth-close{min-width:0;margin:0;padding:3px 10px;background:#fff;color:#667085;border:0;font-size:22px}.agent-reauth-actions{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:12px}.agent-reauth-actions button{margin:0;min-width:0}.agent-reauth-message{margin-top:12px;padding:9px 11px;border-radius:8px;font-size:14px}.agent-reauth-message.error{background:#fce8e6}.agent-reauth-message.success{background:#e6f4ea}`+MESSAGE_CONTENT_CSS;

// ═══════════════════════════════════════════════════════════════
//  工具函数
// ═══════════════════════════════════════════════════════════════

function esc(s){return(s==null?'':String(s)).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}

function parseMultipartFile(req){
  const buf=req.rawBody;
  if(!Buffer.isBuffer(buf))return null;
  const contentType=String(req.headers['content-type']||'');
  const boundaryMatch=contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundary=boundaryMatch&&(boundaryMatch[1]||boundaryMatch[2]);
  if(!boundary)return null;
  const marker=Buffer.from('--'+boundary);
  let start=buf.indexOf(marker);
  while(start!==-1){
    const headerStart=start+marker.length+2;
    const headerEnd=buf.indexOf(Buffer.from('\r\n\r\n'),headerStart);
    if(headerEnd===-1)break;
    const headers=buf.subarray(headerStart,headerEnd).toString('utf8');
    if(/content-disposition:\s*form-data;/i.test(headers)&&/filename=/i.test(headers)){
      const bodyStart=headerEnd+4;
      const next=buf.indexOf(Buffer.from('\r\n--'+boundary),bodyStart);
      if(next===-1)return null;
      const nameMatch=headers.match(/filename="([^"]*)"/i);
      return{filename:nameMatch?nameMatch[1]:'upload',data:buf.subarray(bodyStart,next)};
    }
    start=buf.indexOf(marker,headerEnd+4);
  }
  return null;
}

function detectAgentIconType(data){
  if(!Buffer.isBuffer(data))return null;
  if(data.length>=8&&data.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))return{mime:'image/png',ext:'png'};
  if(data.length>=3&&data[0]===0xff&&data[1]===0xd8&&data[2]===0xff)return{mime:'image/jpeg',ext:'jpg'};
  if(data.length>=6&&['GIF87a','GIF89a'].includes(data.subarray(0,6).toString('ascii')))return{mime:'image/gif',ext:'gif'};
  if(data.length>=12&&data.subarray(0,4).toString('ascii')==='RIFF'&&data.subarray(8,12).toString('ascii')==='WEBP')return{mime:'image/webp',ext:'webp'};
  return null;
}

function h(s){return s||'-'}

function fmtTime(ts){
  if(!ts)return '';
  const d=typeof ts==='number'&&ts<1e12?new Date(ts*1000):new Date(ts);
  const p=n=>String(n).padStart(2,'0');
  return p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes())
}

function timeTag(ts){
  if(!ts)return'';
  const d=typeof ts==='number'&&ts<1e12?new Date(ts*1000):new Date(ts);
  const p=n=>String(n).padStart(2,'0');
  const iso=d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+'T'+p(d.getHours())+':'+p(d.getMinutes());
  const readable=p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes());
  return'<time datetime="'+iso+'">'+readable+'</time>'
}

function parseAuditContent(content){
  try{
    const data=JSON.parse(content);
    const direction=data.direction||(String(data.audit||'').includes('出站')?'outbound':'inbound');
    return{valid:true,direction,blocked:data.action==='hard_deny',keyword:data.keyword||'',text:data.text||''};
  }catch(_){return{valid:false,direction:'inbound',blocked:true,keyword:'',text:''};}
}

function renderAuditContent(content,tFn,timeHtml){
  const data=parseAuditContent(content);
  if(!data.valid)return'<div class="audit-message"><strong>'+esc(tFn('web.audit.message_invalid'))+'</strong>'+(timeHtml?' <span class="meta">'+timeHtml+'</span>':'')+'</div>';
  const title=tFn(data.direction==='outbound'?'web.audit.message_outbound':'web.audit.message_inbound');
  const result=tFn(data.blocked?'web.audit.message_blocked':'web.audit.message_allowed');
  const keyword=data.keyword?'<div class="audit-message-row"><span>'+esc(tFn('web.audit.message_keyword'))+'</span>'+esc(data.keyword)+'</div>':'';
  const original=data.text?'<div class="audit-message-row"><span>'+esc(tFn('web.audit.message_original'))+'</span>'+esc(data.text).replace(/\n/g,'<br>')+'</div>':'';
  return'<div class="audit-message"><div class="audit-message-head"><strong>'+esc(title)+'</strong><span class="audit-message-result">'+esc(result)+'</span>'+(timeHtml?'<span class="meta">'+timeHtml+'</span>':'')+'</div>'+keyword+original+'</div>';
}

function ajaxPaginationScript(){
  return '<script>(function(){var selections={};function remember(region){region.querySelectorAll("form").forEach(function(form){form.querySelectorAll("input[type=checkbox][name]:checked:not(:disabled)").forEach(function(input){var key=form.action+"|"+input.name;(selections[key]||(selections[key]=new Set())).add(input.value)})})}function restore(region){region.querySelectorAll("form").forEach(function(form){form.querySelectorAll("input[type=checkbox][name]:not(:disabled)").forEach(function(input){var picked=selections[form.action+"|"+input.name];if(picked&&picked.has(input.value))input.checked=true})})}document.addEventListener("click",function(event){var link=event.target.closest("a[href*=\\"page=\\" i]");if(!link||event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();var region=document.querySelector("main[data-voko-page-region]");if(!region)return location.assign(link.href);remember(region);region.setAttribute("aria-busy","true");fetch(link.href,{headers:{"X-Requested-With":"voko-pagination"}}).then(function(response){if(!response.ok)throw new Error("page request failed");return response.text()}).then(function(html){var next=new DOMParser().parseFromString(html,"text/html").querySelector("main[data-voko-page-region]");if(!next)throw new Error("page region missing");region.replaceWith(next);restore(next);history.pushState(null,"",link.href);next.scrollIntoView({block:"nearest"})}).catch(function(){location.assign(link.href)})});})();</script>'
}

function ajaxListFilterScript(){
  return '<script>(function(){document.addEventListener("submit",function(event){var form=event.target;if(form.tagName!=="FORM"||String(form.method).toLowerCase()!=="get"||!form.querySelector("[name=keyword],[name=q]"))return;var region=document.querySelector("main[data-voko-page-region]");if(!region)return;event.preventDefault();var url=new URL(form.action||location.href,location.origin),data=new FormData(form);data.forEach(function(value,key){if(value)url.searchParams.set(key,value);else url.searchParams.delete(key)});region.setAttribute("aria-busy","true");fetch(url,{headers:{"X-Requested-With":"voko-filter"}}).then(function(r){if(!r.ok)throw new Error("filter failed");return r.text()}).then(function(html){var next=new DOMParser().parseFromString(html,"text/html").querySelector("main[data-voko-page-region]");if(!next)throw new Error("filter region missing");region.replaceWith(next);history.pushState(null,"",url)}).catch(function(){location.assign(url)})})})();</script>'
}

function ajaxAccessListScript(){
  return '<script>(function(){function fail(form,message){var old=form.querySelector(".access-action-error");if(old)old.remove();var note=document.createElement("span");note.className="error access-action-error";note.style.marginLeft="8px";note.textContent=message||"Action failed";form.appendChild(note)}function refresh(){return fetch(location.href,{headers:{"X-Requested-With":"voko-access-list"}}).then(function(r){if(!r.ok)throw new Error("refresh failed");return r.text()}).then(function(html){var next=new DOMParser().parseFromString(html,"text/html").querySelector("main[data-voko-page-region]");var current=document.querySelector("main[data-voko-page-region]");if(!next||!current)throw new Error("refresh region missing");current.replaceWith(next)})}document.addEventListener("submit",function(event){var form=event.target.closest("form[data-voko-access-list]");if(!form)return;event.preventDefault();var button=form.querySelector("button[type=submit]");if(button)button.disabled=true;var data={};new FormData(form).forEach(function(value,key){data[key]=value});var url=new URL(form.action,location.origin);fetch("/api"+url.pathname+"/action",{method:"POST",headers:{"Content-Type":"application/json",Accept:"application/json"},body:JSON.stringify(data)}).then(function(r){return r.json().catch(function(){return{success:false,error:"Action failed"}})}).then(function(result){if(!result.success)throw new Error(result.error||"Action failed");return refresh()}).catch(function(err){fail(form,err.message)}).finally(function(){if(button)button.disabled=false})})})();</script>'
}

function page(title,body,opt={},tFn,locale){
  // P2 i18n：tFn/locale 由 renderPage(req,...) 传入；未改造路由不传 → 透传 k=>k，渲染行为不变
  const t=tFn||(k=>k);
  const loc=locale||'zh';
  const nav=opt.nav||('<a href="/">'+esc(t('common.nav.home'))+'</a>');
  // 客户端 bundle（common 子集，带 zh 回退）注入供 data-i18n 扫描 + window.t 用
  const i18nBoot='<script>window.__LOCALE__='+jsonForInlineScript(loc)+';window.__I18N__='+jsonForInlineScript(getClientBundle(loc))+'</script>';
  const jd=opt.jsonld?'\n<script type="application/ld+json">'+jsonForInlineScript(opt.jsonld)+'</script>':'';
  const msgBg=opt.msg?.warning?'#fff4ce':(opt.msg?.success?'#e6f4ea':'#fce8e6');
  const msgIcon=opt.msg?.warning?'⚠️ ':(opt.msg?.success?'✅ ':'❌ ');
  const msgStatus=opt.msg?.warning?'PotentialActionStatus':(opt.msg?.success?'CompletedSuccessfully':'Failed');
  const msg=opt.msg?'<div role="alert" style="padding:8px 14px;border-radius:6px;background:'+msgBg+';margin-bottom:10px;font-weight:600" data-agent-kind="status">'+msgIcon+esc(opt.msg.text)+'</div>\n<script type="application/ld+json">'+jsonForInlineScript({'@context':'https://schema.org','@type':'ActionStatusType',actionStatus:msgStatus,description:opt.msg.text})+'</script>':'';
  const st=opt.subtitle?' <span class="meta" style="font-size:14px;font-weight:400">('+esc(opt.subtitle)+')</span>':'';
  const ha=opt.headerAction||'';
  const h1=ha?'<h1 style="display:flex;justify-content:space-between;align-items:center"><span>'+esc(title)+st+'</span>'+ha+'</h1>':'<h1>'+esc(title)+st+'</h1>';
  let footer=opt.footer||'';
  if(!footer.includes('data-voko-language-switcher'))footer+=renderLanguageFooter(loc);
  const lang=loc==='en'?'en':(loc==='ja'?'ja':'zh-CN');
  return '<!DOCTYPE html>\n<html lang="'+lang+'">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width,initial-scale=1.0">\n<link rel="icon" href="/favicon.png">\n<title>VOKO — '+esc(title)+'</title>\n<style>'+CSS+EXTRA_CSS+'</style>\n'+i18nBoot+'\n</head>\n<body>\n<nav role="navigation" aria-label="'+esc(t('common.nav.aria_label'))+'">'+nav+'</nav>\n'+h1+'\n<main data-voko-page-region aria-live="polite" aria-label="'+esc(title)+'">'+msg+body+'</main>'+footer+jd+submitLockScript()+ajaxPaginationScript()+ajaxListFilterScript()+ajaxAccessListScript()+'\n</body>\n</html>'
}

function agentNav(aid,aname,tFn){const home=tFn?tFn('common.nav.home'):'首页';return'<a href="/">'+esc(home)+'</a> › <a href="/agents/'+esc(aid)+'">'+esc(aname||aid)+'</a>'}

/** 生成 POST 到 /agents/{id} 的表单 */
function actionForm(aid,action,fields,btn,cls,agentAction,submitLabel,formAttrs){
  const daa=agentAction||action;
  const lockAttrs=submitLabel?' data-submit-lock="1" data-submit-label="'+esc(submitLabel)+'"':'';
  let _af=fields.findIndex(f=>!f.val);if(_af<0)_af=0;const f=fields.map((fld,i)=>{const ff=i===_af?' autofocus':'';
    let h='<label for="'+fld.id+'">'+esc(fld.label)+'</label>';
    if(fld.type==='select'){
      h+='<select id=\"'+fld.id+'\" name=\"'+fld.name+'\" '+(fld.attr||'')+ff+'>';
      for(const[v,t]of Object.entries(fld.options))h+='<option value="'+esc(v)+'"'+(fld.val===v?' selected':'')+'>'+esc(t)+'</option>';
      h+='</select>'
    }else if(fld.type==='textarea'){
      h+='<textarea id=\"'+fld.id+'\" name=\"'+fld.name+'\" '+(fld.attr||'')+ff+'>'+(fld.val?esc(fld.val):'')+'</textarea>'
    }else{
      h+='<input type=\"'+fld.type+'\" id=\"'+fld.id+'\" name=\"'+fld.name+'\" value=\"'+(fld.val?esc(fld.val):'')+'\" '+(fld.attr||'')+ff+'>'
    }
    return h
  }).join('\n');
  return '<form method="POST" action="/agents/'+esc(aid)+'" data-agent-kind="action" data-agent-action="'+daa+'"'+lockAttrs+(formAttrs||'')+'>\n<input type="hidden" name="_action" value="'+action+'">\n'+f+'\n<button type="submit" class="'+(cls||'')+'" data-agent-kind="action" data-agent-action="'+daa+'.submit">'+esc(btn||'提交')+'</button>\n</form>'
}

/** 原生 POST 表单的同步提交锁；fetch 型入口仍在各自函数内用 try/finally 解锁。 */
function inviteConfirmUi(tFn,formSelector){
  const selector=JSON.stringify(formSelector);
  return '<dialog id="dlg-invite-confirm" style="border:none;border-radius:12px;padding:0;max-width:380px;width:calc(100% - 40px);box-shadow:0 12px 36px rgba(15,23,42,.18)">'
    +'<div style="padding:20px 22px 18px"><h3 style="margin:0 0 8px;font-size:18px">'+esc(tFn('web.invite.confirm_title'))+'</h3>'
    +'<p style="color:#667085;font-size:14px;line-height:1.65;margin:0 0 18px">'+esc(tFn('web.invite.confirm_message'))+'</p>'
    +'<form method="dialog" style="display:flex;gap:8px;justify-content:flex-end"><button class="btn-sm btn-outline" value="cancel" style="margin:0;padding:6px 16px;min-height:auto">'+esc(tFn('common.btn.cancel'))+'</button>'
    +'<button type="button" class="btn-sm" id="invite-confirm-submit" style="margin:0;padding:6px 16px;min-height:auto">'+esc(tFn('web.invite.confirm_btn'))+'</button></form></div></dialog>'
    +'<script>(function(){var f=document.querySelector('+selector+'),d=document.getElementById("dlg-invite-confirm"),ok=document.getElementById("invite-confirm-submit"),confirmed=false;if(!f||!d||!ok)return;f.addEventListener("submit",function(e){if(confirmed)return;e.preventDefault();e.stopImmediatePropagation();d.showModal()});ok.addEventListener("click",function(){confirmed=true;d.close();f.requestSubmit()})})();</script>';
}

function submitLockScript(){
  return '<script>(function(){'
    +'function reset(f){f.dataset.submitLocked="";f.removeAttribute("aria-busy");var bs=f.querySelectorAll(\'button[type="submit"],input[type="submit"]\');bs.forEach(function(b){if(b._vokoWasDisabled===false)b.disabled=false;b.removeAttribute("aria-busy");if(b.tagName==="INPUT"){if(b._vokoIdleValue!=null)b.value=b._vokoIdleValue}else if(b._vokoIdleHtml!=null)b.innerHTML=b._vokoIdleHtml})}'
    +'document.querySelectorAll("form[data-submit-lock]").forEach(function(f){f.addEventListener("submit",function(e){if(f.dataset.submitLocked==="1"){e.preventDefault();return false}if(!f.checkValidity())return;f.dataset.submitLocked="1";f.setAttribute("aria-busy","true");var bs=f.querySelectorAll(\'button[type="submit"],input[type="submit"]\'),label=f.dataset.submitLabel||"";bs.forEach(function(b,i){b._vokoWasDisabled=b.disabled;if(b.tagName==="INPUT")b._vokoIdleValue=b.value;else b._vokoIdleHtml=b.innerHTML;b.disabled=true;b.setAttribute("aria-busy","true");if(i===0&&label){if(b.tagName==="INPUT")b.value=label;else{b.textContent="";var s=document.createElement("span");s.className="voko-spinner";s.setAttribute("aria-hidden","true");b.appendChild(s);b.appendChild(document.createTextNode(label))}}});return true})});'
    +'window.addEventListener("pageshow",function(){document.querySelectorAll("form[data-submit-lock]").forEach(reset)});'
    +'})();</script>';
}

/** 判断是否为可被 /api/console 调用的 action（是函数 + 非 _ 前缀内部 helper） */
function isCallableAction(h,action){return typeof h[action]==='function' && !action.startsWith('_')}

/** 37 个 action 的分组映射，供 /llms.txt、/prompt、/api/handlers 共享，避免漂移 */
const ACTION_GROUPS=[
  {group:'im',actions:['whoami','send_message','get_chat_history','list_conversations','fetch_new_messages','mark_conversation_read','get_status','create_group','invite_to_group','accept_invitation','decline_invitation','get_group_members','get_group_context']},
  {group:'manage',actions:['get_agent_profile','update_agent_profile','set_agent_status','set_private_mode','manage_whitelist','manage_blacklist','list_access_lists','declare_capabilities','search_capabilities','start_worker','stop_worker']},
  {group:'pay',actions:['agent_pricing','create_payment','check_payments','add_payment_auth','list_payment_auth','delete_payment_auth','apply_payment_auth','refresh_payment_auth','search_banks','bind_agent_payment_auth']},
  {group:'audit',actions:['list_audit_rules','manage_audit_rules']},
  {group:'human',actions:['ask_human_for_help','check_human_replies','close_human_request']},
  {group:'misc',actions:['register_agent','verify_agent_email','get_visitor_profile','upload_and_send_file','invite_friend']},
];
function listActions(group){if(group==='all')return ACTION_GROUPS.flatMap(g=>g.actions);const g=ACTION_GROUPS.find(x=>x.group===group);return g?g.actions:[]}
const GROUP_LABELS={zh:{im:'收发消息',manage:'Agent 管理',pay:'支付',audit:'审核',human:'人工介入',misc:'其他'},en:{im:'Messaging',manage:'Agent Management',pay:'Payments',audit:'Audit',human:'Human Intervention',misc:'Other'}};

/** HTTP 表单动作 → handler action 显式映射（manifest 用；纯数据 handler 无专属表单，不在此列） */
const FORM_ACTIONS=[
  {name:'message.send',path:'/messages/send',danger:'low'},
  {name:'agent.profile.update',path:'/agents/{id}',danger:'low'},
  {name:'agent.status.set',path:'/agents/{id}',danger:'low'},
  {name:'whitelist.add',path:'/agents/{id}',danger:'low'},
  {name:'blacklist.add',path:'/agents/{id}',danger:'medium'},
  {name:'access.mode.set',path:'/agents/{id}',danger:'low'},
  {name:'agent.pricing.set',path:'/agents/{id}',danger:'low'},
  {name:'agent.caps.declare',path:'/agents/{id}',danger:'low'},
  {name:'agent.invite.send',path:'/agents/{id}',danger:'low'},
  {name:'human.ask',path:'/agents/{id}',danger:'low'},
  {name:'file.send',path:'/api/agents/{id}/send-file',danger:'low'},
  {name:'payment.create',path:'/payments',danger:'medium'},
  {name:'payment.auth.manage',path:'/payment-auth',danger:'medium'},
  {name:'audit.rule.manage',path:'/audit-rules',danger:'low'},
  {name:'agent.register',path:'/register',danger:'low'},
];
let _manifestCache={};

const DEEP_LINKS_ZH=[{intent:'回复某访客的最新消息',template:'/agents/{agentId}/c/{visitorId}?action=reply&focus=1',params:{agentId:'Agent ID',visitorId:'访客 IM UID'}},{intent:'查看聊天历史',template:'/agents/{agentId}/c/{visitorId}',params:{agentId:'Agent ID',visitorId:'访客 IM UID'}},{intent:'查看某访客资料',template:'/agents/{agentId}/visitor?uid={visitorId}',params:{agentId:'Agent ID',visitorId:'访客 UID'}},{intent:'加白名单',template:'/agents/{agentId}/whitelist?visitorId={visitorId}',params:{agentId:'Agent ID',visitorId:'访客 UID'}},{intent:'拉黑访客',template:'/agents/{agentId}/blacklist?visitorId={visitorId}',params:{agentId:'Agent ID',visitorId:'访客 UID'}},{intent:'创建支付订单',template:'/payments?action=create&agentId={agentId}&visitorId={visitorId}',params:{agentId:'Agent ID',visitorId:'访客 UID'}},{intent:'查看已支付订单',template:'/payments?status=1'},{intent:'搜索审核规则',template:'/audit-rules?q={keyword}',params:{keyword:'搜索词'}},{intent:'查看人工介入列表',template:'/interventions?q={keyword}',params:{keyword:'搜索词（可选）'}},{intent:'发送消息给某访客',template:'/send-message?agentId={agentId}&toUid={visitorId}',params:{agentId:'Agent ID',visitorId:'访客 UID'}}];
const DEEP_LINKS_EN=[{intent:'Reply to a visitor\'s latest message',template:'/agents/{agentId}/c/{visitorId}?action=reply&focus=1',params:{agentId:'Agent ID',visitorId:'Visitor IM UID'}},{intent:'View chat history',template:'/agents/{agentId}/c/{visitorId}',params:{agentId:'Agent ID',visitorId:'Visitor IM UID'}},{intent:'View visitor profile',template:'/agents/{agentId}/visitor?uid={visitorId}',params:{agentId:'Agent ID',visitorId:'Visitor UID'}},{intent:'Add to whitelist',template:'/agents/{agentId}/whitelist?visitorId={visitorId}',params:{agentId:'Agent ID',visitorId:'Visitor UID'}},{intent:'Block visitor',template:'/agents/{agentId}/blacklist?visitorId={visitorId}',params:{agentId:'Agent ID',visitorId:'Visitor UID'}},{intent:'Create payment order',template:'/payments?action=create&agentId={agentId}&visitorId={visitorId}',params:{agentId:'Agent ID',visitorId:'Visitor UID'}},{intent:'View paid orders',template:'/payments?status=1'},{intent:'Search audit rules',template:'/audit-rules?q={keyword}',params:{keyword:'Search keyword'}},{intent:'View intervention list',template:'/interventions?q={keyword}',params:{keyword:'Search keyword (optional)'}},{intent:'Send message to visitor',template:'/send-message?agentId={agentId}&toUid={visitorId}',params:{agentId:'Agent ID',visitorId:'Visitor UID'}}];
const GUIDE_DESC_ZH='任意页加 ?guide=1 顶部显示可见操作指导清单（编号与 ?som=1 徽章同源），服务视觉/VLM agent；元素 agent 可直接读 JSON-LD';
const GUIDE_DESC_EN='Add ?guide=1 to any page to show a visible action guide at the top (numbers match ?som=1 badges); designed for vision/VLM agents; element agents can read JSON-LD directly';

function getManifestSync(locale='zh'){
  if(_manifestCache[locale])return _manifestCache[locale];
  const isEn=SUPPORTED_LOCALES.includes(locale)&&locale==='en';
  const guideDesc=isEn?GUIDE_DESC_EN:GUIDE_DESC_ZH;
  const deepLinks=isEn?DEEP_LINKS_EN:DEEP_LINKS_ZH;
  _manifestCache[locale]={
    name:'VOKO LITE',description:'IM interface for AI agents',version:pkg.version,entrypoint:'/',
    capabilities:{
      browse:{methods:['GET'],paths:['/','/register','/agents/{id}','/agents/{id}/c/{uid}','/agents/{id}/edit','/agents/{id}/status','/agents/{id}/whitelist','/agents/{id}/blacklist','/agents/{id}/access-mode','/agents/{id}/pricing','/agents/{id}/caps','/agents/{id}/human','/interventions','/audit-rules','/payments','/payment-auth','/send-message','/capabilities']},
      act:{methods:['POST'],actions:FORM_ACTIONS},
      json:{console:'/api/console',hint:'POST with Accept: application/json or ?json=1 returns pure JSON'},
      guest:{bugReport:'/api/bug-report'},
      mcp:{endpoint:'/mcp',toolListMethod:'tools/list'},
      guide:{param:'?guide=1',somParam:'?som=1',combo:'?guide=1&som=1',description:guideDesc}
    },
    discovery:{llmsTxt:'/llms.txt',prompt:'/prompt',handlers:'/api/handlers',sitemap:'/sitemap.xml',robots:'/robots.txt'},
    deepLinks
  };
  return _manifestCache[locale];
}

async function getAgentList(h){const d=await h.whoami({});return d.agents||[]}
async function getAgentInfo(h,id){const a=await getAgentList(h);return a.find(x=>x.agentId===id)||null}
async function getAgentStatus(h,id){
  try{const s=await h.get_status({agentId:id});return s}catch{return{agent:{imConnected:false,imStatus:'unknown',backendConnected:false},warnings:[]}}
}

/** 渲染操作表单页（GET） */
function renderFormPage(title,agentId,agentName,formHtml,tFn,locale){
  const nm=agentName||agentId;
  const back=tFn?tFn('common.btn.back_to_agent',{name:esc(nm)}):('← 返回 '+esc(nm));
  return page(title,'<div class="card">'+formHtml+'</div><p><a href="/agents/'+esc(agentId)+'">'+back+'</a></p>',{nav:agentNav(agentId,agentName,tFn)},tFn,locale)
}

function actionReturnPath(req) {
  const fallback='/agents/'+encodeURIComponent(req.params.agentId);
  const candidates=[req.body&&req.body.returnTo,req.get('Referer')];
  for(const candidate of candidates){
    if(!candidate)continue;
    try{
      const url=new URL(candidate,'http://localhost');
      const match=url.pathname.match(/^\/agents\/([^/]+)(?:\/|$)/);
      if(match&&decodeURIComponent(match[1])===String(req.params.agentId))
        return url.pathname+url.search;
    }catch{}
  }
  return fallback;
}

function actionResultLocation(path,key,message) {
  return path+(path.includes('?')?'&':'?')+key+'='+encodeURIComponent(message);
}

/** 处理操作 POST：调用 handler，重定向回来源页 */
async function handleAction(req,res,handler,successKey){
  try{
    const r=await handler;
    const back=actionReturnPath(req);
    if(r.success!==false&&r.error===undefined){
      const syncWarnings=Array.isArray(r.syncWarnings)?r.syncWarnings.filter(v=>typeof v==='string'&&v):[];
      if(syncWarnings.length)
        res.redirect(actionResultLocation(back,'warn',req.t('web.agent.access_sync_partial',{reason:syncWarnings.join('；')})));
      else
        res.redirect(actionResultLocation(back,'ok',req.t(successKey)));
    }
    else
      res.redirect(actionResultLocation(back,'err',r.error||req.t('common.action.failed')))
  }catch(e){
    const back2=actionReturnPath(req);
    res.redirect(actionResultLocation(back2,'err',e.message))
  }
}

// ═══════════════════════════════════════════════════════════════
//  路由
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
//  WebSocket 实时更新脚本（首页 Agent 连接状态）
// ═══════════════════════════════════════════════════════════════

function agentWsScript(t) {
  const i18nObj = {
    online: t('common.status.online'),
    offline: t('common.status.offline'),
    copied: t('common.home.copied'),
    failed: t('common.action.failed'),
    gen_creating: t('common.home.gen_creating'),
    gen: t('common.btn.generate_link'),
    gen_failed: t('common.home.gen_failed'),
    processing: t('common.home.processing'),
    wl_add: t('common.wl.add'),
    wl_remove: t('common.wl.remove'),
    bl_add: t('common.bl.add'),
    bl_remove: t('common.bl.remove'),
    remove_prefix: t('common.home.remove_prefix'),
    confirm_remove: t('common.home.confirm_remove'),
    confirm_delete_audit: t('common.home.confirm_delete_audit'),
    submitting: t('common.home.submitting'),
    success: t('common.home.success'),
    submit: t('common.home.submit'),
    status_ok: t('common.footer.status_ok'),
    status_im_down: t('common.footer.status_im_down'),
    status_init: t('common.footer.status_init'),
  };
  return `<script>
var I = ${JSON.stringify(i18nObj)};
var pendingShortLinkButton=null;
function generateShortLink(t){var aid3=t.dataset.agent;t.disabled=true;t.textContent=I.gen_creating;fetch("/api/short-link/create",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({agentId:aid3})}).then(function(r){return r.json()}).then(function(d){if(d.success){location.reload()}else{t.disabled=false;t.textContent=I.gen;var m=document.getElementById("toast-msg");if(m)m.textContent=I.gen_failed;var d2=document.getElementById("dlg-toast");if(d2)d2.showModal()}}).catch(function(){t.disabled=false;t.textContent=I.gen})}
(function(){
  var ws = null;
  function connectWS() {
    try {
      ws = new WebSocket("ws://" + location.host + "/ws");
      ws.onmessage = function(e) {
        try {
          var d = JSON.parse(e.data);
          if (d.event === "agent-wukongim:status") {
            var link = document.querySelector('a[href="/agents/' + d.data.agentId + '"]');
            if (link) {
              var cell = link.closest("tr").querySelectorAll("td")[1];
              if (cell) {
                cell.innerHTML = d.data.imConnected
                  ? '<span class="online">'+I.online+'</span>'
                  : '<span class="offline">'+I.offline+'</span>';
              }
            }
          }
          if (d.event === "runtime:updated") {
            var s = document.getElementById("footer-status-text");
            if (s && d.data.statusKey) {
              var texts = {
                'common.footer.status_ok': I.status_ok,
                'common.footer.status_im_down': I.status_im_down,
                'common.footer.status_init': I.status_init
              };
              var text = texts[d.data.statusKey] || '...';
              s.textContent = text;
              s.style.color = d.data.statusColor || '#888';
            }
          }
        } catch(_) {}
      };
      ws.onclose = function() { setTimeout(connectWS, 3000); };
    } catch(_) { setTimeout(connectWS, 5000); }
  }
  connectWS();
})();
document.addEventListener("click",function(e){var t=e.target;
 if(t.matches("[data-role=logout-btn]")){var d=document.getElementById("dlg-logout");if(d)d.showModal()}
 else if(t.matches("[data-role=confirm-gen-link]")){var b=pendingShortLinkButton;pendingShortLinkButton=null;var sd=document.getElementById("dlg-short-link-security");if(sd)sd.close();if(b)generateShortLink(b)}
 else if(t.matches("[data-role=copy-link]")){navigator.clipboard.writeText(t.dataset.url).then(function(){var m=document.getElementById("toast-msg");if(m)m.textContent=I.copied;var d2=document.getElementById("dlg-toast");if(d2)d2.showModal()}).catch(function(){})}
 else if(t.matches("[data-role=toggle-pub]")){var s=t;var aid=s.dataset.agent;var isPub=s.dataset.pubStatus==="published";s.style.pointerEvents="none";s.style.opacity="0.5";fetch("/api/agents/"+aid+"/status",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:isPub?0:1})}).then(function(r){return r.json()}).then(function(d){if(d.success){s.textContent=d.label;s.className=d.cls;s.title=isPub?d.titleUnpub:d.titlePub;s.dataset.pubStatus=d.pubStatus}else{var m=document.getElementById("toast-msg");if(m)m.textContent=d.error||I.failed;var d2=document.getElementById("dlg-toast");if(d2)d2.showModal()}}).catch(function(e){var m=document.getElementById("toast-msg");if(m)m.textContent=e.message;var d2=document.getElementById("dlg-toast");if(d2)d2.showModal()}).finally(function(){s.style.pointerEvents="";s.style.opacity=""})}
 else if(t.matches("[data-role=toggle-acc]")){var s=t;var aid=s.dataset.agent;var isPriv=s.dataset.accMode==="private";s.style.pointerEvents="none";s.style.opacity="0.5";fetch("/api/agents/"+aid+"/access-mode",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({enabled:!isPriv})}).then(function(r){return r.json()}).then(function(d){if(d.success){s.textContent=d.label;s.className=d.cls;s.title=isPriv?d.titlePub:d.titlePriv;s.dataset.accMode=d.accMode}else{var m=document.getElementById("toast-msg");if(m)m.textContent=d.error||I.failed;var d2=document.getElementById("dlg-toast");if(d2)d2.showModal()}}).catch(function(e){var m=document.getElementById("toast-msg");if(m)m.textContent=e.message;var d2=document.getElementById("dlg-toast");if(d2)d2.showModal()}).finally(function(){s.style.pointerEvents="";s.style.opacity=""})}
 else if(t.matches("[data-role=gen-link]")){pendingShortLinkButton=t;var sd=document.getElementById("dlg-short-link-security");if(sd)sd.showModal()}
else if(t.matches("[data-role=wl-toggle]")||t.matches("[data-role=bl-toggle]")){var s=t;var isRemove=s.textContent.trim().indexOf(I.remove_prefix)===0;var role=s.dataset.role;var listType=role==="wl-toggle"?"whitelist":"blacklist";var act=isRemove?"remove_"+listType:"add_"+listType;var addLabel=role==="wl-toggle"?I.wl_add:I.bl_add;var removeLabel=role==="wl-toggle"?I.wl_remove:I.bl_remove;s.disabled=true;s.textContent=I.processing;fetch("/api/agents/"+s.dataset.agent+"/action",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({_action:act,visitorId:s.dataset.visitor})}).then(function(r){return r.json()}).then(function(d){if(d.success){s.textContent=isRemove?addLabel:removeLabel}else{var m=document.getElementById("toast-msg");if(m)m.textContent=d.error||I.failed;var d2=document.getElementById("dlg-toast");if(d2)d2.showModal()}}).catch(function(e){var m=document.getElementById("toast-msg");if(m)m.textContent=e.message;var d2=document.getElementById("dlg-toast");if(d2)d2.showModal()}).finally(function(){s.disabled=false})}
else if(t.matches("[data-role=wl-remove]")||t.matches("[data-role=bl-remove]")){var s=t;var role2=s.dataset.role;var listType2=role2==="wl-remove"?"whitelist":"blacklist";var act2="remove_"+listType2;if(!confirm(I.confirm_remove))return;s.disabled=true;var row=s.closest("tr");fetch("/api/agents/"+s.dataset.agent+"/action",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({_action:act2,visitorId:s.dataset.visitor})}).then(function(r){return r.json()}).then(function(d){if(d.success&&row)row.remove();else{var m=document.getElementById("toast-msg");if(m)m.textContent=d.error||I.failed;var d2=document.getElementById("dlg-toast");if(d2)d2.showModal()}}).catch(function(e){var m=document.getElementById("toast-msg");if(m)m.textContent=e.message;var d2=document.getElementById("dlg-toast");if(d2)d2.showModal()}).finally(function(){s.disabled=false})}
else if(t.matches("[data-role=audit-delete]")){var s=t;if(!confirm(I.confirm_delete_audit))return;s.disabled=true;var row2=s.closest("tr");fetch("/api/audit-rules/"+s.dataset.ruleId+"/delete",{method:"POST"}).then(function(r){return r.json()}).then(function(d){if(d.success&&row2)row2.remove();else{var m=document.getElementById("toast-msg");if(m)m.textContent=d.error||I.failed;var d2=document.getElementById("dlg-toast");if(d2)d2.showModal()}}).catch(function(e){var m=document.getElementById("toast-msg");if(m)m.textContent=e.message;var d2=document.getElementById("dlg-toast");if(d2)d2.showModal()}).finally(function(){s.disabled=false})}
});
document.addEventListener("submit",function(e){var f=e.target.closest("form[data-ajax]");if(!f)return;e.preventDefault();var btn=f.querySelector("button[type=submit]");if(btn){btn.disabled=true;btn.textContent=I.submitting}var fd=new FormData(f);var body={};fd.forEach(function(v,k){body[k]=v});var url=f.action||f.dataset.action;fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(function(r){return r.json()}).then(function(d){if(d.success){var el=document.getElementById(f.dataset.resultId||"ajax-result");if(el){el.className="alert alert-success";el.textContent=d.message||I.success}else{var m=document.getElementById("toast-msg");if(m)m.textContent=d.message||I.success;var d2=document.getElementById("dlg-toast");if(d2)d2.showModal()}if(f.dataset.reload==="true"){setTimeout(function(){location.reload()},800)}}else{var el=document.getElementById(f.dataset.resultId||"ajax-result");if(el){el.className="alert alert-error";el.textContent=d.error||I.failed}else{var m=document.getElementById("toast-msg");if(m)m.textContent=d.error||I.failed;var d2=document.getElementById("dlg-toast");if(d2)d2.showModal()}}}).catch(function(e){var m=document.getElementById("toast-msg");if(m)m.textContent=e.message;var d2=document.getElementById("dlg-toast");if(d2)d2.showModal()}).finally(function(){if(btn){btn.disabled=false;btn.textContent=btn.dataset.origText||I.submit}})});
function ajaxRowRemove(url,body,row){fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(function(r){return r.json()}).then(function(d){if(d.success){row.remove()}else{var m=document.getElementById("toast-msg");if(m)m.textContent=d.error||I.failed;var d2=document.getElementById("dlg-toast");if(d2)d2.showModal()}}).catch(function(e){var m=document.getElementById("toast-msg");if(m)m.textContent=e.message;var d2=document.getElementById("dlg-toast");if(d2)d2.showModal()})}
</script>`;
}

function createWebRouter(handlers, db, opts={}){
  const R=Router();
  R.use(rateLimit({
    windowMs: 60 * 1000,
    limit: 300,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { success: false, error: 'Too many requests' },
  }));
  const currentOwnerEmail=()=>{
    try{
      const selected=db.prepare("SELECT data FROM config WHERE type='current_user_email'").get();
      const email=String(selected?.data?JSON.parse(selected.data):'').trim().toLowerCase();
      if(email)return email;
    }catch(_){}
    try{
      const tokenRow=db.prepare("SELECT data FROM config WHERE type='user_access_token'").get();
      const tokenMap=tokenRow&&tokenRow.data?JSON.parse(tokenRow.data):{};
      return Object.entries(tokenMap).sort((a,b)=>(b[1]?.updated_at||0)-(a[1]?.updated_at||0))[0]?.[0]?.trim().toLowerCase()||'';
    }catch(_){return ''}
  };
  const requireSensitiveLocalAuth=(req,res,next)=>{
    const supplied=String(req.get('x-voko-token')||req.get('authorization')||'').replace(/^Bearer\s+/i,'');
    if(opts.localAuthToken&&supplied===opts.localAuthToken){req.localAuth={type:'instance'};return next()}
    const session=opts.webSessions&&opts.webSessions.resolveRequest(req);
    if(session){req.localAuth={type:'web',...session};return next()}
    if((req.get('accept')||'').includes('application/json')||req.query.json==='1')return res.status(401).json({success:false,error:'Unauthorized'});
    return res.redirect('/login');
  };
  const requireSensitiveCsrf=(req,res,next)=>{
    if(req.localAuth?.type==='instance')return next();
    if(opts.webSessions&&opts.webSessions.verifyCsrf(req,req.localAuth))return next();
    return res.status(403).json({success:false,error:'Invalid CSRF token'});
  };
  R.use((req,res,next)=>{
    const pathMatch=String(req.path||'').match(/^\/agents?\/([^/]+)/);
    const agentId=String((req.body&&req.body.agentId)||(req.query&&req.query.agentId)||(req.params&&req.params.agentId)||(pathMatch&&pathMatch[1])||'').trim();
    if(!agentId)return next();
    try{
      const row=db.prepare('SELECT owner_email FROM agents WHERE agent_id=? LIMIT 1').get(agentId);
      if(!row||!row.owner_email)return next();
      const current=String(currentOwnerEmail()).trim().toLowerCase();
      if(current&&current===String(row.owner_email).trim().toLowerCase())return next();
      return res.status(403).send('Forbidden');
    }catch(_){return res.status(500).send('Unable to verify Agent ownership')}
  });
  const refreshProfiles=typeof opts.refreshUserProfiles==='function'
    ? opts.refreshUserProfiles
    : uids=>refreshUserProfiles(db,uids);

  // locale 检测 + 注入 req.t / req.locale（每请求按 ?lang → Cookie → Accept-Language 决定）
  // P0 兼容期：路由暂未消费 req.t（不改任何渲染行为，页面仍中文）；P2 SSR 试点起逐步接 req.t
  R.use((req, res, next) => {
    req.locale = detectWebLocale(req, res);
    req.t = makeT(req.locale);
    next();
  });

  const publicMutationPath=(pathname)=>pathname==='/login'||pathname==='/reauth'||pathname==='/bug-report'||pathname==='/api/bug-report'||pathname==='/register'||pathname.startsWith('/api/login/')||pathname.startsWith('/api/agent-registration')||pathname.startsWith('/join/');
  const sensitiveMutation=(req)=>!['GET','HEAD','OPTIONS'].includes(String(req.method||'GET').toUpperCase())&&!publicMutationPath(String(req.path||''));
  const webAuthFailure=(res,status,error)=>res.status(status).json({success:false,code:'WEB_AUTH_REQUIRED',error});

  // 所有 Web 写操作共用本地会话和 CSRF 边界；实例令牌仍供 CLI/MCP 使用。
  R.use((req,res,next)=>{
    if(!sensitiveMutation(req)||!opts.webSessions)return next();
    const supplied=String(req.get('x-voko-token')||req.get('authorization')||'').replace(/^Bearer\s+/i,'');
    if(opts.localAuthToken&&supplied===opts.localAuthToken){req.localAuth={type:'instance'};return next()}
    const session=opts.webSessions.resolveRequest(req);
    if(!session)return webAuthFailure(res,401,req.t('web.reauth.required'));
    req.localAuth={type:'web',...session};
    if(!opts.webSessions.verifyCsrf(req,req.localAuth))return webAuthFailure(res,403,req.t('web.reauth.required'));
    next();
  });

  function webAuthorizationUi(req){
    if(['/login','/bug-report'].includes(String(req.path||'')))return'';
    const T=req.t,L=k=>esc(T(k));
    const email=currentOwnerEmail();
    const css='<style>.voko-auth-dialog{width:min(440px,calc(100% - 32px));padding:0;border:0;border-radius:14px;box-shadow:0 22px 70px rgba(15,23,42,.28)}.voko-auth-dialog::backdrop{background:rgba(15,23,42,.48)}.voko-auth-box{padding:24px}.voko-auth-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.voko-auth-head h2{margin:0;font-size:20px;border:0}.voko-auth-close{min-width:0;margin:0;padding:3px 10px;background:#fff;color:#667085;border:0;font-size:22px}.voko-auth-actions{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:12px}.voko-auth-actions button{margin:0;min-width:0}.voko-auth-message{margin-top:12px;padding:9px 11px;border-radius:8px;font-size:14px}.voko-auth-message.error{background:#fce8e6;color:#b42318}.voko-auth-message.success{background:#e6f4ea;color:#0f7b45}</style>';
    const html='<dialog id="voko-auth-dialog" class="voko-auth-dialog"><div class="voko-auth-box"><div class="voko-auth-head"><h2>'+L('web.reauth.title')+'</h2><button type="button" id="voko-auth-close" class="voko-auth-close" aria-label="'+L('common.btn.close')+'">×</button></div><p class="meta" style="margin:5px 0 12px">'+L('web.reauth.desc')+'</p><div id="voko-auth-fields"><label for="voko-auth-email">'+L('register.login.email')+'</label><input type="email" id="voko-auth-email" value="'+esc(email)+'" autocomplete="email"><label for="voko-auth-code">'+L('register.login.code')+'</label><input type="text" id="voko-auth-code" maxlength="6" autocomplete="one-time-code" placeholder="'+L('register.login.code_ph')+'"><div class="voko-auth-actions"><button type="button" class="btn-outline" id="voko-auth-send">'+L('register.login.send_code')+'</button><button type="button" class="btn-success" id="voko-auth-verify">'+L('web.reauth.verify')+'</button></div></div><div id="voko-auth-message" class="voko-auth-message" hidden aria-live="polite"></div></div></dialog>';
    const script='<script>(function(){var nativeFetch=window.fetch.bind(window),dlg=document.getElementById("voko-auth-dialog"),email=document.getElementById("voko-auth-email"),code=document.getElementById("voko-auth-code"),send=document.getElementById("voko-auth-send"),verify=document.getElementById("voko-auth-verify"),close=document.getElementById("voko-auth-close"),message=document.getElementById("voko-auth-message"),fields=document.getElementById("voko-auth-fields"),pending=null;function cookie(name){var p=name+"=",x=document.cookie.split(";").map(function(v){return v.trim()}).find(function(v){return v.indexOf(p)===0});return x?decodeURIComponent(x.slice(p.length)):""}function publicPath(path){return path==="/login"||path==="/reauth"||path==="/bug-report"||path==="/api/bug-report"||path==="/register"||path.indexOf("/api/login/")===0||path.indexOf("/api/agent-registration")===0||path.indexOf("/join/")===0}function isSensitive(url,init){var u=new URL(url,location.href),method=String((init&&init.method)||"GET").toUpperCase();return u.origin===location.origin&&["GET","HEAD","OPTIONS"].indexOf(method)===-1&&!publicPath(u.pathname)}function showMessage(text,kind){message.hidden=false;message.textContent=text;message.className="voko-auth-message "+kind}function authorize(){if(pending)return pending;fields.hidden=false;message.hidden=true;code.value="";dlg.showModal();code.focus();pending=new Promise(function(resolve,reject){dlg._resolve=resolve;dlg._reject=reject});return pending}async function authPost(action){var r=await nativeFetch("/reauth",{method:"POST",headers:{"Accept":"application/json","Content-Type":"application/json"},body:JSON.stringify({action:action,email:email.value.trim(),code:code.value.trim()})}),j=await r.json();if(!r.ok||!j.success)throw new Error(j.error||'+JSON.stringify(T('common.action.failed'))+');return j}close.addEventListener("click",function(){dlg.close();if(dlg._reject)dlg._reject(new Error('+JSON.stringify(T('web.reauth.cancelled'))+'));pending=null});send.addEventListener("click",async function(){send.disabled=true;try{await authPost("sendCode");showMessage('+JSON.stringify(T('web.reauth.code_sent'))+',"success");code.focus()}catch(e){showMessage(e.message,"error")}finally{send.disabled=false}});verify.addEventListener("click",async function(){verify.disabled=true;try{await authPost("verify");fields.hidden=true;showMessage("✓ "+'+JSON.stringify(T('web.reauth.success'))+',"success");setTimeout(function(){dlg.close();var done=dlg._resolve;pending=null;if(done)done()},700)}catch(e){showMessage(e.message,"error")}finally{verify.disabled=false}});code.addEventListener("keydown",function(e){if(e.key==="Enter")verify.click()});window.fetch=async function(input,init){var requestUrl=typeof input==="string"?input:input.url,options=Object.assign({},init||{});if(!isSensitive(requestUrl,options))return nativeFetch(input,options);options.headers=new Headers(options.headers||{});options.headers.set("X-VOKO-CSRF",cookie("voko_csrf"));options.headers.set("Accept",options.headers.get("Accept")||"application/json");var response=await nativeFetch(input,options);if((response.status===401||response.status===403)&&((await response.clone().json().catch(function(){return{}})).code==="WEB_AUTH_REQUIRED")){await authorize();options.headers.set("X-VOKO-CSRF",cookie("voko_csrf"));response=await nativeFetch(input,options)}return response};document.addEventListener("submit",async function(event){var form=event.target;if(!(form instanceof HTMLFormElement)||event.defaultPrevented||String(form.method).toUpperCase()!=="POST"||form.method==="dialog")return;var url=new URL(form.action||location.href,location.href);if(url.origin!==location.origin||publicPath(url.pathname))return;event.preventDefault();var data=new FormData(form);if(event.submitter&&event.submitter.name)data.append(event.submitter.name,event.submitter.value);var body=form.enctype==="multipart/form-data"?data:new URLSearchParams(Array.from(data.entries()).map(function(x){return[x[0],String(x[1])] }));try{var response=await window.fetch(url.href,{method:"POST",body:body});if(response.redirected){location.assign(response.url);return}var type=response.headers.get("content-type")||"";if(type.indexOf("text/html")!==-1){document.open();document.write(await response.text());document.close();return}var result=await response.json().catch(function(){return{}});if(result.success)location.reload();else throw new Error(result.error||'+JSON.stringify(T('common.action.failed'))+')}catch(e){if(e&&e.message!=='+JSON.stringify(T('web.reauth.cancelled'))+')window.alert(e.message||'+JSON.stringify(T('common.action.failed'))+')}})})();</'+'script>';
    return css+html+script;
  }

  // 把公共授权 UI 注入所有 VOKO HTML 页面，包括子路由渲染的群聊和支付页面。
  R.use((req,res,next)=>{
    const send=res.send.bind(res);
    res.send=(body)=>{
      if(typeof body==='string'&&body.includes('</body>'))body=body.replace('</body>',webAuthorizationUi(req)+'</body>');
      return send(body);
    };
    next();
  });

  // ?som=1 视觉编号 + ?guide=1 操作指导（可组合 ?guide=1&som=1）
  // 编号与指导清单同源（都按 DOM 顺序扫 [data-agent-action]）：视觉 agent 看 guide 懂语义、看 SoM 徽章定位
  const SOM_CSS='body.som-mode{counter-reset:som}body.som-mode [data-agent-action]{counter-increment:som;position:relative}body.som-mode [data-agent-action]::before{content:counter(som);position:absolute;top:-9px;left:-9px;background:#d93025;color:#fff;width:24px;height:24px;border-radius:50%;font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:center;z-index:9999;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5)}';
  const GUIDE_CSS='.agent-guide{background:#fff8e1;border:2px solid #f9a825;border-radius:8px;padding:12px 16px;margin:0 0 14px 0;font-size:14px}.agent-guide h3{margin:0 0 6px;color:#e65100;font-size:15px}.agent-guide p{margin:2px 0}.agent-guide ol{margin:4px 0 6px 18px;padding:0;line-height:1.8}.agent-guide ol li code{background:#fff3cd;padding:1px 4px;border-radius:3px;font-size:12px;color:#b25400}.agent-guide .ag-num{display:inline-block;min-width:22px;font-weight:700;color:#d93025}.agent-guide .ag-hint{font-size:12px;color:#666;margin-top:8px;border-top:1px dashed #e0c107;padding-top:6px;line-height:1.7}';
  /** 扫描页面 [data-agent-action] 元素，按 DOM 顺序生成"编号→动作"清单（编号与 ?som=1 徽章同源） */
  function buildGuide(html,withSom,tFn){
    const t=tFn||(k=>k);
    const re=/data-agent-action="([^"]+)"[^>]*>([^<]*)/g;
    const items=[];let m;
    while((m=re.exec(html))){items.push({action:m[1],text:(m[2]||'').trim()})}
    const list=items.map((it,i)=>'<li><span class="ag-num">'+(i+1)+'</span> '+(it.text?esc(it.text)+' <code>'+esc(it.action)+'</code>':'<code>'+esc(it.action)+'</code>')+'</li>').join('');
    const hint='<div class="ag-hint">'
      +(withSom?'':t('web.guide.hint_visual')+'<br>')
      +t('web.guide.hint_data')+'<br>'
      +t('web.guide.hint_deeplink')+'</div>';
    return '<div class="agent-guide" data-agent-kind="guide"><h3>'+t('web.guide.title')+'</h3>'
      +(items.length?'<p>'+t('web.guide.has_actions')+'</p><ol>'+list+'</ol>':'<p>'+t('web.guide.no_actions')+'</p>')
      +hint+'</div>';
  }
  R.use((req,res,next)=>{
    // 不在此处强制设 Content-Type: text/html —— 会污染 res.json() 端点（express 仅在未设时设 application/json）。
    // HTML 路由 res.send(html) 自动 text/html；JSON 路由 res.json() 自动 application/json。som/guide 模式见下。
    const som=req.query.som==='1';
    const guide=req.query.guide==='1';
    if(som||guide){
      const orig=res.send.bind(res);
      res.send=(h)=>{
        if(typeof h==='string'){
          let css='';
          if(som)css+=SOM_CSS;
          if(guide)css+=GUIDE_CSS;
          if(css)h=h.replace('</head>','<style>'+css+'</style></head>');
          if(som)h=h.replace('<body>','<body class="som-mode">');
          if(guide){const g=buildGuide(h,som,req.t);h=h.replace(/<main[^>]*>/,m=>m+g)}
        }
        return orig(h);
      };
    }
    next();
  });

  // ── SSR i18n 渲染入口：路由用 renderPage(req,...) 即自动带 req.t/req.locale ──
  function renderPage(req,title,body,opt){
    const options=opt||{};
    return page(title,body,{...options,footer:options.footer===undefined?renderFooter(req.t,req.locale):options.footer},req.t,req.locale);
  }

  // ── 页脚：运行时信息 ──
  function renderFooter(tFn, locale){
    return renderSystemFooter(db,tFn,locale);
    /* Legacy implementation retained below for this release. */
    const t=tFn||(k=>k);
    const langSwitcher=renderLanguageSwitcher(locale);
    const bugLink='<a href="/bug-report" style="font-size:13px">'+esc(t('web.bug_report.link'))+'</a>';
    try{if(!db)return '<div style="display:flex;justify-content:flex-end;gap:14px;align-items:center;margin-top:20px">'+bugLink+langSwitcher+'</div>';
      const rt=db.prepare("SELECT data FROM config WHERE type='runtime'").get();
      if(!rt)return '<div style="display:flex;justify-content:flex-end;gap:14px;align-items:center;margin-top:20px">'+bugLink+langSwitcher+'</div>';
      const d=JSON.parse(rt.data);
      let updateNotice='';
      try{const ur=db.prepare("SELECT data FROM config WHERE type='update_status'").get();const u=ur&&ur.data?JSON.parse(ur.data):null;if(u&&u.updateAvailable&&u.latestVersion){updateNotice=' <span style="color:#b45309;font-weight:700">'+esc(t('common.footer.update_available',{version:u.latestVersion}))+'</span>'}}catch{}
      // 运行状态
      let statusKey='common.footer.status_init',statusColor='#888';
      if(d.agents&&d.agents.length){
        const imDown=d.agents.some(a=>a.imConnected===false);
        if(imDown){statusKey='common.footer.status_im_down';statusColor='#d93025';}
        else{statusKey='common.footer.status_ok';statusColor='#0f9d58';}
      }
      return '<div class="info-bar" style="margin-top:20px;font-size:13px;color:#888;display:flex;justify-content:space-between;align-items:center">'
        +'<span>'
        +'<span>版本：V'+esc(pkg.version)+'</span>'
        +updateNotice
        +(d.port?' <span>'+esc(t('common.footer.port'))+': '+esc(d.port)+'</span>':'')
        +' <span>PID: '+esc(d.pid||'')+'</span>'
        +' <span>'+esc(t('common.footer.status'))+': <span id="footer-status-text" style="color:'+statusColor+';font-weight:700">'+esc(t(statusKey))+'</span></span>'
        +'</span>'
        +'<span style="display:flex;gap:14px;align-items:center">'+bugLink+langSwitcher+'</span>'
        +'</div>';
    }catch{return '<div style="display:flex;justify-content:flex-end;gap:14px;align-items:center;margin-top:20px">'+bugLink+langSwitcher+'</div>'}
  }

  function renderAgentFormPage(title,agentId,agentName,formHtml,tFn,locale,opt){
    const back=esc(tFn('common.btn.back_to_agent',{name:agentName}));
    return page(title,'<div class="card">'+formHtml+'</div><p><a href="/agents/'+esc(agentId)+'">'+back+'</a></p>',{...(opt||{}),nav:agentNav(agentId,agentName,tFn),footer:renderFooter(tFn,locale)},tFn,locale);
  }

  // ────────── favicon ──────────

  R.get('/favicon.png', (req, res) => {
    const ico = require('path').join(__dirname, '..', '..', 'assets', 'voko-icon.png');
    if (require('fs').existsSync(ico)) res.type('image/png').send(require('fs').readFileSync(ico));
    else res.status(404).end();
  });
  R.get('/favicon.ico', (req, res) => res.redirect('/favicon.png'));

  function bugReportForm(T, values={}){
    const L=k=>esc(T(k));
    const severity=values.severity||'medium';
    let currentEmail='';
    try{currentEmail=getCurrentUserEmail(db)||''}catch{}
    const typeOptions=['<option value="">'+L('web.bug_report.agent_type_unknown')+'</option>'];
    try{for(const item of getBackendTypes(db)){typeOptions.push('<option value="'+esc(item.value)+'"'+(values.agentType===item.value?' selected':'')+'>'+esc(item.label||item.value)+'</option>')}}catch{}
    return '<p class="meta" style="margin:0 0 14px;max-width:720px">'+L('web.bug_report.intro')+'</p>'
      +'<form method="POST" action="/bug-report" class="card" style="padding:18px 20px;max-width:760px" data-submit-lock="1" data-submit-label="'+L('common.home.submitting')+'"><input type="hidden" name="action" value="submit">'
      +'<div class="form-grid"><div class="full"><label for="br-title">'+L('web.bug_report.field.title')+' *</label><input id="br-title" name="title" maxlength="160" required value="'+esc(values.title||'')+'" style="max-width:none"></div>'
      +'<div class="full"><label for="br-description">'+L('web.bug_report.field.description')+' *</label><textarea id="br-description" name="description" maxlength="8000" rows="4" required style="max-width:none">'+esc(values.description||'')+'</textarea></div>'
      +'<div class="full"><label for="br-owner-email">'+L('web.bug_report.field.email')+'</label><input id="br-owner-email" name="ownerEmail" type="email" maxlength="254" value="'+esc(currentEmail||values.ownerEmail||'')+'" autocomplete="email" style="max-width:none"'+(currentEmail?' readonly':'')+'><p class="meta" style="margin:4px 0 0">'+L('web.bug_report.field.email_help')+'</p></div>'
      +'<div><label for="br-severity">'+L('web.bug_report.field.severity')+' *</label><select id="br-severity" name="severity">'
      +['low','medium','high','critical'].map(v=>'<option value="'+v+'"'+(severity===v?' selected':'')+'>'+L('web.bug_report.severity.'+v)+'</option>').join('')+'</select></div>'
      +'<div><label for="br-agent-type">'+L('web.bug_report.field.agent_type')+'</label><select id="br-agent-type" name="agentType">'+typeOptions.join('')+'</select></div></div>'
      +'<details style="margin-top:14px;border-top:1px solid #e4e7ec;padding-top:12px"><summary style="cursor:pointer;color:#1a73e8;font-weight:700;font-size:14px">'+L('web.bug_report.optional_details')+'</summary>'
      +'<div class="form-grid" style="margin-top:8px"><div class="full"><label for="br-steps">'+L('web.bug_report.field.steps')+'</label><textarea id="br-steps" name="steps" maxlength="4000" rows="3" style="max-width:none">'+esc(values.steps||'')+'</textarea></div>'
      +'<div><label for="br-expected">'+L('web.bug_report.field.expected')+'</label><textarea id="br-expected" name="expected" maxlength="2000" rows="2">'+esc(values.expected||'')+'</textarea></div>'
      +'<div><label for="br-actual">'+L('web.bug_report.field.actual')+'</label><textarea id="br-actual" name="actual" maxlength="2000" rows="2">'+esc(values.actual||'')+'</textarea></div></div></details>'
      +'<button type="submit" style="margin-top:16px">'+L('web.bug_report.submit')+'</button></form>';
  }

  function bugHistoryView(T, result){
    const L=k=>esc(T(k));
    if(!result)return '<p class="meta">'+L('web.bug_report.loading_history')+'</p>';
    if(result.success===false)return '<div class="card"><p class="error">'+esc(result.error||T('common.action.failed'))+'</p></div>';
    const data=result.data||result;
    const reports=Array.isArray(data.reports)?data.reports:(Array.isArray(data.items)?data.items:(Array.isArray(data.bugs)?data.bugs:[]));
    if(!reports.length)return '<div class="card"><p class="meta">'+L('web.bug_report.no_history')+'</p></div>';
    return '<div style="display:grid;gap:12px">'+reports.map(report=>{
      const replies=Array.isArray(report.replies)?report.replies:(report.developerReply||report.developer_reply?[{content:report.developerReply||report.developer_reply}]:[]);
      return '<section class="card" style="padding:18px 20px;max-width:760px">'
        +'<div class="form-grid"><div class="full"><label>'+L('web.bug_report.field.title')+'</label><div>'+esc(report.title||'-')+'</div></div>'
        +'<div><label>'+L('web.bug_report.status')+'</label><div>'+esc(report.status||'pending')+'</div></div>'
        +'<div><label>'+L('web.bug_report.submitted_at')+'</label><div>'+esc(fmtTime(report.createdAt||report.created_at)||'-')+'</div></div>'
        +'<div class="full"><label>'+L('web.bug_report.field.description')+'</label><div style="white-space:pre-wrap">'+esc(report.description||'-')+'</div></div>'
        +'<div class="full"><label>'+L('web.bug_report.developer_reply')+'</label>'
        +(replies.length?replies.map(r=>'<div style="white-space:pre-wrap;border-top:1px solid #eee;padding:8px 0">'+esc(r.content||r.reply||r.message||'')+'</div>').join(''):'<p class="meta">'+L('web.bug_report.no_reply')+'</p>')
        +'</div></div></section>'}).join('')+'</div>';
  }

  function bugReportPage(T,{active='submit',submitValues={},queryResult=''}={}){
    const L=k=>esc(T(k));
    const tabScript='<script>(function(){document.querySelectorAll("[data-bug-tab]").forEach(function(b){b.addEventListener("click",function(){var u=new URL(location.href);if(b.dataset.bugTab==="query")u.searchParams.set("view","query");else u.searchParams.delete("view");location.assign(u)})})})();</script>';
    const tabBtn=(id,label,on)=>'<button type="button" role="tab" data-bug-tab="'+id+'" aria-selected="'+(on?'true':'false')+'" style="background:transparent;border:none;border-bottom:3px solid '+(on?'#1a73e8':'transparent')+';color:'+(on?'#1a73e8':'#666')+';font:inherit;font-size:16px;font-weight:'+(on?'700':'600')+';padding:10px 20px;margin-bottom:-2px;cursor:pointer">'+label+'</button>';
    return '<div role="tablist" aria-label="'+L('web.bug_report.title')+'" style="display:flex;gap:4px;border-bottom:2px solid #e0e0e0;margin-bottom:14px">'
      +tabBtn('submit',L('web.bug_report.submit_tab'),active==='submit')+tabBtn('query',L('web.bug_report.query_tab'),active==='query')+'</div>'
      +'<section role="tabpanel" data-bug-panel="submit"'+(active==='submit'?'':' hidden')+'>'+bugReportForm(T,submitValues)+'</section>'
      +'<section role="tabpanel" data-bug-panel="query"'+(active==='query'?'':' hidden')+'>'+queryResult+'</section>'+tabScript;
  }

  R.get('/bug-report',async(req,res,next)=>{
    try{
      const T=req.t,active=req.query.view==='query'?'query':'submit';
      const history=active==='query'?await handlers.bug_report({action:'query',source:'web'}):null;
      const body=bugReportPage(T,{active,queryResult:active==='query'?bugHistoryView(T,history):''});
      res.send(renderPage(req,T('web.bug_report.title'),body,{footer:renderFooter(T,req.locale)}));
    }catch(e){next(e)}
  });

  // Guest JSON API: bug reports intentionally do not require a VOKO login.
  R.post('/api/bug-report',async(req,res,next)=>{
    try{
      const result=await handlers.bug_report({...req.body,source:'guest-api'});
      res.status(result?.success===false?400:200).json(result);
    }catch(e){next(e)}
  });

  R.post('/bug-report',async(req,res,next)=>{
    try{
      const T=req.t,L=k=>esc(T(k));
      const action='submit';
      const result=await handlers.bug_report({...req.body,action,source:'web'});
      if(!result?.success){
        const body=bugReportPage(T,{active:action,submitValues:req.body});
        return res.send(renderPage(req,T('web.bug_report.title'),body,{msg:{text:result?.error||T('common.action.failed')},footer:renderFooter(T,req.locale)}));
      }
      let body;
      if(action==='submit'){
        body='<div class="card" style="max-width:680px;padding:22px 24px"><p class="success" style="font-size:20px;margin-top:0">'+L('web.bug_report.submit_success')+'</p>'
          +'<p class="meta">'+L('web.bug_report.auto_history')+'</p>'
          +'<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:18px"><a class="btn" href="/bug-report?view=query">'+L('web.bug_report.query_tab')+'</a><a class="btn btn-outline" href="/bug-report">'+L('web.bug_report.submit_another')+'</a></div></div>';
      }
      res.send(renderPage(req,T('web.bug_report.title'),body,{footer:renderFooter(T,req.locale)}));
    }catch(e){next(e)}
  });

  // ────────── 首页 — Agent 列表 ──────────

  R.get('/',async(req,res,next)=>{
    try{
      const T=req.t,L=k=>esc(T(k));
      // 读取配置状态
      let hasToken=false,port='',userEmail='',tokenEmail='';
      try{if(db){
        const tokenRow=db.prepare("SELECT data FROM config WHERE type='user_access_token'").get();
        if(tokenRow){
          const d=JSON.parse(tokenRow.data);
          const keys=Object.keys(d);
          hasToken=keys.length>0;
          if(keys.length>0) tokenEmail=keys[0]; // 取第一个邮箱作为主人邮箱
        }
        const rtRow=db.prepare("SELECT data FROM config WHERE type='runtime'").get();
        if(rtRow){const rt=JSON.parse(rtRow.data);port=rt.port||'';userEmail=rt.userEmail||''}
      }}catch{}
      // 无 token 时跳转到登录页
      if(!hasToken)return res.redirect('/login');

      // 主人邮箱（优先 runtime，回退 user_access_token 的 key）
      const ownerEmail=userEmail||tokenEmail||'';

      // 只显示本邮箱下的 Agent
      const whoData=ownerEmail?await handlers.whoami({ownerEmail}):await handlers.whoami({});
      let agents=whoData.agents||[];
      // sort: online first (from runtime)
      try{const rt=db.prepare("SELECT data FROM config WHERE type=\'runtime\'").get();if(rt){const rd=JSON.parse(rt.data);const imMap={};for(const a of rd.agents||[])imMap[a.agentId]=a.imConnected;agents.sort((a,b)=>(imMap[b.agentId]?1:0)-(imMap[a.agentId]?1:0))}}catch{}
      // pagination + search
      const page = parseInt(req.query.page, 10) || 1;
      const keyword = req.query.keyword || '';
      let filtered=agents;
      if(keyword){const kw=keyword.toLowerCase();filtered=agents.filter(a=>(a.agentName||'').toLowerCase().includes(kw)||(a.agentId||'').toLowerCase().includes(kw))}
      const limit=20,totalPages=Math.ceil(filtered.length/limit);
      const pageAgents=filtered.slice((page-1)*limit,page*limit);
      const rows=[];const jd=[];

      for(const a of pageAgents){
        let connStatus='<span class="unknown">'+L('common.status.unknown')+'</span>';
        try{const st=await getAgentStatus(handlers,a.agentId);const ag=st.agent;if(ag)connStatus=ag.imConnected?'<span class="online">'+L('common.status.online')+'</span>':'<span class="offline">'+L('common.status.offline')+'</span>'}catch{}
        var bt=a.backendType||'-';
        var shortCell='<button class="btn btn-sm btn-outline" data-role="gen-link" data-agent="'+esc(a.agentId)+'" style="margin:0;padding:2px 8px;font-size:12px;min-height:auto">'+L('common.btn.generate_link')+'</button>';
        if(db){try{var sr=db.prepare('SELECT short_link_url FROM agents WHERE agent_id=?').get(a.agentId);if(sr&&sr.short_link_url){var su=esc(sr.short_link_url);shortCell='<a href="'+su+'" target="_blank" style="font-size:13px">'+su.substring(0,35)+(su.length>35?'…':'')+'</a> <button class="btn btn-sm btn-outline" data-role="copy-link" data-url="'+su+'" style="margin:1px;padding:1px 6px;font-size:11px;min-height:auto">'+L('common.btn.copy')+'</button>'}}catch(ex){}}
        var actionHtml='<a href="/agents/'+esc(a.agentId)+'/edit" class="btn btn-sm btn-outline" style="margin:1px;padding:1px 6px;font-size:11px;min-height:auto">'+L('common.btn.edit')+'</a> <a href="/agents/'+esc(a.agentId)+'/caps" class="btn btn-sm btn-outline" style="margin:1px;padding:1px 6px;font-size:11px;min-height:auto">'+L('common.btn.caps')+'</a> <span class="'+(a.publishStatus==='published'?'online':'pending')+'" data-role="toggle-pub" data-agent="'+esc(a.agentId)+'" data-pub-status="'+(a.publishStatus==='published'?'published':'unpublished')+'" title="'+esc(a.publishStatus==='published'?T('common.pub.title_published'):T('common.pub.title_unpublished'))+'" style="cursor:pointer;font-size:12px">'+L(a.publishStatus==='published'?'common.pub.published':'common.pub.unpublished')+'</span> <span class="'+(a.accessMode==='private'?'online':'pending')+'" data-role="toggle-acc" data-agent="'+esc(a.agentId)+'" data-acc-mode="'+(a.accessMode==='private'?'private':'public')+'" title="'+esc(a.accessMode==='private'?T('common.acc.title_private'):T('common.acc.title_public'))+'" style="cursor:pointer;font-size:12px">'+L(a.accessMode==='private'?'common.acc.private':'common.acc.public')+'</span>';
        rows.push('<tr><td><a href="/agents/'+esc(a.agentId)+'">'+esc(a.agentName||a.agentId)+'</a></td><td style="white-space:nowrap;font-size:14px;text-align:center">'+connStatus+'</td><td style="white-space:nowrap;font-size:14px;text-align:center">'+esc(bt)+'</td><td style="white-space:nowrap;font-size:13px">'+shortCell+'</td><td style="white-space:nowrap;font-size:13px;text-align:center">'+actionHtml+'</td></tr>');        jd.push({name:a.agentName,identifier:a.agentId})
      }

      // 信息栏
      const body='<div class="info-bar" style="display:flex;flex-wrap:nowrap;justify-content:space-between;align-items:center;gap:8px">'
        +'<span style="display:flex;align-items:center;gap:6px;white-space:nowrap">'
        +'<strong>👤 '+esc(ownerEmail)+'</strong>'
        +'<a href="javascript:void(0)" data-role="logout-btn" class="btn btn-sm btn-outline" style="margin:0;min-width:auto;min-height:auto;padding:2px 8px;font-size:12px;line-height:1.4">'+L('common.btn.switch')+'</a>'
        +'</span>'
        +(filtered.length>0?'<span style="white-space:nowrap"><a href="/agent/add?new=1" class="btn btn-sm" style="margin:0;min-width:auto;min-height:auto;padding:3px 10px;font-size:13px;line-height:1.4">'+L('common.btn.register')+'</a></span>':'')
        +'</div>'
        +(filtered.length>0
          ?'<div class="table-wrap"><table><thead><tr><th style="text-align:center">'+L('web.home.col.agent')+'</th><th style="text-align:center">'+L('web.home.col.status')+'</th><th style="text-align:center">'+L('web.home.col.type')+'</th><th style="text-align:center">'+L('web.home.col.short_link')+'</th><th style="text-align:center">'+L('web.home.col.actions')+'</th></tr></thead><tbody>'+rows.join('\n')+'</tbody></table></div>'
          :'<div style="text-align:center;padding:60px 0"><p class="meta" style="font-size:16px;margin:0 0 20px">'+L('web.home.empty')+'</p><a href="/agent/add?new=1" class="btn" style="font-size:18px;padding:14px 40px">'+L('common.btn.register')+'</a></div>')
        +(filtered.length>0
          ?'<div style="display:flex;align-items:center;gap:8px;margin:12px 0 6px 0"><form method="GET" action="/" style="display:flex;align-items:center;gap:8px;margin:0"><input type="text" name="keyword" value="'+esc(keyword)+'" placeholder="'+esc(T('web.home.search_ph'))+'" style="width:200px;max-width:100%;margin:0;font-size:14px;padding:6px 10px">'+(keyword?'<a href="/" class="btn-sm btn-outline" style="margin:0;padding:6px 10px;min-width:auto;min-height:auto">✕</a>':'')+'<button type="submit" class="btn-sm" style="margin:0;padding:6px 12px;min-width:auto;min-height:auto" data-agent-action="agent.search">'+L('web.agent.search_btn')+'</button></form></div>'+'<h2 style="margin:18px 0 8px 0;">'+L('web.home.ops_title')+'</h2><div class="ops">'
          +'<a href="/audit-rules" class="op-card" data-agent-kind="link" data-agent="nav_card">'+L('web.home.op.audit')+'</a>'
          +'<a href="/payments" class="op-card" data-agent-kind="link" data-agent="nav_card">'+L('web.home.op.payments')+'</a>'
          +'<a href="/voko-im.log" class="op-card" data-agent-kind="link" data-agent="nav_card">'+L('web.home.op.logs')+'</a>'
          +'</div>'
          :'');
      var logoutDlg='<dialog id="dlg-logout" style="border:none;border-radius:12px;padding:28px;text-align:center;max-width:360px"><h3 style="margin:0 0 8px;font-size:18px">'+L('web.home.logout.title')+'</h3><p style="color:#666;margin:0 0 16px">'+L('web.home.logout.confirm')+'</p><form method="dialog" style="display:flex;gap:8px;justify-content:center"><button class="btn btn-outline" value="cancel">'+L('common.btn.cancel')+'</button><a href="/api/logout" class="btn btn-danger">'+L('common.btn.logout')+'</a></form></dialog>';var shortLinkDlg='<dialog id="dlg-short-link-security" style="border:none;border-radius:12px;padding:0;max-width:350px;width:calc(100% - 40px);box-shadow:0 12px 36px rgba(15,23,42,.18)"><div style="padding:20px 22px 18px"><p style="color:#667085;font-size:14px;line-height:1.65;margin:0 0 16px;text-align:left">'+L('web.home.short_link.security_tip')+'</p><form method="dialog" style="display:flex;gap:8px;justify-content:flex-end"><button class="btn-sm btn-outline" value="cancel" style="margin:0;padding:6px 16px;min-height:auto">'+L('common.btn.cancel')+'</button><button type="button" class="btn-sm" data-role="confirm-gen-link" style="margin:0;padding:6px 16px;min-height:auto">'+L('common.btn.generate_link')+'</button></form></div></dialog>';var toastDlg='<dialog id="dlg-toast" style="border:none;border-radius:12px;padding:24px;text-align:center;max-width:360px"><p id="toast-msg" style="font-size:16px;margin:0 0 12px 0"></p><form method="dialog"><button class="btn-sm" style="margin:0;padding:6px 24px;font-size:14px">'+L('common.toast.ok')+'</button></form></dialog>';var pgBar='';const kwHome=keyword?'&keyword='+encodeURIComponent(keyword):'';if(totalPages>1){pgBar='<div style="display:flex;align-items:center;justify-content:center;gap:12px;padding:8px 0;font-size:14px">';if(page>1)pgBar+='<a href="/?page='+(page-1)+kwHome+'" class="btn-sm" style="padding:4px 12px">'+esc(T('web.payments.prev_page'))+'</a>';pgBar+='<span style="color:#666">'+esc(T('web.payments.page_of',{cur:page,total:totalPages}))+'</span>';if(page<totalPages)pgBar+='<a href="/?page='+(page+1)+kwHome+'" class="btn-sm" style="padding:4px 12px">'+esc(T('web.payments.next_page'))+'</a>';pgBar+='</div>'}res.send(renderPage(req,T('web.home.title'),body+pgBar+logoutDlg+shortLinkDlg+toastDlg,{subtitle:T('web.home.subtitle_count',{count:filtered.length}),jsonld:{'@context':'https://schema.org','@type':'ItemList',itemListElement:jd},footer:renderFooter(T, req.locale)+agentWsScript(T)}))
    }catch(e){next(e)}
  });

  // ────────── 注册 ──────────
  R.use(createRegisterRouter(handlers, db, { webSessions: opts.webSessions }));

  // ────────── 银行卡管理 ──────────
  R.use(createPaymentAuthRouter(handlers, db));

  // ────────── 群聊管理（群详情 / 建群 / 群操作）──────────
  R.use(createGroupRouter(handlers, db));

  // ────────── 切换账号（不清 token，新登录时覆盖） ──────────
  R.get('/api/logout', (req, res) => {
    if(opts.webSessions){opts.webSessions.destroyRequest(req);opts.webSessions.clearCookie(res)}
    res.redirect('/login?mode=switch');
  });

  // ────────── Agent 看板页（短页面） ──────────

  R.get('/agents/:agentId',async(req,res,next)=>{
    try{
      const T=req.t,L=k=>esc(T(k));
      const{agentId}=req.params;
      const agent=await getAgentInfo(handlers,agentId);
      if(!agent)return res.status(404).send(renderPage(req,T('web.agent.not_found_title'),'<p class="error">'+T('web.agent.not_found_msg',{id:esc(agentId)})+'</p><a href="/">← '+L('common.btn.home')+'</a>'));

      // 状态
      let stCls='unknown',stTxt='○ '+T('common.status.unknown'),stBdg='',warnings=[];
      try{const s=await getAgentStatus(handlers,agentId);const ag=s.agent;stCls=ag.imConnected?'online':'offline';stTxt=ag.imConnected?'● '+T('common.status.online'):'○ '+T('common.status.offline');stBdg=ag.imConnected?'badge-online':'badge-offline';warnings=s.warnings||[]}catch{}

      // 会话（分页 + 搜索）
      const page = parseInt(req.query.page, 10) || 1;
      const keyword = req.query.keyword || '';
      const limit = 10;
      const offset = (page - 1) * limit;
      const activeTab=req.query.tab==='group'?'group':'conv';
      const createdGroupId=String(req.query.created||'');
      let convs=[],convTotal=0,convPages=0;
      try{const cr=await handlers.list_conversations({agentId,filter:'all',limit,offset,keyword,channelType:'direct'});convs=cr.conversations||[];convTotal=cr.total||0;convPages=Math.ceil(convTotal/limit)}catch{}
      if(activeTab==='conv'&&convs.length){try{await refreshProfiles(convs.map(c=>c.channelId))}catch(_){}}

      // 群列表（群 Tab，来自服务端，分页，不在本地持久化）
      const gpage=Math.max(1,parseInt(req.query.gpage,10)||1);
      const goffset=(gpage-1)*limit;
      let groups=[],groupTotal=0,groupPages=0;
      try{
        const allGroups=[];
        let fetchOffset=0;
        do{
          const gr=await handlers.list_groups({agentId,limit:100,offset:fetchOffset});
          const batch=gr.groups||[];
          if(fetchOffset===0)groupTotal=gr.total||batch.length;
          allGroups.push(...batch);
          fetchOffset+=batch.length;
          if(!batch.length||fetchOffset>=groupTotal)break;
        }while(true);
        const activityByChannel={};
        try{
          const self=db.prepare('SELECT imUid FROM agents WHERE agent_id=?').get(agentId);
          if(self&&self.imUid){
            const rows=db.prepare('SELECT channel_id,last_timestamp FROM conversations WHERE user_uid=? AND channel_type=2').all(self.imUid);
            rows.forEach(r=>{activityByChannel[r.channel_id]={lastConversation:Number(r.last_timestamp)||0,lastMessage:0,lastSystem:0};});
          }
        }catch(_){}
        try{
          const channelIds=[...new Set(allGroups.map(g=>String(g.channel_id||'')).filter(Boolean))];
          for(let i=0;i<channelIds.length;i+=500){
            const chunk=channelIds.slice(i,i+500);
            const rows=db.prepare('SELECT channel_id,MAX(CASE WHEN content_type!=12 THEN timestamp ELSE 0 END) AS last_message_timestamp,MAX(CASE WHEN content_type=12 THEN timestamp ELSE 0 END) AS last_system_timestamp FROM messages WHERE channel_type=2 AND channel_id IN ('+chunk.map(()=>'?').join(',')+') GROUP BY channel_id').all(...chunk);
            rows.forEach(r=>{const a=activityByChannel[r.channel_id]||(activityByChannel[r.channel_id]={lastConversation:0,lastMessage:0,lastSystem:0});a.lastMessage=Number(r.last_message_timestamp)||0;a.lastSystem=Number(r.last_system_timestamp)||0;});
          }
        }catch(_){}
        const sortableTime=value=>{if(value===undefined||value===null||value==='')return 0;if(typeof value==='number'||/^\d+(?:\.\d+)?$/.test(String(value))){const n=Number(value);return Number.isFinite(n)?(n<1e12?n*1000:n):0;}const parsed=Date.parse(String(value));return Number.isFinite(parsed)?parsed:0;};
        const groupActivityTime=g=>{
          const local=activityByChannel[g.channel_id]||{};
          return Math.max(
            sortableTime(g.created_at??g.createdAt),
            sortableTime(g.notice_updated_at??g.noticeUpdatedAt??g.announcement_updated_at??g.announcementUpdatedAt??g.updated_at??g.updatedAt),
            sortableTime(g.last_system_message_at??g.lastSystemMessageAt),
            sortableTime(g.last_message_at??g.lastMessageAt??g.last_message_time??g.lastMessageTime),
            sortableTime(local.lastConversation),sortableTime(local.lastSystem),sortableTime(local.lastMessage),
          );
        };
        allGroups.sort((a,b)=>{
          const aDissolved=(a.status||'active')==='dissolved';
          const bDissolved=(b.status||'active')==='dissolved';
          if(aDissolved!==bDissolved)return aDissolved?1:-1;
          const aCreated=createdGroupId&&String(a.channel_id)===createdGroupId;
          const bCreated=createdGroupId&&String(b.channel_id)===createdGroupId;
          if(aCreated!==bCreated)return aCreated?-1:1;
          const byActivity=groupActivityTime(b)-groupActivityTime(a);
          if(byActivity)return byActivity;
          return new Date(b.joined_at||0).getTime()-new Date(a.joined_at||0).getTime();
        });
        groups=allGroups.slice(goffset,goffset+limit);
        groupPages=Math.ceil(groupTotal/limit);
      }catch{}

      const aName=esc(agent.agentName||agent.agentId);
      const aId=esc(agentId);

      // 结果提示
      let msg=null;
      if(req.query.ok)msg={success:true,text:req.query.ok};
      else if(req.query.warn)msg={warning:true,text:req.query.warn};
      else if(req.query.err)msg={success:false,text:req.query.err};

      // 信息条
      const infoBar='<div class="info-bar"><span>ID: <code>'+aId+'</code></span><span>'+L('web.agent.info.status')+': <span class="badge '+stBdg+' '+stCls+'">'+stTxt+'</span></span><span>'+L('web.agent.info.backend')+': '+h(agent.backendType)+'</span><span>'+L('web.agent.info.publish')+': '+h(agent.publishStatus)+'</span>'+(agent.ownerEmail?'<span>'+L('web.agent.info.email')+': '+esc(agent.ownerEmail)+'</span>':'')+(warnings.length?'<span class="error">⚠️ '+esc(warnings.join('; '))+'</span>':'')+'</div>';

      // 搜索框
      const keywordEsc=esc(keyword);
      const searchHtml='<form method="GET" action="/agents/'+aId+'" style="display:inline-block;margin-left:8px"><input type="text" name="keyword" value="'+keywordEsc+'" placeholder="'+esc(T('web.agent.search_ph'))+'" style="width:180px;max-width:100%;display:inline-block;margin:0;font-size:14px;padding:6px 10px;vertical-align:middle">'+(keywordEsc?'<a href="/agents/'+aId+'" class="btn-sm btn-outline" style="margin:0 0 0 4px;padding:6px 10px;min-width:auto;min-height:auto;vertical-align:middle">✕</a>':'')+'<button type="submit" class="btn-sm" style="margin:0 0 0 4px;padding:6px 12px;min-width:auto;min-height:auto;vertical-align:middle" data-agent-action="agent.search">'+L('web.agent.search_btn')+'</button></form>';

      // 会话
      let convHtml='<p class="meta">'+L('web.agent.no_conversations')+'</p>';
      if(convs.length){
        // 补昵称（user_cache 有则用，无则回退 channelId）
        let convNickMap={};
        try{const cids=convs.map(c=>c.channelId);const rows=db.prepare('SELECT uid, nickname FROM user_cache WHERE uid IN ('+cids.map(()=>'?').join(',')+')').all(...cids);rows.forEach(r=>{convNickMap[r.uid]=r.nickname||'';});}catch(_){}
        convHtml='<div class="table-wrap"><table><thead><tr><th>'+L('web.agent.col.visitor')+'</th><th>'+L('web.agent.col.last_msg')+'</th><th style="text-align:center">'+L('web.agent.col.last_from')+'</th><th style="text-align:center">'+L('web.agent.col.time')+'</th></tr></thead><tbody>';
        for(const c of convs){
          const lastFrom='<span class="meta">'+(c.lastIsMe===2||c.lastContentType===11?L('web.agent.last_from.system'):(c.needsReply?L('web.agent.last_from.visitor'):L('web.agent.last_from.ai')))+'</span>';
          const msg=esc((c.lastMessage||'').length>60?(c.lastMessage||'').substring(0,60)+'…':c.lastMessage||'');
          const unreadBadge=c.unreadCount>0?' <span class="badge" style="background:#e74c3c;color:#fff;border-radius:10px;padding:1px 6px;font-size:11px">'+c.unreadCount+'</span>':'';
          convHtml+='<tr><td style="max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><a href="/agents/'+aId+'/c/'+esc(c.channelId)+'">'+esc(convNickMap[c.channelId]||c.name||c.channelId)+'</a>'+unreadBadge+'</td><td style="white-space:normal;word-break:break-word;max-width:300px">'+msg+'</td><td style="white-space:nowrap;width:50px;text-align:center">'+lastFrom+'</td><td class="meta" style="white-space:nowrap;width:90px;text-align:center">'+timeTag(c.lastTimestamp)+'</td></tr>'
        }
        convHtml+='</tbody></table></div>'
      }
      // 翻页
      let pgBar='';const kwParam=keywordEsc?'&keyword='+encodeURIComponent(keyword):'';
      if(convPages>1){
        pgBar='<div style="display:flex;align-items:center;justify-content:center;gap:12px;padding:8px 0;font-size:14px">';
        if(page>1)pgBar+='<a href="/agents/'+aId+'?page='+(page-1)+kwParam+'" class="btn-sm" style="padding:4px 12px">'+esc(T('web.payments.prev_page'))+'</a>';
        pgBar+='<span style="color:#666">'+esc(T('web.payments.page_of',{cur:page,total:convPages}))+'</span>';
        if(page<convPages)pgBar+='<a href="/agents/'+aId+'?page='+(page+1)+kwParam+'" class="btn-sm" style="padding:4px 12px">'+esc(T('web.payments.next_page'))+'</a>';
        pgBar+='</div>'
      }
      const aclOps='<h2>'+L('web.agent.acl_title')+'</h2><div class="ops" style="grid-template-columns:repeat(auto-fill,minmax(140px,1fr))"><a href="/capabilities?agentId='+aId+'" class="op-card" data-agent-kind="link" data-agent="nav_card">'+L('web.home.op.capabilities')+'</a><a href="/send-message?agentId='+aId+'" class="op-card" data-agent-kind="link" data-agent="nav_card">'+L('web.home.op.send_message')+'</a><a href="/interventions?agentId='+aId+'" class="op-card" data-agent-kind="link" data-agent="nav_card">'+L('web.home.op.interventions')+'</a><a href="/agents/'+aId+'/invite" class="op-card" data-agent-kind="link" data-agent="nav_card">'+L('web.agent.invite.title')+'</a><a href="/agents/'+aId+'/payment-auth" class="op-card" data-agent-kind="link" data-agent="nav_card">'+L('web.home.op.payments')+'</a><a href="/agents/'+aId+'/whitelist" class="op-card" data-agent-kind="link" data-agent="nav_card">'+L('web.agent.op.whitelist')+'</a><a href="/agents/'+aId+'/blacklist" class="op-card" data-agent-kind="link" data-agent="nav_card">'+L('web.agent.op.blacklist')+'</a><a href="/agents/'+aId+'/pricing" class="op-card" data-agent-kind="link" data-agent="nav_card">'+L('web.agent.op.pricing')+'</a></div>';;;
      // 群列表（群 Tab）
      let groupHtml='<p class="meta">'+L('web.agent.no_groups')+'</p>';
      if(groups.length){
        const groupMentionCounts={};
        try{
          const self=db.prepare('SELECT imUid FROM agents WHERE agent_id=?').get(agentId);
          if(self&&self.imUid){for(const g of groups){
            const conv=db.prepare('SELECT unread_count FROM conversations WHERE user_uid=? AND channel_id=? AND channel_type=2').get(self.imUid,g.channel_id);
            const unread=Math.max(0,Number(conv&&conv.unread_count||0));if(!unread)continue;
            const recent=db.prepare('SELECT mention FROM messages WHERE channel_id=? AND channel_type=2 AND is_me=0 ORDER BY timestamp DESC,rowid DESC LIMIT ?').all(g.channel_id,unread);
            groupMentionCounts[g.channel_id]=recent.reduce((n,r)=>{try{const m=r.mention?JSON.parse(r.mention):null;return n+(m&&(m.all||(m.uids||[]).includes(self.imUid))?1:0)}catch(_){return n}},0);
          }}
        }catch(_){}
        // 查群主昵称 + 成员数
        let ownerNickMap={};
        try{const oids=[...new Set(groups.map(g=>g.owner_uid).filter(Boolean))];if(oids.length){const rows=db.prepare('SELECT uid, nickname FROM user_cache WHERE uid IN ('+oids.map(()=>'?').join(',')+')').all(...oids);rows.forEach(r=>{ownerNickMap[r.uid]=r.nickname||'';});}}catch(_){}
        groupHtml='<div class="table-wrap"><table><thead><tr><th>'+L('web.agent.col.group_name')+'</th><th>'+L('web.group.role.owner')+'</th><th style="text-align:center">'+L('web.group.tab.members')+'</th><th>'+L('web.group.field.notice')+'</th></tr></thead><tbody>';
        for(const g of groups){
          const ownerName=esc(ownerNickMap[g.owner_uid]||g.owner_uid||'');
          const memberCount=g.member_count||0;
          const atCount=groupMentionCounts[g.channel_id]||0;
          const atBadge=atCount?' <span class="badge" style="background:#1a73e8;color:#fff;border-radius:10px;padding:1px 6px;font-size:11px">'+L('web.group.mention.list_badge')+' '+atCount+'</span>':'';
          const dissolvedBadge=(g.status||'active')==='dissolved'?' <span class="badge" style="background:#fce8e6;color:#b71c1c;border-color:#d93025;font-size:11px">'+L('web.group.dissolved.label')+'</span>':'';
          groupHtml+='<tr><td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><a href="/agents/'+aId+'/g/'+esc(g.channel_id)+'">'+esc(g.name||g.channel_id)+'</a>'+dissolvedBadge+atBadge+'</td><td class="meta">'+ownerName+'</td><td class="meta" style="text-align:center">'+memberCount+'</td><td class="meta" style="white-space:normal;word-break:break-word;max-width:280px">'+(g.notice?esc(g.notice.length>40?g.notice.substring(0,40)+'…':g.notice):'<span style="color:#bbb">—</span>')+'</td></tr>';
        }
        groupHtml+='</tbody></table></div>';
      }
      let gPgBar='';
      if(groupPages>1){
        gPgBar='<div style="display:flex;align-items:center;justify-content:center;gap:12px;padding:8px 0;font-size:14px">';
        if(gpage>1)gPgBar+='<a href="/agents/'+aId+'?tab=group&gpage='+(gpage-1)+'" class="btn-sm" style="padding:4px 12px">'+esc(T('web.payments.prev_page'))+'</a>';
        gPgBar+='<span style="color:#666">'+esc(T('web.payments.page_of',{cur:gpage,total:groupPages}))+'</span>';
        if(gpage<groupPages)gPgBar+='<a href="/agents/'+aId+'?tab=group&gpage='+(gpage+1)+'" class="btn-sm" style="padding:4px 12px">'+esc(T('web.payments.next_page'))+'</a>';
        gPgBar+='</div>';
      }
      const groupOps='<h2>'+L('web.agent.group_ops_title')+'</h2><div class="ops" style="grid-template-columns:repeat(auto-fill,minmax(140px,1fr))"><a href="/agents/'+aId+'/create-group" class="op-card" data-agent-kind="link" data-agent="nav_card">'+L('web.agent.op.create_group')+'</a><a href="/agents/'+aId+'/search-group" class="op-card" data-agent-kind="link" data-agent="nav_card">'+L('web.agent.op.search_group')+'</a></div>';

      // Tab（会话列表 / 群列表）
      const tabBtn=(id,label,active)=>'<button type="button" data-tab="'+id+'" style="background:transparent;border:none;border-bottom:3px solid '+(active?'#1a73e8':'transparent')+';color:'+(active?'#1a73e8':'#666')+';font:inherit;font-size:16px;font-weight:'+(active?'700':'600')+';padding:10px 20px;margin-bottom:-2px;cursor:pointer">'+label+'</button>';
      const convLabel=L('web.agent.tab.conversations')+(convTotal?' ('+convTotal+')':'');
      const groupLabel=L('web.agent.tab.groups')+(groupTotal?' ('+groupTotal+')':'');
      const tabBar='<div style="display:flex;gap:4px;border-bottom:2px solid #e0e0e0;margin-bottom:14px">'+tabBtn('conv',convLabel,activeTab==='conv')+tabBtn('group',groupLabel,activeTab==='group')+'</div>';
      const convPanel='<div id="tab-conv" style="'+(activeTab==='conv'?'':'display:none')+'">'+searchHtml+convHtml+pgBar+aclOps+'</div>';
      const groupPanel='<div id="tab-group" style="'+(activeTab==='group'?'':'display:none')+'">'+groupHtml+gPgBar+groupOps+'</div>';
      const body=infoBar+tabBar+convPanel+groupPanel+'<p><a href="/">← '+L('common.btn.home')+'</a></p>';

      const tabScript='<script>(function(){function setTab(t){var c=document.getElementById("tab-conv"),g=document.getElementById("tab-group");if(c)c.style.display=(t==="conv"?"":"none");if(g)g.style.display=(t==="group"?"":"none");document.querySelectorAll("button[data-tab]").forEach(function(b){var on=b.getAttribute("data-tab")===t;b.style.borderBottomColor=on?"#1a73e8":"transparent";b.style.color=on?"#1a73e8":"#666";b.style.fontWeight=on?"700":"600";});var u=new URL(location.href);if(t==="group")u.searchParams.set("tab","group");else u.searchParams.delete("tab");history.replaceState(null,"",u);}document.addEventListener("click",function(e){var b=e.target.closest("button[data-tab]");if(b)setTab(b.getAttribute("data-tab"))});})();</script>';

      res.send(renderPage(req,T('web.agent.title',{name:aName}),body,{nav:agentNav(agentId,agent.agentName||agent.agentId,T),msg,jsonld:{'@context':'https://schema.org',name:agent.agentName,identifier:agent.agentId},footer:renderFooter(T, req.locale)+tabScript}))
    }catch(e){next(e)}
  });

  // ────────── 会话详情 + 发消息 ──────────

  R.get('/agents/:agentId/c/:channelId',async(req,res,next)=>{
    try{
      const T=req.t,L=k=>esc(T(k));
      const messageRenderer=createMessageRenderer(messageLabels(T));
      const{agentId,channelId}=req.params;
      try{await refreshProfiles([channelId])}catch(_){}
      let isBl=false,isWl=false;
      try{const bl=await handlers.list_access_lists({agentId,listType:'blacklist'});const wl=await handlers.list_access_lists({agentId,listType:'whitelist'});const blL=bl.data||bl.entries||bl.accessList||[];const wlL=wl.data||wl.entries||wl.accessList||[];isBl=blL.some(e=>(e.visitor_id||e.visitorId||'')===channelId);isWl=wlL.some(e=>(e.visitor_id||e.visitorId||'')===channelId);}catch{}
      let hasPricing=false;try{const pr=await handlers.agent_pricing({agentId});if(pr&&pr.pricingModel)hasPricing=true;}catch{}
      let hasPaymentAuth=false;try{const pa=db.prepare("SELECT 1 FROM agents a JOIN payment_auth p ON p.id=a.payment_auth_id WHERE a.agent_id=? AND UPPER(COALESCE(p.receiver_apply_status,''))='COMPLETED' LIMIT 1").get(agentId);hasPaymentAuth=!!pa;}catch{}
      const agent=await getAgentInfo(handlers,agentId);
      const aName=agent?esc(agent.agentName||agent.agentId):esc(agentId);
      const focus=req.query.focus==='1'||req.query.action==='reply';
      const replyStyle=focus?'border:2px solid #1a73e8;box-shadow:0 0 0 3px rgba(26,115,232,.15)':'';
      let md;try{md=await handlers.get_chat_history({agentId,channelId,limit:50})}catch{md={messages:[]}}
      let peerAgentName='';try{const p=db.prepare('SELECT agent_name FROM agents WHERE imUid=? AND agent_id!=? LIMIT 1').get(channelId,agentId);if(p&&p.agent_name)peerAgentName=p.agent_name}catch(_){}
      const peerLabel=peerAgentName||L('web.conversation.from.visitor');
      const msgs=md.messages||[];let mh='<p class="meta">'+L('web.conversation.no_messages')+'</p>';const jd=[];
      if(msgs.length){mh='';const s=[...msgs].reverse();for(const m of s){const sr=m.isMe?L('web.conversation.from.agent'):peerLabel;const t=timeTag(m.timestamp);if(m.contentType===11){const audit=parseAuditContent(m.content);mh+=renderAuditContent(m.content,T,t);jd.push({from:'system',content:audit.valid?audit.text:T('web.audit.message_invalid'),timestamp:m.timestamp});continue;}const c=messageRenderer.render(m.contentType,m.content);mh+='<div style="padding:8px 12px;margin:4px 0;border-radius:6px;border-left:4px solid '+(m.isMe?'#0f9d58':'#1a73e8')+';background:'+(m.isMe?'#e6f4ea':'#e8f0fe')+'"><strong>'+esc(sr)+'</strong> <span style="color:#888;font-size:13px">['+t+']</span><br>'+c+'</div>';jd.push({from:m.isMe?'agent':'visitor',content:m.content,timestamp:m.timestamp})}}
      const aId2=esc(agentId),cId2=esc(channelId);
      // 访客昵称（user_cache 有则显示名称，无则仅显示 id）
      let visitorName=peerAgentName||channelId;
      if(!peerAgentName)try{const r=db.prepare('SELECT nickname FROM user_cache WHERE uid=? LIMIT 1').get(channelId);if(r&&r.nickname)visitorName=r.nickname;}catch(_){}
      const titleId=visitorName!==channelId?visitorName+' ('+channelId+')':channelId;
      const navId=visitorName!==channelId?esc(visitorName)+' ('+cId2+')':cId2;
      const returnTo='/agents/'+aId2+'/c/'+cId2;
      const actionBtn=(action,label)=>'<form method="POST" action="/agents/'+aId2+'" class="op-card" style="padding:0"><input type="hidden" name="_action" value="'+action+'"><input type="hidden" name="visitorId" value="'+cId2+'"><input type="hidden" name="returnTo" value="'+returnTo+'"><button type="submit" style="width:100%;background:none;border:none;padding:10px 8px;margin:0;font:inherit;font-weight:600;font-size:14px;color:#1a1a2e;cursor:pointer" data-agent-kind="action">'+label+'</button></form>';
      const wlBtn=actionBtn(isWl?'remove_whitelist':'add_whitelist',L(isWl?'common.wl.remove':'common.wl.add'));
      const blBtn=actionBtn(isBl?'remove_blacklist':'add_blacklist',L(isBl?'common.bl.remove':'common.bl.add'));
      const payBtn=hasPricing&&hasPaymentAuth?'<a href=\"/payments?action=create&agentId='+aId2+'&visitorId='+cId2+'\" class=\"op-card\" data-agent-kind=\"link\" data-agent=\"nav_card\">'+L('web.conversation.pay.create')+'</a>':'<span class=\"op-card\" style=\"color:#aaa;cursor:not-allowed;opacity:0.6\" title=\"'+esc(T(hasPaymentAuth?'web.conversation.pay.unconfigured_title':'web.conversation.pay.card_required_title'))+'\">'+L('web.conversation.pay.create')+'</span>';res.send(renderPage(req,T('web.conversation.title',{id:titleId}),
'<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px"><span class="meta" id="msg-count">'+T('web.conversation.count_msg',{count:msgs.length})+'</span></div>'
+'<div id="msg-box" style="max-height:50vh;overflow-y:auto;border:1px solid #e0e0e0;padding:12px;border-radius:6px;background:#fff;margin-bottom:10px">'+mh+'</div>'
+'<div class="card" id="reply" style="'+replyStyle+'"><h3>'+L('web.conversation.reply_title')+'</h3><form method="POST" action="/messages/send" data-submit-lock="1" data-submit-label="'+L('web.conversation.sending')+'"><input type="hidden" name="agentId" value="'+aId2+'"><input type="hidden" name="toUid" value="'+cId2+'"><label for="c">'+L('web.conversation.label.content')+'</label><div class="voko-compose-row"><input type="text" id="c" name="content" required autocomplete="off" autofocus><button type="submit" class="voko-send-button" data-agent="send_msg_btn">'+L('common.btn.send')+'</button></div></form></div>'
+'<div class="card"><h3>'+L('web.conversation.visitor_ops')+'</h3><div class="ops" style="grid-template-columns:repeat(auto-fill,minmax(140px,1fr))"><a href="/agents/'+aId2+'/visitor?uid='+cId2+'" class="op-card" data-agent-kind="link" data-agent="nav_card">'+L('web.conversation.op.profile')+'</a>'+wlBtn+''+blBtn+'<a href="/agents/'+aId2+'/human?visitorId='+cId2+'" class="op-card" data-agent-kind="link" data-agent="nav_card">'+L('web.conversation.op.human')+'</a><a href="/agents/'+aId2+'/upload?toUid='+encodeURIComponent(channelId)+'&channelType=1" class="op-card" data-agent-kind="link" data-agent="nav_card">'+L('web.conversation.op.upload')+'</a>'+payBtn+'</div></div><a href="/agents/'+aId2+'">'+T('web.conversation.back',{name:aName})+'</a>',
{nav:agentNav(agentId,aName,T)+' › '+navId,jsonld:{'@context':'https://schema.org',agentId,channelId,messages:jd},footer:renderFooter(T, req.locale)+messageRendererScript(T)+'<script>(function(){var b=document.getElementById("msg-box");if(b)b.scrollTop=b.scrollHeight;})();</script>'+'<script>var _A='+jsonForInlineScript(agentId)+',_C='+jsonForInlineScript(channelId)+',_R='+jsonForInlineScript({agent:T('web.conversation.from.agent'),visitor:peerLabel,no_msg:T('web.conversation.no_messages'),count_msg:T('web.conversation.count_msg'),auditIn:T('web.audit.message_inbound'),auditOut:T('web.audit.message_outbound'),auditBlocked:T('web.audit.message_blocked'),auditAllowed:T('web.audit.message_allowed'),auditKeyword:T('web.audit.message_keyword'),auditOriginal:T('web.audit.message_original'),auditInvalid:T('web.audit.message_invalid')})+',_seen={};'+"(function(){function _esc(s){return String(s==null?\"\":s).replace(/[&<>\"']/g,function(c){return{\"&\":\"&amp;\",\"<\":\"&lt;\",\">\":\"&gt;\",'\"':\"&quot;\",\"'\":\"&#39;\"}[c]})}function _audit(ct,t){try{var d=JSON.parse(ct),out=d.direction===\"outbound\"||(!d.direction&&String(d.audit||\"\").indexOf(\"出站\")>=0),title=out?_R.auditOut:_R.auditIn,result=d.action===\"hard_deny\"?_R.auditBlocked:_R.auditAllowed,rows=\"\";if(d.keyword)rows+='<div class=\"audit-message-row\"><span>'+_esc(_R.auditKeyword)+\"</span>\"+_esc(d.keyword)+\"</div>\";if(d.text)rows+='<div class=\"audit-message-row\"><span>'+_esc(_R.auditOriginal)+\"</span>\"+_esc(d.text).replace(/\\n/g,\"<br>\")+\"</div>\";return '<div class=\"audit-message\"><div class=\"audit-message-head\"><strong>'+_esc(title)+'</strong><span class=\"audit-message-result\">'+_esc(result)+'</span><span class=\"meta\">'+_esc(t)+\"</span></div>\"+rows+\"</div>\"}catch(_){return '<div class=\"audit-message\"><strong>'+_esc(_R.auditInvalid)+'</strong> <span class=\"meta\">'+_esc(t)+\"</span></div>\"}}function _addMsg(m){var bx=document.getElementById(\"msg-box\"),isMe=m.isMe===true||m.isMe===1,sr=isMe?_R.agent:_R.visitor,t=new Date((m.timestamp||0)*1000).toLocaleTimeString(),ct=(m.content||\"\"),h;if(m.contentType===11){h=_audit(ct,t)}else{var bc=isMe?\"#0f9d58\":\"#1a73e8\",bg=isMe?\"#e6f4ea\":\"#e8f0fe\";h='<div style=\"padding:8px 12px;margin:4px 0;border-radius:6px;border-left:4px solid '+bc+';background:'+bg+'\"><strong>'+_esc(sr)+'</strong> <span style=\"color:#888;font-size:13px\">['+_esc(t)+']</span><br>'+window.__vokoMessageRenderer.render(m.contentType,ct)+\"</div>\"}bx.insertAdjacentHTML(\"beforeend\",h);bx.scrollTop=bx.scrollHeight;var mc=document.getElementById(\"msg-count\");if(mc){mc.textContent=_R.count_msg.replace(\"{count}\",bx.children.length)}}function _connect(){try{var ws=new WebSocket(\"ws://\"+location.host+\"/ws\");ws.onmessage=function(e){try{var d=JSON.parse(e.data);if(d.event===\"agent-wukongim:message\"){var m=d.data;if(m.agentId===_A&&m.channelId===_C&&m.messageId&&!_seen[m.messageId]){_seen[m.messageId]=1;_addMsg(m)}}}catch(_){}};ws.onclose=function(){setTimeout(_connect,3000)}}catch(_){setTimeout(_connect,5000)}}_connect()})();"+'</script>'}))
    }catch(e){next(e)}
  });

  // 群详情 / 建群 / 群操作 已迁至 web/group.js（createGroupRouter）

  // 标记会话已读：UI 按钮已移除，handler 保留并通过 /api/console + /api/handlers 暴露给 agent

  R.post('/messages/send',async(req,res,next)=>{
    try{
      const{agentId,toUid,content,channelType}=req.body;
      let mentions=null;
      if(channelType&&Number(channelType)===2&&req.body.mentions){
        try{
          const raw=typeof req.body.mentions==='string'?JSON.parse(req.body.mentions):req.body.mentions;
          const all=raw&&raw.all===true;
          const uids=raw&&Array.isArray(raw.uids)?raw.uids.filter(x=>typeof x==='string'&&x).slice(0,100):[];
          if(all||uids.length)mentions={all,uids};
        }catch(_){}
      }
      // @all is a group-management operation. Enforce the same owner/admin
      // rule as MCP on the Web route instead of trusting browser payloads.
      if(Number(channelType)===2&&mentions&&mentions.all===true){
        try{
          const group=await handlers.get_group_context({agentId,toUid,limit:1,offset:0});
          const myUid=db.prepare('SELECT imUid FROM agents WHERE agent_id=? LIMIT 1').get(agentId)?.imUid;
          const me=(group?.members||[]).find(m=>String(m.uid)===String(myUid));
          if(!me||!['owner','admin'].includes(String(me.role||''))){
            const error=req.t('web.group.mention.all_forbidden');
            if(req.is('json'))return res.status(403).json({success:false,error,code:'MENTION_ALL_FORBIDDEN'});
            return res.status(403).send(renderPage(req,'Error','<p class="error">'+esc(error)+'</p>'));
          }
        }catch(e){
          const error=e?.message||req.t('common.action.failed');
          if(req.is('json'))return res.status(502).json({success:false,error,code:'GROUP_CONTEXT_UNAVAILABLE'});
          return res.status(502).send(renderPage(req,'Error','<p class="error">'+esc(error)+'</p>'));
        }
      }
      if(!agentId||!toUid||!content){
        if(req.is('json'))return res.status(400).json({success:false,error:'缺少参数'});
        return res.status(400).send(renderPage(req,'错误','<p class="error">缺少参数</p><a href="javascript:history.back()">返回</a>'));
      }
      const r=await handlers.send_message({agentId,toUid,content,channelType:channelType?Number(channelType):undefined,mentions});
      if(req.is('json'))return res.json(r.success!==false?{success:true,message:'消息已发送',messageId:r.messageId,messageSeq:r.messageSeq}:{success:false,error:r.error||'未知错误'});
      r.success?res.redirect('/agents/'+esc(agentId)+'/c/'+esc(toUid)+'?ok='+encodeURIComponent('消息已发送')):res.send(renderPage(req,'发送失败','<p class="error">❌ '+esc(r.error||'未知错误')+'</p><a href="/agents/'+esc(agentId)+'/c/'+esc(toUid)+'">返回</a>'))
    }catch(e){next(e)}
  });

  // 建群表单/handler 已迁至 web/group.js

  // ══════════════════════════════════════════════════════════
  //  管理操作表单页（每个一个文件，模式统一）
  // ══════════════════════════════════════════════════════════

  // ── 编辑资料 ──
  R.get('/api/agent-backend-types',(req,res)=>{
    try{
      const T=req.t;
      const types=getBackendTypes(db);
      let detected=new Set();
      try{detected=new Set(createRegistrationOrchestrator({db}).inspectEnvironment().detected.map(x=>x.type));}catch(_){}
      res.json({success:true,types:types.map(t=>({value:t.value,label:t.value==='others'?T('db.backend_type.others'):t.label,detected:detected.has(t.value)}))});
    }catch(e){res.status(500).json({success:false,error:e.message})}
  });

  R.get('/agents/:agentId/edit',async(req,res,next)=>{
    try{
      const T=req.t,L=k=>esc(T(k));
      const{agentId}=req.params;
      let p={};
      try{const r=await handlers.get_agent_profile({agentId});if(r.success)p=r.data||{};else p={}}catch{}
      // 回退：从 whoami 获取基本数据（agent 可能不在本地 DB）
      if(!p.agentId){try{const w=await handlers.whoami({});const a=(w.agents||[]).find(x=>x.agentId===agentId);if(a)p={agentId:a.agentId,agentName:a.agentName,backendType:a.backendType,category:a.category,description:a.description,shortDescription:a.shortDescription,iconUrl:a.iconUrl,contactPhone:a.contactPhone,address:a.address,tags:a.tags}}catch{}}
      const aname=p.agentName||agentId;
      let catList=[];
      try{const resp=await fetch(VOKO_API_URL+'/api/agent-categories');const d=await resp.json();if(d.success&&Array.isArray(d.data))catList=d.data;}catch(_){}
      if(!catList.length)catList=[{code:'general'},{code:'other'}];
      const catOpts=catList.map(c=>{const key='db.agent.category.'+c.code;const lbl=T(key);const label=lbl!==key?lbl:(c.label||c.code);return '<option value="'+c.code+'"'+(p.category===c.code?' selected':'')+'>'+esc(label)+'</option>';}).join('');
      const btTypes=getBackendTypes(db);const knownVals=getBackendTypeValues(db);
      var btInitValue='',btInitText=T('web.agent.edit.select_backend_type');
      if(p.backendType&&knownVals.includes(p.backendType)){var tm=btTypes.find(function(x){return x.value===p.backendType});btInitValue=p.backendType;btInitText=tm?(tm.value==='others'?T('db.backend_type.others'):tm.label):p.backendType;}
      else if(p.backendType){btInitValue=p.backendType;btInitText=T('db.backend_type.others');}
      const backendField='<div><label for="bt">'+T('web.agent.edit.backend_type')+'</label>'
        +'<p class="meta" style="margin:2px 0 6px">'+L('web.agent.edit.runtime_hint')+'</p>'
        +'<div class="voko-select" id="bt-wrapper">'
        +'<div class="voko-select-trigger" id="bt-trigger" tabindex="0"><span class="voko-select-text" id="bt-text">'+esc(btInitText)+'</span><span class="voko-select-arrow">▼</span></div>'
        +'<div class="voko-select-dropdown" id="bt-dropdown">'
        +'<input type="text" class="voko-select-search" id="bt-search" placeholder="'+esc(T('web.agent.edit.search_type_ph'))+'" autocomplete="off">'
        +'<div class="voko-select-options" id="bt-options"><div class="voko-option voko-option-empty">'+L('web.agent.edit.types_load_on_open')+'</div></div></div>'
        +'<input type="hidden" id="bt" name="backendType" value="'+esc(btInitValue)+'">'
        +'</div></div>';
      const iconUrl=p.iconUrl||'/favicon.png';
      const iconField='<div><label>'+L('web.agent.edit.icon_url')+'</label>'
        +'<div class="agent-icon-field"><button type="button" class="agent-icon-button" id="agent-icon-button" data-agent-action="agent.icon.upload" aria-label="'+L('web.agent.edit.icon_change')+'">'
        +'<img class="agent-icon-preview" id="agent-icon-preview" src="'+esc(iconUrl)+'" alt="'+L('web.agent.edit.icon_url')+'" onerror="this.onerror=null;this.src=\'/favicon.png\'">'
        +'<span class="agent-icon-overlay">'+L('web.agent.edit.icon_change')+'</span></button>'
        +'<div><p class="meta agent-icon-help">'+L('web.agent.edit.icon_hint')+'</p><span id="agent-icon-status" class="agent-icon-status" aria-live="polite"></span></div></div>'
        +'<input type="file" id="agent-icon-file" accept="image/png,image/jpeg,image/webp,image/gif" hidden>'
        +'<input type="hidden" id="iconUrl" name="iconUrl" value="'+esc(p.iconUrl||'')+'"></div>';
      // 构建 2 列表单，字段紧凑排列
      const f=function(l,id,v,attr){return '<div><label for="'+id+'">'+esc(l)+'</label><input type="text" id="'+id+'" name="'+id+'" value="'+esc(v||'')+'" '+(attr||'')+'></div>'};
      res.send(renderAgentFormPage(T('web.agent.edit.title'),agentId,aname,
        '<form method="POST" action="/agents/'+esc(agentId)+'" data-agent-action="agent.profile.update" class="form-grid">\n'
        +'<input type="hidden" name="_action" value="update_profile">\n'
        +'<div class="full edit-section-title">'+L('web.agent.edit.section_profile')+'</div>'
        +f(T('web.agent.edit.name'),'name',p.agentName,'required')
        +'<div><label for="category">'+T('web.agent.edit.category')+'</label><select id="category" name="category" style="width:100%;max-width:460px;padding:10px 12px;margin-top:3px;background:#fff;color:#1a1a2e;border:2px solid #b0b0b0;border-radius:6px;font-size:16px;font-family:inherit;outline:none;">'
        +'<option value="">-- '+T('web.agent.edit.select_category')+' --</option>'
        +catOpts
        +'</select></div>'
        +backendField
        +f(T('web.agent.edit.short_desc'),'short_description',p.shortDescription)
        +f(T('web.agent.edit.tags'),'tags',Array.isArray(p.tags)?p.tags.join(', '):(p.tags||''),'placeholder="'+esc(T('web.agent.edit.tags_ph'))+'"')
        +iconField
        +f(T('web.agent.edit.phone'),'contact_phone',p.contactPhone)
        +f(T('web.agent.edit.address'),'address',p.address)
        +'<div class="full"><label for="desc">'+T('web.agent.edit.description')+'</label><textarea id="desc" name="description" rows="3">'+esc(p.description||'')+'</textarea></div>'
        +'<div class="full" style="display:flex;gap:10px;align-items:center;margin-top:4px"><button type="submit">'+L('common.btn.save')+'</button>'
        +'<span class="meta">'+T('web.agent.edit.sync_hint')+'</span></div>'
        +'</form>'
        +'<script>(function(){'
        +'var w=document.getElementById("bt-wrapper"),tr=document.getElementById("bt-trigger"),dd=document.getElementById("bt-dropdown"),bs=document.getElementById("bt-search"),bt=document.getElementById("bt"),tx=document.getElementById("bt-text"),oc=document.getElementById("bt-options");'
        +'var all=[],loaded=false,loading=false,TXT_NO_MATCH='+JSON.stringify(T('web.agent.edit.no_match'))+',TXT_LOADING='+JSON.stringify(T('web.agent.edit.types_loading'))+',TXT_FAILED='+JSON.stringify(T('web.agent.edit.types_load_failed'))+',TXT_LOCAL='+JSON.stringify(T('register.flow.provider.local'))+',TXT_MORE='+JSON.stringify(T('register.flow.provider.more'))+';'
        +'function esc3(s){return String(s==null?"":s).replace(/[&<>"\']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",\'"\':"&quot;","\'":"&#39;"}[c]})}'
        +'function loadTypes(){if(loaded||loading)return;loading=true;oc.innerHTML=\'<div class="voko-option voko-option-empty">\'+esc3(TXT_LOADING)+"</div>";fetch("/api/agent-backend-types",{headers:{Accept:"application/json"}}).then(function(r){if(!r.ok)throw new Error("load failed");return r.json()}).then(function(j){if(!j.success)throw new Error(j.error||"load failed");var local=j.types.filter(function(x){return x.detected}),more=j.types.filter(function(x){return !x.detected});function opts(xs){return xs.map(function(x){return \'<div class="voko-option" data-value="\'+esc3(x.value)+\'">\'+esc3(x.label)+"</div>"}).join("")}oc.innerHTML=(local.length?\'<div class="voko-option-group">\'+esc3(TXT_LOCAL)+"</div>"+opts(local):"")+\'<div class="voko-option-group">\'+esc3(TXT_MORE)+"</div>"+opts(more);all=Array.from(oc.querySelectorAll(".voko-option:not(.voko-option-empty)"));loaded=true}).catch(function(){oc.innerHTML=\'<div class="voko-option voko-option-empty">\'+esc3(TXT_FAILED)+"</div>"}).finally(function(){loading=false})}'
        +'function open(){dd.style.display="block";loadTypes();bs.focus();}'
        +'function close(){dd.style.display="none";bs.value="";all.forEach(function(o){o.style.display="";});var h=oc.querySelector(".voko-option-empty");if(h)h.remove();}'
        +'if(tr&&dd){tr.addEventListener("click",function(e){e.stopPropagation();if(dd.style.display==="block")close();else open();});}'
        +'if(bs&&oc){bs.addEventListener("input",function(){var q=bs.value.toLowerCase(),hm=false;all.forEach(function(o){if(!q||o.textContent.toLowerCase().indexOf(q)!==-1){o.style.display="";hm=true;}else{o.style.display="none";}});var h=oc.querySelector(".voko-option-empty");if(!hm&&q){if(!h){h=document.createElement("div");h.className="voko-option voko-option-empty";h.textContent=TXT_NO_MATCH;oc.appendChild(h);}}else if(h){h.remove();}});bs.addEventListener("click",function(e){e.stopPropagation();});}'
        +'if(oc){oc.addEventListener("click",function(e){var opt=e.target.closest(".voko-option");if(!opt||opt.classList.contains("voko-option-empty"))return;bt.value=opt.getAttribute("data-value");tx.textContent=opt.textContent;close();});}'
        +'if(bs){bs.addEventListener("keydown",function(e){if(e.key==="Escape"){close();tr.focus();}});}'
        +'if(tr){tr.addEventListener("keydown",function(e){if(e.key==="Enter"||e.key===" "){e.preventDefault();open();}});}'
        +'document.addEventListener("click",function(e){if(w&&!w.contains(e.target))close();});'
        +'})();(function(){var b=document.getElementById("agent-icon-button"),f=document.getElementById("agent-icon-file"),img=document.getElementById("agent-icon-preview"),hidden=document.getElementById("iconUrl"),status=document.getElementById("agent-icon-status");if(!b||!f)return;var aid='+JSON.stringify(agentId)+',fallback="/favicon.png";function setStatus(text,kind){status.textContent=text||"";status.className="agent-icon-status"+(kind?" "+kind:"")}b.addEventListener("click",function(){if(!b.disabled)f.click()});f.addEventListener("change",function(){var file=f.files&&f.files[0];if(file)upload(file)});async function upload(file){var allowed=["image/png","image/jpeg","image/webp","image/gif"];if(allowed.indexOf(file.type)===-1){setStatus('+JSON.stringify(T('web.agent.edit.icon_invalid'))+',"error");f.value="";return}if(file.size>500*1024){setStatus('+JSON.stringify(T('web.agent.edit.icon_too_large'))+',"error");f.value="";return}var previous=hidden.value||fallback,preview=URL.createObjectURL(file);img.src=preview;b.disabled=true;setStatus('+JSON.stringify(T('web.agent.edit.icon_uploading'))+',"pending");var fd=new FormData();fd.append("file",file,file.name);try{var r=await fetch("/api/agents/"+encodeURIComponent(aid)+"/icon",{method:"POST",body:fd});var j=await r.json();if(!r.ok||!j.success)throw new Error(j.error||'+JSON.stringify(T('web.agent.edit.icon_upload_failed'))+');hidden.value=j.iconUrl;var u=new URL(j.iconUrl,location.href);u.searchParams.set("_v",Date.now());img.src=u.href;setStatus('+JSON.stringify(T('web.agent.edit.icon_updated'))+',"success")}catch(e){img.src=previous;setStatus(e.message||'+JSON.stringify(T('web.agent.edit.icon_upload_failed'))+',"error")}finally{URL.revokeObjectURL(preview);b.disabled=false;f.value=""}}})();</script>'
      ,req.t,req.locale))
    }catch(e){next(e)}
  });

  // ── 发布状态 ──
  R.get('/agents/:agentId/status',async(req,res,next)=>{
    try{
      const T=req.t;
      const{agentId}=req.params;const agent=await getAgentInfo(handlers,agentId);if(!agent)return res.redirect('/');
      const pub=agent.publishStatus==='published';
      res.send(renderAgentFormPage(T('web.agent.status.title'),agentId,agent.agentName||agentId,
        '<p>'+T('web.agent.status.current')+'：<strong>'+(pub?T('common.pub.published'):T('web.agent.status.unpublished'))+'</strong></p>'+actionForm(agentId,'set_status',[
          {id:'st',name:'status',label:T('web.agent.status.action'),type:'select',options:pub?{'0':T('web.agent.status.unpub_opt')}:{'1':T('web.agent.status.pub_opt')}},
        ],T('common.btn.confirm'),null,'agent.status.set'),req.t,req.locale))
    }catch(e){next(e)}
  });

  // ── 白名单 ──
  R.get('/agents/:agentId/whitelist',async(req,res,next)=>{
    try{
      const T=req.t,L=k=>esc(T(k));
      const{agentId}=req.params;const page=parseInt(req.query.page,10)||1,keyword=req.query.keyword||'',limit=20,offset=(page-1)*limit;const agent=await getAgentInfo(handlers,agentId);if(!agent)return res.redirect('/');
      const prefill=esc(req.query.visitorId||'');
      let listHtml='<p class="meta">'+L('web.agent.whitelist.empty')+'</p>';var totalPages=0;
try{const r=await handlers.list_access_lists({agentId,listType:'whitelist',limit,offset,keyword});const es=r.data||r.entries||r.accessList||[],total=r.total||es.length;totalPages=Math.ceil(total/limit);let wlNickMap={};if(es.length){try{const vids=es.map(e=>e.visitor_id||e.visitorId||'').filter(Boolean);if(vids.length){const rows=db.prepare('SELECT uid, nickname FROM user_cache WHERE uid IN ('+vids.map(()=>'?').join(',')+')').all(...vids);rows.forEach(r=>{wlNickMap[r.uid]=r.nickname||'';});}}catch(_){}const wlName=(vid)=>{const n=wlNickMap[vid];return n?esc(n)+' ('+esc(vid)+')':esc(vid);};const wlSource=(e)=>e.source==='same_owner_default'?(e.auto_trust_disabled?'已关闭自动信任':'同一主人自动信任'):(e.source==='outbound_contact'?'主动联系自动加入':'手动添加');listHtml='<div class="table-wrap"><table><thead><tr><th>'+L('web.agent.whitelist.col.visitor')+'</th><th>来源</th><th>'+L('web.agent.whitelist.col.reason')+'</th><th style="text-align:center">'+L('web.agent.whitelist.col.action')+'</th></tr></thead><tbody>'+es.map(e=>'<tr><td>'+wlName(e.visitor_id||e.visitorId||'')+'</td><td>'+esc(wlSource(e))+'</td><td>'+esc(e.reason||'-')+'</td><td style="text-align:center"><form method="POST" action="/agents/'+esc(agentId)+'" data-voko-access-list style="display:inline"><input type="hidden" name="_action" value="remove_whitelist"><input type="hidden" name="visitorId" value="'+esc(e.visitor_id||e.visitorId||'')+'"><button type="submit" class="btn-xs btn-outline" style="margin:0;padding:2px 8px;font-size:11px;min-height:auto">'+L('common.btn.remove')+'</button></form></td></tr>').join('\n')+'</tbody></table></div>'}}catch{}
      const keywordEsc=esc(keyword);const kwParam=keywordEsc?'&keyword='+encodeURIComponent(keyword):'';var pgBar='';if(totalPages>1){pgBar='<div style="display:flex;align-items:center;justify-content:center;gap:12px;padding:8px 0;font-size:14px">';if(page>1)pgBar+='<a href="/agents/'+esc(agentId)+'/whitelist?page='+(page-1)+kwParam+'" class="btn-sm" style="padding:4px 12px">'+esc(T('web.payments.prev_page'))+'</a>';pgBar+='<span style="color:#666">'+esc(T('web.payments.page_of',{cur:page,total:totalPages}))+'</span>';if(page<totalPages)pgBar+='<a href="/agents/'+esc(agentId)+'/whitelist?page='+(page+1)+kwParam+'" class="btn-sm" style="padding:4px 12px">'+esc(T('web.payments.next_page'))+'</a>';pgBar+='</div>'}var searchBox='<form method="GET" action="/agents/'+esc(agentId)+'/whitelist" style="margin:8px 0;display:flex;align-items:center;gap:6px"><input type="text" name="keyword" value="'+keywordEsc+'" placeholder="'+esc(T('web.agent.wl_search_ph'))+'" style="width:200px;max-width:100%;margin:0;font-size:14px;padding:6px 10px">'+(keywordEsc?'<a href="/agents/'+esc(agentId)+'/whitelist" class="btn-sm btn-outline" style="margin:0;padding:6px 10px;min-width:auto;min-height:auto">✕</a>':'')+'<button type="submit" class="btn-sm" style="margin:0;padding:6px 12px;min-width:auto;min-height:auto" data-agent-action="agent.search">'+L('web.agent.search_btn')+'</button></form>';res.send(renderAgentFormPage(T('web.agent.whitelist.title'),agentId,agent.agentName||agentId,searchBox+listHtml+pgBar+'<h3>'+L('web.agent.whitelist.add_title')+'</h3>'+actionForm(agentId,'add_whitelist',[
        {id:'wv',name:'visitorId',label:T('web.agent.whitelist.col.visitor'),type:'text',val:prefill,attr:'required placeholder="'+esc(T('web.agent.whitelist.ph.visitor'))+'"'},
        {id:'wr',name:'reason',label:T('web.agent.whitelist.reason_opt'),type:'text'},
      ],T('common.btn.add'),'','whitelist.add',undefined,' data-voko-access-list'),req.t,req.locale))
    }catch(e){next(e)}
  });

  // ── 黑名单 ──
  R.get('/agents/:agentId/blacklist',async(req,res,next)=>{
    try{
      const T=req.t,L=k=>esc(T(k));
      const{agentId}=req.params;const page=parseInt(req.query.page,10)||1,keyword=req.query.keyword||'',limit=20,offset=(page-1)*limit;const agent=await getAgentInfo(handlers,agentId);if(!agent)return res.redirect('/');
      const prefill=esc(req.query.visitorId||'');
      let listHtml='<p class="meta">'+L('web.agent.blacklist.empty')+'</p>';
      let alreadyBlacklisted = false, totalPages = 0;
      try{const r=await handlers.list_access_lists({agentId,listType:'blacklist',limit,offset,keyword});const es=r.data||r.entries||r.accessList||[],total=r.total||es.length;totalPages=Math.ceil(total/limit);let blNickMap={};if(es.length){try{const vids=es.map(e=>e.visitor_id||e.visitorId||'').filter(Boolean);if(vids.length){const rows=db.prepare('SELECT uid, nickname FROM user_cache WHERE uid IN ('+vids.map(()=>'?').join(',')+')').all(...vids);rows.forEach(r=>{blNickMap[r.uid]=r.nickname||'';});}}catch(_){}const blName=(vid)=>{const n=blNickMap[vid];return n?esc(n)+' ('+esc(vid)+')':esc(vid);};listHtml='<div class="table-wrap"><table><thead><tr><th>'+L('web.agent.blacklist.col.visitor')+'</th><th>'+L('web.agent.blacklist.col.reason')+'</th><th style="text-align:center">'+L('web.agent.blacklist.col.action')+'</th></tr></thead><tbody>'+es.map(e=>'<tr><td>'+blName(e.visitor_id||e.visitorId||'')+'</td><td>'+esc(e.reason||'-')+'</td><td style="text-align:center"><form method="POST" action="/agents/'+esc(agentId)+'" data-voko-access-list style="display:inline"><input type="hidden" name="_action" value="remove_blacklist"><input type="hidden" name="visitorId" value="'+esc(e.visitor_id||e.visitorId||'')+'"><button type="submit" class="btn-xs btn-outline" style="margin:0;padding:2px 8px;font-size:11px;min-height:auto">'+L('common.btn.remove')+'</button></form></td></tr>').join('\n')+'</tbody></table></div>';if(prefill && es.some(e=>(e.visitor_id||e.visitorId||'')===prefill))alreadyBlacklisted=true}}catch{}
      const formTitle = alreadyBlacklisted ? T('web.agent.blacklist.remove_title') : T('web.agent.blacklist.add_title');
      const formBtn = alreadyBlacklisted ? T('common.bl.remove') : T('web.agent.blacklist.block_btn');
      const formAction = alreadyBlacklisted ? 'remove_blacklist' : 'add_blacklist';
      const formCls = alreadyBlacklisted ? '' : 'btn-danger';
      const formFields = alreadyBlacklisted
        ? [{id:'bv',name:'visitorId',label:T('web.agent.blacklist.col.visitor'),type:'text',val:prefill,attr:'required placeholder="'+esc(T('web.agent.blacklist.ph.visitor'))+'"'}]
        : [{id:'bv',name:'visitorId',label:T('web.agent.blacklist.col.visitor'),type:'text',val:prefill,attr:'required placeholder="'+esc(T('web.agent.blacklist.ph.visitor'))+'"'},
           {id:'br',name:'reason',label:T('web.agent.blacklist.reason_opt'),type:'text'}];
      const keywordEsc=esc(keyword);const kwParam=keywordEsc?'&keyword='+encodeURIComponent(keyword):'';var pgBar='';if(totalPages>1){pgBar='<div style="display:flex;align-items:center;justify-content:center;gap:12px;padding:8px 0;font-size:14px">';if(page>1)pgBar+='<a href="/agents/'+esc(agentId)+'/blacklist?page='+(page-1)+kwParam+'" class="btn-sm" style="padding:4px 12px">'+esc(T('web.payments.prev_page'))+'</a>';pgBar+='<span style="color:#666">'+esc(T('web.payments.page_of',{cur:page,total:totalPages}))+'</span>';if(page<totalPages)pgBar+='<a href="/agents/'+esc(agentId)+'/blacklist?page='+(page+1)+kwParam+'" class="btn-sm" style="padding:4px 12px">'+esc(T('web.payments.next_page'))+'</a>';pgBar+='</div>'}var searchBox='<form method="GET" action="/agents/'+esc(agentId)+'/blacklist" style="margin:8px 0;display:flex;align-items:center;gap:6px"><input type="text" name="keyword" value="'+keywordEsc+'" placeholder="'+esc(T('web.agent.bl_search_ph'))+'" style="width:200px;max-width:100%;margin:0;font-size:14px;padding:6px 10px">'+(keywordEsc?'<a href="/agents/'+esc(agentId)+'/blacklist" class="btn-sm btn-outline" style="margin:0;padding:6px 10px;min-width:auto;min-height:auto">✕</a>':'')+'<button type="submit" class="btn-sm" style="margin:0;padding:6px 12px;min-width:auto;min-height:auto" data-agent-action="agent.search">'+L('web.agent.search_btn')+'</button></form>';res.send(renderAgentFormPage(T('web.agent.blacklist.title'),agentId,agent.agentName||agentId,searchBox+listHtml+pgBar+'<h3>'+esc(formTitle)+'</h3>'+actionForm(agentId,formAction,formFields,formBtn,formCls,'blacklist.'+formAction,undefined,' data-voko-access-list'),req.t,req.locale))
    }catch(e){next(e)}
  });

  // ── 访问模式 ──
  R.get('/agents/:agentId/access-mode',async(req,res,next)=>{
    try{
      const T=req.t;
      const{agentId}=req.params;const agent=await getAgentInfo(handlers,agentId);if(!agent)return res.redirect('/');
      const priv=agent.accessMode==='private';
      res.send(renderAgentFormPage(T('web.agent.access.title'),agentId,agent.agentName||agentId,
        '<p>'+T('web.agent.access.current')+'：<strong>'+(priv?T('web.agent.access.private_desc'):T('web.agent.access.public_desc'))+'</strong></p>'+actionForm(agentId,'set_access_mode',[
          {id:'am',name:'enabled',label:T('web.agent.access.switch_to'),type:'select',options:priv?{false:T('web.agent.access.public_opt')}:{true:T('web.agent.access.private_opt')}},
        ],T('common.btn.switch'),null,'access.mode.set'),req.t,req.locale))
    }catch(e){next(e)}
  });

  // ── 订阅 ──
  R.get('/agents/:agentId/pricing',async(req,res,next)=>{
    try{
      const T=req.t;
      const{agentId}=req.params;const agent=await getAgentInfo(handlers,agentId);if(!agent)return res.redirect('/');
      let p={pricingModel:'free',price:null,durationMinutes:null};
      try{const pr=await handlers.agent_pricing({agentId});if(pr.pricingModel)p=pr}catch{}
      const curLabel=p.pricingModel==='free'?T('web.agent.pricing.free'):T('web.agent.pricing.paid',{price:p.price,duration:p.durationMinutes});
      res.send(renderAgentFormPage(T('web.agent.pricing.title'),agentId,agent.agentName||agentId,
        '<div class="card"><p>'+T('web.agent.pricing.current')+'：<strong>'+curLabel+'</strong></p>'+actionForm(agentId,'set_pricing',[
          {id:'pm',name:'pricingModel',label:T('web.agent.pricing.model'),type:'select',options:{free:T('web.agent.pricing.free_opt'),duration:T('web.agent.pricing.duration_opt')},val:p.pricingModel},
          {id:'pp',name:'price',label:T('web.agent.pricing.price'),type:'number',attr:'step="0.01" min="0"',val:p.price},
          {id:'pd',name:'durationMinutes',label:T('web.agent.pricing.duration'),type:'number',attr:'min="0"',val:p.durationMinutes},
        ],T('common.btn.save'),null,'agent.pricing.set')+'</div><p class="meta" style="margin-top:10px">'+T('web.agent.pricing.auth_hint')+'</p>',req.t,req.locale))
    }catch(e){next(e)}
  });

  // ── 能力声明 ──
  R.get('/agents/:agentId/caps',async(req,res,next)=>{
    try{
      const T=req.t,L=k=>esc(T(k));
      const{agentId}=req.params;const agent=await getAgentInfo(handlers,agentId);if(!agent)return res.redirect('/');
      let abilities=[];
      try{const r=await handlers.get_agent_profile({agentId});if(r.success&&r.data&&Array.isArray(r.data.ability))abilities=r.data.ability}catch{}
      const initial=JSON.stringify(abilities).replace(/</g,'\\u003c');
      res.send(renderAgentFormPage(T('web.agent.caps.title'),agentId,agent.agentName||agentId,
        '<p>'+T('web.agent.caps.intro')+'</p><form method="POST" action="/agents/'+esc(agentId)+'" id="caps-form" data-agent-action="agent.caps.declare"><input type="hidden" name="_action" value="declare_caps"><input type="hidden" name="ability" id="caps-json"><div id="caps-list"></div><button type="submit">'+L('web.agent.caps.declare_btn')+'</button></form>'
        +'<script>(function(){var list=document.getElementById("caps-list"),form=document.getElementById("caps-form"),initial='+initial+',labels='+JSON.stringify({name:T('web.agent.caps.name'),namePh:T('web.agent.caps.name_ph'),fields:T('web.agent.caps.fields'),fieldPh:T('web.agent.caps.field_ph'),addField:T('web.agent.caps.add_field'),remove:T('common.btn.remove'),removeCap:T('web.agent.caps.remove'),empty:T('web.agent.caps.empty')}).replace(/</g,'\\u003c')+';function esc4(s){return String(s==null?"":s).replace(/[&<>"\']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",\'"\':"&quot;","\'":"&#39;"}[c]})}function meta(v){return encodeURIComponent(JSON.stringify(v||{}))}function field(f){f=f||{};return \'<div class="cap-field" data-meta="\'+meta(f)+\'" style="display:flex;gap:10px;align-items:center;margin:8px 0"><input class="cf-name" value="\'+esc4(f.name||"")+\'" placeholder="\'+esc4(labels.fieldPh)+\'" required style="flex:1;max-width:none;margin:0"><button type="button" class="cap-remove-field" style="margin:0;padding:8px 14px;min-width:0;background:#f5e9ff;color:#b067e8;border:1px solid #d8b4fe">\'+esc4(labels.remove)+"</button></div>"}function capability(c){c=c||{};var el=document.createElement("div");el.className="card cap-card";el.dataset.meta=meta(c);el.style.cssText="padding:20px;border-radius:10px;margin:14px 0";el.innerHTML=\'<label style="margin-top:0">\'+esc4(labels.name)+\'</label><input class="cap-name" value="\'+esc4(c.name||"")+\'" placeholder="\'+esc4(labels.namePh)+\'" required style="max-width:none"><div style="padding:8px 28px 0"><label>\'+esc4(labels.fields)+\'</label><div class="cap-fields"></div><button type="button" class="cap-add-field" style="margin:4px 0 0;padding:0;min-width:0;background:none;border:0;color:#5b7cfa;font-size:15px">+ \'+esc4(labels.addField)+\'</button></div><div style="display:flex;justify-content:flex-end;margin-top:10px"><button type="button" class="cap-remove" style="margin:0;padding:9px 18px;min-width:0;background:#ef5350;border-color:#e53935">\'+esc4(labels.removeCap)+"</button></div>";var fs=el.querySelector(".cap-fields");(Array.isArray(c.fields)?c.fields:[]).forEach(function(x){fs.insertAdjacentHTML("beforeend",field(x))});return el}function add(c){list.appendChild(capability(c))}if(initial.length)initial.forEach(add);else list.innerHTML=\'<p class="meta" id="caps-empty">\'+esc4(labels.empty)+"</p>";document.getElementById("caps-add").onclick=function(){var e=document.getElementById("caps-empty");if(e)e.remove();add({})};list.addEventListener("click",function(e){var b=e.target.closest("button");if(!b)return;if(b.classList.contains("cap-remove"))b.closest(".cap-card").remove();if(b.classList.contains("cap-add-field"))b.previousElementSibling.insertAdjacentHTML("beforeend",field({}));if(b.classList.contains("cap-remove-field"))b.closest(".cap-field").remove()});form.addEventListener("submit",function(){var data=Array.from(list.querySelectorAll(".cap-card")).map(function(c){var out={};try{out=JSON.parse(decodeURIComponent(c.dataset.meta))}catch(_){}out.name=c.querySelector(".cap-name").value.trim();out.fields=Array.from(c.querySelectorAll(".cap-field")).map(function(f){var x={type:"string"};try{x=JSON.parse(decodeURIComponent(f.dataset.meta))}catch(_){}x.name=f.querySelector(".cf-name").value.trim();return x});return out});document.getElementById("caps-json").value=JSON.stringify(data)});})();</script>',req.t,req.locale,{headerAction:'<button type="button" id="caps-add" class="btn-sm btn-outline" style="margin:0">'+L('web.agent.caps.add')+'</button>'}))
    }catch(e){next(e)}
  });

  // ── 邀请好友 ──
  R.get('/agents/:agentId/invite',async(req,res,next)=>{
    try{
      const T=req.t;
      const{agentId}=req.params;const agent=await getAgentInfo(handlers,agentId);if(!agent)return res.redirect('/');
      res.send(renderAgentFormPage(T('web.agent.invite.title'),agentId,agent.agentName||agentId,
        actionForm(agentId,'invite',[
          {id:'fe',name:'friendEmail',label:T('web.agent.invite.email'),type:'email',attr:'required placeholder="friend@example.com"'},
        ],T('web.agent.invite.send_btn'),null,'agent.invite.send')
        +inviteConfirmUi(T,'form[data-agent-action="agent.invite.send"]'),req.t,req.locale))
    }catch(e){next(e)}
  });

  // ── 人工介入 ──
  R.get('/agents/:agentId/human',async(req,res,next)=>{
    try{
      const T=req.t,L=k=>esc(T(k));
      const{agentId}=req.params;const agent=await getAgentInfo(handlers,agentId);if(!agent)return res.redirect('/');
      res.send(renderAgentFormPage(T('web.agent.human.title'),agentId,agent.agentName||agentId,
        '<div class="card"><h3>'+L('web.agent.human.request_title')+'</h3>'+actionForm(agentId,'ask_human',[
          {id:'hv',name:'visitorId',label:T('web.agent.human.visitor'),type:'text',val:esc(req.query.visitorId||''),attr:'required placeholder="'+esc(T('web.agent.human.visitor_ph'))+'"'},
          {id:'hp',name:'problem',label:T('web.agent.human.problem'),type:'textarea',attr:'rows="3" required placeholder="'+esc(T('web.agent.human.problem_ph'))+'"'},
          {id:'hs',name:'suggestion',label:T('web.agent.human.suggestion'),type:'textarea',attr:'rows="2" placeholder="'+esc(T('web.agent.human.suggestion_ph'))+'"'},
        ],T('web.agent.human.submit_btn'),null,'human.ask')+'</div><p class="meta" style="margin-top:10px">'+T('web.agent.human.view_replies_hint')+'</p>',req.t,req.locale))
    }catch(e){next(e)}
  });

  // ── 访客查询 ──
  R.get('/agents/:agentId/visitor',async(req,res,next)=>{
    try{
      const T=req.t,L=k=>esc(T(k));
      const{agentId}=req.params;const agent=await getAgentInfo(handlers,agentId);if(!agent)return res.redirect('/');
      let result='';
      if(req.query.uid){
        try{
          const r=await handlers.get_visitor_profile({visitorId:req.query.uid,agentId});
          if(r&&r.success!==false&&r.visitorId){
            // handler 返回扁平结构（字段在顶层，无 profile 嵌套）
            const recent=(r.recentMessages||[]).slice(0,5).map(function(m){
              const role=m.isMe?'<span style="color:#07c160">'+L('web.conversation.from.agent')+'</span>':'<span style="color:#888">'+L('web.conversation.from.visitor')+'</span>';
              const t=m.timestamp?timeTag(m.timestamp):'';
              const c=esc((m.content||'').substring(0,120)+(m.content&&m.content.length>120?'…':''));
              return '<tr><td style="white-space:nowrap;font-size:13px;text-align:center">'+role+'</td><td style="font-size:13px;white-space:normal;word-break:break-word">'+c+'</td><td class="meta" style="white-space:nowrap;font-size:13px;text-align:center">'+t+'</td></tr>';
            }).join('');
            result='<div class="card"><h3>'+T('web.agent.visitor.profile_title',{name:esc(r.nickname||r.visitorId)})+'</h3><div class="table-wrap"><table>'
              +'<tr><th>UID</th><td>'+esc(r.visitorId)+'</td></tr>'
              +'<tr><th>'+L('web.agent.visitor.total')+'</th><td>'+(r.totalMessages||0)+'</td></tr>'
              +'<tr><th>'+L('web.agent.visitor.first')+'</th><td>'+(r.firstMessageAt?timeTag(r.firstMessageAt):'-')+'</td></tr>'
              +'<tr><th>'+L('web.agent.visitor.last')+'</th><td>'+(r.lastMessageAt?timeTag(r.lastMessageAt):'-')+'</td></tr>'
              +'<tr><th>'+L('web.agent.visitor.whitelisted')+'</th><td>'+(r.isWhitelisted?T('web.agent.visitor.yes'):T('web.agent.visitor.no'))+'</td></tr>'
              +'<tr><th>'+L('web.agent.visitor.blacklisted')+'</th><td>'+(r.isBlacklisted?T('web.agent.visitor.yes'):T('web.agent.visitor.no'))+'</td></tr>'
              +'</table></div>'+(recent?'<h3 style="margin-top:14px">'+L('web.agent.visitor.recent')+'</h3><div class="table-wrap"><table><thead><tr><th style="text-align:center">'+L('web.agent.visitor.col.dir')+'</th><th>'+L('web.agent.visitor.col.content')+'</th><th style="text-align:center">'+L('web.agent.visitor.col.time')+'</th></tr></thead><tbody>'+recent+'</tbody></table></div>':'')+'</div>';
          }else result='<p class="meta">'+L('web.agent.visitor.not_found')+'</p>'
        }catch{result='<p class="error">'+L('web.agent.visitor.query_failed')+'</p>'}
      }
      res.send(renderAgentFormPage(T('web.agent.visitor.title'),agentId,agent.agentName||agentId,
        '<div class="card"><form method="GET" action="/agents/'+esc(agentId)+'/visitor"><label for="vu">'+L('web.agent.visitor.col.id')+'</label><input type="text" id="vu" name="uid" value="'+esc(req.query.uid||'')+'" required placeholder="'+esc(T('web.agent.visitor.ph'))+'"><button type="submit" style="margin-left:8px">'+L('common.btn.search')+'</button></form></div>'+result,req.t,req.locale))
    }catch(e){next(e)}
  });

  // ── 添加并发送附件 ──
  R.get('/agents/:agentId/upload',async(req,res,next)=>{
    try{
      const T=req.t,L=k=>esc(T(k));
      const{agentId}=req.params;const agent=await getAgentInfo(handlers,agentId);if(!agent)return res.redirect('/');
      const aid=esc(agentId);
      const rawToUid=String(req.query.toUid||'');
      const prefillChannelType=Number(req.query.channelType)===2?'2':'1';
      let recipientName='';
      if(rawToUid&&prefillChannelType==='2'){
        try{const g=await handlers.get_group_context({agentId,channelId:rawToUid,limit:1});if(g&&g.success)recipientName=String(g.groupName||g.name||'')}catch(_){}
        if(!recipientName)try{const r=db.prepare('SELECT name FROM conversations WHERE channel_id=? AND channel_type=2 AND name IS NOT NULL LIMIT 1').get(rawToUid);if(r&&r.name!==rawToUid)recipientName=String(r.name)}catch(_){}
      }else if(rawToUid){
        try{const r=db.prepare('SELECT agent_name FROM agents WHERE imUid=? LIMIT 1').get(rawToUid);if(r&&r.agent_name)recipientName=String(r.agent_name)}catch(_){}
        if(!recipientName)try{const r=db.prepare('SELECT nickname FROM user_cache WHERE uid=? LIMIT 1').get(rawToUid);if(r&&r.nickname)recipientName=String(r.nickname)}catch(_){}
        if(!recipientName)try{const r=db.prepare('SELECT name FROM conversations WHERE channel_id=? AND channel_type=1 AND name IS NOT NULL LIMIT 1').get(rawToUid);if(r&&r.name!==rawToUid)recipientName=String(r.name)}catch(_){}
      }
      const prefillRecipient=esc(recipientName||rawToUid);
      const returnPath=rawToUid?'/agents/'+encodeURIComponent(agentId)+'/'+(prefillChannelType==='2'?'g':'c')+'/'+encodeURIComponent(rawToUid):'/agents/'+encodeURIComponent(agentId);
      res.send(renderPage(req,T('web.agent.upload.title'),
        '<style>.upload-zone{border:2px dashed #bbb;border-radius:8px;padding:24px;text-align:center;cursor:pointer;transition:border-color .2s}.upload-zone:hover,.upload-zone.drag-over{border-color:#1a73e8;background:#e8f0fe}#upload-file{display:none}.upload-zone p{margin:4px 0;font-size:14px;color:#666}#upload-filename{margin-top:8px}#upload-progress{display:none;margin:8px 0;font-size:14px;color:#1a73e8}#upload-result{margin-top:10px;font-size:14px}#upload-result .url-box{word-break:break-all;background:#f0f0f0;padding:8px;border-radius:4px;margin:4px 0}</style>'+
        '<div class="card"><h3>📎 '+L('web.agent.upload.browser_title')+'</h3>'+
        '<div class="upload-zone" id="upload-zone"><p><strong>'+L('web.agent.upload.click')+'</strong> '+L('web.agent.upload.drag')+'</p><p style="font-size:12px;color:#999">'+L('web.agent.upload.hint')+'</p></div>'+
        '<input type="file" id="upload-file" accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.zip,.mp3,.mp4,.txt,.json,.webp,.gif">'+
        '<label for="upload-to">'+L('web.agent.upload.to_uid')+'</label><input type="text" id="upload-to" value="'+prefillRecipient+'" data-to-uid="'+esc(rawToUid)+'" data-initial-display="'+prefillRecipient+'" required placeholder="'+L('web.agent.upload.to_uid_ph')+'">'+
        '<input type="hidden" id="upload-channel-type" value="'+prefillChannelType+'">'+
        '<label for="upload-message">'+L('web.agent.upload.message')+'</label><textarea id="upload-message" rows="2" placeholder="'+L('web.agent.upload.message_ph')+'"></textarea>'+
        '<input type="text" id="upload-filename" placeholder="'+esc(T('web.agent.upload.name_ph'))+'" style="margin-top:8px;display:block">'+
        '<button id="upload-submit-btn" disabled style="margin-top:8px">'+L('web.agent.upload.submit_btn')+'</button>'+
        '<div id="upload-progress">'+L('web.agent.upload.uploading')+'</div>'+
        '<div id="upload-result"></div></div>'+
        '<p class="meta">'+L('web.agent.upload.send_hint')+'</p>'+
        '<script>'+
        '(function(){'+
          'var z=document.getElementById("upload-zone"),f=document.getElementById("upload-file"),'+
          'btn=document.getElementById("upload-submit-btn"),prog=document.getElementById("upload-progress"),'+
          'resDiv=document.getElementById("upload-result"),fn=document.getElementById("upload-filename"),to=document.getElementById("upload-to"),ct=document.getElementById("upload-channel-type"),msg=document.getElementById("upload-message");'+
          'var selectedFile=null,uploading=false,idleBtnHtml=btn.innerHTML;'+
          'z.addEventListener("click",function(){if(!uploading)f.click()});'+
          'z.addEventListener("dragover",function(e){e.preventDefault();z.classList.add("drag-over")});'+
          'z.addEventListener("dragleave",function(){z.classList.remove("drag-over")});'+
          'z.addEventListener("drop",function(e){e.preventDefault();z.classList.remove("drag-over");if(!uploading)handleFiles(e.dataTransfer.files)});'+
          'f.addEventListener("change",function(){if(!uploading)handleFiles(f.files)});'+
          'function handleFiles(files){if(uploading)return;if(files.length){selectedFile=files[0];z.innerHTML="<p><strong>"+esc2(selectedFile.name)+"</strong></p><p style=\\"font-size:12px;color:#999\\">"+(selectedFile.size/1024).toFixed(1)+" KB</p>";btn.disabled=false}}'+
          'btn.addEventListener("click",async function(){if(uploading||!selectedFile)return;if(!to.value.trim()){to.focus();return}uploading=true;var file=selectedFile,uploadName=fn.value||selectedFile.name;btn.disabled=true;btn.setAttribute("aria-busy","true");btn.innerHTML=\'<span class="voko-spinner" aria-hidden="true"></span>\'+'+JSON.stringify(T('web.agent.upload.uploading'))+';f.disabled=true;fn.disabled=true;to.disabled=true;ct.disabled=true;msg.disabled=true;z.setAttribute("aria-busy","true");z.style.opacity=".55";z.style.cursor="not-allowed";prog.style.display="block";resDiv.innerHTML="";'+
            'var fd=new FormData();fd.append("file",file,uploadName);'+
            'var initialDisplay=to.getAttribute("data-initial-display")||"",storedUid=to.getAttribute("data-to-uid")||"",recipient=to.value.trim()===initialDisplay&&storedUid?storedUid:to.value.trim();var params=new URLSearchParams({toUid:recipient,channelType:ct.value,message:msg.value.trim()});'+
            'try{var r=await fetch("/api/agents/'+aid+'/send-file?"+params,{method:"POST",body:fd});var j=await r.json();'+
              'if(j.success){location.href='+JSON.stringify(returnPath)+';return}'+
              'else{resDiv.innerHTML="<p class=\\"error\\">❌ "+esc2(j.error||"上传失败")+"</p>"}'+
            '}catch(e){resDiv.innerHTML="<p class=\\"error\\">❌ 网络错误: "+esc2(e.message)+"</p>"}'+
            'finally{uploading=false;if(selectedFile)btn.disabled=false;btn.removeAttribute("aria-busy");btn.innerHTML=idleBtnHtml;f.disabled=false;fn.disabled=false;to.disabled=false;ct.disabled=false;msg.disabled=false;z.removeAttribute("aria-busy");z.style.opacity="";z.style.cursor="";prog.style.display="none"}'+
          '});'+
          'function esc2(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}'+
        '})();</script>'+
        '<p style="margin-top:12px"><a href="/agents/'+aid+'">'+T('common.btn.back_to_agent',{name:esc(agent.agentName||agentId)})+'</a></p>',
      {nav:agentNav(agentId,agent.agentName||agentId,T)}))
    }catch(e){next(e)}
  });

  // 附件发送 API — 浏览器上传后立即发送
  R.post('/api/agents/:agentId/send-file', async (req, res) => {
    try {
      const { agentId } = req.params;
      const buf = req.rawBody;
      if (!buf) return res.json({ success: false, error: '未接收到文件数据' });
      const contentType = req.headers['content-type'] || '';
      const boundaryMatch = contentType.match(/boundary=(.+)/);
      if (!boundaryMatch) return res.json({ success: false, error: '无效的上传请求' });
      const boundary = boundaryMatch[1];
      const str = buf.toString('binary');
      const parts = str.split('--' + boundary);
      let filedata = null, filename = '';
      for (const part of parts) {
        if (part.includes('Content-Disposition') && part.includes('filename=')) {
          const headerEnd = part.indexOf('\r\n\r\n');
          const headers = part.slice(0, headerEnd);
          const bodyContent = part.slice(headerEnd + 4);
          const endIdx = bodyContent.lastIndexOf('\r\n');
          const fc = endIdx > 0 ? bodyContent.slice(0, endIdx) : bodyContent;
          const fnMatch = headers.match(/filename="([^"]*)"/);
          filename = fnMatch ? fnMatch[1] : 'upload';
          filedata = Buffer.from(fc, 'binary');
          break;
        }
      }
      if (!filedata) return res.json({ success: false, error: '未找到上传文件' });
      const path = require('path');
      const uploadDir = require('fs').mkdtempSync(path.join(require('os').tmpdir(), 'voko-upload-'));
      // 净化 filename：basename 剥离目录 + 剔除残留分隔符与 ..，防路径穿越写任意路径
      const safeName = path.basename(filename || 'upload').replace(/[\\/:]/g, '').replace(/\.\./g, '').trim() || 'upload';
      const tmpPath = path.join(uploadDir, safeName);
      try {
        require('fs').writeFileSync(tmpPath, filedata, { flag: 'wx', mode: 0o600 });
        const result = await handlers.upload_and_send_file({
          agentId,
          toUid: String(req.query.toUid||''),
          channelType: Number(req.query.channelType)===2?2:1,
          message: String(req.query.message||''),
          filePath: tmpPath,
          fileName: filename,
        });
        require('fs').rmSync(uploadDir, { recursive: true, force: true });
        res.json(result);
      } catch (e) {
        try { require('fs').rmSync(uploadDir, { recursive: true, force: true }); } catch (_) {}
        res.json({ success: false, error: '上传到 OSS 失败: ' + e.message });
      }
    } catch (e) {
      res.json({ success: false, error: e.message });
    }
  });

  R.post('/api/agents/:agentId/icon',async(req,res)=>{
    try{
      const file=parseMultipartFile(req);
      if(!file)return res.status(400).json({success:false,error:req.t('web.agent.edit.icon_upload_invalid')});
      if(file.data.length>500*1024)return res.status(413).json({success:false,error:req.t('web.agent.edit.icon_too_large')});
      const type=detectAgentIconType(file.data);
      if(!type)return res.status(400).json({success:false,error:req.t('web.agent.edit.icon_invalid')});
      const objectName='agent-icons/'+require('crypto').randomUUID()+'.'+type.ext;
      const uploader=typeof opts.uploadAgentIcon==='function'?opts.uploadAgentIcon:async(data,name,mime)=>require('../server/oss').uploadToOSS(name,data,mime);
      const iconUrl=await uploader(file.data,objectName,type.mime);
      const updated=await handlers.update_agent_profile({agentId:req.params.agentId,iconUrl});
      if(updated?.success===false||updated?.error)return res.status(502).json({success:false,error:updated.error||req.t('web.agent.edit.icon_upload_failed')});
      return res.json({success:true,iconUrl});
    }catch(e){return res.status(500).json({success:false,error:e.message||req.t('web.agent.edit.icon_upload_failed')})}
  });

  R.post('/api/web/agents/restart',requireSensitiveLocalAuth,requireSensitiveCsrf,async(req,res)=>{
    try{
      if(typeof handlers.restart_agent_runtime!=='function')return res.status(503).json({success:false,error:'Agent runtime restart is unavailable'});
      const result=await handlers.restart_agent_runtime();
      return res.status(result?.success===false?500:200).json(result);
    }catch(e){return res.status(500).json({success:false,error:e.message})}
  });

  // ══════════════════════════════════════════════════════════
  //  操作 POST 处理（统一入口 /agents/:agentId）
  // ══════════════════════════════════════════════════════════

  R.post('/agents/:agentId',async(req,res,next)=>{
    try{
      const{agentId}=req.params;const a=req.body._action;
      try{
        switch(a){
          case'update_profile':await handleAction(req,res,handlers.update_agent_profile({
            agentId,name:req.body.name||undefined,description:req.body.description||undefined,
            short_description:req.body.short_description||undefined,category:req.body.category||undefined,
            tags:req.body.tags?JSON.stringify(req.body.tags.replace(/，/g,',').split(',').map(t=>t.trim()).filter(Boolean)):undefined,iconUrl:req.body.iconUrl||undefined,
            address:req.body.address||undefined,contact_phone:req.body.contact_phone||undefined,
            backendType:req.body.backendType||undefined
          }),'common.action.profile_updated');break;
          case'set_status':await handleAction(req,res,handlers.set_agent_status({agentId,status:parseInt(req.body.status,10)}),'common.action.status_updated');break;
          case'add_whitelist':await handleAction(req,res,handlers.manage_whitelist({agentId,action:'add',visitorId:req.body.visitorId,reason:req.body.reason||''}),'common.action.whitelist_added');break;
          case'add_blacklist':await handleAction(req,res,handlers.manage_blacklist({agentId,action:'add',visitorId:req.body.visitorId,reason:req.body.reason||''}),'common.action.blacklist_added');break;
          case'remove_blacklist':await handleAction(req,res,handlers.manage_blacklist({agentId,action:'remove',visitorId:req.body.visitorId}),'common.action.blacklist_removed');break;
          case'remove_whitelist':await handleAction(req,res,handlers.manage_whitelist({agentId,action:'remove',visitorId:req.body.visitorId}),'common.action.whitelist_removed');break;
          case'set_access_mode':await handleAction(req,res,handlers.set_private_mode({agentId,enabled:req.body.enabled==='true'}),'common.action.access_mode_changed');break;
          case'declare_caps':{
            let ab;try{ab=JSON.parse(req.body.ability)}catch{ab=req.body.ability}
            const r=await handlers.declare_capabilities({agentId,ability:ab});
            if(r.success===false||r.error)return res.redirect(actionResultLocation('/','err',r.error||req.t('common.action.failed')));
            return res.redirect(actionResultLocation('/','ok',req.t('common.action.caps_declared')))
          }
          case'set_pricing':await handleAction(req,res,handlers.agent_pricing({
            agentId,pricingModel:req.body.pricingModel||'free',
            price:req.body.price?parseFloat(req.body.price):undefined,
            durationMinutes:req.body.durationMinutes?parseInt(req.body.durationMinutes,10):undefined
          }),'common.action.pricing_updated');break;
          case'invite':{
            const r=await handlers.invite_friend({agentId,friendEmail:req.body.friendEmail});
            const back=actionReturnPath(req);
            if(r.success===false)return res.redirect(actionResultLocation(back,'err',r.error||req.t('common.action.failed')));
            if(r.result==='already_registered'){
              const email=r.email||req.body.friendEmail||'';
              return res.redirect('/capabilities?agentId='+encodeURIComponent(agentId)+'&q='+encodeURIComponent(email)+'&inviteResult=already_registered');
            }
            const key='web.invite.result.'+r.result;
            const level=r.result==='email_failed'?'warn':'ok';
            return res.redirect(actionResultLocation(back,level,req.t(key,{email:r.email||req.body.friendEmail})));
          }
          case'ask_human':await handleAction(req,res,handlers.ask_human_for_help({
            agentId,visitorId:req.body.visitorId,problem:req.body.problem,suggestion:req.body.suggestion||''
          }),'common.action.human_requested');break;
          default:res.redirect('/agents/'+esc(agentId)+'?err='+encodeURIComponent(req.t('common.action.unknown')))
        }
      }catch(e){res.redirect(a==='declare_caps'?actionResultLocation('/','err',e.message):'/agents/'+esc(agentId)+'?err='+encodeURIComponent(e.message))}
    }catch(e){next(e)}
  });

  // AJAX: 切换上下架状态
  R.post('/api/agents/:agentId/status', async (req, res) => {
    try {
      const { agentId } = req.params;
      const r = await handlers.set_agent_status({ agentId, status: req.body.status });
      if (r.success !== false && r.error === undefined) {
        const pub = req.body.status === 1;
        res.json({ success: true, label: pub ? req.t('common.pub.published') : req.t('common.pub.unpublished'), cls: pub ? 'online' : 'pending',
          titlePub: req.t('common.pub.title_published'),
          titleUnpub: req.t('common.pub.title_unpublished'),
          pubStatus: pub ? 'published' : 'unpublished' });
      } else {
        res.json({ success: false, error: r.error || req.t('common.action.failed') });
      }
    } catch (e) { res.json({ success: false, error: e.message }); }
  });

  // AJAX: 切换访问模式
  R.post('/api/agents/:agentId/access-mode', async (req, res) => {
    try {
      const { agentId } = req.params;
      const r = await handlers.set_private_mode({ agentId, enabled: req.body.enabled });
      if (r.success !== false && r.error === undefined) {
        const priv = req.body.enabled;
        res.json({ success: true, label: priv ? req.t('common.acc.private') : req.t('common.acc.public'), cls: priv ? 'online' : 'pending',
          titlePriv: req.t('common.acc.title_private'),
          titlePub: req.t('common.acc.title_public'),
          accMode: priv ? 'private' : 'public' });
      } else {
        res.json({ success: false, error: r.error || req.t('common.action.failed') });
      }
    } catch (e) { res.json({ success: false, error: e.message }); }
  });

  // AJAX: 通用 Agent 操作（白名单/黑名单/资料/能力/定价/人工介入）
  R.post('/api/agents/:agentId/action', async (req, res) => {
    try {
      const { agentId } = req.params;
      const { _action, ...params } = req.body;
      let r;
      switch (_action) {
        case 'update_profile':
          r = await handlers.update_agent_profile({ agentId,
            name: params.name, description: params.description,
            short_description: params.short_description, category: params.category,
            tags: params.tags, iconUrl: params.iconUrl,
            address: params.address, contact_phone: params.contact_phone,
            backendType: params.backendType });
          break;
        case 'add_whitelist':
          r = await handlers.manage_whitelist({ agentId, action: 'add', visitorId: params.visitorId, reason: params.reason || '' });
          break;
        case 'remove_whitelist':
          r = await handlers.manage_whitelist({ agentId, action: 'remove', visitorId: params.visitorId });
          break;
        case 'add_blacklist':
          r = await handlers.manage_blacklist({ agentId, action: 'add', visitorId: params.visitorId, reason: params.reason || '' });
          break;
        case 'remove_blacklist':
          r = await handlers.manage_blacklist({ agentId, action: 'remove', visitorId: params.visitorId });
          break;
        case 'declare_caps':
          r = await handlers.declare_capabilities({ agentId, ability: params.ability });
          break;
        case 'set_pricing':
          r = await handlers.agent_pricing({ agentId, pricingModel: params.pricingModel, price: params.price, durationMinutes: params.durationMinutes });
          break;
        case 'ask_human':
          r = await handlers.ask_human_for_help({ agentId, visitorId: params.visitorId, problem: params.problem, suggestion: params.suggestion });
          break;
        case 'set_status':
          r = await handlers.set_agent_status({ agentId, status: parseInt(params.status, 10) });
          break;
        case 'set_access_mode':
          r = await handlers.set_private_mode({ agentId, enabled: params.enabled === 'true' || params.enabled === true });
          break;
        default: return res.json({ success: false, error: '未知操作: ' + (_action || '') });
      }
      if (r && r.success !== false && r.error === undefined) {
        res.json({ success: true, ...r });
      } else {
        res.json({ success: false, error: (r && r.error) || '操作失败' });
      }
    } catch (e) { res.json({ success: false, error: e.message }); }
  });

  // AJAX: 审核规则增删改
  R.post('/api/audit-rules', async (req, res) => {
    try {
      const r = await handlers.manage_audit_rules(req.body);
      res.json(r.success !== false && r.error === undefined ? { success: true, ...r } : { success: false, error: r.error || '操作失败' });
    } catch (e) { res.json({ success: false, error: e.message }); }
  });
  R.post('/api/audit-rules/:id/delete', async (req, res) => {
    try {
      const r = await handlers.manage_audit_rules({ action: 'delete', ruleId: req.params.id });
      res.json(r.success !== false ? { success: true } : { success: false, error: r.error || '删除失败' });
    } catch (e) { res.json({ success: false, error: e.message }); }
  });

  // ══════════════════════════════════════════════════════════
  //  全局功能页面
  // ══════════════════════════════════════════════════════════

  // ── 人工介入列表 ──
  R.get('/interventions',async(req,res,next)=>{
    try{
      const T=req.t,L=k=>esc(T(k));
      const curPage=Math.max(1,parseInt(req.query.page,10)||1);
      const limit=Math.min(50,Math.max(5,parseInt(req.query.limit,10)||10));
      const offset=(curPage-1)*limit;
      const keyword=req.query.q||'';
      const filterAgentId=req.query.agentId||'';

      // 查询 Agent 名称映射
      const nameMap={};
      try{if(db){const na=db.prepare("SELECT agent_id,agent_name FROM agents").all();for(const n of na)nameMap[n.agent_id]=n.agent_name||n.agent_id}}catch{}

      // Agent 下拉选项
      let agentOpts='';
      try{
        let oe='';const rtRow=db.prepare("SELECT data FROM config WHERE type='runtime'").get();if(rtRow){const d=JSON.parse(rtRow.data);oe=d.userEmail||''}if(!oe){const tkRow=db.prepare("SELECT data FROM config WHERE type='user_access_token'").get();if(tkRow){const d2=JSON.parse(tkRow.data);const ks=Object.keys(d2);if(ks.length)oe=ks[0]}}
        const w=await handlers.whoami(oe?{ownerEmail:oe}:{});const ags=w.agents||[];
        for(const a of ags)agentOpts+='<option value="'+esc(a.agentId)+'"'+(filterAgentId===a.agentId?' selected':'')+'>'+esc(a.agentName||a.agentId)+'</option>'
      }catch{}

      let rowsHtml='<tr><td colspan="5" class="meta" style="text-align:center">'+L('web.interventions.empty')+'</td></tr>';
      let total=0,totalPages=0;

      if(db){
        // 构造搜索条件
        let where='1=1';const params=[];
        if(keyword){
          where='(oi.agent_id LIKE ? OR oi.visitor_id LIKE ? OR oi.problem LIKE ? OR oi.status LIKE ? OR a.agent_name LIKE ?)';
          const kw='%'+keyword+'%';params.push(kw,kw,kw,kw,kw)
        }
        // 按当前用户过滤
        let ownerEmail='';
        try{
          const rtRow=db.prepare("SELECT data FROM config WHERE type='runtime'").get();
          if(rtRow)try{const d=JSON.parse(rtRow.data);ownerEmail=d.userEmail||''}catch{}
          if(!ownerEmail){
            const tkRow=db.prepare("SELECT data FROM config WHERE type='user_access_token'").get();
            if(tkRow)try{const d=JSON.parse(tkRow.data);const ks=Object.keys(d);if(ks.length)ownerEmail=ks[0]}catch{}
          }
        }catch{}
        if(filterAgentId){where+=' AND oi.agent_id=?';params.push(filterAgentId)}
        if(ownerEmail){where+=' AND a.owner_email=?';params.push(ownerEmail)}
        // 总数
        const countRow=db.prepare('SELECT COUNT(*) as c FROM owner_interventions oi LEFT JOIN agents a ON oi.agent_id=a.agent_id WHERE '+where).get(...params);
        total=countRow?countRow.c:0;
        totalPages=Math.ceil(total/limit);

        const items=db.prepare('SELECT oi.*,a.agent_name FROM owner_interventions oi LEFT JOIN agents a ON oi.agent_id=a.agent_id WHERE '+where+' ORDER BY oi.ask_time DESC LIMIT ? OFFSET ?').all(...params,limit,offset);
        // 补昵称
        let intvNickMap={};
        if(items.length){try{const vids=[...new Set(items.map(r=>r.visitor_id).filter(Boolean))];if(vids.length){const rows=db.prepare('SELECT uid, nickname FROM user_cache WHERE uid IN ('+vids.map(()=>'?').join(',')+')').all(...vids);rows.forEach(r=>{intvNickMap[r.uid]=r.nickname||'';});}}catch(_){}}
        if(items.length)rowsHtml=items.map(r=>{
          const aname=r.agent_name||nameMap[r.agent_id]||r.agent_id||'';
          const prob=esc((r.problem||'').substring(0,100));
          const statusCell=r.skip_reply?L('web.interventions.status.no_reply'):(r.owner_reply?L('web.interventions.reply.done'):L('web.interventions.reply.pending'));
          const vn=intvNickMap[r.visitor_id];const member=vn?esc(vn)+' ('+esc(r.visitor_id)+')':esc(r.visitor_id||'');const vd=Number(r.target_channel_type)===2?esc(r.target_channel_id||'')+' / '+member:member;
          return '<tr><td>'+esc(aname)+'</td><td>'+vd+'</td><td style="max-width:200px;word-break:break-word;white-space:normal">'+prob+'</td><td class="meta" style="white-space:nowrap">'+timeTag(r.ask_time)+'</td><td style="white-space:nowrap;text-align:center">'+statusCell+'</td></tr>'
        }).join('\n')
      }

      // 翻页链接
      let pagination='';
      const qs=(keyword?'&q='+encodeURIComponent(keyword):'')+(filterAgentId?'&agentId='+encodeURIComponent(filterAgentId):'');
      if(totalPages>1){
        pagination='<div style="display:flex;gap:8px;align-items:center;margin:8px 0;font-size:14px">';
        if(curPage>1)pagination+='<a href="/interventions?page='+(curPage-1)+'&limit='+limit+qs+'" class="btn btn-sm">'+L('web.interventions.prev_page')+'</a>';
        pagination+='<span style="color:#888">'+T('web.interventions.page_count',{cur:curPage,total:totalPages,count:total})+'</span>';
        if(curPage<totalPages)pagination+='<a href="/interventions?page='+(curPage+1)+'&limit='+limit+qs+'" class="btn btn-sm">'+L('web.interventions.next_page')+'</a>';
        pagination+='</div>'
      }

      // 搜索表单 + 结果
      const body='<form method="GET" action="/interventions" style="margin-bottom:10px;display:flex;gap:8px;align-items:end;flex-wrap:wrap">'
        +'<div><label for="ia" style="font-size:14px;margin:0">Agent</label><select id="ia" name="agentId" style="width:180px;padding:6px 10px;font-size:14px" onchange="this.form.submit()"><option value="">-- '+L('web.payments.all_agents')+' --</option>'+agentOpts+'</select></div>'
        +'<div><label for="iq" style="font-size:14px;margin:0">'+L('web.interventions.search_label')+'</label><input type="text" id="iq" name="q" value="'+esc(keyword)+'" style="width:200px;padding:6px 10px;font-size:14px" placeholder="'+esc(T('web.interventions.search_ph'))+'" autofocus></div>'
        +'<button type="submit" class="btn-sm" style="margin:0">'+L('common.btn.search')+'</button>'
        +(keyword?'<a href="/interventions" class="btn-sm btn-outline" style="margin:0;line-height:2">'+L('web.interventions.clear')+'</a>':'')
        +'</form>'
        +'<div class="table-wrap" aria-live="polite"><table style="font-size:14px"><thead><tr><th>'+L('web.interventions.col.agent')+'</th><th>'+L('web.interventions.col.visitor')+'</th><th>'+L('web.interventions.col.problem')+'</th><th>'+L('web.interventions.col.time')+'</th><th style="text-align:center">'+L('web.interventions.col.status')+'</th></tr></thead><tbody>'+rowsHtml+'</tbody></table></div>'
        +pagination
        +'<a href="/">← '+L('common.btn.home')+'</a>';
      res.send(renderPage(req,T('web.interventions.title'),body,{nav:'<a href="/">'+L('common.nav.home')+'</a> › '+L('web.interventions.breadcrumb'),
footer:'<script>(function(){try{var ws=new WebSocket("ws://"+location.host+"/ws");ws.onmessage=function(e){try{var d=JSON.parse(e.data);if(d.event==="owner-intervention:email-reply"||d.event==="owner-intervention:new")setTimeout(function(){location.reload()},800)}catch(_){}};ws.onclose=function(){setTimeout(arguments.callee,3000)}}catch(_){}})();</script>'}))
    }catch(e){next(e)}
  });

  // ── 邀请好友使用VOKO ──
  R.get('/invite',async(req,res,next)=>{
    try{
      const T=req.t,L=k=>esc(T(k));
      // 查所有已发布 agent 供选择
      let agents=[];
      try{if(db){const ownerEmail=String(currentOwnerEmail()).trim().toLowerCase();if(ownerEmail)agents=db.prepare("SELECT agent_id,agent_name FROM agents WHERE publish_status='published' AND LOWER(TRIM(owner_email))=? ORDER BY agent_name").all(ownerEmail)}}catch{}
      const opts=agents.map(a=>'<option value="'+esc(a.agent_id)+'">'+esc(a.agent_name||a.agent_id)+'</option>').join('\n');
      res.send(renderPage(req,T('web.invite.title'),'<div class="card"><form method="POST" action="/invite" data-agent-action="invite.send"><label for="ia">'+L('web.invite.select_agent')+'</label><select id="ia" name="agentId" required autofocus><option value="">'+L('web.invite.select_ph')+'</option>'+opts+'</select><label for="ie">'+L('web.invite.email')+'</label><input type="email" id="ie" name="friendEmail" required placeholder="friend@example.com" autocomplete="email"><br><br><button type="submit">'+L('web.invite.send_btn')+'</button></form></div>'+inviteConfirmUi(T,'form[data-agent-action="invite.send"]')+'<a href="/">← '+L('common.btn.home')+'</a>',{nav:'<a href="/">'+L('common.nav.home')+'</a> › '+L('web.invite.breadcrumb')}))
    }catch(e){next(e)}
  });
  R.post('/invite',async(req,res,next)=>{
    try{
      const T=req.t,L=k=>esc(T(k));
      const r=await handlers.invite_friend({agentId:req.body.agentId,friendEmail:req.body.friendEmail});
      if(r.success!==false){
        if(r.result==='already_registered'){
          const email=r.email||req.body.friendEmail||'';
          return res.redirect('/capabilities?agentId='+encodeURIComponent(req.body.agentId)+'&q='+encodeURIComponent(email)+'&inviteResult=already_registered');
        }
        const isWarning=r.result==='email_failed';
        const key='web.invite.result.'+r.result;
        res.send(renderPage(req,T(isWarning?'web.invite.warning_title':'web.invite.sent_title'),'<p class="'+(isWarning?'pending':'success')+'">'+esc(T(key,{email:r.email||req.body.friendEmail}))+'</p><a href="'+(isWarning?'/invite':'/')+'">← '+L(isWarning?'web.invite.retry':'common.btn.home')+'</a>',{nav:'<a href="/">'+L('common.nav.home')+'</a> › '+L('web.invite.breadcrumb')}));
      }else res.send(renderPage(req,T('web.invite.failed_title'),'<p class="error">'+esc(r.error||T('web.invite.failed_default'))+'</p><a href="/invite">'+L('web.invite.retry')+'</a>'))
    }catch(e){next(e)}
  });

  // ── 支付 ──
  R.get('/payments',async(req,res,next)=>{
    try{
      const T=req.t,L=k=>esc(T(k));
      const stTxt=code=>T('db.payment_orders.status.'+code);
      const stOpt=code=>code==='created'?T('web.payments.option.created'):stTxt(code);
      if(req.query.action==='create'){
        let ao='<option value="">'+esc(T('web.payments.create.select_agent'))+'</option>';
        try{const ag=await getAgentList(handlers);for(const a of ag)ao+='<option value="'+esc(a.agentId)+'"'+(req.query.agentId===a.agentId?' selected':'')+'>'+esc(a.agentName||a.agentId)+'</option>'}catch{}
        const v2=esc(req.query.visitorId||'');
        const cbody='<div class="card"><h3>'+L('web.payments.create.heading')+'</h3><form method="POST" action="/payments"><label for="pa">'+L('web.payments.create.agent')+'</label><select id="pa" name="agentId" required>'+ao+'</select><label for="pv">'+L('web.payments.create.visitor')+'</label><input type="text" id="pv" name="visitorId" value="'+v2+'" required><label for="pa2">'+L('web.payments.create.amount')+'</label><input type="number" id="pa2" name="amount" step="0.01" min="0" required autofocus><label for="pd">'+L('web.payments.create.desc')+'</label><input type="text" id="pd" name="description"><br><br><button type="submit" class="btn-success">'+L('common.btn.create')+'</button><a href="/payments" class="btn" style="margin-left:8px">'+L('common.btn.cancel')+'</a></form></div>';
        return res.send(renderPage(req,T('web.payments.create.title'),cbody,{nav:'<a href="/">'+L('common.nav.home')+'</a> › <a href="/payments">'+L('web.payments.breadcrumb')+'</a> › '+L('web.payments.create.breadcrumb')}));
      }
      const curPage=Math.max(1,parseInt(req.query.page,10)||1);const limit=10;const offset=(curPage-1)*limit;
      const aid=req.query.agentId||'',vid=req.query.visitorId||'',rawStatus=String(req.query.status||''),oid=req.query.orderNo||'',fstart=req.query.start||'',fend=req.query.end||'',amtMin=parseFloat(req.query.amtMin)||0,amtMax=parseFloat(req.query.amtMax)||0,txn=req.query.txn||'',desc=req.query.desc||'';
      const allowedPaymentStatuses=new Set(['','0','1','2','3','pending','processing','created','paid','failed','expired']);
      const st=allowedPaymentStatuses.has(rawStatus)?rawStatus:'';
      let orders=[],total=0,sumAmt=0;
      if(db){
        let ownerEmail='';try{ownerEmail=String(currentOwnerEmail()).trim().toLowerCase()}catch{}
        if(ownerEmail){
          let w=['LOWER(TRIM(a.owner_email))=?'];let p=[ownerEmail];
          if(aid&&aid!='all'){w.push('po.agent_id=?');p.push(aid)}
          if(vid){w.push('po.visitor_id LIKE ?');p.push('%'+vid+'%')}
          if(st){w.push('po.status=?');p.push(st)}
          if(oid){w.push('(po.id LIKE ? OR po.order_no LIKE ?)');p.push('%'+oid+'%','%'+oid+'%')}
          if(fstart){w.push('po.created_at>=?');p.push(new Date(fstart).getTime())}
          if(fend){w.push('po.created_at<=?');p.push(new Date(fend).getTime())}
          if(amtMin>0){w.push('CAST(po.amount AS REAL)>=?');p.push(amtMin)}
          if(amtMax>0){w.push('CAST(po.amount AS REAL)<=?');p.push(amtMax)}
          if(txn){w.push('(po.third_trade_no LIKE ? OR po.trade_no LIKE ?)');p.push('%'+txn+'%','%'+txn+'%')}
          if(desc){w.push('po.description LIKE ?');p.push('%'+desc+'%')}
          const wh=' WHERE '+w.join(' AND ');
          const from=' FROM payment_orders po JOIN agents a ON a.agent_id=po.agent_id';
          const c=db.prepare('SELECT COUNT(*) as c, COALESCE(SUM(CAST(po.amount AS REAL)),0) as s'+from+wh).get(...p);total=c?c.c:0;sumAmt=c?c.s:0;
          orders=db.prepare('SELECT po.*'+from+wh+' ORDER BY po.created_at DESC LIMIT ? OFFSET ?').all(...p,limit,offset);
        }
      }
      let agentOpts='<option value="all">'+esc(T('web.payments.all_agents'))+'</option>';
      try{const ags=await getAgentList(handlers);for(const a of ags)agentOpts+='<option value="'+esc(a.agentId)+'"'+(aid===a.agentId?' selected':'')+'>'+esc(a.agentName||a.agentId)+'</option>'}catch{}
      const stClr={'0':'#e37400','1':'#0f9d58','2':'#d93025','3':'#888','pending':'#e37400','processing':'#e37400','created':'#e37400','paid':'#0f9d58','failed':'#d93025','expired':'#888'};
      let rows='<tr><td colspan="7" class="meta" style="text-align:center">'+esc(T('web.payments.empty'))+'</td></tr>';
      if(orders.length){
        // 补昵称
        let payNickMap={};
        try{const vids=[...new Set(orders.map(o=>o.visitor_id).filter(Boolean))];if(vids.length){const rows2=db.prepare('SELECT uid, nickname FROM user_cache WHERE uid IN ('+vids.map(()=>'?').join(',')+')').all(...vids);rows2.forEach(r=>{payNickMap[r.uid]=r.nickname||'';});}}catch(_){}
        const payName=(vid)=>{const n=payNickMap[vid];return n?esc(n)+' ('+esc(vid)+')':esc(vid||'-');};
        rows=orders.map(o=>{const stxt=stTxt(o.status);const sc=stClr[o.status]||'#666';const t=o.paid_at||o.created_at||0;const at=typeof o.amount==='number'?o.amount:parseFloat(o.amount)||0;return '<tr><td style="font-family:monospace;font-size:13px;max-width:170px;overflow:hidden;text-overflow:ellipsis" title="'+esc(o.order_no||o.id||'')+'">'+esc(o.order_no||o.id||'-')+'</td><td>'+payName(o.visitor_id)+'</td><td style="max-width:150px;white-space:normal;word-break:break-word;font-size:14px">'+esc((o.description||'').substring(0,40))+'</td><td style="text-align:right;font-family:monospace">¥'+at.toFixed(2)+'</td><td style="font-family:monospace;font-size:12px;color:#666">'+esc(o.third_trade_no||o.trade_no||'-')+'</td><td class="meta" style="font-size:13px">'+fmtTime(t)+'</td><td style="text-align:center;color:'+sc+';font-weight:600">'+esc(stxt)+'</td></tr>'}).join('\n');
      }
      const pg=Math.ceil(total/limit);
      let pgBar='';
      const qs=(aid&&aid!='all'?'&agentId='+encodeURIComponent(aid):'')+(vid?'&visitorId='+encodeURIComponent(vid):'')+(st?'&status='+encodeURIComponent(st):'')+(oid?'&orderNo='+encodeURIComponent(oid):'')+(fstart?'&start='+encodeURIComponent(fstart):'')+(fend?'&end='+encodeURIComponent(fend):'')+(amtMin?'&amtMin='+encodeURIComponent(amtMin):'')+(amtMax?'&amtMax='+encodeURIComponent(amtMax):'')+(txn?'&txn='+encodeURIComponent(txn):'')+(desc?'&desc='+encodeURIComponent(desc):'');
      if(pg>1){pgBar='<div style="display:flex;align-items:center;justify-content:center;gap:12px;padding:8px 0;font-size:14px">';if(curPage>1)pgBar+='<a href="/payments?page='+(curPage-1)+qs+'" class="btn-sm" style="padding:4px 12px">'+esc(T('web.payments.prev_page'))+'</a>';pgBar+='<span style="color:#666">'+esc(T('web.payments.page_of',{cur:curPage,total:pg}))+'</span>';if(curPage<pg)pgBar+='<a href="/payments?page='+(curPage+1)+qs+'" class="btn-sm" style="padding:4px 12px">'+esc(T('web.payments.next_page'))+'</a>';pgBar+='</div>'}
      const td=new Date();const ts=td.getFullYear()+'-'+String(td.getMonth()+1).padStart(2,'0')+'-'+String(td.getDate()).padStart(2,'0');
      const fld=(lab,inner)=>'<label style="display:flex;flex-direction:column;font-size:12px;color:#555;font-weight:600;gap:3px">'+lab+inner+'</label>';
      const fs='padding:8px 10px;font-size:14px;border:1px solid #ccc;border-radius:4px';
      const stVals=['','0','1','2','3','pending','processing','created','paid','failed','expired'];
      const stOpts=stVals.map(v=>'<option value="'+v+'"'+(st===v?' selected':'')+'>'+esc(v===''?T('web.payments.all_statuses'):stOpt(v))+'</option>').join('');
      const body='<form method="GET" action="/payments">'
        +'<div style="background:#fafafa;border:1px solid #e5e5e5;border-radius:8px;padding:12px;margin-bottom:12px">'
        +'<div style="display:flex;gap:14px;align-items:flex-end;flex-wrap:wrap;margin-bottom:10px">'
        +fld(L('web.payments.filter.agent'),'<select name="agentId" style="width:130px;'+fs+'">'+agentOpts+'</select>')
        +fld(L('web.payments.filter.start'),'<input type="datetime-local" name="start" value="" style="width:185px;'+fs+'">')
        +fld(L('web.payments.filter.end'),'<input type="datetime-local" name="end" value="" style="width:185px;'+fs+'">')
        +fld(L('web.payments.filter.order_no'),'<input type="text" name="orderNo" value="'+esc(oid)+'" style="width:170px;'+fs+'" placeholder="'+L('web.payments.ph.order_no')+'">')
        +'</div><div style="display:flex;gap:14px;align-items:flex-end;flex-wrap:wrap">'
        +fld(L('web.payments.filter.amount_min'),'<input type="number" name="amtMin" value="'+esc(amtMin||'')+'" step="0.01" min="0" style="width:90px;'+fs+'" placeholder="'+L('web.payments.ph.amount_min')+'">')
        +fld(L('web.payments.filter.amount_max'),'<input type="number" name="amtMax" value="'+esc(amtMax||'')+'" step="0.01" min="0" style="width:90px;'+fs+'" placeholder="'+L('web.payments.ph.amount_max')+'">')
        +fld(L('web.payments.filter.status'),'<select name="status" style="width:120px;'+fs+'">'+stOpts+'</select>')
        +fld(L('web.payments.filter.payer'),'<input type="text" name="visitorId" value="'+esc(vid)+'" style="width:110px;'+fs+'" placeholder="'+L('web.payments.ph.payer')+'">')
        +fld(L('web.payments.filter.txn'),'<input type="text" name="txn" value="'+esc(txn)+'" style="width:150px;'+fs+'" placeholder="'+L('web.payments.ph.txn')+'">')
        +fld(L('web.payments.filter.desc'),'<input type="text" name="desc" value="'+esc(desc)+'" style="width:130px;'+fs+'" placeholder="'+L('web.payments.ph.desc')+'">')
        +'<button type="submit" data-agent="payment_search_btn" style="padding:0 22px;height:36px;background:#07c160;border:none;color:#fff;border-radius:4px;font-size:14px;font-weight:700;cursor:pointer">'+esc(T('common.btn.search'))+'</button>'
        +'</div></div>'
        +'</form>'
        +'<div style="font-size:13px;color:#666;margin-bottom:8px">'+esc(T('web.payments.summary',{count:total,total:sumAmt.toFixed(2)}))+'</div>'
        +'<div class="table-wrap" aria-live="polite"><table style="font-size:14px"><thead><tr><th>'+L('web.payments.col.order_no')+'</th><th>'+L('web.payments.col.payer')+'</th><th>'+L('web.payments.col.desc')+'</th><th style="text-align:right">'+L('web.payments.col.amount')+'</th><th>'+L('web.payments.col.merchant_no')+'</th><th>'+L('web.payments.col.time')+'</th><th style="text-align:center">'+L('web.payments.col.status')+'</th></tr></thead><tbody>'+rows+'</tbody></table></div>'
        +pgBar
        +'<div class="ops" style="margin-top:12px"></div>';
      const payNav='<a href="/">'+L('common.nav.home')+'</a> › '+L('web.payments.breadcrumb');
      const payHeaderAction='<a href="/payment-auth" class="btn btn-sm btn-outline" style="font-size:14px">'+L('web.payment_auth.title')+'</a>';
      res.send(renderPage(req,T('web.payments.title'),body,{nav:payNav,headerAction:payHeaderAction}))
    }catch(e){next(e)}
  });
  R.post('/payments',async(req,res,next)=>{
    try{const r=await handlers.create_payment({agentId:req.body.agentId,visitorId:req.body.visitorId,amount:parseFloat(req.body.amount),description:req.body.description||''});r.success?res.redirect('/payments'):res.send(renderPage(req,req.t('web.payments.failed'),'<p class="error">'+esc(r.error)+'</p><a href="/payments">'+esc(req.t('common.btn.back'))+'</a>'))}catch(e){next(e)}
  });

  // ── 银行卡管理（已迁至 payment-auth.js）──

  // ── 银行搜索 JSON API ──
  R.get('/api/banks', async (req, res, next) => {
    try {
      const r = await handlers.search_banks({ keyword: req.query.keyword || '' });
      res.json({ success: true, data: (r.data || r.banks || []).map(b => ({ code: b.code, name: b.name || b.bankName, shortName: b.shortName || b.short_name })) });
    } catch (e) { next(e); }
  });

  // ── 审核规则 ──
  R.get('/audit-rules',async(req,res,next)=>{
    try{
      const T=req.t,L=k=>esc(T(k));
      const dirCn=k=>T('db.audit_rules.direction.'+k);
      const actTxt=k=>T('db.audit_rules.action.'+k);
      const dir=['outbound','inbound'].includes(req.query.direction)?req.query.direction:'';
      const curPage=Math.max(1,parseInt(req.query.page,10)||1);
      const limit=10;
      const offset=(curPage-1)*limit;
      const keyword=req.query.q||'';

      // 读取规则
      let rules=[];try{const r=await handlers.list_audit_rules({direction:dir});rules=r.data||r.rules||r.auditRules||[]}catch{}

      // 关键字过滤
      if(keyword){const kw=keyword.toLowerCase();rules=rules.filter(r=>(r.keyword||'').toLowerCase().includes(kw)||(r.prompt||'').toLowerCase().includes(kw)||(r.action||'').includes(kw)||(r.direction||'').includes(kw)||(dirCn(r.direction)||'').includes(keyword))}

      // 翻页
      const total=rules.length;
      const totalPages=Math.ceil(total/limit);
      const pageItems=rules.slice(offset,offset+limit);

      // 行渲染
      let rowsHtml='<tr><td colspan="6" class="meta" style="text-align:center">'+L('web.audit.empty')+'</td></tr>';
      if(pageItems.length){
        rowsHtml=pageItems.map(r=>{
          const d=dirCn(r.direction)||'';
          const kw=esc((r.keyword||'').substring(0,40));
          const prompt=esc((r.prompt||'').substring(0,60));
          const act=['soft_deny','hard_deny','allow'].includes(r.action)?actTxt(r.action):(r.action||'--');
          const rid=esc(r.id||'');
          return '<tr><td style="text-align:center">'+esc(d)+'</td><td>'+kw+'</td><td style="max-width:180px;word-break:break-word;white-space:normal">'+prompt+'</td><td style="text-align:center">'+esc(act)+'</td><td style="white-space:nowrap;text-align:center"><a href="/audit-rules/'+rid+'/delete" class="btn btn-xs btn-danger" data-agent-kind="action" data-agent-action="audit.rule.delete" role="button">'+L('web.audit.delete_btn')+'</a><a href="/audit-rules/'+rid+'/edit" class="btn btn-xs" style="margin-left:8px" data-agent-kind="action" data-agent-action="audit.rule.edit" role="button">'+L('web.audit.edit_btn')+'</a></td></tr>'
        }).join('\n')
      }

      const title=T('web.audit.title');

      let pg='';
      const qs=(dir?'direction='+encodeURIComponent(dir):'')+(keyword?'&q='+encodeURIComponent(keyword):'');
      if(totalPages>1){
        pg='<div style="display:flex;gap:8px;align-items:center;margin:8px 0;font-size:14px">';
        if(curPage>1)pg+='<a href="/audit-rules?'+qs+'&page='+(curPage-1)+'" class="btn-sm" data-testid="prev-page" data-agent="prev_page">'+L('web.audit.prev_page')+'</a>';
        pg+='<span style="color:#888">'+T('web.audit.page_count',{cur:curPage,total:totalPages,count:total})+'</span>';
        if(curPage<totalPages)pg+='<a href="/audit-rules?'+qs+'&page='+(curPage+1)+'" class="btn-sm" data-testid="next-page" data-agent="next_page">'+L('web.audit.next_page')+'</a>';
        pg+='</div>'
      }

      const dirOpt=(val,sel)=>'<option value="'+val+'"'+(sel?' selected':'')+'>'+(val==='all'||val===''?L('web.audit.all_opt'):dirCn(val))+'</option>';
      const dOpts=dir==='outbound'?dirOpt('',false)+dirOpt('outbound',true)+dirOpt('inbound',false):dir==='inbound'?dirOpt('',false)+dirOpt('outbound',false)+dirOpt('inbound',true):dirOpt('',false)+dirOpt('outbound',true)+dirOpt('inbound',false);
      const actOpt=(val)=>'<option value="'+val+'">'+actTxt(val)+'</option>';
      const aOpts=actOpt('soft_deny')+actOpt('hard_deny')+actOpt('allow');

      const body='<form method="GET" action="/audit-rules" style="display:flex;gap:8px;margin-bottom:10px">'
        +(dir?'<input type="hidden" name="direction" value="'+esc(dir)+'">':'')
        +'<div><label for="aq" style="font-size:14px;margin:0">'+L('web.audit.search_label')+'</label><input type="text" id="aq" name="q" value="'+esc(keyword)+'" style="width:200px;padding:6px 10px;font-size:14px" placeholder="'+esc(T('web.audit.search_ph'))+'" autofocus></div>'
        +'<button type="submit" class="btn-sm" style="margin:0;margin-top:18px" data-testid="search-btn" data-agent="search_btn">'+L('common.btn.search')+'</button>'
        +(keyword?'<a href="/audit-rules'+(dir?'?direction='+encodeURIComponent(dir):'')+'" class="btn-sm btn-outline" style="margin:0;margin-top:18px">'+L('web.audit.clear')+'</a>':'')
        +'</form>'
        +'<div class="table-wrap" aria-live="polite"><table style="font-size:14px"><thead><tr><th style="text-align:center">'+L('web.audit.col.direction')+'</th><th>'+L('web.audit.col.keyword')+'</th><th>'+L('web.audit.col.prompt')+'</th><th style="text-align:center">'+L('web.audit.col.action')+'</th><th style="text-align:center">'+L('web.audit.col.op')+'</th></tr></thead><tbody>'+rowsHtml+'</tbody></table></div>'
        +pg
        +'<div class="card"><h3>'+L('web.audit.add_title')+'</h3><form method="POST" action="/audit-rules"><input type="hidden" name="action" value="add"><div style="display:flex;gap:12px;flex-wrap:wrap"><div style="flex:1;min-width:160px"><label for="rd">'+L('web.audit.lbl.direction')+'</label><select id="rd" name="direction" style="width:100%">'+dOpts+'</select></div><div style="flex:2;min-width:200px"><label for="rk">'+L('web.audit.lbl.keyword')+'</label><input type="text" id="rk" name="keyword" required style="width:100%"></div></div><div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:4px"><div style="flex:2;min-width:200px"><label for="rp">'+L('web.audit.lbl.prompt')+'</label><input type="text" id="rp" name="prompt" style="width:100%"></div><div style="flex:1;min-width:140px"><label for="ra">'+L('web.audit.lbl.action')+'</label><select id="ra" name="actionType" style="width:100%">'+aOpts+'</select></div></div><div style="margin-top:8px"><button type="submit">'+L('common.btn.add')+'</button></div></form></div>';
      res.send(renderPage(req,title,body,{nav:'<a href="/">'+L('common.nav.home')+'</a> › '+title}))
    }catch(e){next(e)}
  });  R.post('/audit-rules',async(req,res,next)=>{
    try{const r=await handlers.manage_audit_rules({action:req.body.action,ruleId:req.body.ruleId||undefined,direction:req.body.direction||undefined,keyword:req.body.keyword||undefined,actionType:req.body.actionType||undefined,prompt:req.body.prompt||undefined});r.success!==false?res.redirect('/audit-rules'):res.send(renderPage(req,req.t('common.label.failed'),'<p class="error">'+esc(r.error)+'</p><a href="/audit-rules">'+esc(req.t('common.btn.back'))+'</a>'))}catch(e){next(e)}
  });

  // ── 删除审核规则确认页 ──
  R.get('/audit-rules/:id/delete',async(req,res,next)=>{
    try{
      const T=req.t,L=k=>esc(T(k));
      let rule=null;
      if(db){const rows=db.prepare('SELECT * FROM audit_rules WHERE id=?').all(req.params.id);if(rows.length)rule=rows[0];}
      if(!rule)return res.send(renderPage(req,T('web.audit.not_found_title'),'<p class="error">'+T('web.audit.not_found_msg')+'</p><a href="/audit-rules">'+L('common.btn.back')+'</a>'));
      const rid=esc(rule.id);
      const kw=esc((rule.keyword||'').substring(0,40));
      const dirLbl=T('db.audit_rules.direction.'+rule.direction)||esc(rule.direction||'');
      const actLbl=['soft_deny','hard_deny','allow'].includes(rule.action)?T('db.audit_rules.action.'+rule.action):esc(rule.action||'');
      res.send(renderPage(req,T('web.audit.confirm_title'),'<div class="card"><p>'+T('web.audit.confirm_msg')+'</p><table><tr><th>'+L('web.audit.th.keyword')+'</th><td>'+kw+'</td></tr><tr><th>'+L('web.audit.th.direction')+'</th><td>'+esc(dirLbl)+'</td></tr><tr><th>'+L('web.audit.th.action')+'</th><td>'+esc(actLbl)+'</td></tr></table><br><form method="POST" action="/audit-rules"><input type="hidden" name="action" value="delete"><input type="hidden" name="ruleId" value="'+rid+'"><button type="submit" class="btn-danger">'+L('web.audit.confirm_btn')+'</button><a href="/audit-rules" class="btn" style="margin-left:8px">'+L('common.btn.cancel')+'</a></form></div>',{nav:'<a href="/">'+L('common.nav.home')+'</a> › <a href="/audit-rules">'+T('web.audit.title')+'</a> › '+L('web.audit.delete_crumb')}))
    }catch(e){next(e)}
  });

    // ── 编辑审核规则 ──
  R.get('/audit-rules/:id/edit',async(req,res,next)=>{
    try{
      const T=req.t,L=k=>esc(T(k));
      const dirCn=k=>T('db.audit_rules.direction.'+k);
      const actTxt=k=>T('db.audit_rules.action.'+k);
      let rule=null;
      if(db){const rows=db.prepare('SELECT * FROM audit_rules WHERE id=?').all(req.params.id);if(rows.length)rule=rows[0];}
      if(!rule)return res.send(renderPage(req,T('web.audit.not_found_title'),'<p class="error">'+T('web.audit.not_found_msg')+'</p><a href="/audit-rules">'+L('common.btn.back')+'</a>'));
      const dirOpt=(val,sel)=>'<option value="'+val+'"'+(sel?' selected':'')+'>'+(val===''?L('web.audit.all_opt'):dirCn(val))+'</option>';
      const dOpts=dirOpt('',false)+dirOpt('outbound',rule.direction==='send'||rule.direction==='outbound')+dirOpt('inbound',rule.direction==='receive'||rule.direction==='inbound');
      const actOpt=(val,sel)=>'<option value="'+val+'"'+(sel?' selected':'')+'>'+actTxt(val)+'</option>';
      const aOpts=actOpt('soft_deny',rule.action==='soft_deny')+actOpt('hard_deny',rule.action==='hard_deny')+actOpt('allow',rule.action==='allow');
      res.send(renderPage(req,T('web.audit.edit_title'),'<div class="card"><form method="POST" action="/audit-rules"><input type="hidden" name="action" value="update"><input type="hidden" name="ruleId" value="'+esc(rule.id)+'"><label for="ed">'+L('web.audit.lbl.direction')+'</label><select id="ed" name="direction" autofocus>'+dOpts+'</select><label for="ek">'+L('web.audit.lbl.keyword')+'</label><input type="text" id="ek" name="keyword" value="'+esc(rule.keyword||'')+'" required><label for="ep">'+L('web.audit.lbl.prompt')+'</label><input type="text" id="ep" name="prompt" value="'+esc(rule.prompt||'')+'"><label for="ea">'+L('web.audit.lbl.action')+'</label><select id="ea" name="actionType">'+aOpts+'</select><br><br><button type="submit">'+L('common.btn.save')+'</button><a href="/audit-rules" class="btn" style="margin-left:8px">'+L('common.btn.cancel')+'</a></form></div>',{nav:'<a href="/">'+L('common.nav.home')+'</a> › <a href="/audit-rules">'+T('web.audit.title')+'</a> › '+L('web.audit.edit_crumb')}))
    }catch(e){next(e)}
  });


  // ── JSON 指令控制台 ──
  R.get('/api/console',requireSensitiveLocalAuth,async(req,res,next)=>{
    try{
      const T=req.t,L=k=>esc(T(k));
      const csrf=opts.webSessions?.requestCsrfToken(req)||'';
      const examples=[
        {label:T('web.console.ex.whoami'),json:'{"action":"whoami","params":{}}'},
        {label:T('web.console.ex.history'),json:'{"action":"get_chat_history","params":{"agentId":"gym","channelId":"test_user"}}'},
        {label:T('web.console.ex.send'),json:'{"action":"send_message","params":{"agentId":"gym","toUid":"test_user","content":"'+T('web.console.ex_send_content')+'"}}'},
        {label:T('web.console.ex.convs'),json:'{"action":"list_conversations","params":{"agentId":"gym"}}'},
        {label:T('web.console.ex.status'),json:'{"action":"get_status","params":{"agentId":"gym"}}'},
      ];

      // Non-JS fallback: simple text list
      const examplesText=examples.map(e=>'<code style="display:block;padding:4px 8px;margin:2px 0;font-size:13px;background:#f5f5f5;border-radius:4px">'+esc(e.json)+'</code>').join('\\n');

      res.send(renderPage(req,T('web.console.title'),'<div class="card"><h3>'+L('web.console.heading')+'</h3><p style="font-size:14px;color:#555;line-height:1.8">'+T('web.console.intro')+'</p><p style="font-size:13px;color:#1a73e8;line-height:1.7">'+T('web.console.hint')+'</p><table style="font-size:14px;width:auto;min-width:auto"><tr><th style="padding:4px 8px">'+L('web.console.col.field')+'</th><th style="padding:4px 8px">'+L('web.console.col.desc')+'</th></tr><tr><td style="padding:4px 8px"><code>action</code></td><td style="padding:4px 8px">'+T('web.console.action_desc')+'</td></tr><tr><td style="padding:4px 8px"><code>params</code></td><td style="padding:4px 8px">'+T('web.console.params_desc')+'</td></tr></table></div>'
      +'<div class="card"><h3>'+L('web.console.examples')+'</h3>'+examplesText+'</div>'
      +'<div class="card"><h3>'+L('web.console.json_cmd')+'</h3><form method="POST" action="/api/console" data-agent="json_form"><input type="hidden" name="_csrf" value="'+esc(csrf)+'">'
      +'<textarea id="json-input" name="json" rows="10" style="width:100%;font-family:monospace;font-size:14px;padding:10px" spellcheck="false" data-agent="json_input" placeholder=\'{"action":"send_message","params":{"agentId":"gym","toUid":"user_xxx","content":"hello"}}\'>{\n  "action": "",\n  "params": {}\n}</textarea>'
      +'<br><br><button type="submit" data-agent="json_submit">'+L('web.console.submit')+'</button> '
      +'<a href="/api/console" class="btn" data-agent="json_reset">'+L('web.console.reset')+'</a></form></div>'
      +'<div id="json-result" data-agent="json_result"></div>'
      +'<p><a href="/">← '+L('common.btn.home')+'</a></p>',{nav:'<a href="/">'+L('common.nav.home')+'</a> › <a href="/api/console">'+L('web.console.title')+'</a>'}))
    }catch(e){next(e)}
  });
  R.post('/api/console',requireSensitiveLocalAuth,requireSensitiveCsrf,async(req,res,next)=>{
    const T=req.t,L=k=>esc(T(k));
    const wantJson=(req.get('accept')||'').includes('application/json')||req.query.json==='1';
    const jfail=(status,payload)=>{res.type('application/json');return res.status(status).json(Object.assign({success:false},payload))};
    let action=null;
    try{
      const raw=(req.body.json||'').trim();
      if(!raw){
        if(wantJson)return jfail(422,{error:T('web.console.err_empty')});
        return res.send(renderPage(req,T('web.console.err_cmd_title'),'<div class="card"><p class="error">❌ '+T('web.console.err_empty')+'</p><a href="/api/console">'+L('web.console.retry')+'</a></div>',{nav:'<a href="/">'+L('common.nav.home')+'</a> › '+L('web.console.title')}));
      }
      let input;
      try{input=JSON.parse(raw)}catch(e){
        if(wantJson)return jfail(422,{error:T('web.console.err_parse')+': '+e.message});
        const hint=raw.length>80?raw.substring(0,80)+'…':raw;
        return res.send(renderPage(req,T('web.console.err_cmd_title'),'<div class="card"><p class="error">❌ '+T('web.console.err_parse')+'</p>'
        +'<p style="font-size:14px;color:#888">'+T('web.console.received')+'：<code>'+esc(hint)+'</code></p>'
        +'<p style="font-size:14px;color:#888">'+T('web.console.error')+'：'+esc(e.message)+'</p>'
        +'<p style="font-size:14px;color:#555">'+T('web.console.suggest')+'</p>'
        +'<a href="/api/console" class="btn">'+L('web.console.retry')+'</a></div>',{nav:'<a href="/">'+L('common.nav.home')+'</a> › '+L('web.console.title')}))
      }
      action=input.action;
      const params=input.params;
      if(!action||!params){
        if(wantJson)return jfail(422,{error:T('web.console.err_missing')});
        return res.send(renderPage(req,T('web.console.err_param_title'),'<div class="card"><p class="error">❌ '+T('web.console.err_missing')+'</p><a href="/api/console">'+L('web.console.retry')+'</a></div>',{nav:'<a href="/">'+L('common.nav.home')+'</a> › '+L('web.console.title')}));
      }
      if(!isCallableAction(handlers,action)){
        if(wantJson)return jfail(422,{error:T('web.console.err_unknown')+': '+action});
        return res.send(renderPage(req,T('web.console.unknown_title'),'<div class="card"><p class="error">❌ '+T('web.console.err_unknown')+': '+esc(action)+'</p><a href="/api/console">'+L('web.console.retry')+'</a></div>',{nav:'<a href="/">'+L('common.nav.home')+'</a> › '+L('web.console.title')}));
      }
      const start=Date.now();
      const result=await handlers[action](params);
      const elapsed=((Date.now()-start)/1000).toFixed(2);
      const success=result.success!==false;
      if(wantJson)return res.type('application/json').json({success,action,params,result,elapsed});
      res.send(renderPage(req,T('web.console.result_title'),'<div class="card"><p class="'+(success?'success':'error')+'">'+(success?'✅ '+T('web.console.exec_success'):'❌ '+T('web.console.exec_fail'))+'</p><p style="font-size:14px;color:#888">'+T('web.console.op')+': '+esc(action)+' | '+T('web.console.elapsed')+': '+elapsed+'s</p></div>'
      +'<div class="card"><h3>'+L('web.console.result_json')+'</h3><pre style="background:#f5f5f5;padding:10px;border-radius:4px;font-size:13px;line-height:1.5;overflow-x:auto;white-space:pre-wrap">'+esc(JSON.stringify(result,null,2))+'</pre></div>'
      +'<div class="card"><h3>'+L('web.console.continue_title')+'</h3><form method="POST" action="/api/console"><input type="hidden" name="_csrf" value="'+esc(opts.webSessions?.requestCsrfToken(req)||'')+'"><textarea name="json" rows="6" style="width:100%;font-family:monospace;font-size:14px" spellcheck="false">'+esc(JSON.stringify(input,null,2))+'</textarea><br><br><button type="submit">'+L('web.console.rerun')+'</button> <a href="/api/console" class="btn">'+L('web.console.new_cmd')+'</a></form></div>'
      +'<script type="application/ld+json">'+jsonForInlineScript({actionStatus:success?'CompletedSuccessfully':'Failed',action,params,result,elapsed})+'</script>',{nav:'<a href="/">'+L('common.nav.home')+'</a> › <a href="/api/console">'+L('web.console.title')+'</a> › '+L('web.console.result_crumb')}))
    }catch(e){
      if(wantJson)return res.type('application/json').status(500).json({success:false,error:e.message,action});
      next(e);
    }
  });

  // ── /api/handlers — action 自描述（复用 MCP schema） ──
  R.get('/api/handlers',async(req,res,next)=>{
    try{
      const getTL=(opts&&typeof opts.getToolList==='function')?opts.getToolList:null;
      let tools=[];
      if(getTL){try{tools=await getTL()||[]}catch{tools=[]}}
      const byName={};
      for(const t of tools){const n=t.name&&t.name.startsWith('voko_')?t.name.slice(5):t.name; if(n)byName[n]=t}
      const actions=Object.keys(handlers)
        .filter(k=>isCallableAction(handlers,k))
        .map(k=>{
          const t=byName[k]||{};
          return {name:k,description:t.description||null,inputSchema:t.inputSchema||null,mcpTool:t.name||null};
        });
      res.type('application/json').json({
        success:true,
        source:tools.length?'mcp tools/list':'handlers keys',
        count:actions.length,
        actions,
        usage:'POST /api/console 带 {action, params} 调用；加 Accept: application/json 或 ?json=1 直返 JSON',
        console:'/api/console',
        mcpEndpoint:'/mcp'
      });
    }catch(e){next(e)}
  });


  // ── 能力发现 ──
  R.get('/capabilities',async(req,res,next)=>{
    try{
      const T=req.t,L=k=>esc(T(k));
      const keyword=req.query.q||'';
      const agentId=req.query.agentId||'';
      const curPage2=parseInt(req.query.page,10)||1;
      const limit=20;
      let results={items:[],total:0};
      let errMsg='';
      const inviteNotice=req.query.inviteResult==='already_registered'
        ?'<p class="pending">'+L('web.invite.result.already_registered')+'</p>'
        :'';

      // 加载 Agent 下拉
      let agents=[],_ownerEmail='';
try{const _rtX=db.prepare("SELECT data FROM config WHERE type='runtime'").get();if(_rtX)try{const _r=JSON.parse(_rtX.data);_ownerEmail=_r.userEmail||''}catch{}if(!_ownerEmail){const _tkX=db.prepare("SELECT data FROM config WHERE type='user_access_token'").get();if(_tkX)try{const _d=JSON.parse(_tkX.data);const _ks=Object.keys(_d);if(_ks.length)_ownerEmail=_ks[0]}catch{}}}catch{}
try{if(_ownerEmail){const _wl=await handlers.whoami({ownerEmail:_ownerEmail});agents=_wl.agents||[]}else{const _a=await getAgentList(handlers);agents=_a}}catch{}
const defAgent=agentId||(agents.length?agents[0].agentId:'');
            const agentOpts=agents.map(a=>'<option value="'+esc(a.agentId)+'"'+(defAgent===a.agentId?' selected':'')+'>'+esc(a.agentName||a.agentId)+'</option>').join('\n');

            if(keyword&&agentId){
        try{
          const r=await handlers.search_capabilities({agent_id:agentId,keyword,page:curPage2,limit});

          if(r.success===false){errMsg=r.error||T('web.capabilities.err_search_failed')}
          else{
            const items=r.data||r.agents||r.results||[];
            results={items:Array.isArray(items)?items:[],total:r.count||r.total||items.length||0};
          }
        }catch(e){errMsg=e.message;}
      }else if(keyword&&!agentId){
        errMsg=T('web.capabilities.err_select_agent');
      }


      let rowsHtml='<tr><td colspan="5" class="meta" style="text-align:center">'+(errMsg?'—':(keyword?L('web.capabilities.empty_search'):L('web.capabilities.empty_initial')))+'</td></tr>';
      // 只排除发起搜索的 Agent 自己（避免它搜到自己）；其他本地 Agent 仍应能在结果里被发现
      const localIds=new Set();
      if(db){try{const a=db.prepare("SELECT agent_id,did,agent_name,imUid FROM agents WHERE agent_id = ?").get(agentId);if(a){if(a.agent_id)localIds.add(String(a.agent_id));if(a.did)localIds.add(String(a.did));if(a.agent_name)localIds.add(String(a.agent_name));if(a.imUid)localIds.add(String(a.imUid))}}catch{}}
      else{const a=agents.find(x=>x.agentId===agentId);if(a){localIds.add(a.agentId);if(a.agentName)localIds.add(a.agentName)}}
      if(results.items.length)rowsHtml=results.items.filter(a=>{
        const id=String(a.id||a.agent_id||a.agentId||'');
        const nm=String(a.name||a.agent_name||a.agentName||'');
        return !localIds.has(id)&&!localIds.has(nm);
      }).map(a=>{
        const nm=esc(a.name||a.agent_name||a.agentName||''); // API 返回 name
        const desc=esc((a.description||a.short_description||'').substring(0,60));
        const tag=esc(a.categoryLabel||a.category||''); // API 返回 categoryLabel
        const st=a.isOnline===true?'<span class="online">● '+L('common.status.online')+'</span>':(a.isOnline===false?'<span class="offline">○ '+L('common.status.offline')+'</span>':'<span class="unknown">○ '+L('common.status.unknown')+'</span>');
        // 发消息：跳到 /send-message，用当前选中的本地 Agent(defAgent) 作发送方、远程 Agent 的 imUid 作接收方。
        // 远程 Agent 不在本地 DB，链接到 /agents/:id 会 404「Agent 不存在」。
        const toUid=a.imUid||a.im_uid||'';
        const sendHref='/send-message?agentId='+encodeURIComponent(defAgent)+(toUid?'&toUid='+encodeURIComponent(toUid):'');
        return '<tr><td style="max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+nm+'</td><td style="max-width:150px;white-space:normal;word-break:break-word;font-size:14px">'+desc+'</td><td style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px">'+tag+'</td><td style="white-space:nowrap;font-size:14px;text-align:center">'+st+'</td><td style="text-align:center"><a href="'+sendHref+'" class="btn btn-xs" style="text-decoration:none" data-agent="msg_btn">'+L('web.capabilities.send_msg_btn')+'</a></td></tr>'
      }).join('\n');

      const body=inviteNotice+'<div class="card"><h3>'+L('web.capabilities.title')+'</h3><p style="font-size:14px;color:#555;line-height:1.8">'+T('web.capabilities.intro')+'</p>'
        +'<form method="GET" action="/capabilities" style="display:flex;gap:8px;flex-wrap:wrap;align-items:end">'
        +'<div><label for="ca" style="font-size:14px;margin:0">'+L('web.capabilities.select_agent')+'</label>'
        +'<select id="ca" name="agentId" style="width:200px;padding:8px 10px;font-size:15px" data-agent="capa_agent_select"><option value="">-- '+L('web.capabilities.select_ph')+' --</option>'+agentOpts+'</select></div>'
        +'<div><label for="cq" style="font-size:14px;margin:0">'+L('web.capabilities.search_label')+'</label>'
        +'<input type="text" id="cq" name="q" value="'+esc(keyword)+'" style="width:200px;padding:8px 10px;font-size:15px" placeholder="'+esc(T('web.capabilities.search_ph'))+'" data-agent="capa_search_input"></div>'
        +'<button type="submit" class="btn-sm" style="margin:0;margin-top:18px" data-agent="capa_search_btn">'+L('common.btn.search')+'</button>'
        +(keyword?'<a href="/capabilities" class="btn-sm btn-outline" style="margin:0;margin-top:18px">'+L('web.capabilities.clear')+'</a>':'')
        +'</form></div>'
        +(results.items.length?'<p class="meta">'+T('web.capabilities.result_count',{count:results.total})+'</p>':'')
        +(errMsg?'<p class="error">'+esc(errMsg)+'</p>':'')
        +'<div class="table-wrap"><table><thead><tr><th>'+L('web.capabilities.col.name')+'</th><th>'+L('web.capabilities.col.desc')+'</th><th>'+L('web.capabilities.col.category')+'</th><th style="text-align:center">'+L('web.capabilities.col.status')+'</th><th style="text-align:center">'+L('web.capabilities.col.op')+'</th></tr></thead><tbody>'+rowsHtml+'</tbody></table></div>'
        ;
      var totalCap=results.total||0,totalCapPages=Math.ceil(totalCap/limit);var pgBar='';if(totalCapPages>1){var capQs='&agentId='+encodeURIComponent(agentId)+(keyword?'&q='+encodeURIComponent(keyword):'');pgBar='<div style="display:flex;align-items:center;justify-content:center;gap:12px;padding:8px 0;font-size:14px">';if(curPage2>1)pgBar+='<a href="/capabilities?page='+(curPage2-1)+capQs+'" class="btn-sm" style="padding:4px 12px">'+esc(T('web.payments.prev_page'))+'</a>';pgBar+='<span style="color:#666">'+esc(T('web.payments.page_of',{cur:curPage2,total:totalCapPages}))+'</span>';if(curPage2<totalCapPages)pgBar+='<a href="/capabilities?page='+(curPage2+1)+capQs+'" class="btn-sm" style="padding:4px 12px">'+esc(T('web.payments.next_page'))+'</a>';pgBar+='</div>'}
      res.send(renderPage(req,T('web.capabilities.title'),body,{nav:'<a href="/">'+L('common.nav.home')+'</a> › '+L('web.capabilities.breadcrumb')}))
    }catch(e){next(e)}
  });  // ────────── Agent 发现 ──────────

  // 系统日志 — 返回最近 2000 行（约 500KB）
  R.get('/voko-im.log',requireSensitiveLocalAuth,(req,res)=>{
    try{
      const logPath = require('path').join(process.env.APPDATA||'', 'voko', 'voko-im.log');
      const fs = require('fs');
      if(!fs.existsSync(logPath)){res.type('text').send('log file not found');return}
      const buf = fs.readFileSync(logPath);
      const lines = buf.toString('utf8').split('\n');
      const tail = lines.slice(-2000).join('\n');
      const T = req.t;
      res.type('text/html; charset=utf-8').send(
        '<!DOCTYPE html><html lang="'+req.locale+'"><head><meta charset="utf-8"><title>'+esc(T('web.home.op.logs'))+' - VOKO</title>'
        +'<style>body{font-family:monospace;font-size:13px;white-space:pre-wrap;word-break:break-all;margin:16px;color:#333;background:#fafafa}a{color:#2563eb;text-decoration:none}pre{margin-top:12px}</style></head><body>'
        +'<a href="/">← '+esc(T('common.btn.home'))+'</a>'
        +renderLanguageFooter(req.locale, 'margin:0 0 12px;font-size:13px;color:#667085;display:flex;justify-content:flex-end')
        +'<pre>'+esc(tail)+'</pre></body></html>');
    }catch(e){res.status(500).type('text').send('read log failed: '+e.message)}
  });

    R.get('/llms.txt',(req,res)=>{res.type('text/plain').send(
'# VOKO LITE - AI Agent Interface\n'
+'\n'
+'## Programmatic Access (recommended for HTTP/curl agents)\n'
+'- GET /api/handlers  -> full action list with JSON Schema params (from MCP tools/list)\n'
+'- POST /api/console with header `Accept: application/json` (or ?json=1) -> pure JSON result, no HTML parsing\n'
+'- MCP endpoint: POST /mcp (JSON-RPC, method tools/list or tools/call)\n'
+'- Deep link templates (intent -> URL with params): GET /.well-known/agent-manifest.json -> deepLinks\n'
+'- Per-page visible guide: append ?guide=1 to any URL (combine ?guide=1&som=1 for numbered marks)\n'
+'\n'
+'## Getting Started\n'
+'1. Open / to see all agents and their latest visitor messages\n'
+'2. Click an agent name to view conversations and management actions\n'
+'3. Click "Reply" to reply to a visitor\n'
+'4. Use the JSON Console (/api/console) to execute commands directly\n'
+'\n'
+'## Common Tasks\n'
+'- Reply to a visitor -> GET /agents/{id} -> click conversation -> POST /messages/send\n'
+'- Edit agent profile -> GET /agents/{id}/edit\n'
+'- Publish/unpublish -> GET /agents/{id}/status\n'
+'- Add whitelist -> GET /agents/{id}/whitelist\n'
+'- Ask for human help -> GET /agents/{id}/human\n'
+'- Request payment -> POST /payments\n'
+'- Manage audit rules -> GET /audit-rules\n'
+'- View interventions -> GET /interventions\n'
+'\n'
+'## All Actions (37, details at /api/handlers)\n'
+'- Messaging: '+listActions('im').join(', ')+'\n'
+'- Agent Management: '+listActions('manage').join(', ')+'\n'
+'- Payment: '+listActions('pay').join(', ')+'\n'
+'- Audit: '+listActions('audit').join(', ')+'\n'
+'- Human Escalation: '+listActions('human').join(', ')+'\n'
+'- Misc: '+listActions('misc').join(', ')+'\n'
+'\n'
+'## Quick Examples (JSON Console)\n'
+'- Send message: {"action":"send_message","params":{"agentId":"gym","toUid":"user","content":"hi"}}\n'
+'- Get history: {"action":"get_chat_history","params":{"agentId":"gym","channelId":"user"}}\n'
+'- List conversations: {"action":"list_conversations","params":{"agentId":"gym"}}\n'
+'- View agents: {"action":"whoami","params":{}}\n'
+'\n'
+'## Format\n'
+'- HTML: text/html; charset=utf-8\n'
+'- JSON-LD on every page\n'
+'- data-agent-* attributes (AAF compatible)\n'
+'- Operation results: ActionStatusType JSON-LD\n');});


  // ── Agent 系统提示词 ──

  // ── 发送消息 ──
  R.get('/send-message',async(req,res,next)=>{
    try{
      const T=req.t,L=k=>esc(T(k));
      const prefillAgent=esc(req.query.agentId||'');
      const prefillUid=esc(req.query.toUid||'');

      let agents=[],ownerEmail='';
      try{
        const rtRow=db.prepare("SELECT data FROM config WHERE type='runtime'").get();
        if(rtRow){const rt=JSON.parse(rtRow.data);ownerEmail=rt.userEmail||''}
        if(!ownerEmail){const tkRow=db.prepare("SELECT data FROM config WHERE type='user_access_token'").get();if(tkRow){const d=JSON.parse(tkRow.data);const ks=Object.keys(d);if(ks.length)ownerEmail=ks[0]}}
      }catch{}
      try{const a=await handlers.whoami(ownerEmail?{ownerEmail}:{});agents=a.agents||[]}catch{}
      let agentOpts='';
      const defAgent=prefillAgent||(agents.length?agents[0].agentId:'');for(const a of agents)agentOpts+='<option value="'+esc(a.agentId)+'"'+(defAgent===a.agentId?' selected':'')+'>'+esc(a.agentName||a.agentId)+'</option>';
      res.send(renderPage(req,T('web.send_message.title'),'<div class="card"><form method="POST" action="/messages/send" data-agent="send_msg_form" data-submit-lock="1" data-submit-label="'+L('web.conversation.sending')+'">'
        +'<label for="sma">'+L('web.send_message.from_agent')+'</label><select id="sma" name="agentId" required style="width:100%" data-agent="send_agent_sel" autofocus>'+agentOpts+'</select>'
        +'<label for="smu">'+L('web.send_message.to_uid')+'</label><input type="text" id="smu" name="toUid" value="'+prefillUid+'" required style="width:100%" autocomplete="off" data-agent="send_uid_input" placeholder="'+esc(T('web.send_message.to_uid_ph'))+'">'
        +'<label for="smc">'+L('web.send_message.content')+'</label><textarea id="smc" name="content" required rows="4" style="width:100%" data-agent="send_content_input" placeholder="'+esc(T('web.send_message.content_ph'))+'"></textarea>'
        +'<br><br><button type="submit" class="voko-send-button" data-agent="send_submit_btn">'+L('common.btn.send')+'</button>'
        +'<a href="/send-message" class="btn" style="margin-left:8px">'+L('web.send_message.reset')+'</a></form></div>'
        +'<p><a href="/">← '+L('common.btn.home')+'</a></p>',{nav:'<a href="/">'+L('common.nav.home')+'</a> › <a href="/send-message">'+L('web.send_message.breadcrumb')+'</a>'}))
    }catch(e){next(e)}
  });

    R.get('/prompt',(req,res)=>{
      const locale = SUPPORTED_LOCALES.includes(req.locale) ? req.locale : 'zh';
      const promptPath = path.join(__dirname, '..', 'core', 'i18n', 'locales', locale, 'prompt.txt');
      const template = fs.readFileSync(promptPath, 'utf8');
      const sep = locale === 'en' ? ', ' : '、';
      const action_list = ACTION_GROUPS.map(g =>
        `- ${GROUP_LABELS[locale][g.group]}: ` + listActions(g.group).join(sep)
      ).join('\n');
      const total = ACTION_GROUPS.reduce((s,g) => s + g.actions.length, 0);
      res.type('text/plain').send(template.replace('{total}', total).replace('{action_list}', action_list));
    });
  R.get('/.well-known/agent-manifest.json',(req,res)=>res.json(getManifestSync(req.locale)));

  // ── sitemap.xml / robots.txt — agent 发现 ──
  R.get('/sitemap.xml',(req,res)=>{
    res.type('application/xml');
    const paths=['/','/register','/interventions','/audit-rules','/payments','/payment-auth','/banks','/send-message','/capabilities','/api/console','/api/handlers','/llms.txt','/prompt','/.well-known/agent-manifest.json'];
    const urls=paths.map(p=>'<url><loc>'+p+'</loc></url>').join('');
    res.send('<?xml version="1.0" encoding="UTF-8"?>\n<!-- base 见 /.well-known/agent-manifest.json 的 entrypoint；loc 为相对路径 -->\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'+urls+'\n</urlset>');
  });
  R.get('/robots.txt',(req,res)=>res.type('text/plain').send('User-agent: *\nAllow: /\nSitemap: /sitemap.xml\n'));

  //  生成短链
  // ═══════════════════════════════════════════════
  R.post('/api/short-link/create', async (req, res) => {
    try {
      const { agentId } = req.body;
      if (!agentId) return res.json({ success: false, error: '缺少 agentId' });
      let imUid = '';
      let ownerEmail = '';
      if (db) {
        try {
          const row = db.prepare('SELECT imUid, owner_email FROM agents WHERE agent_id=?').get(agentId);
          if (row) {
            imUid = row.imUid || '';
            ownerEmail = row.owner_email || '';
          }
        } catch (_) {}
      }
      if (!imUid || !ownerEmail) return res.json({ success: false, error: 'Agent 不存在或尚未完成 IM 绑定' });
      const userAccessToken = getUserAccessToken(db, ownerEmail);
      if (!userAccessToken) return res.json({ success: false, error: '当前 owner 尚未登录或登录已过期' });
      const title = agentId;
      const reqPath = '/api/external/v1/short-link/create';
      const body = { agentId, imUid, title };
      const apiRes = await fetch(VOKO_API_URL + reqPath, {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userAccessToken}` },
        body: JSON.stringify(body)
      });
      const json = await apiRes.json();
      if (json.success) {
        const shortUrl = normalizeOfficialPublicUrl(json.data.shortUrl || '', { canonicalMain: true });
        if (db) {
          try { db.prepare('UPDATE agents SET short_link_url=?, updated_at=? WHERE agent_id=?').run(shortUrl, Date.now(), agentId); } catch (_) {}
        }
        return res.json({ success: true, data: { shortUrl } });
      }
      res.json({ success: false, error: json.message || '生成短链失败' });
    } catch (e) {
      res.json({ success: false, error: e.message });
    }
  });

  // ══════════════════════════════════════════════════════
  //  冒烟测试可视化
  // ══════════════════════════════════════════════════════

  // 页面与执行器随 Lite 包发布，npm 安装环境同样可用
  R.get('/smoke-test', (req, res) => {
    res.sendFile(require('path').join(__dirname, '..', 'testing', 'smoke-test.html'));
  });

  // 注册表
  R.get('/api/smoke/registry', (req, res) => {
    try {
      const smokeModule = '../testing/smoke-all';
      const smokePath = require.resolve(smokeModule);
      delete require.cache[smokePath];
      const { REGISTRY } = require(smokeModule);
      res.json(REGISTRY.map(({ id, name, mode, section, input, expected }) =>
        ({ id, name, mode: mode || 'core', section, input, expected })));
    } catch (e) {
      res.json({ error: e.message });
    }
  });

  // 运行 (SSE 流)
  R.post('/api/smoke/run', async (req, res) => {
    const { mode, items: selectedIds } = req.body;
    if (!selectedIds || selectedIds.length === 0) {
      return res.status(400).json({ error: '未选择测试项' });
    }

    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (data) => { if (!res.destroyed) res.write(`data: ${JSON.stringify(data)}\n\n`); };

    try {
      const smokeModule = '../testing/smoke-all';
      const smokePath = require.resolve(smokeModule);
      delete require.cache[smokePath];
      const smoke = require(smokeModule);
      // 设置 BASE_URL（从 DB 读取实际端口）
      let port = 3100;
      try {
        const r = db.prepare("SELECT data FROM config WHERE type='runtime'").get();
        if (r) port = JSON.parse(r.data).port || 3100;
      } catch (_) {}
      smoke.setBaseUrl(`http://127.0.0.1:${port}`);

      // 初始化 ctx
      const whoamiR = await handlers.whoami({});
      const agents = whoamiR.agents || [];
      if (agents.length === 0) {
        send({ done: true, passed: 0, failed: 0, skipped: 0, error: '无已注册 Agent' });
        return res.end();
      }
      const first = agents[0];
      const agentId = first.agentId;
      let convs = [];
      try {
        convs = (await handlers.list_conversations({ agentId, limit: 1, filter: 'all' })).conversations || [];
      } catch (_) {}
      const visitorId = convs.length > 0 ? convs[0].channelId : 'smoke_test_visitor';

      // 从 DB 补全 agent 信息
      const dbAgents = smoke.queryDb(
        "SELECT agent_id, agent_name, backend_type, short_link_url FROM agents WHERE publish_status='published'"
      );
      const nameMap = {};
      for (const row of dbAgents) nameMap[row.agent_id] = row;
      const allAgents = agents.map(a => ({
        ...a,
        backendType: a.backendType || (nameMap[a.agentId]?.backend_type || ''),
        agentName: a.agentName || (nameMap[a.agentId]?.agent_name || ''),
        shortLinkUrl: nameMap[a.agentId]?.short_link_url || null,
      }));

      const ctx = {
        agentId, visitorId, agents, allAgents,
        _shortLinks: {},
      };
      for (const a of allAgents) {
        if (a.shortLinkUrl) ctx._shortLinks[a.agentId] = a.shortLinkUrl;
      }

      // 传给 runRegistry 的选中项
      ctx._selectedItems = selectedIds;

      let passed = 0, failed = 0, skipped = 0;

      await smoke.runRegistry(ctx, mode, (item, status, detail, elapsed) => {
        if (status === 'pass') passed++;
        else if (status === 'skip') skipped++;
        else failed++;
        // 将 input/expected 中的占位符替换为运行时真实值
        const resolve = (s) => (s || '')
          .replace(/\{agentId\}/g, ctx.agentId)
          .replace(/\{visitorId\}/g, ctx.visitorId);
        send({
          id: item.id, status, name: item.name,
          input: resolve(item.input), expected: resolve(item.expected),
          detail, elapsed,
        });
        if (res.destroyed) throw new Error('client disconnected');
      });

      send({ done: true, passed, failed, skipped });
    } catch (e) {
      if (e.message === 'client disconnected') return;
      send({ done: true, passed: 0, failed: 0, skipped: 0, error: e.message });
    }
    res.end();
  });

  return R
}

module.exports={createWebRouter};
