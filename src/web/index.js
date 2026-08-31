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
const { validateImUidExists } = require('../core/im-user-validation');
const { createRegistrationOrchestrator } = require('../core/registration-orchestrator');
const { discoverWorkBuddyAgents } = require('../core/dispatcher/workbuddy-agents');
const { discoverProviderInstances, getProviderInstanceTerm, supportsProviderInstances } = require('../core/dispatcher/provider-instances');
const { RoutingConversationStore, MessageRouteStore, isRoutingFeatureEnabled } = require('../core/provider-routing');
const { loadSafetyClassifierConfig, saveSafetyClassifierConfig, testSafetyClassifierConfig } = require('../core/safety-classifier');
const { SAFETY_MODEL_PRESETS, findSafetyModelPreset } = require('../core/safety-model-presets');
const { COPY_ICON, UI_CONTROL_CSS, copyButton, copyControlScript, messageDialog } = require('./ui-controls');
const { getProviderManualCommand } = require('../core/provider-setup');


const CONVERSATION_TAB_CSS = `.conversation-tab-shell{grid-template-columns:30px minmax(0,1fr) 30px;gap:0;align-items:end;border-bottom:2px solid #e0e0e0}.conversation-tab-arrow{margin:0 0 -2px;min-width:30px;height:49px;padding:0;border:0;background:transparent;color:#687386;border-radius:6px;box-shadow:none}.conversation-tab-arrow:hover:not(:disabled){background:#eef4ff;color:#1a73e8}.conversation-tab-rail{gap:4px;scrollbar-width:none;padding:0 4px 2px}.conversation-tab-rail::-webkit-scrollbar{display:none}.conversation-tab-card{min-width:108px;padding:10px 20px;border:0;border-bottom:3px solid transparent;border-radius:6px;background:transparent;color:#666;font-size:16px;font-weight:600;box-shadow:none;margin-bottom:-2px}.conversation-tab-card:hover{border-bottom-color:#9fc1f7;background:transparent;color:#1a73e8}.conversation-tab-card.active{border-bottom-color:#1a73e8;background:transparent;color:#1a73e8;font-weight:700;box-shadow:none}.conversation-tab-new{border-style:solid;color:#1a73e8;background:transparent}@media(max-width:600px){.conversation-tab-shell{grid-template-columns:28px minmax(0,1fr) 28px}.conversation-tab-card{min-width:96px;padding:10px 14px}}`;
const A2A_TASK_CARD_CSS='.a2a-task-card{padding:16px 18px}.a2a-task-card-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.a2a-task-card-title{display:flex;align-items:center;gap:9px;min-width:0;flex:1 1 320px}.a2a-task-card-title strong{font-size:17px;color:#1a1a2e}.a2a-task-card-id{min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#667085;font-size:13px;text-decoration:none}.a2a-task-card-id:hover{color:#1a73e8;text-decoration:underline}.a2a-task-card-inline-meta{display:flex;align-items:center;gap:7px 14px;flex:0 0 auto;white-space:nowrap;color:#667085;font-size:13px}.a2a-task-card-inline-meta span{display:inline-flex;align-items:center;gap:5px}.a2a-task-card-inline-meta strong{color:#344054;font-weight:700}.a2a-task-card-chip{display:inline-flex;align-items:center;padding:3px 9px;border-radius:999px;background:#f2f4f7;color:#475467;font-size:13px;line-height:1.4;font-weight:700}.a2a-task-card-chip.success{background:#e6f4ea;color:#137333}.a2a-task-card-chip.info{background:#e8f0fe;color:#1557b0}.a2a-task-card-message-count{color:#1557b0;font-weight:700}.a2a-task-messages{max-height:50vh;overflow-y:auto;border:1px solid #e4e7ec;padding:10px;border-radius:9px;background:#fbfcfe;margin-top:12px}.a2a-task-message-count{display:inline-flex;align-items:center;padding:3px 9px;border-radius:999px;background:#f2f4f7;color:#667085;font-size:13px;font-weight:700}@media(max-width:600px){.a2a-task-card{padding:14px}.a2a-task-card-head{align-items:flex-start}.a2a-task-card-title{width:100%;flex-basis:100%}.a2a-task-card-id{font-size:12px}.a2a-task-card-inline-meta{width:100%;flex-wrap:wrap;white-space:normal;gap:7px 12px}.a2a-task-card-inline-meta span{width:auto}}';
const AUDIT_LAYOUT_CSS = `.audit-grid{display:grid;gap:10px 18px}.audit-grid>*{min-width:0}.audit-grid input,.audit-grid select{max-width:none}.audit-grid-two{grid-template-columns:1fr 1fr}.audit-grid-three{grid-template-columns:repeat(3,minmax(0,1fr))}.audit-model-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:12px}.audit-model-actions button{margin:0}.audit-model-actions label{display:flex;align-items:center;gap:7px;margin:0 0 0 4px}.audit-model-actions input{margin:0}.audit-grid .full{grid-column:1/-1}.audit-rule-prompt-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:end;margin-top:10px}.audit-rule-prompt-row input{max-width:none}.audit-rule-prompt-row button{margin:0;white-space:nowrap}@media(max-width:760px){.audit-grid-two,.audit-grid-three{grid-template-columns:1fr}.audit-grid .full{grid-column:auto}.audit-model-actions label{width:100%;margin-left:0}}`;

// ═══════════════════════════════════════════════════════════════
//  CSS — 浅色 OCR 友好主题
// ═══════════════════════════════════════════════════════════════

const CSS = `@charset "UTF-8";*{box-sizing:border-box}body{font-family:'PingFang SC','Microsoft YaHei','Noto Sans SC','Hiragino Sans GB',sans-serif;background:#f5f7fa;color:#1a1a2e;margin:0;padding:20px;font-size:18px;line-height:1.7;max-width:1100px;margin-left:auto;margin-right:auto;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}a{color:#1a73e8;font-weight:600;padding:4px 2px;display:inline-block}h1{font-size:24px;border-bottom:3px solid #1a73e8;padding-bottom:8px;margin:0 0 10px 0}h2{font-size:20px;margin:18px 0 8px 0;color:#1a1a2e}h3{font-size:17px;margin:0 0 4px 0;color:#1a73e8}nav{font-size:14px;color:#666;margin-bottom:10px;padding:6px 0;border-bottom:1px solid #ddd}.table-wrap{width:100%;overflow-x:auto;margin:6px 0 12px 0}table{width:100%;min-width:500px;border-collapse:collapse;background:#fff;border-radius:6px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,0.06)}th,td{padding:10px 12px;text-align:left;border:1px solid #e0e0e0;font-size:15px;white-space:nowrap}th{background:#e8f0fe;font-weight:700;font-size:14px}tr:nth-child(even){background:#fafbfc}label{display:block;margin-top:10px;font-weight:700;font-size:15px;color:#1a1a2e}input,select,textarea{width:100%;max-width:460px;padding:10px 12px;margin-top:3px;background:#fff;color:#1a1a2e;border:2px solid #b0b0b0;border-radius:6px;font-size:16px;font-family:inherit;outline:none}input:focus,select:focus{border-color:#1a73e8;box-shadow:0 0 0 3px rgba(26,115,232,0.12)}button,.btn{display:inline-block;margin-top:10px;padding:10px 22px;min-width:100px;font-size:16px;font-weight:700;cursor:pointer;text-align:center;font-family:inherit;background:#1a73e8;color:#fff;border:2px solid #1557b0;border-radius:6px;text-decoration:none}button:hover{background:#1557b0}.btn-success{background:#0f9d58;border-color:#0b8043}.btn-success:hover{background:#0b8043}.btn-danger{background:#d93025;border-color:#b71c1c}.btn-danger:hover{background:#b71c1c}.online{color:#0f9d58;font-weight:700}.offline{color:#d93025;font-weight:700}.unknown{color:#888}.pending{color:#e37400;font-weight:600}.success{color:#0f9d58;font-weight:700;font-size:17px}.error{color:#d93025;font-weight:600}.meta{color:#888;font-size:14px}.card{background:#fff;border:1px solid #e0e0e0;border-radius:8px;padding:12px 16px;margin:10px 0;box-shadow:0 1px 2px rgba(0,0,0,0.04)}.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:13px;font-weight:700;border:1px solid}.badge-online{background:#e6f4ea;color:#0f9d58;border-color:#0f9d58}.badge-offline{background:#fce8e6;color:#d93025;border-color:#d93025}.badge-pending{background:#fef7e0;color:#e37400;border-color:#e37400}.info-bar{display:flex;flex-wrap:wrap;gap:6px 14px;background:#fff;border:1px solid #e0e0e0;border-radius:6px;padding:8px 12px;margin:0 0 10px 0;font-size:15px}.info-bar span{white-space:nowrap}.ops{display:grid;gap:8px;margin:6px 0 0 0;grid-template-columns:repeat(6,1fr)}@media(max-width:900px){.ops{grid-template-columns:repeat(4,1fr)}}@media(max-width:600px){.ops{grid-template-columns:repeat(3,1fr)}}@media(max-width:400px){.ops{grid-template-columns:repeat(2,1fr)}}.op-card{display:block;background:#fff;border:2px solid #e0e0e0;border-radius:8px;padding:10px 8px;text-align:center;text-decoration:none;color:#1a1a2e;font-weight:600;font-size:14px}.op-card:hover{border-color:#1a73e8;background:#e8f0fe}button.op-card{margin:0;min-width:0;width:100%}code{background:#f0f0f0;padding:1px 4px;border-radius:3px;font-size:14px}.info-line{margin:4px 0;font-size:15px}.info-line strong{display:inline-block;min-width:70px}.btn-sm{padding:8px 14px;min-width:auto;min-height:36px;font-size:14px;display:inline-block;margin:0;line-height:1.4}.btn-xs{padding:8px 14px;min-width:auto;min-height:36px;font-size:14px;font-weight:700;display:inline-block;margin:0;line-height:1.4;border-radius:4px;text-decoration:none}.btn-outline{background:#fff;color:#1a73e8;border-color:#1a73e8;text-decoration:none}.btn-outline:hover{background:#e8f0fe}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 16px}.form-grid .full{grid-column:1/-1}.audit-rule-form-grid input,.audit-rule-form-grid select{max-width:none}.audit-rule-add-card{padding:16px 20px}.audit-rule-form-grid{gap:10px 18px}@media(max-width:700px){.form-grid{grid-template-columns:1fr}}.voko-select{position:relative;width:100%;max-width:460px}.voko-select-trigger{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;margin-top:3px;background:#fff;color:#1a1a2e;border:2px solid #b0b0b0;border-radius:6px;font-size:16px;font-family:inherit;cursor:pointer;user-select:none}.voko-select-trigger:focus{border-color:#1a73e8;box-shadow:0 0 0 3px rgba(26,115,232,0.12);outline:none}.voko-select-arrow{font-size:11px;color:#888;margin-left:8px}.voko-select-dropdown{display:none;position:absolute;top:100%;left:0;right:0;z-index:100;margin-top:4px;background:#fff;border:2px solid #b0b0b0;border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,0.12);overflow:hidden}.voko-select-search{width:100%;padding:10px 12px;margin:0;background:#fff;color:#1a1a2e;border:none;border-bottom:1px solid #e0e0e0;font-size:14px;font-family:inherit;outline:none;box-sizing:border-box}.voko-select-options{max-height:220px;overflow-y:auto;padding:4px 0}.voko-option{padding:9px 14px;font-size:15px;color:#1a1a2e;cursor:pointer}.voko-option:hover{background:#e8f0fe}.voko-option-empty{color:#999!important;cursor:default}.conversation-tab-shell{display:grid;grid-template-columns:38px minmax(0,1fr) 38px;gap:8px;align-items:stretch;margin:8px 0 14px}.conversation-tab-arrow{margin:0;min-width:38px;padding:0;border:1px solid #d7dee8;background:#fff;color:#52606f;border-radius:8px;box-shadow:0 1px 2px rgba(0,0,0,.04)}.conversation-tab-arrow:hover:not(:disabled){background:#e8f0fe;color:#1a73e8}.conversation-tab-arrow:disabled{opacity:.35;cursor:default}.conversation-tab-rail{display:flex;gap:8px;overflow-x:auto;scroll-behavior:smooth;scrollbar-width:thin;padding:1px}.conversation-tab-card{flex:0 0 auto;min-width:132px;max-width:220px;padding:9px 16px;border:2px solid #e0e0e0;border-radius:8px;background:#fff;color:#1a1a2e;text-decoration:none;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 1px 2px rgba(0,0,0,.04)}.conversation-tab-card:hover{border-color:#1a73e8;background:#e8f0fe}.conversation-tab-card.active{border-color:#1a73e8;background:#e8f0fe;color:#1557b0;box-shadow:0 0 0 2px rgba(26,115,232,.1)}button.conversation-tab-card{width:auto;margin:0;font:inherit;font-size:14px;font-weight:700;cursor:pointer}.conversation-tab-new{border-style:dashed;color:#1a73e8;background:#f8fbff}@media(max-width:600px){.conversation-tab-shell{grid-template-columns:34px minmax(0,1fr) 34px;gap:5px}.conversation-tab-card{min-width:116px;padding:8px 12px}}`;

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

function copyIcon(){return COPY_ICON}
function jumpIcon(){return '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path d="M8 16 16 8M9 8h7v7" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>'}
function accessIcon(kind){const path=kind==='visitor'?'<path d="M4 7h16v10H7l-3 3V7Z"/><path d="M8 11h8M8 14h5"/>':kind==='owner'?'<path d="M12 3 5 6v5c0 4.5 2.9 8.1 7 10 4.1-1.9 7-5.5 7-10V6l-7-3Z"/><path d="m9 12 2 2 4-4"/>':kind==='im'?'<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8" cy="11" r="2"/><path d="M12 10h5M12 14h5M6 16h4"/>':kind==='external'?'<path d="M9 4v5M15 4v5M7 9h10v3a5 5 0 0 1-10 0V9ZM12 17v3"/>':'<circle cx="6" cy="12" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><path d="m8 11 8-4M8 13l8 4"/>';return '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'+path+'</svg>'}

function externalGatewayErrorText(t,code){
  const key={LOGIN_REQUIRED:'login_required',EXTERNAL_GATEWAY_DISABLED:'disabled',EXTERNAL_GATEWAY_UNAVAILABLE:'unavailable',WEBHOOK_URL_INVALID:'webhook_invalid',AGENT_UNAVAILABLE:'agent_unavailable',INVALID_REQUEST:'invalid_request'}[String(code||'')];
  return t('web.external_gateway.'+(key||'request_failed'));
}

function initialLatestScrollScript(selector,{page=false}={}){
  return '<script>(function(){var selector='+jsonForInlineScript(selector)+',target=document.querySelector(selector);if(!target)return;var following=true,observer=null,timer=null;function latest(){if(!following)return;if('+String(page)+'){target=document.querySelector(selector)||target;window.scrollTo(0,document.documentElement.scrollHeight);var messages=target.querySelectorAll(".a2a-task-messages"),last=messages[messages.length-1];if(last)last.scrollTop=last.scrollHeight}else target.scrollTop=target.scrollHeight}function stop(){following=false;if(observer)observer.disconnect();if(timer)clearTimeout(timer)}var eventsTarget='+String(page)+'?window:target;eventsTarget.addEventListener("wheel",stop,{passive:true,once:true});eventsTarget.addEventListener("touchstart",stop,{passive:true,once:true});if(!'+String(page)+')eventsTarget.addEventListener("pointerdown",stop,{passive:true,once:true});requestAnimationFrame(function(){latest();requestAnimationFrame(latest)});window.addEventListener("load",latest,{once:true});window.addEventListener("pageshow",function(){following=true;var attempts=0,restore=setInterval(function(){latest();if(++attempts>=10)clearInterval(restore)},50)});if('+String(page)+'&&window.MutationObserver){observer=new MutationObserver(latest);observer.observe(document.body,{childList:true,subtree:true})}else if(window.ResizeObserver){observer=new ResizeObserver(latest);observer.observe(target);timer=setTimeout(stop,2000)}window.addEventListener("pagehide",function(event){if(event.persisted)return;if(observer)observer.disconnect();if(timer)clearTimeout(timer)},{once:true})})();</script>';
}

function renderPaymentRegionNotice(tFn){
  const t=tFn||(k=>k);
  return '<div class="payment-region-notice" role="note" data-testid="payment-region-notice" style="display:flex;align-items:flex-start;gap:10px;margin:0 0 12px 0;padding:10px 12px;border:1px solid #f2d675;border-radius:8px;background:#fff8e1;color:#704600;font-size:14px;line-height:1.6">'
    +'<span aria-hidden="true" style="flex:0 0 auto;font-size:18px;line-height:1.45">ℹ️</span>'
    +'<div><strong style="display:block;margin-bottom:2px">'+esc(t('web.payments.region_notice.title'))+'</strong>'
    +'<span>'+esc(t('web.payments.region_notice.body'))+'</span></div></div>';
}

function renderPaymentCreationResult(tFn,result,visitorId){
  const t=tFn||(k=>k),rawStatus=String(result?.deliveryStatus||'unknown');
  const deliveryStatus=['delivered','pending','failed'].includes(rawStatus)?rawStatus:'unknown';
  const sentToVisitor=deliveryStatus==='delivered'&&result?.sentToVisitor===true;
  const tone=deliveryStatus==='delivered'
    ?{border:'#9ad0ad',background:'#edf8f1',color:'#176b3a'}
    :deliveryStatus==='failed'
      ?{border:'#efb1ac',background:'#fff1f0',color:'#a12622'}
      :{border:'#f0c36d',background:'#fff8e1',color:'#7a4f01'};
  const deliveryText=t('web.payments.create.delivery.'+deliveryStatus,{visitorId});
  const error=result?.deliveryError
    ?'<p class="meta" style="margin:8px 0 0;color:'+tone.color+'">'+esc(t('web.payments.create.delivery_error',{error:result.deliveryError}))+'</p>'
    :'';
  return '<div class="card" data-testid="payment-create-result" data-delivery-status="'+deliveryStatus+'" data-sent-to-visitor="'+String(sentToVisitor)+'">'
    +'<h3>'+esc(t('web.payments.create.result_title'))+'</h3>'
    +'<div style="padding:12px;border:1px solid '+tone.border+';border-radius:8px;background:'+tone.background+';color:'+tone.color+';font-weight:600">'+esc(deliveryText)+error+'</div>'
    +'<p style="margin:14px 0 4px"><strong>'+esc(t('web.payments.create.result_order'))+'：</strong> '+esc(result?.orderNo||result?.orderId||'-')+'</p>'
    +'<p style="margin:4px 0 14px"><strong>'+esc(t('web.payments.create.result_visitor'))+'：</strong> '+esc(visitorId||result?.visitorId||'-')+'</p>'
    +'<a href="/payments" class="btn">'+esc(t('web.payments.create.view_orders'))+'</a></div>';
}

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
  return '<script>(function(){document.addEventListener("submit",function(event){var form=event.target;if(form.tagName!=="FORM"||String(form.method).toLowerCase()!=="get"||!form.querySelector("[name=keyword],[name=q],[name=a2aKeyword]"))return;var region=document.querySelector("main[data-voko-page-region]");if(!region)return;event.preventDefault();var url=new URL(form.action||location.href,location.origin),data=new FormData(form);data.forEach(function(value,key){if(value)url.searchParams.set(key,value);else url.searchParams.delete(key)});region.setAttribute("aria-busy","true");fetch(url,{headers:{"X-Requested-With":"voko-filter"}}).then(function(r){if(!r.ok)throw new Error("filter failed");return r.text()}).then(function(html){var next=new DOMParser().parseFromString(html,"text/html").querySelector("main[data-voko-page-region]");if(!next)throw new Error("filter region missing");region.replaceWith(next);history.pushState(null,"",url)}).catch(function(){location.assign(url)})})})();</script>'
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
  const h1=opt.showTitle===false?'':(ha?'<h1 style="display:flex;justify-content:space-between;align-items:center"><span>'+esc(title)+st+'</span>'+ha+'</h1>':'<h1>'+esc(title)+st+'</h1>');
  let footer=opt.footer||'';
  if(!footer.includes('data-voko-language-switcher'))footer+=renderLanguageFooter(loc);
  footer+=messageDialog(esc,t('common.toast.ok'));
  const lang=loc==='en'?'en':(loc==='ja'?'ja':'zh-CN');
  return '<!DOCTYPE html>\n<html lang="'+lang+'">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width,initial-scale=1.0">\n<link rel="icon" href="/favicon.png">\n<title>VOKO — '+esc(title)+'</title>\n<style>'+CSS+EXTRA_CSS+A2A_TASK_CARD_CSS+UI_CONTROL_CSS+'</style>\n'+i18nBoot+'\n</head>\n<body>\n<nav role="navigation" aria-label="'+esc(t('common.nav.aria_label'))+'">'+nav+'</nav>\n'+h1+'\n<main data-voko-page-region aria-live="polite" aria-label="'+esc(title)+'">'+msg+body+'</main>'+footer+jd+copyControlScript()+submitLockScript()+ajaxPaginationScript()+ajaxListFilterScript()+ajaxAccessListScript()+'\n</body>\n</html>'
}

function agentNav(aid,aname,tFn){const home=tFn?tFn('common.nav.home'):'首页';return'<a href="/">'+esc(home)+'</a> › <a href="/agents/'+esc(aid)+'">'+esc(aname||aid)+'</a>'}

/** 生成 POST 到 /agents/{id} 的表单 */
function actionForm(aid,action,fields,btn,cls,agentAction,submitLabel,formAttrs){
  const daa=agentAction||action;
  const lockAttrs=submitLabel?' data-submit-lock="1" data-submit-label="'+esc(submitLabel)+'"':'';
  let _af=fields.findIndex(f=>!f.val);if(_af<0)_af=0;const f=fields.map((fld,i)=>{const ff=i===_af?' autofocus':'';
    if(fld.type==='hidden')return '<input type="hidden" id="'+fld.id+'" name="'+fld.name+'" value="'+(fld.val?esc(fld.val):'')+'">';
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

/** action 分组映射，供 /llms.txt、/prompt、/api/handlers 共享，避免漂移（数量动态计算） */
const ACTION_GROUPS=[
  {group:'im',actions:['whoami','list_agents','send_message','get_chat_history','list_conversations','fetch_new_messages','mark_conversation_read','get_status','create_group','invite_to_group','accept_invitation','decline_invitation','get_group_members','get_group_context']},
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

const DEEP_LINKS_ZH=[{intent:'回复某访客的最新消息',template:'/agents/{agentId}/c/{visitorId}?action=reply&focus=1',params:{agentId:'Agent ID',visitorId:'访客 IM UID'}},{intent:'查看聊天历史',template:'/agents/{agentId}/c/{visitorId}',params:{agentId:'Agent ID',visitorId:'访客 IM UID'}},{intent:'查看某访客资料',template:'/agents/{agentId}/visitor?uid={visitorId}',params:{agentId:'Agent ID',visitorId:'访客 UID'}},{intent:'加白名单',template:'/agents/{agentId}/whitelist?visitorId={visitorId}',params:{agentId:'Agent ID',visitorId:'访客 UID'}},{intent:'拉黑访客',template:'/agents/{agentId}/blacklist?visitorId={visitorId}',params:{agentId:'Agent ID',visitorId:'访客 UID'}},{intent:'创建支付订单',template:'/payments?action=create&agentId={agentId}&visitorId={visitorId}',params:{agentId:'Agent ID',visitorId:'访客 UID'}},{intent:'查看已支付订单',template:'/payments?status=1'},{intent:'搜索安全规则',template:'/audit-rules?q={keyword}',params:{keyword:'搜索词'}},{intent:'查看人工介入列表',template:'/interventions?q={keyword}',params:{keyword:'搜索词（可选）'}},{intent:'发送消息给某访客',template:'/send-message?agentId={agentId}&toUid={visitorId}',params:{agentId:'Agent ID',visitorId:'访客 UID'}}];
const DEEP_LINKS_EN=[{intent:'Reply to a visitor\'s latest message',template:'/agents/{agentId}/c/{visitorId}?action=reply&focus=1',params:{agentId:'Agent ID',visitorId:'Visitor IM UID'}},{intent:'View chat history',template:'/agents/{agentId}/c/{visitorId}',params:{agentId:'Agent ID',visitorId:'Visitor IM UID'}},{intent:'View visitor profile',template:'/agents/{agentId}/visitor?uid={visitorId}',params:{agentId:'Agent ID',visitorId:'Visitor UID'}},{intent:'Add to whitelist',template:'/agents/{agentId}/whitelist?visitorId={visitorId}',params:{agentId:'Agent ID',visitorId:'Visitor UID'}},{intent:'Block visitor',template:'/agents/{agentId}/blacklist?visitorId={visitorId}',params:{agentId:'Agent ID',visitorId:'Visitor UID'}},{intent:'Create payment order',template:'/payments?action=create&agentId={agentId}&visitorId={visitorId}',params:{agentId:'Agent ID',visitorId:'Visitor UID'}},{intent:'View paid orders',template:'/payments?status=1'},{intent:'Search security rules',template:'/audit-rules?q={keyword}',params:{keyword:'Search keyword'}},{intent:'View intervention list',template:'/interventions?q={keyword}',params:{keyword:'Search keyword (optional)'}},{intent:'Send message to visitor',template:'/send-message?agentId={agentId}&toUid={visitorId}',params:{agentId:'Agent ID',visitorId:'Visitor UID'}}];
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
      browse:{methods:['GET'],paths:['/','/register','/agents/{id}','/agents/{id}/c/{uid}','/agents/{id}/edit','/agents/{id}/status','/agents/{id}/visibility','/agents/{id}/whitelist','/agents/{id}/blacklist','/agents/{id}/access-mode','/agents/{id}/pricing','/agents/{id}/caps','/agents/{id}/human','/interventions','/audit-rules','/payments','/payment-auth','/send-message','/capabilities']},
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

async function getAgentList(h){const d=await h.list_agents({limit:500});return d.agents||[]}
async function getAgentInfo(h,id){const a=await getAgentList(h);return a.find(x=>x.agentId===id)||null}
function getAgentPaymentAuth(db,agentId){
  try{return db.prepare("SELECT p.name,p.bank_name,p.bank_card FROM agents a JOIN payment_auth p ON p.id=a.payment_auth_id WHERE a.agent_id=? AND UPPER(COALESCE(p.receiver_apply_status,''))='COMPLETED' LIMIT 1").get(agentId)||null}catch{return null}
}
function hasAgentPaymentAuth(db,agentId){return!!getAgentPaymentAuth(db,agentId)}
function pricingDurationDisplay(minutes){
  const total=Number(minutes)||0,units=[['month',43200],['week',10080],['day',1440],['hour',60]];
  for(const[unit,multiplier]of units)if(total>0&&total%multiplier===0)return{unit,value:total/multiplier};
  return{unit:'minute',value:total||1};
}
function validPaidPricing(price,durationMinutes,trialMinutes){
  const p=Number(price),duration=Number(durationMinutes),trial=Number(trialMinutes);
  return Number.isFinite(p)&&p>0&&Number.isInteger(duration)&&duration>0&&Number.isInteger(trial)&&trial>=0;
}
async function getAgentStatus(h,id){
  try{const s=await h.get_status({agentId:id});return s}catch{return{agent:{imConnected:false,imStatus:'unknown',automaticDeliveryReady:false,pullReady:true},warnings:[],probeFailed:true}}
}

function getMessageMode(status, tFn){
  const agent=status&&status.agent;
  if(!agent||status.probeFailed)return{detected:false,code:'',text:tFn('web.home.message_mode.loading')};
  const temporaryMode=String(agent.deliveryStatus&&agent.deliveryStatus.temporaryPreferredMode||'').trim();
  if(temporaryMode){const temporaryKey='web.home.message_mode.'+temporaryMode;const temporaryText=tFn(temporaryKey);return{detected:true,code:temporaryMode,text:temporaryText===temporaryKey?temporaryMode:temporaryText}}
  const automaticModes=Array.isArray(agent.automaticReadyModes)?agent.automaticReadyModes:[];
  const mode=String(agent.activeAutomaticMode||automaticModes[0]||'').trim();
  if(mode){
    const key='web.home.message_mode.'+mode;
    const translated=tFn(key);
    return{detected:true,code:mode,text:translated===key?mode:translated};
  }
  if(agent.pullReady===true||agent.deliveryStatus){
    return{detected:true,code:'pull',text:tFn('web.home.message_mode.pull')};
  }
  return{detected:false,code:'',text:tFn('web.home.message_mode.loading')};
}

const HOME_AGENT_NAME_MAX_LENGTH=24;
function truncateAgentName(value,maxLength=HOME_AGENT_NAME_MAX_LENGTH){
  const text=String(value==null?'':value);
  const chars=Array.from(text);
  return chars.length>maxLength?chars.slice(0,maxLength-1).join('')+'…':text;
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
    message_mode_loading: t('web.home.message_mode.loading'),
    message_mode_pull: t('web.home.message_mode.pull'),
    message_modes: {
      pull: t('web.home.message_mode.pull'),
      websocket: t('web.home.message_mode.websocket'),
      http: t('web.home.message_mode.http'),
      acp_ws: t('web.home.message_mode.acp_ws'),
      acp: t('web.home.message_mode.acp'),
      attach: t('web.home.message_mode.attach'),
      cli: t('web.home.message_mode.cli'),
      mcp: t('web.home.message_mode.mcp'),
    },
    message_mode_checking: t('web.home.message_mode.checking'),
    message_mode_available: t('web.home.message_mode.available'),
    message_mode_unavailable: t('web.home.message_mode.unavailable'),
    message_mode_active: t('web.home.message_mode.active'),
    message_mode_temporary: t('web.home.message_mode.temporary'),
    message_mode_switch_failed: t('web.home.message_mode.switch_failed'),
    message_mode_enable: t('web.home.message_mode.enable'),
    message_mode_setup: t('web.home.message_mode.setup'),
    message_mode_setup_title: t('web.home.message_mode.setup_title'),
    message_mode_setup_help: t('web.home.message_mode.setup_help'),
    message_mode_setup_summary: t('web.home.message_mode.setup_summary'),
    message_mode_install_title: t('web.home.message_mode.install_title'),
    message_mode_install_help: t('web.home.message_mode.install_help'),
    message_mode_login_title: t('web.home.message_mode.login_title'),
    message_mode_login_help: t('web.home.message_mode.login_help'),
    message_mode_copy_command: t('register.flow.copy_command'),
    message_mode_close: t('common.btn.close'),
    message_mode_copy_install: t('web.home.message_mode.copy_install'),
    message_mode_copy_login: t('web.home.message_mode.copy_login'),
    message_mode_recheck: t('web.home.message_mode.recheck'),
    message_mode_loopback_confirm: t('web.home.message_mode.loopback_confirm'),
    message_mode_verify: t('web.home.message_mode.verify'),
    message_mode_verification_required: t('web.home.message_mode.verification_required'),
    message_mode_quota_exhausted: t('web.home.message_mode.quota_exhausted'),
    message_mode_timeout: t('web.home.message_mode.timeout'),
    message_mode_states: {
      verified: t('web.home.message_mode.state_verified'),
      pending_verification: t('web.home.message_mode.state_pending'),
      login_expired: t('web.home.message_mode.state_login_expired'),
      quota_exhausted: t('web.home.message_mode.state_quota'),
      timeout: t('web.home.message_mode.state_timeout'),
      failed: t('web.home.message_mode.state_failed'),
      not_installed: t('web.home.message_mode.state_not_installed'),
    },
    message_mode_retry: t('web.home.message_mode.retry'),
    message_mode_resolve: t('web.home.message_mode.resolve'),
    message_mode_verify_help: t('web.home.message_mode.verify_help'),
    qwen_setup_title: t('web.home.message_mode.qwen_setup_title'),
    qwen_setup_help: t('web.home.message_mode.qwen_setup_help'),
    qwen_login_title: t('web.home.message_mode.qwen_login_title'),
    qwen_login_help: t('web.home.message_mode.qwen_login_help'),
    message_mode_install_action: t('web.home.message_mode.install_action'),
    message_mode_installed: t('web.home.message_mode.installed'),
    message_mode_login_launched: t('web.home.message_mode.login_launched'),
    message_mode_auth_unverified: t('web.home.message_mode.auth_unverified'),
    message_mode_login_action: t('web.home.message_mode.login_action'),
    message_mode_open_action: t('web.home.message_mode.open_action'),
    message_mode_launching: t('web.home.message_mode.launching'),
    message_mode_workbuddy_notice: t('web.home.message_mode.workbuddy_notice'),
    message_mode_workbuddy_ready: t('web.home.message_mode.workbuddy_ready'),
    message_mode_workbuddy_missing: t('web.home.message_mode.workbuddy_missing'),
    message_mode_workbuddy_install_command_help: t('web.home.message_mode.workbuddy_install_command_help'),
    message_mode_qwen_notice: t('web.home.message_mode.qwen_notice'),
    message_mode_dumate_notice: t('web.home.message_mode.dumate_notice'),
    dumate_setup_title: t('web.home.message_mode.dumate_setup_title'),
    qwen_manual_command: getProviderManualCommand('qwen-office'),
    dumate_manual_command: getProviderManualCommand('dumate'),
    copied: t('common.home.copied'),
    failed: t('common.action.failed'),
    gen_creating: t('common.home.gen_creating'),
    gen: t('common.btn.generate_link'),
    gen_failed: t('common.home.gen_failed'),
    owner_expires: t('web.home.owner_link.expires'),
    owner_title: t('web.home.owner_link.title'),
    owner_warning: t('web.home.owner_link.warning'),
    owner_copy: t('web.home.owner_link.copy'),
    owner_verify: t('web.home.owner_link.verify_device'),
    owner_ready: t('web.home.owner_link.ready'),
    owner_copy_text: t('web.home.owner_link.copy_text'),
    owner_copy_template: t('web.home.owner_link.copy_template'),
    owner_devices_summary: t('web.home.owner_link.devices_summary'),
    owner_devices_title: t('web.home.owner_link.devices_title'),
    owner_device: t('web.home.owner_link.device'),
    owner_device_status: t('web.home.owner_link.device_status'),
    owner_device_last_seen: t('web.home.owner_link.device_last_seen'),
    owner_device_expires: t('web.home.owner_link.device_expires'),
    owner_device_online: t('web.home.owner_link.device_online'),
    owner_device_offline: t('web.home.owner_link.device_offline'),
    owner_disconnect: t('web.home.owner_link.disconnect'),
    owner_no_devices: t('web.home.owner_link.no_devices'),
    owner_disabled: t('web.home.owner_link.disabled'),
    access_offline_tip: t('web.home.access.offline_tip'),
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
  const script=`<script>
var I = ${jsonForInlineScript(i18nObj)};
var pendingShortLinkButton=null;
var pendingConfirmAction=null;
function showVokoConfirm(message,action){var d=document.getElementById("dlg-action-confirm");if(!d){d=document.createElement("dialog");d.id="dlg-action-confirm";d.style.cssText="border:none;border-radius:12px;padding:0;max-width:380px;width:calc(100% - 40px);box-shadow:0 12px 36px rgba(15,23,42,.18)";d.innerHTML='<div style="padding:22px 24px 18px"><div style="display:grid;place-items:center;width:40px;height:40px;margin:0 auto 12px;border-radius:50%;background:#fce8e6;color:#d93025;font-size:20px;font-weight:800" aria-hidden="true">!</div><p data-role="confirm-message" style="color:#667085;font-size:14px;line-height:1.65;margin:0 0 18px;text-align:center"></p><div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="btn-sm btn-outline" data-role="confirm-cancel" style="margin:0;padding:6px 16px;min-height:auto">'+${JSON.stringify(t('common.btn.cancel'))}+'</button><button type="button" class="btn-sm btn-danger" data-role="confirm-action" style="margin:0;padding:6px 16px;min-height:auto">'+${JSON.stringify(t('common.btn.confirm'))}+'</button></div></div>';document.body.appendChild(d);d.querySelector('[data-role="confirm-cancel"]').addEventListener("click",function(){pendingConfirmAction=null;d.close()});d.querySelector('[data-role="confirm-action"]').addEventListener("click",function(){var fn=pendingConfirmAction;pendingConfirmAction=null;d.close();if(fn)fn()});d.addEventListener("click",function(e){if(e.target===d){pendingConfirmAction=null;d.close()}})}d.querySelector('[data-role="confirm-message"]').textContent=message;pendingConfirmAction=action;d.showModal()}
function showAccessOfflineTip(){var m=document.getElementById("toast-msg");if(m)m.textContent=I.access_offline_tip;var d=document.getElementById("dlg-toast");if(d)d.showModal()}
function setAgentAccessAvailability(row,online){if(!row)return;var cell=row.querySelector(".home-agent-short");if(!cell)return;cell.classList.toggle("is-agent-offline",!online);cell.setAttribute("data-agent-online",online?"true":"false");cell.querySelectorAll("button,a,.home-access-value").forEach(function(control){if(control.matches("button,a"))control.setAttribute("aria-disabled",online?"false":"true");control.style.opacity=online?"":"0.42";control.style.filter=online?"":"grayscale(1)";if(control.classList.contains("home-access-value"))control.style.color=online?"":"#b0b5bd";if(control.matches("button,a"))control.style.cursor=online?"":"not-allowed"})}
function setMessageModeAvailability(row,online){if(!row)return;var details=row.querySelector("details[data-role=message-mode-picker]");if(!details)return;details.classList.toggle("is-agent-offline",!online);details.dataset.agentOnline=online?"true":"false";if(!online)details.open=false}
document.addEventListener("click",function(e){var control=e.target.closest&&e.target.closest(".home-agent-short button,.home-agent-short a");if(!control)return;var cell=control.closest(".home-agent-short");if(!cell||!cell.classList.contains("is-agent-offline"))return;e.preventDefault();e.stopImmediatePropagation();showAccessOfflineTip()},true);
document.querySelectorAll("tr[data-agent-id]").forEach(function(row){var cell=row.querySelector(".home-agent-short"),state=cell&&cell.getAttribute("data-agent-online");if(state==="true"||state==="false")setAgentAccessAvailability(row,state==="true")});
function generateShortLink(t){var aid3=t.dataset.agent;t.disabled=true;t.textContent=I.gen_creating;fetch("/api/short-link/create",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({agentId:aid3})}).then(function(r){return r.json()}).then(function(d){if(d.success){location.reload()}else{t.disabled=false;t.textContent=I.gen;var m=document.getElementById("toast-msg");if(m)m.textContent=I.gen_failed;var d2=document.getElementById("dlg-toast");if(d2)d2.showModal()}}).catch(function(){t.disabled=false;t.textContent=I.gen})}
var copySvg=${JSON.stringify(COPY_ICON)};
function ownerLinkDialog(){var dlg=document.getElementById("dlg-owner-link");if(dlg)return dlg;dlg=document.createElement("dialog");dlg.id="dlg-owner-link";dlg.style.cssText="border:none;border-radius:12px;padding:0;max-width:350px;width:calc(100% - 40px);box-shadow:0 12px 36px rgba(15,23,42,.18)";dlg.innerHTML='<div style="padding:20px 22px 18px"><p style="color:#667085;font-size:14px;line-height:1.65;margin:0 0 16px;text-align:left"></p><form method="dialog" style="display:flex;gap:8px;justify-content:flex-end"><button class="btn-sm btn-outline" value="cancel" style="margin:0;padding:6px 16px;min-height:auto"></button><button type="button" class="btn-sm" data-role="confirm-owner-link" style="margin:0;padding:6px 16px;min-height:auto"></button></form></div>';dlg.querySelector("p").textContent=I.owner_warning;dlg.querySelector('button[value="cancel"]').textContent=${JSON.stringify(t('common.btn.cancel'))};dlg.querySelector("[data-role=confirm-owner-link]").textContent=I.gen;document.body.appendChild(dlg);return dlg}
var ownerLinkSessionKey="voko.owner-links.v1";
function readOwnerLinks(){try{var value=JSON.parse(sessionStorage.getItem(ownerLinkSessionKey)||"{}");return value&&typeof value==="object"?value:{}}catch(_){return{}}}
function saveOwnerLink(agentId,data){try{var links=readOwnerLinks();links[agentId]={ownerUrl:data.ownerUrl,expiresAt:data.expiresAt||null};sessionStorage.setItem(ownerLinkSessionKey,JSON.stringify(links))}catch(_){}}
function renderOwnerLinkEntry(agentId,data){var row=Array.from(document.querySelectorAll("[data-owner-agent]")).find(function(item){return item.dataset.ownerAgent===agentId});if(!row||!data||!data.ownerUrl)return;var expiresAt=Date.parse(data.expiresAt||"");if(Number.isFinite(expiresAt)&&expiresAt<=Date.now()){try{var links=readOwnerLinks();delete links[agentId];sessionStorage.setItem(ownerLinkSessionKey,JSON.stringify(links))}catch(_){}return}var value=row.querySelector("[data-owner-link-value]"),actions=row.querySelector("[data-owner-link-actions]");if(!value||!actions)return;var link=document.createElement("a");link.className="home-access-value";link.href=data.ownerUrl;link.target="_blank";link.rel="noopener noreferrer";link.textContent=data.ownerUrl.length>35?data.ownerUrl.slice(0,35)+"…":data.ownerUrl;link.title=data.ownerUrl+(Number.isFinite(expiresAt)?"\\n"+I.owner_expires+new Date(expiresAt).toLocaleString():"");value.replaceWith(link);link.setAttribute("data-owner-link-value","");var copy=actions.querySelector("[data-owner-link-copy]");if(!copy){copy=document.createElement("button");copy.type="button";copy.className="voko-copy-button";copy.setAttribute("data-owner-link-copy","");copy.innerHTML=copySvg;actions.insertBefore(copy,actions.firstChild)}copy.setAttribute("data-voko-copy-value",data.ownerUrl);copy.title=I.owner_copy;copy.setAttribute("aria-label",I.owner_copy)}
function restoreOwnerLinks(){var links=readOwnerLinks();Object.keys(links).forEach(function(agentId){renderOwnerLinkEntry(agentId,links[agentId])})}
function openOwnerLinkDialog(t){var dlg=ownerLinkDialog();dlg.dataset.agent=t.dataset.agent||"";dlg.showModal()}
function createOwnerLink(){var dlg=ownerLinkDialog(),aid=dlg.dataset.agent||"",trigger=Array.from(document.querySelectorAll('[data-role="gen-owner-link"]')).find(function(button){return button.dataset.agent===aid});if(!aid)return;dlg.close();var original=trigger?trigger.textContent:I.gen;if(trigger){trigger.disabled=true;trigger.textContent=I.gen_creating}fetch("/api/owner-link/create",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({agentId:aid})}).then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d}})}).then(function(x){if(!x.ok||!x.data.success)throw new Error(x.data.error||I.gen_failed);var d=x.data.data||{};saveOwnerLink(aid,d);renderOwnerLinkEntry(aid,d)}).catch(function(e){var m=document.getElementById("toast-msg");if(m)m.textContent=e.message||I.gen_failed;var errorDialog=document.getElementById("dlg-toast");if(errorDialog)errorDialog.showModal()}).finally(function(){if(trigger){trigger.disabled=false;trigger.textContent=original}})}
function restoreOwnerLinks(){try{sessionStorage.removeItem("voko.owner-links.v1")}catch(_){}}
function ownerLinkDialog(){var dlg=document.getElementById("dlg-owner-link");if(dlg)return dlg;dlg=document.createElement("dialog");dlg.id="dlg-owner-link";dlg.style.cssText="border:none;border-radius:12px;padding:0;max-width:460px;width:calc(100% - 32px);box-shadow:0 12px 36px rgba(15,23,42,.18)";dlg.innerHTML='<div style="padding:22px 24px 20px"><h3 data-role="owner-link-title" style="margin:0 0 10px"></h3><p data-role="owner-link-message" style="color:#667085;font-size:14px;line-height:1.65;margin:0 0 14px;text-align:left"></p><textarea data-role="owner-link-copy-value" readonly rows="7" style="display:none;width:100%;max-width:none;margin:0 0 12px;font-size:13px;line-height:1.55"></textarea><p data-role="owner-link-expiry" class="meta" style="display:none;margin:0 0 14px"></p><div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap"><button type="button" class="btn-sm btn-outline" data-role="owner-link-cancel" style="margin:0;padding:6px 16px;min-height:auto"></button><button type="button" class="btn-sm" data-role="confirm-owner-link" style="margin:0;padding:6px 16px;min-height:auto"></button><button type="button" class="btn-sm" data-role="copy-owner-link" style="display:none;margin:0;padding:6px 16px;min-height:auto"></button></div></div>';dlg.querySelector('[data-role="owner-link-cancel"]').textContent=${JSON.stringify(t('common.btn.cancel'))};dlg.querySelector('[data-role="owner-link-cancel"]').onclick=function(){dlg.close()};dlg.querySelector('[data-role="copy-owner-link"]').onclick=function(){var value=dlg.querySelector('[data-role="owner-link-copy-value"]').value;navigator.clipboard.writeText(value).then(function(){dlg.querySelector('[data-role="copy-owner-link"]').textContent=I.copied})};document.body.appendChild(dlg);return dlg}
function openOwnerLinkDialog(t){var dlg=ownerLinkDialog();dlg.dataset.agent=t.dataset.agent||"";dlg.dataset.agentName=t.dataset.agentName||t.dataset.agent||"Agent";dlg.querySelector('[data-role="owner-link-title"]').textContent=I.owner_verify;dlg.querySelector('[data-role="owner-link-message"]').textContent=I.owner_warning;dlg.querySelector('[data-role="owner-link-copy-value"]').style.display="none";dlg.querySelector('[data-role="owner-link-expiry"]').style.display="none";dlg.querySelector('[data-role="copy-owner-link"]').style.display="none";var confirm=dlg.querySelector('[data-role="confirm-owner-link"]');confirm.style.display="inline-block";confirm.textContent=I.owner_verify;dlg.showModal()}
function createOwnerLink(){var dlg=ownerLinkDialog(),aid=dlg.dataset.agent||"",agentName=dlg.dataset.agentName||"Agent",trigger=Array.from(document.querySelectorAll('[data-role="gen-owner-link"]')).find(function(button){return button.dataset.agent===aid});if(!aid)return;var confirm=dlg.querySelector('[data-role="confirm-owner-link"]'),original=trigger?trigger.textContent:I.owner_verify;confirm.disabled=true;confirm.textContent=I.gen_creating;if(trigger){trigger.disabled=true;trigger.textContent=I.gen_creating}fetch("/api/owner-link/create",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({agentId:aid})}).then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d}})}).then(function(x){if(!x.ok||!x.data.success)throw new Error(x.data.error||I.gen_failed);var d=x.data.data||{},expiry=Date.parse(d.expiresAt||""),expiryText=Number.isFinite(expiry)?new Date(expiry).toLocaleString():"",copyText=I.owner_copy_template.replace("{agent}",agentName).replace("{url}",d.ownerUrl).replace("{expires}",expiryText);dlg.querySelector('[data-role="owner-link-title"]').textContent=I.owner_ready;dlg.querySelector('[data-role="owner-link-message"]').textContent=I.owner_copy_text;var field=dlg.querySelector('[data-role="owner-link-copy-value"]');field.value=copyText;field.style.display="block";var expires=dlg.querySelector('[data-role="owner-link-expiry"]');expires.textContent=I.owner_expires+expiryText;expires.style.display=expiryText?"block":"none";confirm.style.display="none";var copy=dlg.querySelector('[data-role="copy-owner-link"]');copy.textContent=I.owner_copy;copy.style.display="inline-block"}).catch(function(e){dlg.close();var m=document.getElementById("toast-msg");if(m)m.textContent=e.message||I.gen_failed;var errorDialog=document.getElementById("dlg-toast");if(errorDialog)errorDialog.showModal()}).finally(function(){confirm.disabled=false;if(trigger){trigger.disabled=false;trigger.textContent=original}})}
function ownerLinkDialog(){var dlg=document.getElementById("dlg-owner-link-v2");if(dlg)return dlg;dlg=document.createElement("dialog");dlg.id="dlg-owner-link-v2";dlg.style.cssText="border:none;border-radius:12px;padding:0;max-width:460px;width:calc(100% - 32px);box-shadow:0 12px 36px rgba(15,23,42,.18)";dlg.innerHTML='<div style="padding:22px 24px 20px"><h3 data-role="owner-link-title" style="margin:0 0 12px"></h3><p data-role="owner-link-message" class="meta" style="margin:0 0 14px"></p><textarea data-role="owner-link-copy-value" readonly rows="7" style="display:none;width:100%;max-width:none;margin:0 0 14px;font-size:13px;line-height:1.55"></textarea><div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="btn-sm btn-outline" data-role="owner-link-close" style="margin:0;padding:6px 16px;min-height:auto"></button><button type="button" class="btn-sm" data-role="copy-owner-link" style="display:none;margin:0;padding:6px 16px;min-height:auto"></button></div></div>';dlg.querySelector('[data-role="owner-link-close"]').textContent=${JSON.stringify(t('common.btn.close'))};dlg.querySelector('[data-role="owner-link-close"]').onclick=function(){dlg.close()};dlg.querySelector('[data-role="copy-owner-link"]').onclick=function(){var button=this,value=dlg.querySelector('[data-role="owner-link-copy-value"]').value;if(window.vokoCopyText)window.vokoCopyText(value,button);else navigator.clipboard.writeText(value).then(function(){button.textContent=I.copied})};document.body.appendChild(dlg);return dlg}
function openOwnerLinkDialog(t){var dlg=ownerLinkDialog();dlg.dataset.agent=t.dataset.agent||"";dlg.dataset.agentName=t.dataset.agentName||t.dataset.agent||"Agent";dlg.querySelector('[data-role="owner-link-title"]').textContent=I.owner_verify;dlg.querySelector('[data-role="owner-link-message"]').textContent=I.gen_creating;dlg.querySelector('[data-role="owner-link-copy-value"]').style.display="none";dlg.querySelector('[data-role="copy-owner-link"]').style.display="none";dlg.showModal();createOwnerLink()}
function createOwnerLink(){var dlg=ownerLinkDialog(),aid=dlg.dataset.agent||"",agentName=dlg.dataset.agentName||"Agent",trigger=Array.from(document.querySelectorAll('[data-role="gen-owner-link"]')).find(function(button){return button.dataset.agent===aid});if(!aid)return;var original=trigger?trigger.textContent:I.owner_verify;if(trigger){trigger.disabled=true;trigger.textContent=I.gen_creating}fetch("/api/owner-link/create",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({agentId:aid})}).then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d}})}).then(function(x){if(!x.ok||!x.data.success)throw new Error(x.data.error||I.gen_failed);var d=x.data.data||{},expiry=Date.parse(d.expiresAt||""),expiryText=Number.isFinite(expiry)?new Date(expiry).toLocaleString():"",copyText=I.owner_copy_template.replace("{agent}",agentName).replace("{url}",d.ownerUrl).replace("{expires}",expiryText);dlg.querySelector('[data-role="owner-link-title"]').textContent=I.owner_ready;dlg.querySelector('[data-role="owner-link-message"]').textContent="";var field=dlg.querySelector('[data-role="owner-link-copy-value"]');field.value=copyText;field.style.display="block";var copy=dlg.querySelector('[data-role="copy-owner-link"]');copy.textContent=I.owner_copy;copy.style.display="inline-block"}).catch(function(e){dlg.querySelector('[data-role="owner-link-title"]').textContent=I.gen_failed;dlg.querySelector('[data-role="owner-link-message"]').textContent=e.message||I.gen_failed}).finally(function(){if(trigger){trigger.disabled=false;trigger.textContent=original}})}
var ownerDevices=[],ownerDevicesLoading=null;
function ownerDeviceName(value){var text=String(value||""),browser=text.indexOf("MicroMessenger")>=0?"WeChat":text.indexOf("Edg/")>=0?"Edge":text.indexOf("Chrome/")>=0?"Chrome":text.indexOf("Safari/")>=0?"Safari":"Browser",system=text.indexOf("iPhone")>=0||text.indexOf("iPad")>=0?"iPhone":text.indexOf("Android")>=0?"Android":text.indexOf("Windows")>=0?"Windows":text.indexOf("Mac OS X")>=0?"macOS":"Device";return browser+" · "+system}
function ownerDeviceSummary(authorized,online){if(!authorized)return I.owner_disabled;return I.owner_devices_summary.replace("{authorized}",String(authorized)).replace("{online}",String(online))}
function renderOwnerDeviceSummaries(){document.querySelectorAll("[data-owner-agent]").forEach(function(row){var agentId=row.dataset.ownerAgent,list=ownerDevices.filter(function(d){return d.agentId===agentId}),button=row.querySelector('[data-role="owner-devices"]');if(button)button.textContent=ownerDeviceSummary(list.length,list.filter(function(d){return d.online}).length)})}
function loadOwnerDevices(){if(ownerDevicesLoading)return ownerDevicesLoading;ownerDevicesLoading=fetch("/api/owner-link/devices",{headers:{Accept:"application/json"}}).then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d}})}).then(function(x){if(!x.ok||!x.data.success)throw new Error(x.data.error||I.failed);ownerDevices=x.data.data?.devices||[];renderOwnerDeviceSummaries();return ownerDevices}).catch(function(){renderOwnerDeviceSummaries();return ownerDevices}).finally(function(){ownerDevicesLoading=null});return ownerDevicesLoading}
function ownerDevicesDialog(){var dlg=document.getElementById("dlg-owner-devices");if(dlg)return dlg;dlg=document.createElement("dialog");dlg.id="dlg-owner-devices";dlg.style.cssText="border:none;border-radius:12px;padding:0;max-width:780px;width:calc(100% - 32px);box-shadow:0 12px 36px rgba(15,23,42,.18)";dlg.innerHTML='<div style="padding:22px 24px 20px"><h3 data-role="owner-devices-title" style="margin:0 0 14px"></h3><div data-role="owner-devices-list"></div><div style="display:flex;justify-content:flex-end;margin-top:16px"><button type="button" class="btn-sm btn-outline" data-role="owner-devices-close" style="margin:0;padding:6px 16px;min-height:auto"></button></div></div>';dlg.querySelector('[data-role="owner-devices-close"]').textContent=${JSON.stringify(t('common.btn.close'))};dlg.querySelector('[data-role="owner-devices-close"]').onclick=function(){dlg.close()};document.body.appendChild(dlg);return dlg}
function renderOwnerDevicesDialog(agentId,agentName){var dlg=ownerDevicesDialog(),list=ownerDevices.filter(function(d){return d.agentId===agentId}),box=dlg.querySelector('[data-role="owner-devices-list"]');dlg.dataset.agent=agentId;dlg.querySelector('[data-role="owner-devices-title"]').textContent=I.owner_devices_title+" · "+agentName;if(!list.length){box.innerHTML='<p class="meta">'+I.owner_no_devices+'</p>';return}box.innerHTML='<div style="width:100%;overflow-x:auto"><table style="width:100%;min-width:680px;box-shadow:none;margin:0"><thead><tr><th>'+I.owner_device+'</th><th>'+I.owner_device_status+'</th><th>'+I.owner_device_last_seen+'</th><th>'+I.owner_device_expires+'</th><th></th></tr></thead><tbody>'+list.map(function(d){return '<tr><td><strong>'+ownerDeviceName(d.deviceLabel)+'</strong></td><td><span class="'+(d.online?'badge-online':'badge-offline')+'">'+(d.online?I.owner_device_online:I.owner_device_offline)+'</span></td><td class="meta">'+new Date(d.lastSeenAt).toLocaleString()+'</td><td class="meta">'+new Date(d.expiresAt).toLocaleString()+'</td><td style="text-align:right"><button type="button" class="btn-sm btn-danger" data-role="disconnect-owner-device" data-device="'+d.deviceId+'" style="margin:0;padding:5px 12px;min-height:auto;white-space:nowrap">'+I.owner_disconnect+'</button></td></tr>'}).join("")+'</tbody></table></div>'}
function openOwnerDevices(t){var dlg=ownerDevicesDialog(),agentId=t.dataset.agent||"",agentName=t.dataset.agentName||agentId;dlg.dataset.agentName=agentName;dlg.showModal();renderOwnerDevicesDialog(agentId,agentName);loadOwnerDevices().then(function(){renderOwnerDevicesDialog(agentId,agentName)})}
function disconnectOwnerDevice(t){var deviceId=t.dataset.device||"",dlg=ownerDevicesDialog(),agentId=dlg.dataset.agent;t.disabled=true;fetch("/api/owner-link/devices/"+encodeURIComponent(deviceId),{method:"DELETE",headers:{Accept:"application/json"}}).then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d}})}).then(function(x){if(!x.ok||!x.data.success)throw new Error(x.data.error||I.failed);ownerDevices=ownerDevices.filter(function(d){return d.deviceId!==deviceId});renderOwnerDeviceSummaries();renderOwnerDevicesDialog(agentId,dlg.querySelector('[data-role="owner-devices-title"]').textContent.split(" · ").slice(1).join(" · "))}).catch(function(e){t.disabled=false;var m=document.getElementById("toast-msg");if(m)m.textContent=e.message||I.failed;var errorDialog=document.getElementById("dlg-toast");if(errorDialog)errorDialog.showModal()})}
function connectOwnerDeviceEvents(){if(!window.EventSource)return;var events=new EventSource("/api/owner-link/device-events");events.addEventListener("devices",function(){loadOwnerDevices().then(function(){var dlg=document.getElementById("dlg-owner-devices");if(dlg&&dlg.open)renderOwnerDevicesDialog(dlg.dataset.agent||"",dlg.dataset.agentName||dlg.dataset.agent||"")})})}
(function(){
  var ws = null;
  function modeText(data){
    if(!data||data.messageModeDetected===false)return I.message_mode_loading;
    var temporaryMode=String(data.temporaryPreferredMode||(data.deliveryStatus&&data.deliveryStatus.temporaryPreferredMode)||"").trim();
    if(temporaryMode)return I.message_modes[temporaryMode]||temporaryMode;
    var mode=String(data.messageMode||data.activeAutomaticMode||((data.automaticReadyModes||[])[0]||"")).trim();
    if(mode)return I.message_modes[mode]||mode;
    if(data.pullReady===true||data.messageModeDetected===true)return I.message_mode_pull;
    return I.message_mode_loading;
  }
  function updateAgentRow(data){
    if(!data||!data.agentId)return;
    document.querySelectorAll("tr[data-agent-id]").forEach(function(row){
      if(row.getAttribute("data-agent-id")!==String(data.agentId))return;
      if(Object.prototype.hasOwnProperty.call(data,"imConnected")){
        var statusCell=row.querySelector("[data-role=connection-status]");
        if(statusCell)statusCell.innerHTML=data.imConnected?'<span class="online">'+I.online+'</span>':'<span class="offline">'+I.offline+'</span>';
        setAgentAccessAvailability(row,data.imConnected===true);
        setMessageModeAvailability(row,data.imConnected===true);
      }
      if(Object.prototype.hasOwnProperty.call(data,"messageModeDetected")||Object.prototype.hasOwnProperty.call(data,"messageMode")||Object.prototype.hasOwnProperty.call(data,"activeAutomaticMode")){
        var modeCell=row.querySelector("[data-role=message-mode]");
        var modeSummary=modeCell&&modeCell.querySelector("[data-role=message-mode-summary]");
        if(modeSummary)modeSummary.textContent=modeText(data);else if(modeCell)modeCell.textContent=modeText(data);
      }
    });
  }
  function connectWS() {
    try {
      ws = new WebSocket("ws://" + location.host + "/ws");
      ws.onmessage = function(e) {
        try {
          var d = JSON.parse(e.data);
          if (d.event === "agent-wukongim:status") {
            updateAgentRow(d.data||{});
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
            if(Array.isArray(d.data.agents))d.data.agents.forEach(updateAgentRow);
          }
        } catch(_) {}
      };
      ws.onclose = function() { setTimeout(connectWS, 3000); };
    } catch(_) { setTimeout(connectWS, 5000); }
  }
  connectWS();
})();
function messageModeLabel(mode){return I.message_modes[mode]||mode}
var workBuddyCopySvg=${JSON.stringify(COPY_ICON)};
function positionMessageModeMenu(details){var menu=details.querySelector("[data-role=message-mode-menu]");details.classList.remove("is-dropup");if(!details.open||!menu)return;menu.style.cssText+=";position:fixed;z-index:1000;right:auto;bottom:auto;transform:none;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow:auto";menu.style.width=menu.querySelector(".home-message-mode-setup")?"380px":"240px";var anchor=details.getBoundingClientRect(),rect=menu.getBoundingClientRect(),gap=5,pad=8,below=window.innerHeight-anchor.bottom-pad,above=anchor.top-pad,dropup=rect.height>below&&above>below,left=Math.max(pad,Math.min(window.innerWidth-rect.width-pad,anchor.left+anchor.width/2-rect.width/2)),top=dropup?Math.max(pad,anchor.top-rect.height-gap):Math.min(window.innerHeight-rect.height-pad,anchor.bottom+gap);if(dropup)details.classList.add("is-dropup");menu.style.left=Math.round(left)+"px";menu.style.top=Math.round(Math.max(pad,top))+"px"}
function renderMessageModeMenu(details,status){details._deliveryStatus=status;var menu=details.querySelector("[data-role=message-mode-menu]"),preferred=String(status.temporaryPreferredMode||""),preferredProvider=String(status.temporaryPreferredProvider||"");if(!menu)return;var html=(status.methods||[]).map(function(method){var manuallySelected=!!preferred&&method.mode===preferred&&String(method.provider||"")===preferredProvider,activeSelected=!preferred&&method.mode===status.activeAutomaticMode,selected=manuallySelected||activeSelected,enabled=method.mode==='pull'?method.available===true:method.automaticReady===true,presentation=method.presentation||null,state=method.mode==='pull'?(manuallySelected?I.message_mode_temporary:(activeSelected?I.message_mode_active:I.message_mode_available)):(presentation&&I.message_mode_states[presentation.state]||I.message_mode_unavailable),tone=presentation&&presentation.tone||((enabled)?'success':'muted'),action=presentation&&presentation.action||null,setupRole=action&&status.backendType==='workbuddy'&&method.mode==='http'?'setup-workbuddy':action&&status.backendType==='qwen-office'&&method.mode==='cli'?'setup-qwen':action&&status.backendType==='dumate'&&method.mode==='http'?'setup-dumate':'',actionLabel=action==='verify'?I.message_mode_verify:action==='retry'?I.message_mode_retry:action==='resolve'?I.message_mode_resolve:I.message_mode_setup;return '<div class="home-message-mode-row"><button type="button" class="home-message-mode-option'+(selected?' is-selected':'')+'" data-role="select-message-mode" data-mode="'+String(method.mode).replace(/"/g,'&quot;')+'" data-provider="'+String(method.provider||'').replace(/"/g,'&quot;')+'" '+(enabled?'':'disabled')+'><span class="home-message-mode-dot is-'+tone+'"></span><span class="home-message-mode-name">'+messageModeLabel(method.mode)+'</span><span class="home-message-mode-state is-'+tone+'">'+state+'</span></button>'+(setupRole?'<button type="button" class="home-message-mode-settings" data-role="'+setupRole+'">'+actionLabel+'</button>':'')+'</div>'}).join('');menu.innerHTML=html;requestAnimationFrame(function(){positionMessageModeMenu(details)})}
function escapeInlineCommand(value){return String(value||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
function inlineCopyCommand(text,command,label){var parts=String(text||'').split('{command}'),before=parts.shift(),after=parts.join('{command}'),punctuation=(after.match(/^[，,。；;：:！？!?]/)||[''])[0],longCommand=String(command||'').length>36;if(punctuation)after=after.slice(punctuation.length);var safeCommand=escapeInlineCommand(command),safeLabel=escapeInlineCommand(label),control=command?'<span class="voko-command-inline'+(longCommand?' is-long':'')+'"><code title="'+safeCommand+'">'+safeCommand+'</code><button type="button" class="voko-copy-button" title="'+safeLabel+'" aria-label="'+safeLabel+'" data-voko-copy-value="'+safeCommand+'">'+workBuddyCopySvg+'</button>'+punctuation+'</span>':'';return before+control+after}
function providerSetupDialog(details,id,title,help,actions){var dialog=document.getElementById(id);if(!dialog){dialog=document.createElement("dialog");dialog.id=id;dialog.className="voko-message-dialog";dialog.style.cssText="width:min(560px,calc(100vw - 24px));max-height:calc(100vh - 24px);padding:0;border:0;border-radius:14px;box-shadow:0 22px 70px rgba(15,23,42,.28);overflow:hidden";document.body.appendChild(dialog)}dialog.innerHTML='<div class="home-message-mode-setup" style="display:grid;gap:12px;max-height:calc(100vh - 24px);overflow-y:auto;overflow-x:hidden;padding:20px;color:#344054;font-size:13px"><div style="display:flex;align-items:center;justify-content:space-between;gap:12px"><strong style="font-size:16px">'+title+'</strong><button type="button" style="display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;margin:0;padding:0;border:0;border-radius:50%;background:transparent;color:#667085;font-size:24px" data-role="close-provider-setup" aria-label="'+I.message_mode_close+'">×</button></div>'+(help?'<p style="margin:0;color:#667085;line-height:1.55">'+help+'</p>':'')+actions.map(function(action){if(action.command)return '<div style="min-width:0;margin:0;color:#667085;line-height:1.55">'+inlineCopyCommand(action.help,action.command,I.message_mode_copy_command)+'</div>';return '<button type="button" class="btn-sm'+(action.secondary?' btn-outline':'')+'" style="margin:0" data-provider-action="'+action.action+'" '+(action.disabled?'disabled':'')+'>'+action.label+'</button>'}).join('')+'<button type="button" class="btn-sm btn-outline" style="margin:0" data-role="recheck-provider">'+I.message_mode_recheck+'</button><p data-role="provider-setup-status" style="display:none;margin:0"></p></div>';dialog._messageModeDetails=details;details.open=false;dialog.showModal()}
function renderWorkBuddySetup(details){var method=((details._deliveryStatus||{}).methods||[]).find(function(item){return item.provider==='workbuddy-http'}),ready=!!(method&&method.available);providerSetupDialog(details,'dlg-workbuddy-setup',I.message_mode_setup_title,ready?I.message_mode_workbuddy_ready:I.message_mode_workbuddy_missing,[{command:'npm install -g @tencent-ai/codebuddy-code',help:I.message_mode_workbuddy_install_command_help},{command:'codebuddy',help:I.message_mode_login_help}]);var dialog=document.getElementById('dlg-workbuddy-setup'),recheck=dialog&&dialog.querySelector('[data-role=recheck-provider]');if(recheck)recheck.dataset.role='recheck-workbuddy-component'}
function renderQwenSetup(details){var method=((details._deliveryStatus||{}).methods||[]).find(function(item){return item.provider==='qwen-office-cli'}),quota=method&&method.verificationStatus==='quota_exhausted',help=quota?I.message_mode_quota_exhausted:I.message_mode_verify_help;providerSetupDialog(details,'dlg-qwen-setup',I.qwen_setup_title,help,[{command:I.qwen_manual_command,help:I.qwen_setup_help}]);var dialog=document.getElementById('dlg-qwen-setup'),recheck=dialog&&dialog.querySelector('[data-role=recheck-provider]');if(recheck){recheck.dataset.role='recheck-qwen';recheck.textContent=I.message_mode_verify}}
function renderDuMateSetup(details){providerSetupDialog(details,'dlg-dumate-setup',I.dumate_setup_title,'',[{command:I.dumate_manual_command,help:I.message_mode_dumate_notice}])}
window.addEventListener("resize",function(){document.querySelectorAll('details[data-role="message-mode-picker"][open]').forEach(positionMessageModeMenu)});window.addEventListener("scroll",function(){document.querySelectorAll('details[data-role="message-mode-picker"][open]').forEach(positionMessageModeMenu)},true);
function refreshMessageMode(details){if(details.dataset.loading==="true")return;details.dataset.loading="true";var menu=details.querySelector("[data-role=message-mode-menu]");if(menu)menu.innerHTML='<span class="home-message-mode-loading">'+I.message_mode_checking+'</span>';fetch("/api/agents/"+encodeURIComponent(details.dataset.agent||"")+"/delivery-channels/refresh",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"}).then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d}})}).then(function(result){if(!result.ok||!result.data.success)throw new Error(result.data.error||I.message_mode_switch_failed);renderMessageModeMenu(details,result.data.deliveryStatus||{})}).catch(function(error){if(menu)menu.innerHTML='<span class="home-message-mode-loading is-error">'+(error.message||I.message_mode_switch_failed)+'</span>'}).finally(function(){details.dataset.loading="false"})}
document.addEventListener("toggle",function(e){var details=e.target;if(!details||!details.matches||!details.matches("details[data-role=message-mode-picker]")||!details.open)return;if(details.dataset.agentOnline==="false"){details.open=false;return}document.querySelectorAll("details[data-role=message-mode-picker][open]").forEach(function(other){if(other!==details)other.open=false});requestAnimationFrame(function(){positionMessageModeMenu(details)});refreshMessageMode(details)},true);
document.addEventListener("click",function(e){document.querySelectorAll("details[data-role=message-mode-picker][open]").forEach(function(details){if(!details.contains(e.target))details.open=false})});
document.addEventListener("click",function(e){var close=e.target.closest&&e.target.closest('[data-role=close-provider-setup]');if(close){e.stopImmediatePropagation();close.closest('dialog').close();return}var setup=e.target.closest&&e.target.closest('[data-role=setup-workbuddy],[data-role=setup-qwen],[data-role=setup-dumate]');if(setup){e.stopImmediatePropagation();var details=setup.closest('details[data-role=message-mode-picker]');if(setup.dataset.role==='setup-workbuddy')renderWorkBuddySetup(details);else if(setup.dataset.role==='setup-qwen')renderQwenSetup(details);else renderDuMateSetup(details);return}var action=e.target.closest&&e.target.closest('[data-provider-action]');if(action){e.stopImmediatePropagation();var dialog=action.closest('dialog'),status=dialog.querySelector('[data-role=provider-setup-status]'),kind=action.dataset.providerAction;action.disabled=true;status.style.display='block';status.textContent=I.message_mode_launching;fetch('/api/provider-setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:kind})}).then(function(r){return r.json().then(function(d){if(!r.ok||!d.success)throw new Error(d.error||I.message_mode_switch_failed);if(kind==='install_workbuddy'){action.textContent=I.message_mode_installed;action.dataset.completed='true';status.textContent=I.message_mode_installed}else status.textContent=d.instruction||I.message_mode_login_launched})}).catch(function(error){status.textContent=error.message||I.message_mode_switch_failed}).finally(function(){if(action.dataset.completed!=='true')action.disabled=false});return}var recheck=e.target.closest&&e.target.closest('[data-role=recheck-provider]');if(recheck){e.stopImmediatePropagation();var dlg=recheck.closest('dialog'),d=dlg&&dlg._messageModeDetails;if(!d)return;recheck.disabled=true;refreshMessageMode(d);setTimeout(function(){recheck.disabled=false;dlg.close()},800)}});
document.addEventListener("click",function(e){var recheck=e.target.closest&&e.target.closest('[data-role=recheck-workbuddy-component]');if(!recheck)return;e.stopImmediatePropagation();var dialog=recheck.closest('dialog'),details=dialog&&dialog._messageModeDetails,status=dialog&&dialog.querySelector('[data-role=provider-setup-status]');if(!details)return;recheck.disabled=true;recheck.textContent=I.message_mode_checking;if(status){status.style.display='block';status.textContent=I.message_mode_checking}fetch("/api/agents/"+encodeURIComponent(details.dataset.agent||"")+"/delivery-channels/refresh",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"}).then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d}})}).then(function(result){if(!result.ok||!result.data.success)throw new Error(result.data.error||I.message_mode_switch_failed);renderMessageModeMenu(details,result.data.deliveryStatus||{});renderWorkBuddySetup(details)}).catch(function(error){if(status)status.textContent=error.message||I.message_mode_switch_failed}).finally(function(){recheck.disabled=false;recheck.textContent=I.message_mode_recheck})});
document.addEventListener("click",function(e){var close=e.target.closest&&e.target.closest("[data-role=close-workbuddy-setup],[data-role=close-provider-setup]");if(close){close.closest("dialog").close();return}var qwenSetup=e.target.closest&&e.target.closest("[data-role=setup-qwen]");if(qwenSetup){renderQwenSetup(qwenSetup.closest("details[data-role=message-mode-picker]"),qwenSetup.dataset.command);return}var qwenRecheck=e.target.closest&&e.target.closest("[data-role=recheck-qwen]");if(qwenRecheck){var qwenDialog=qwenRecheck.closest("dialog"),qwenDetails=qwenDialog&&qwenDialog._messageModeDetails;if(!qwenDetails)return;showVokoConfirm(I.message_mode_loopback_confirm,function(){qwenRecheck.disabled=true;qwenRecheck.textContent=I.message_mode_checking;fetch("/api/agents/"+encodeURIComponent(qwenDetails.dataset.agent||"")+"/delivery-channels/verify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({providerId:"qwen-office-cli"})}).then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d}})}).then(function(result){if(result.data&&result.data.deliveryStatus)renderMessageModeMenu(qwenDetails,result.data.deliveryStatus);if(!result.ok||!result.data.success)throw new Error(result.data.error||I.message_mode_switch_failed);qwenDialog.close()}).catch(function(error){var status=qwenDialog.querySelector('[data-role=provider-setup-status]');if(status){status.style.display='block';status.className='home-message-mode-loading is-error';status.textContent=error.message||I.message_mode_switch_failed}}).finally(function(){qwenRecheck.disabled=false;qwenRecheck.textContent=I.message_mode_verify})});return}var setup=e.target.closest&&e.target.closest("[data-role=setup-workbuddy]");if(setup){renderWorkBuddySetup(setup.closest("details[data-role=message-mode-picker]"));return}var recheck=e.target.closest&&e.target.closest("[data-role=recheck-workbuddy]");if(recheck){var dialog=recheck.closest("dialog"),details=dialog&&dialog._messageModeDetails||recheck.closest("details[data-role=message-mode-picker]");if(!details)return;showVokoConfirm(I.message_mode_loopback_confirm,function(){recheck.disabled=true;recheck.textContent=I.message_mode_checking;fetch("/api/agents/"+encodeURIComponent(details.dataset.agent||"")+"/delivery-channels/verify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({providerId:"workbuddy-http"})}).then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d}})}).then(function(result){if(!result.ok||!result.data.success)throw new Error(result.data.error||I.message_mode_switch_failed);renderMessageModeMenu(details,result.data.deliveryStatus||{});if(dialog)dialog.close()}).catch(function(error){var box=dialog&&dialog.querySelector(".home-message-mode-setup");if(box){var message=document.createElement("p");message.className="home-message-mode-loading is-error";message.textContent=error.message||I.message_mode_switch_failed;box.appendChild(message)}else{var menu=details.querySelector("[data-role=message-mode-menu]");if(menu)menu.innerHTML='<span class="home-message-mode-loading is-error">'+(error.message||I.message_mode_switch_failed)+'</span>'}}).finally(function(){recheck.disabled=false;recheck.textContent=I.message_mode_recheck})})}});
document.addEventListener("click",function(e){var option=e.target.closest&&e.target.closest("[data-role=select-message-mode]");if(!option)return;var details=option.closest("details[data-role=message-mode-picker]"),agentId=details&&details.dataset.agent;option.disabled=true;fetch("/api/agents/"+encodeURIComponent(agentId||"")+"/delivery-channels/select",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({mode:option.dataset.mode,providerId:option.dataset.provider||null})}).then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d}})}).then(function(result){if(!result.ok||!result.data.success)throw new Error(result.data.error||I.message_mode_switch_failed);var status=result.data.deliveryStatus||{},summary=details.querySelector("[data-role=message-mode-summary]");if(summary)summary.textContent=messageModeLabel(status.temporaryPreferredMode||status.activeAutomaticMode||"pull");renderMessageModeMenu(details,status);details.open=false}).catch(function(error){var m=document.getElementById("toast-msg");if(m)m.textContent=error.message||I.message_mode_switch_failed;var dialog=document.getElementById("dlg-toast");if(dialog)dialog.showModal();option.disabled=false})});
document.addEventListener("click",function(e){var t=e.target.closest?e.target.closest("[data-role]")||e.target:e.target;
 if(t.matches("[data-role=logout-btn]")){var d=document.getElementById("dlg-logout");if(d)d.showModal()}
 else if(t.matches("[data-role=confirm-gen-link]")){var b=pendingShortLinkButton;pendingShortLinkButton=null;var sd=document.getElementById("dlg-short-link-security");if(sd)sd.close();if(b)generateShortLink(b)}
 else if(t.matches("[data-role=toggle-pub]")){var s=t;var aid=s.dataset.agent;var isPub=s.dataset.pubStatus==="published";s.disabled=true;s.style.opacity="0.5";fetch("/api/agents/"+aid+"/status",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:isPub?0:1})}).then(function(r){return r.json()}).then(function(d){if(d.success){s.textContent=d.label;s.className="btn btn-sm home-mode-toggle "+(d.pubStatus==="published"?"home-mode-published":"home-mode-unpublished");s.title=isPub?d.titleUnpub:d.titlePub;s.dataset.pubStatus=d.pubStatus;if(d.pubStatus==="unpublished"){var row=s.closest("tr[data-agent-id]");setAgentAccessAvailability(row,false);var statusCell=row&&row.querySelector("[data-role=connection-status]");if(statusCell)statusCell.innerHTML='<span class="offline">'+I.offline+'</span>'}}else{var m=document.getElementById("toast-msg");if(m)m.textContent=d.error||I.failed;var d2=document.getElementById("dlg-toast");if(d2)d2.showModal()}}).catch(function(e){var m=document.getElementById("toast-msg");if(m)m.textContent=e.message;var d2=document.getElementById("dlg-toast");if(d2)d2.showModal()}).finally(function(){s.disabled=false;s.style.opacity=""})}
 else if(t.matches("[data-role=toggle-acc]")){var s=t;var aid=s.dataset.agent;var isPriv=s.dataset.accMode==="private";s.disabled=true;s.style.opacity="0.5";fetch("/api/agents/"+aid+"/access-mode",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({enabled:!isPriv})}).then(function(r){return r.json()}).then(function(d){if(d.success){s.textContent=d.label;s.className="btn btn-sm btn-outline home-mode-toggle home-access-mode "+(d.accMode==="private"?"home-mode-private":"home-mode-public");s.title=isPriv?d.titlePub:d.titlePriv;s.dataset.accMode=d.accMode}else{var m=document.getElementById("toast-msg");if(m)m.textContent=d.error||I.failed;var d2=document.getElementById("dlg-toast");if(d2)d2.showModal()}}).catch(function(e){var m=document.getElementById("toast-msg");if(m)m.textContent=e.message;var d2=document.getElementById("dlg-toast");if(d2)d2.showModal()}).finally(function(){s.disabled=false;s.style.opacity=""})}
 else if(t.matches("[data-role=gen-link]")){pendingShortLinkButton=t;var sd=document.getElementById("dlg-short-link-security");if(sd)sd.showModal()}
else if(t.matches("[data-role=wl-toggle]")||t.matches("[data-role=bl-toggle]")){var s=t;var isRemove=s.textContent.trim().indexOf(I.remove_prefix)===0;var role=s.dataset.role;var listType=role==="wl-toggle"?"whitelist":"blacklist";var act=isRemove?"remove_"+listType:"add_"+listType;var addLabel=role==="wl-toggle"?I.wl_add:I.bl_add;var removeLabel=role==="wl-toggle"?I.wl_remove:I.bl_remove;s.disabled=true;s.textContent=I.processing;fetch("/api/agents/"+s.dataset.agent+"/action",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({_action:act,visitorId:s.dataset.visitor})}).then(function(r){return r.json()}).then(function(d){if(d.success){s.textContent=isRemove?addLabel:removeLabel}else{var m=document.getElementById("toast-msg");if(m)m.textContent=d.error||I.failed;var d2=document.getElementById("dlg-toast");if(d2)d2.showModal()}}).catch(function(e){var m=document.getElementById("toast-msg");if(m)m.textContent=e.message;var d2=document.getElementById("dlg-toast");if(d2)d2.showModal()}).finally(function(){s.disabled=false})}
else if(t.matches("[data-role=wl-remove]")||t.matches("[data-role=bl-remove]")){var s=t;showVokoConfirm(I.confirm_remove,function(){var role2=s.dataset.role;var listType2=role2==="wl-remove"?"whitelist":"blacklist";var act2="remove_"+listType2;s.disabled=true;var row=s.closest("tr");fetch("/api/agents/"+s.dataset.agent+"/action",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({_action:act2,visitorId:s.dataset.visitor})}).then(function(r){return r.json()}).then(function(d){if(d.success&&row)row.remove();else{var m=document.getElementById("toast-msg");if(m)m.textContent=d.error||I.failed;var d2=document.getElementById("dlg-toast");if(d2)d2.showModal()}}).catch(function(e){var m=document.getElementById("toast-msg");if(m)m.textContent=e.message;var d2=document.getElementById("dlg-toast");if(d2)d2.showModal()}).finally(function(){s.disabled=false})})}
else if(t.matches("[data-role=audit-delete]")){var s=t;showVokoConfirm(I.confirm_delete_audit,function(){s.disabled=true;var row2=s.closest("tr");fetch("/api/audit-rules/"+s.dataset.ruleId+"/delete",{method:"POST"}).then(function(r){return r.json()}).then(function(d){if(d.success&&row2)row2.remove();else{var m=document.getElementById("toast-msg");if(m)m.textContent=d.error||I.failed;var d2=document.getElementById("dlg-toast");if(d2)d2.showModal()}}).catch(function(e){var m=document.getElementById("toast-msg");if(m)m.textContent=e.message;var d2=document.getElementById("dlg-toast");if(d2)d2.showModal()}).finally(function(){s.disabled=false})})}
});
document.addEventListener("submit",function(e){var f=e.target.closest("form[data-ajax]");if(!f)return;e.preventDefault();var btn=f.querySelector("button[type=submit]");if(btn){btn.disabled=true;btn.textContent=I.submitting}var fd=new FormData(f);var body={};fd.forEach(function(v,k){body[k]=v});var url=f.action||f.dataset.action;fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(function(r){return r.json()}).then(function(d){if(d.success){var el=document.getElementById(f.dataset.resultId||"ajax-result");if(el){el.className="alert alert-success";el.textContent=d.message||I.success}else{var m=document.getElementById("toast-msg");if(m)m.textContent=d.message||I.success;var d2=document.getElementById("dlg-toast");if(d2)d2.showModal()}if(f.dataset.reload==="true"){setTimeout(function(){location.reload()},800)}}else{var el=document.getElementById(f.dataset.resultId||"ajax-result");if(el){el.className="alert alert-error";el.textContent=d.error||I.failed}else{var m=document.getElementById("toast-msg");if(m)m.textContent=d.error||I.failed;var d2=document.getElementById("dlg-toast");if(d2)d2.showModal()}}}).catch(function(e){var m=document.getElementById("toast-msg");if(m)m.textContent=e.message;var d2=document.getElementById("dlg-toast");if(d2)d2.showModal()}).finally(function(){if(btn){btn.disabled=false;btn.textContent=btn.dataset.origText||I.submit}})});
function ajaxRowRemove(url,body,row){fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(function(r){return r.json()}).then(function(d){if(d.success){row.remove()}else{var m=document.getElementById("toast-msg");if(m)m.textContent=d.error||I.failed;var d2=document.getElementById("dlg-toast");if(d2)d2.showModal()}}).catch(function(e){var m=document.getElementById("toast-msg");if(m)m.textContent=e.message;var d2=document.getElementById("dlg-toast");if(d2)d2.showModal()})}
</script>`;
  return script.replace(/var copySvg=[\s\S]*?(?=\(function\(\)\{\n  var ws)/,'');
}

function createWebRouter(handlers, db, opts={}){
  const R=Router();
  const trustedRemoteEnabled=opts.trustedRemoteEnabled===true;
  const routingConversations=new RoutingConversationStore(db);
  const messageRoutes=new MessageRouteStore(db);
  R.use(rateLimit({
    windowMs: 60 * 1000,
    limit: 300,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { success: false, error: 'Too many requests' },
  }));
  // Trusted remote is parked independently from the email owner-intervention
  // flow. Hide its UI and deny direct access before authentication or proxy
  // handlers can reveal whether a session/link exists.
  R.use((req,res,next)=>{
    if(trustedRemoteEnabled)return next();
    const path=(String(req.path||'').replace(/\/$/,'')||'/').toLowerCase();
    const parked=path==='/trusted-remote'
      ||path==='/api/owner-link'||path.startsWith('/api/owner-link/')
      ||path==='/api/owner-chat'||path.startsWith('/api/owner-chat/')
      ||path==='/api/owner-codex-config'||path.startsWith('/api/owner-codex-config/')
      ||/\/owner-chats(?:\/|$)/.test(path);
    if(!parked)return next();
    if(String(req.get('accept')||'').includes('application/json')||req.query.json==='1')return res.status(404).json({success:false,error:'Not Found'});
    return res.status(404).send('Not Found');
  });
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
  const externalGatewayFetch=opts.externalGatewayFetch||globalThis.fetch;
  const externalGatewayBase=String(ENDPOINTS.api.baseUrl||'').replace(/\/+$/,'');
  const externalGatewayPath='/api/external/v1/gateway/integrations';
  const externalGatewayAgent=(localAgentId)=>{
    const ownerEmail=String(currentOwnerEmail()||'').trim().toLowerCase();
    const row=db.prepare('SELECT agent_id,agent_name,owner_email,did FROM agents WHERE agent_id=? LIMIT 1').get(String(localAgentId||''));
    if(!row||String(row.owner_email||'').trim().toLowerCase()!==ownerEmail)return null;
    const{serverAgentIdFromDid}=require('../core/agent-invitations');
    const publicAgentId=serverAgentIdFromDid(row.did);
    return publicAgentId?{...row,publicAgentId}:null;
  };
  const externalGatewayRequest=async(pathname,init={})=>{
    const ownerEmail=String(currentOwnerEmail()||'').trim().toLowerCase();
    const token=getUserAccessToken(db,ownerEmail);
    if(!token){const error=new Error('LOGIN_REQUIRED');error.status=401;throw error}
    const response=await externalGatewayFetch(externalGatewayBase+pathname,{...init,redirect:'error',headers:{Accept:'application/json',Authorization:'Bearer '+token,...(init.headers||{})},signal:AbortSignal.timeout(10000)});
    const result=response.status===204?{success:true}:await response.json().catch(()=>({success:false,error:{code:'INVALID_RESPONSE'}}));
    if(!response.ok||result.success===false){const code=result?.error?.code||result?.error?.message||'EXTERNAL_GATEWAY_REQUEST_FAILED';const error=new Error(String(code));error.status=response.status||502;throw error}
    return result;
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
  const requireFreshSensitiveLocalAuth=(req,res,next)=>{
    if(req.localAuth?.type==='instance')return next();
    if(req.localAuth?.type==='web'&&Number(req.localAuth.createdAt)>0&&Date.now()-Number(req.localAuth.createdAt)<=5*60*1000)return next();
    return res.status(401).json({success:false,code:'WEB_AUTH_REQUIRED',error:req.t('web.reauth.required')});
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

  const loadA2ATaskRows=async agentId=>{
    const selectedAgent=String(agentId||'').trim();let inbound=[];
    if(opts.a2aMailboxClient){try{inbound=(await opts.a2aMailboxClient.listInboundTasks(selectedAgent||undefined)).map(row=>({task_id:row.gateway_task_id,context_id:row.context_id,agent_id:row.local_agent_id,standard_state:row.standard_state,delivery_state:row.delivery_state,updated_at:row.updated_at,created_at:row.created_at,direction:'Inbound',source_channel:row.source_channel,principal_kind:row.principal_kind,principal_name:row.display_name,principal_display_id:row.principal_display_id,principal_view_id:row.principal_view_id,trust_level:row.trust_level,webhook_status:row.webhook_status,webhook_attempt_count:row.webhook_attempt_count,webhook_next_attempt_at:row.webhook_next_attempt_at}))}catch{}}
    if(!inbound.length&&opts.a2aModule?.running)inbound=opts.a2aModule.getDatabase().prepare(`SELECT gateway_task_id AS task_id,context_id,agent_id,standard_state,delivery_state,updated_at FROM a2a_local_tasks WHERE (?='' OR agent_id=?) ORDER BY updated_at DESC LIMIT 100`).all(selectedAgent,selectedAgent).map(row=>({...row,direction:'Inbound',principal_kind:'unknown'}));
    let outbound=[];if(opts.a2aMailboxClient){try{outbound=(await opts.a2aMailboxClient.listOutboundTasks()).filter(row=>!selectedAgent||row.local_agent_id===selectedAgent)}catch{}}
    return inbound.concat(outbound.map(row=>({task_id:row.gateway_task_id,context_id:row.context_id,agent_id:row.local_agent_id,standard_state:row.standard_state,delivery_state:row.delivery_state,updated_at:row.updated_at,direction:'Outbound'}))).sort((a,b)=>new Date(b.updated_at||0)-new Date(a.updated_at||0));
  };
  const renderA2ATaskRows=(rows,{showAgent=true,T=key=>key}={})=>{
    if(!rows.length)return '<p class="meta">'+esc(T('web.agent.a2a.empty'))+'</p>';
    const principalLabel=row=>T('web.agent.a2a.principal.'+({voko_agent:'voko_agent',did:'did',oauth:'oauth',api_client:'api_client',card_key:'card_key',anonymous_guest:'anonymous_guest'}[row.principal_kind]||'external'))+(row.principal_name?' · '+row.principal_name:'')+(row.principal_display_id?' · '+row.principal_display_id:'');
    const direction=row=>T('web.agent.a2a.direction.'+(String(row.direction).toLowerCase()==='outbound'?'outbound':'inbound'));
    const state=value=>T('web.agent.a2a.state.'+String(value||'unknown').toLowerCase());
    const delivery=value=>T('web.agent.a2a.delivery.'+String(value||'unknown').toLowerCase());
    return '<div class="table-wrap"><table><thead><tr><th>'+esc(T('web.agent.a2a.col.counterparty'))+'</th><th>'+esc(T('web.agent.a2a.col.task'))+'</th>'+(showAgent?'<th>'+esc(T('web.agent.a2a.col.agent'))+'</th>':'')+'<th style="text-align:center">'+esc(T('web.agent.a2a.col.direction'))+'</th><th style="text-align:center">'+esc(T('web.agent.a2a.col.status'))+'</th><th style="text-align:center">'+esc(T('web.agent.a2a.col.time'))+'</th></tr></thead><tbody>'+rows.map(row=>'<tr><td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(principalLabel(row))+'</td><td style="white-space:normal;word-break:break-word"><a href="/a2a-tasks/'+encodeURIComponent(row.task_id)+'"><code>'+esc(String(row.task_id).slice(0,12))+'…</code></a><div class="meta">'+esc(T('web.agent.a2a.context'))+': '+esc(String(row.context_id||'').slice(0,12))+'…</div></td>'+(showAgent?'<td>'+esc(row.agent_id)+'</td>':'')+'<td style="text-align:center;white-space:nowrap">'+esc(direction(row))+'</td><td style="text-align:center;white-space:nowrap"><strong>'+esc(state(row.standard_state))+'</strong><div class="meta">'+esc(delivery(row.delivery_state))+'</div></td><td class="meta" style="text-align:center;white-space:nowrap">'+timeTag(row.updated_at)+'</td></tr>').join('')+'</tbody></table></div>';
  };
  const buildA2APrincipalGroups=(rows,T=key=>key,keyword='')=>{
    const inbound=rows.filter(row=>String(row.direction).toLowerCase()!=='outbound'),groups=new Map();
    inbound.forEach(row=>{
      // Only a server-issued pseudonymous principal ID is safe to group. Unknown callers stay separate.
      const principalId=String(row.principal_display_id||'').trim(),principalViewId=String(row.principal_view_id||'').trim();
      const key=principalViewId||('task:'+String(row.task_id));
      if(!groups.has(key))groups.set(key,{principalId,principalViewId,rows:[]});
      groups.get(key).rows.push(row);
    });
    const principalType=row=>T('web.agent.a2a.principal.'+({voko_agent:'voko_agent',did:'did',oauth:'oauth',api_client:'api_client',card_key:'card_key',anonymous_guest:'anonymous_guest'}[row.principal_kind]||'external'));
    const needle=String(keyword||'').trim().toLocaleLowerCase();
    return Array.from(groups.values()).filter(group=>!needle||group.rows.some(row=>[
      group.principalId,row.principal_name,row.principal_kind,principalType(row),row.task_id,row.context_id,
      row.standard_state,row.delivery_state,row.direction,
    ].some(value=>String(value||'').toLocaleLowerCase().includes(needle)))).sort((a,b)=>new Date(b.rows[0]?.updated_at||0)-new Date(a.rows[0]?.updated_at||0));
  };
  const filterA2ATaskRows=(rows,T=key=>key,keyword='')=>{
    const principalType=row=>T('web.agent.a2a.principal.'+({voko_agent:'voko_agent',did:'did',oauth:'oauth',api_client:'api_client',card_key:'card_key',anonymous_guest:'anonymous_guest'}[row.principal_kind]||'external'));
    const needle=String(keyword||'').trim().toLocaleLowerCase();
    return rows.filter(row=>!needle||[
      row.principal_display_id,row.principal_name,row.principal_kind,principalType(row),row.task_id,row.context_id,
      row.standard_state,row.delivery_state,row.direction,
    ].some(value=>String(value||'').toLocaleLowerCase().includes(needle)))
      .sort((a,b)=>new Date(b.updated_at||0)-new Date(a.updated_at||0));
  };
  const renderA2APrincipalRows=(rows,agentId,T=key=>key)=>{
    if(!rows.length)return '<p class="meta">'+esc(T('web.agent.a2a.empty'))+'</p>';
    const principalType=row=>T('web.agent.a2a.principal.'+({voko_agent:'voko_agent',did:'did',oauth:'oauth',api_client:'api_client',card_key:'card_key',anonymous_guest:'anonymous_guest'}[row.principal_kind]||'external'));
    const state=value=>T('web.agent.a2a.state.'+String(value||'unknown').toLowerCase());
    const items=buildA2APrincipalGroups(rows,T);
    if(!items.length)return '<p class="meta">'+esc(T('web.agent.a2a.empty'))+'</p>';
    return '<div class="table-wrap"><table><thead><tr><th>'+esc(T('web.agent.a2a.col.counterparty'))+'</th><th>'+esc(T('web.agent.a2a.col.latest_task'))+'</th><th style="text-align:center">'+esc(T('web.agent.a2a.col.task_count'))+'</th><th style="text-align:center">'+esc(T('web.agent.a2a.col.status'))+'</th><th style="text-align:center">'+esc(T('web.agent.a2a.col.time'))+'</th></tr></thead><tbody>'+items.map(group=>{
      const latest=group.rows[0],label=group.principalId?group.principalId:principalType(latest)+(latest.principal_name?' · '+latest.principal_name:'');
      const href=group.principalViewId?'/agents/'+encodeURIComponent(agentId)+'/a2a/'+encodeURIComponent(group.principalViewId):'/a2a-tasks/'+encodeURIComponent(latest.task_id);
      return '<tr><td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><a href="'+href+'"><strong>'+esc(label)+'</strong></a></td><td><code>'+esc(String(latest.task_id).slice(0,12))+'…</code></td><td style="text-align:center">'+esc(group.rows.length)+'</td><td style="text-align:center"><strong>'+esc(state(latest.standard_state))+'</strong></td><td class="meta" style="text-align:center;white-space:nowrap">'+timeTag(latest.updated_at)+'</td></tr>';
    }).join('')+'</tbody></table></div>';
  };
  const parseA2AEventPayload=event=>{try{return typeof event?.payload_json==='string'?JSON.parse(event.payload_json):(event?.payload_json||{})}catch{return{}}};
  /**
   * @param {Record<string, unknown>} task
   * @param {string} counterparty
   * @param {(key: string, params?: Record<string, unknown>) => string} T
   * @param {Record<string, unknown>} options
   */
  const renderA2ATaskConversation=(task,counterparty,T=key=>key,options={})=>{
    const events=Array.isArray(task?.events)?task.events:[],messages=[],artifacts=[];let noReply=false;
    events.forEach(event=>{
      const payload=parseA2AEventPayload(event),type=String(event.event_type||''),text=typeof payload.text==='string'?payload.text:typeof payload.message==='string'?payload.message:'';
      if(type==='completed'&&payload.noReply===true)noReply=true;
      if(type==='artifact'){
        const artifact=payload.artifact||payload;
        artifacts.push({name:String(artifact.name||artifact.artifactId||T('web.a2a_task.artifact')),createdAt:event.created_at});
      }
      if(!text)return;
      if(type==='task_submitted')messages.push({sender:counterparty,isAgent:false,text,createdAt:event.created_at});
      else if(['message','completed','input_required','auth_required'].includes(type))messages.push({sender:T('web.conversation.from.agent'),isAgent:true,text,createdAt:event.created_at});
    });
    const body=messages.length?messages.map(message=>'<div style="padding:8px 12px;margin:4px 0;border-radius:6px;border-left:4px solid '+(message.isAgent?'#0f9d58':'#1a73e8')+';background:'+(message.isAgent?'#e6f4ea':'#e8f0fe')+'"><strong>'+esc(message.sender)+'</strong> <span style="color:#888;font-size:13px">['+timeTag(message.createdAt)+']</span><br>'+esc(message.text).replace(/\n/g,'<br>')+'</div>').join(''):noReply?'<p class="meta">'+esc(T('web.a2a_task.no_reply'))+'</p>':'<p class="meta">'+esc(T('web.a2a_task.no_content'))+'</p>';
    const artifactBody=artifacts.length?'<ul class="meta">'+artifacts.map(item=>'<li>'+esc(item.name)+' · '+timeTag(item.createdAt)+'</li>').join('')+'</ul>':'';
    const taskId=String(task?.gateway_task_id||task?.id||'');
    const taskState=esc(T('web.agent.a2a.state.'+String(task?.standard_state||task?.status?.state||'unknown').toLowerCase()));
    const deliveryState=esc(options.deliveryValue||T('web.agent.a2a.delivery.'+String(task?.delivery_state||task?.metadata?.deliveryState||'unknown').toLowerCase()));
    const messageSummary=esc(T('web.a2a_task.message_count',{count:messages.length}));
    const compactMessageCount='<span class="a2a-task-message-count">'+messageSummary+'</span>';
    const taskIdNode=options.taskIdPlain?'<span class="a2a-task-card-id">'+esc(taskId)+'</span>':'<a class="a2a-task-card-id" href="/a2a-tasks/'+encodeURIComponent(taskId)+'" title="'+esc(T('web.a2a_task.breadcrumb'))+'">'+esc(taskId)+'</a>';
    const taskMeta=options.showTaskMeta
      ? '<div class="a2a-task-card-head"><div class="a2a-task-card-title"><span class="badge badge-online">'+esc(options.taskLabel||T('web.a2a_principal.task_tab',{index:1}))+'</span>'+taskIdNode+'</div><div class="a2a-task-card-inline-meta"><span><strong>'+esc(options.stateLabel||T('web.a2a_task.state'))+'</strong> <span class="a2a-task-card-chip success">'+taskState+'</span></span><span><strong>'+esc(options.deliveryLabel||T('web.a2a_task.delivery'))+'</strong> <span class="a2a-task-card-chip info">'+deliveryState+'</span></span><span class="a2a-task-card-message-count">'+compactMessageCount+'</span></div></div>'
      : '<div style="display:flex;justify-content:flex-end;margin:10px 0 6px">'+compactMessageCount+'</div>';
    return taskMeta+'<div class="a2a-task-messages">'+body+artifactBody+'</div>';
  };

  R.get('/a2a-tasks',async(req,res)=>{
    const T=req.t||makeT(req.locale||'zh');
    if(!currentOwnerEmail())return res.redirect('/login');
    if(!opts.a2aModule?.running)return res.send(renderPage(req,'A2A Tasks','<nav><a href="/">'+esc(T('common.nav.home'))+'</a> › A2A Tasks</nav><h1>A2A Tasks</h1><div class="card"><p>A2A Mailbox is not enabled.</p></div>'));
    try{
      const a2aDb=opts.a2aModule.getDatabase();
      const selectedAgent=String(req.query.agentId||'').trim();
      if(selectedAgent&&!ownsA2AAgent(selectedAgent))return res.status(404).send(renderPage(req,'A2A Tasks','<h1>A2A Tasks</h1><div class="card error">Agent not found.</div>'));
      let inbound=[];
      if(opts.a2aMailboxClient){try{inbound=(await opts.a2aMailboxClient.listInboundTasks(selectedAgent||undefined)).map(row=>({
        task_id:row.gateway_task_id,context_id:row.context_id,agent_id:row.local_agent_id,standard_state:row.standard_state,
        delivery_state:row.delivery_state,updated_at:row.updated_at,direction:'Inbound',principal_kind:row.principal_kind,
        principal_name:row.display_name,trust_level:row.trust_level}))}catch{}}
      if(!inbound.length)inbound=a2aDb.prepare(`SELECT gateway_task_id AS task_id,context_id,agent_id,standard_state,delivery_state,updated_at FROM a2a_local_tasks WHERE (?='' OR agent_id=?) ORDER BY updated_at DESC LIMIT 100`).all(selectedAgent,selectedAgent)
        .map(row=>({...row,direction:'Inbound',principal_kind:'unknown'}));
      const outbound=(opts.a2aMailboxClient?await opts.a2aMailboxClient.listOutboundTasks():[]).filter(row=>!selectedAgent||row.local_agent_id===selectedAgent);
      const rows=inbound.concat(outbound.map(row=>({task_id:row.gateway_task_id,agent_id:row.local_agent_id,standard_state:row.standard_state,
        delivery_state:row.delivery_state,updated_at:row.updated_at,direction:'Outbound'}))).sort((a,b)=>new Date(b.updated_at||0)-new Date(a.updated_at||0));
      const principalLabel=row=>({voko_agent:'VOKO Agent',did:'Verified DID',oauth:'Verified OAuth',api_client:'API credential',card_key:'Verified Card key',anonymous_guest:'Anonymous visitor'}[row.principal_kind]||'External caller')+(row.principal_name?' · '+row.principal_name:'');
      const contexts=new Map();rows.forEach(row=>{const key=String(row.context_id||row.task_id);if(!contexts.has(key))contexts.set(key,[]);contexts.get(key).push(row)});
      const body=rows.length?Array.from(contexts.entries()).map(([contextId,tasks])=>'<section class="card"><h2 style="margin-top:0">Context <code>'+esc(contextId.slice(0,12))+'…</code></h2><div class="table-wrap"><table><thead><tr><th>Direction</th><th>Agent</th><th>Counterparty</th><th>Task</th><th>Task state</th><th>Delivery</th><th>Updated</th></tr></thead><tbody>'
        +tasks.map(row=>'<tr><td>'+esc(row.direction)+'</td><td>'+esc(row.agent_id)+'</td><td>'+esc(principalLabel(row))+'</td><td><a href="/a2a-tasks/'+encodeURIComponent(row.task_id)+'"><code>'+esc(String(row.task_id).slice(0,12))+'…</code></a></td><td>'+esc(row.standard_state)+'</td><td>'+esc(row.delivery_state)+'</td><td>'+esc(fmtTime(row.updated_at))+'</td></tr>').join('')+'</tbody></table></div></section>').join('')
        :'<div class="card"><p>No A2A tasks yet.</p></div>';
      res.send(renderPage(req,'A2A Tasks','<nav><a href="/">'+esc(T('common.nav.home'))+'</a> › A2A Tasks</nav><h1>A2A Tasks</h1><p class="meta">A2A tasks are isolated from visitor conversations. Provider sessions, credentials, prompts and envelope contents are not displayed.</p>'+body));
    }catch(error){res.status(500).send(renderPage(req,'A2A Tasks','<h1>A2A Tasks</h1><div class="card error">'+esc(error.message)+'</div>'));}
  });
  const ownsA2AAgent=agentId=>{try{const row=db.prepare('SELECT owner_email FROM agents WHERE agent_id=?').get(agentId);return !!row&&String(row.owner_email||'').trim().toLowerCase()===String(currentOwnerEmail()||'').trim().toLowerCase()}catch{return false}};
  const authorizeA2AApi=(req,{csrf=false}={})=>{
    const supplied=String(req.get('x-voko-token')||req.get('authorization')||'').replace(/^Bearer\s+/i,'');
    if(opts.localAuthToken&&supplied===opts.localAuthToken)return true;
    const session=opts.webSessions?.resolveRequest(req);
    if(!session)return false;
    return !csrf||opts.webSessions.verifyCsrf(req,session);
  };
  R.get('/agents/:agentId/external/:principalViewId',async(req,res)=>{
    const locale=req.locale||detectWebLocale(req,res),T=req.t||makeT(locale),L=key=>esc(T(key));req.locale=locale;req.t=T;
    const agentId=String(req.params.agentId||''),principalViewId=String(req.params.principalViewId||'');
    const notFound=()=>res.status(404).send(renderPage(req,T('web.agent.external.title'),'<div class="card error">'+L('web.agent.external.not_found')+'</div>',{showTitle:false,footer:renderFooter(T,locale)}));
    if(!ownsA2AAgent(agentId)||!/^pv_[0-9a-f]{32}$/i.test(principalViewId))return notFound();
    try{
      const rows=(await loadA2ATaskRows(agentId)).filter(row=>String(row.direction).toLowerCase()!=='outbound'&&row.source_channel==='rest_webhook'&&String(row.principal_view_id||'')===principalViewId);
      if(!rows.length||!opts.a2aMailboxClient)return notFound();
      const systemName=String(rows[0].principal_name||T('web.agent.external.unknown'));
      const contexts=Array.from(rows.reduce((map,row)=>{const id=String(row.context_id||'');if(!map.has(id))map.set(id,[]);map.get(id).push(row);return map},new Map()).entries())
        .map(([id,tasks])=>({id,tasks:tasks.sort((a,b)=>new Date(a.created_at||a.updated_at||0)-new Date(b.created_at||b.updated_at||0)),createdAt:Math.min(...tasks.map(item=>new Date(item.created_at||item.updated_at||0).getTime())),updatedAt:Math.max(...tasks.map(item=>new Date(item.updated_at||0).getTime()))}))
        .sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id));
      const contextPageSize=10,contextTotalPages=Math.max(1,Math.ceil(contexts.length/contextPageSize)),requestedContext=String(req.query.contextId||''),requestedContextIndex=contexts.findIndex(item=>item.id===requestedContext),contextPage=Math.min(Math.max(1,parseInt(String(req.query.contextPage||''),10)||(requestedContextIndex>=0?Math.floor(requestedContextIndex/contextPageSize)+1:contextTotalPages)),contextTotalPages),pageContexts=contexts.slice((contextPage-1)*contextPageSize,contextPage*contextPageSize),selectedContext=pageContexts.find(item=>item.id===requestedContext)||pageContexts[pageContexts.length-1],taskPageSize=10,taskTotalPages=Math.max(1,Math.ceil(selectedContext.tasks.length/taskPageSize)),taskPage=Math.min(Math.max(1,parseInt(String(req.query.taskPage||''),10)||taskTotalPages),taskTotalPages),pageTasks=selectedContext.tasks.slice((taskPage-1)*taskPageSize,taskPage*taskPageSize),details=[];
      for(const row of pageTasks){const task=await opts.a2aMailboxClient.getInboundTask(row.task_id);if(!task||task.source_channel!=='rest_webhook'||String(task.local_agent_id)!==agentId||String(task.principal_view_id||'')!==principalViewId)return notFound();details.push(task)}
      const agent=await getAgentInfo(handlers,agentId);
      const contextBase='/agents/'+encodeURIComponent(agentId)+'/external/'+encodeURIComponent(principalViewId)+'?contextPage=';
      const tabs=contexts.length>1?'<style>'+CONVERSATION_TAB_CSS+'</style><div class="conversation-tab-shell">'+(contextPage>1?'<a class="conversation-tab-arrow" id="external-tabs-prev" aria-label="'+esc(T('web.payments.prev_page'))+'" href="'+contextBase+(contextPage-1)+'">‹</a>':'<span class="conversation-tab-arrow" aria-disabled="true">‹</span>')+'<div class="conversation-tab-rail" id="external-context-tab-rail" role="tablist">'+pageContexts.map(context=>'<a class="conversation-tab-card'+(context.id===selectedContext.id?' active':'')+'" role="tab" aria-selected="'+(context.id===selectedContext.id)+'" href="/agents/'+encodeURIComponent(agentId)+'/external/'+encodeURIComponent(principalViewId)+'?contextId='+encodeURIComponent(context.id)+'&contextPage='+contextPage+'">'+esc(T('web.agent.external.conversation',{index:contexts.indexOf(context)+1}))+'</a>').join('')+'</div>'+(contextPage<contextTotalPages?'<a class="conversation-tab-arrow" id="external-tabs-next" aria-label="'+esc(T('web.payments.next_page'))+'" href="'+contextBase+(contextPage+1)+'">›</a>':'<span class="conversation-tab-arrow" aria-disabled="true">›</span>')+'</div>':'';
      const webhookState=(task)=>{const value=String(task?.webhook_status||'').toLowerCase(),attempts=Math.max(0,Number(task?.webhook_attempt_count)||0);if(value==='sent')return T('web.agent.external.webhook.sent');if(value==='dead')return T('web.agent.external.webhook.failed');if(value==='canceled')return T('web.agent.external.webhook.canceled');if(value==='pending')return attempts?T('web.agent.external.webhook.retrying',{attempt:Math.min(3,attempts)}):T('web.agent.external.webhook.pending');if(value==='leased')return attempts>1?T('web.agent.external.webhook.retrying',{attempt:Math.min(3,attempts-1)}):T('web.agent.external.webhook.sending');return T(['COMPLETED','FAILED','REJECTED','CANCELED'].includes(String(task?.standard_state||'').toUpperCase())?'web.agent.external.webhook.pending':'web.agent.external.webhook.waiting')};
      const messages=details.map((task,index)=>'<section class="card a2a-task-card">'+renderA2ATaskConversation(task,systemName,T,{showTaskMeta:true,taskIdPlain:true,taskLabel:T('web.agent.external.request',{index:(taskPage-1)*taskPageSize+index+1}),stateLabel:T('web.agent.external.processing_status'),deliveryLabel:T('web.agent.external.webhook_status'),deliveryValue:webhookState(task)})+'</section>').join('');
      let taskPagination='';if(taskTotalPages>1){const taskBase='/agents/'+encodeURIComponent(agentId)+'/external/'+encodeURIComponent(principalViewId)+'?contextId='+encodeURIComponent(selectedContext.id)+'&taskPage=';taskPagination='<div style="display:flex;align-items:center;justify-content:center;gap:12px;padding:10px 0;font-size:14px">';if(taskPage>1)taskPagination+='<a href="'+taskBase+(taskPage-1)+'" class="btn-sm" style="padding:4px 12px">'+esc(T('web.payments.prev_page'))+'</a>';taskPagination+='<span style="color:#666">'+esc(T('web.payments.page_of',{cur:taskPage,total:taskTotalPages}))+'</span>';if(taskPage<taskTotalPages)taskPagination+='<a href="'+taskBase+(taskPage+1)+'" class="btn-sm" style="padding:4px 12px">'+esc(T('web.payments.next_page'))+'</a>';taskPagination+='</div>'}
      const body='<div id="external-conversation-root">'+tabs+messages+taskPagination+'</div>';
      const tabScript='';
      if(String(req.query.fragment||'')==='external')return res.send(body);
      const liveScript='<script>(function(){var busy=false,timer=null;function bindTabs(root){var rail=root.querySelector(".conversation-tab-rail"),prev=root.querySelector("#external-tabs-prev"),next=root.querySelector("#external-tabs-next");if(!rail||!prev||!next)return;function state(){var max=Math.max(0,rail.scrollWidth-rail.clientWidth);prev.disabled=rail.scrollLeft<2;next.disabled=rail.scrollLeft>=max-2}prev.onclick=function(){rail.scrollBy({left:-Math.max(180,rail.clientWidth*.7),behavior:"smooth"})};next.onclick=function(){rail.scrollBy({left:Math.max(180,rail.clientWidth*.7),behavior:"smooth"})};rail.addEventListener("scroll",state,{passive:true});state()}function fragmentUrl(){var u=new URL(location.href);u.searchParams.set("fragment","external");return u.pathname+u.search}function refresh(){if(busy||document.hidden)return;var current=document.getElementById("external-conversation-root");if(!current)return;busy=true;fetch(fragmentUrl(),{headers:{"Accept":"text/html","X-Requested-With":"voko-external-conversation"},cache:"no-store"}).then(function(r){if(!r.ok)throw new Error("refresh failed");return r.text()}).then(function(html){var doc=new DOMParser().parseFromString(html,"text/html"),fresh=doc.getElementById("external-conversation-root");if(!fresh||fresh.innerHTML===current.innerHTML)return;var rail=current.querySelector(".conversation-tab-rail"),left=rail?rail.scrollLeft:0,boxes=current.querySelectorAll(".a2a-task-messages"),oldBox=boxes[boxes.length-1],wasBottom=!oldBox||oldBox.scrollHeight-oldBox.clientHeight-oldBox.scrollTop<3,oldTop=oldBox?oldBox.scrollTop:0;current.replaceWith(fresh);var next=fresh.querySelector(".conversation-tab-rail");if(next)next.scrollLeft=left;var freshBoxes=fresh.querySelectorAll(".a2a-task-messages"),freshBox=freshBoxes[freshBoxes.length-1];if(freshBox)freshBox.scrollTop=wasBottom?freshBox.scrollHeight:oldTop;bindTabs(fresh)}).catch(function(){}).finally(function(){busy=false})}timer=setInterval(refresh,3000);document.addEventListener("visibilitychange",function(){if(!document.hidden)refresh()});window.addEventListener("pagehide",function(){clearInterval(timer)},{once:true})})();</script>';
      res.send(renderPage(req,T('web.agent.external.conversation_title',{name:systemName}),body,{showTitle:false,nav:agentNav(agentId,agent?.agentName||agentId,T)+' › '+esc(systemName),footer:renderFooter(T,locale)+tabScript+initialLatestScrollScript('#external-conversation-root',{page:true})+liveScript}));
    }catch(_){return notFound()}
  });
  R.get('/agents/:agentId/a2a/:principalViewId',async(req,res)=>{
    const locale=req.locale||detectWebLocale(req,res),T=req.t||makeT(locale),L=key=>esc(T(key));req.locale=locale;req.t=T;
    const agentId=String(req.params.agentId||''),principalViewId=String(req.params.principalViewId||'');
    const notFound=()=>res.status(404).send(renderPage(req,T('web.a2a_principal.title'),'<div class="card error">'+L('web.a2a_principal.not_found')+'</div>',{showTitle:false,footer:renderFooter(T,locale)}));
    if(!ownsA2AAgent(agentId)||!/^pv_[0-9a-f]{32}$/i.test(principalViewId))return notFound();
    try{
      const rows=(await loadA2ATaskRows(agentId)).filter(row=>String(row.direction).toLowerCase()!=='outbound'&&String(row.principal_view_id||'')===principalViewId);
      if(!rows.length||!opts.a2aMailboxClient)return notFound();
      const principalDisplayId=String(rows[0].principal_display_id||'A2A');
      const contexts=Array.from(rows.reduce((map,row)=>{const id=String(row.context_id||'');if(!map.has(id))map.set(id,[]);map.get(id).push(row);return map},new Map()).entries())
        .map(([id,tasks])=>({id,tasks:tasks.sort((a,b)=>new Date(a.created_at||a.updated_at||0)-new Date(b.created_at||b.updated_at||0)),updatedAt:Math.max(...tasks.map(item=>new Date(item.updated_at||0).getTime()))}))
        .sort((a,b)=>b.updatedAt-a.updatedAt);
      const requestedContext=String(req.query.contextId||''),contextPageSize=10,contextTotalPages=Math.max(1,Math.ceil(contexts.length/contextPageSize)),requestedContextIndex=contexts.findIndex(item=>item.id===requestedContext),contextPage=Math.min(Math.max(1,parseInt(String(req.query.contextPage||''),10)||(requestedContextIndex>=0?Math.floor(requestedContextIndex/contextPageSize)+1:1)),contextTotalPages),pageContexts=contexts.slice((contextPage-1)*contextPageSize,contextPage*contextPageSize),selectedContext=pageContexts.find(item=>item.id===requestedContext)||pageContexts[0];
      const requestedTask=String(req.query.taskId||'');
      if(requestedTask&&!selectedContext.tasks.some(row=>String(row.task_id)===requestedTask))return notFound();
      const taskPageSize=10,taskTotalPages=Math.max(1,Math.ceil(selectedContext.tasks.length/taskPageSize)),taskPage=Math.min(Math.max(1,parseInt(String(req.query.taskPage||''),10)||taskTotalPages),taskTotalPages),pageTasks=selectedContext.tasks.slice((taskPage-1)*taskPageSize,taskPage*taskPageSize),details=[];
      for(const row of pageTasks){const task=await opts.a2aMailboxClient.getInboundTask(row.task_id);if(!task||String(task.local_agent_id)!==agentId||String(task.principal_view_id||'')!==principalViewId||String(task.context_id||'')!==selectedContext.id)return notFound();details.push(task)}
      const agent=await getAgentInfo(handlers,agentId);
      const contextBase='/agents/'+encodeURIComponent(agentId)+'/a2a/'+encodeURIComponent(principalViewId)+'?contextPage=';
      const tabs=contexts.length>1?'<style>'+CONVERSATION_TAB_CSS+'</style><div class="conversation-tab-shell">'+(contextPage>1?'<a class="conversation-tab-arrow" id="a2a-tabs-prev" aria-label="'+esc(T('web.payments.prev_page'))+'" href="'+contextBase+(contextPage-1)+'">‹</a>':'<span class="conversation-tab-arrow" aria-disabled="true">‹</span>')+'<div class="conversation-tab-rail" id="a2a-context-tab-rail" role="tablist">'+pageContexts.map(context=>'<a class="conversation-tab-card'+(context.id===selectedContext.id?' active':'')+'" role="tab" aria-selected="'+(context.id===selectedContext.id)+'" href="/agents/'+encodeURIComponent(agentId)+'/a2a/'+encodeURIComponent(principalViewId)+'?contextId='+encodeURIComponent(context.id)+'&contextPage='+contextPage+'" title="'+esc(context.id)+'">'+esc(T('web.a2a_principal.context_tab',{index:contexts.indexOf(context)+1}))+'</a>').join('')+'</div>'+(contextPage<contextTotalPages?'<a class="conversation-tab-arrow" id="a2a-tabs-next" aria-label="'+esc(T('web.payments.next_page'))+'" href="'+contextBase+(contextPage+1)+'">›</a>':'<span class="conversation-tab-arrow" aria-disabled="true">›</span>')+'</div>':'';
      const contextHeader='<div class="meta" style="margin:10px 0">'+L('web.a2a_principal.context_id')+' <code>'+esc(selectedContext.id)+'</code> · '+esc(T('web.agent.a2a.col.task_count'))+': '+esc(selectedContext.tasks.length)+'</div>';
      const taskCards=details.map((task,index)=>'<section class="card a2a-task-card" id="task-'+esc(task.gateway_task_id)+'">'+renderA2ATaskConversation(task,principalDisplayId,T,{showTaskMeta:true,taskLabel:T('web.a2a_principal.task_tab',{index:(taskPage-1)*taskPageSize+index+1})})+'</section>').join('');
      let taskPagination='';if(taskTotalPages>1){const taskBase='/agents/'+encodeURIComponent(agentId)+'/a2a/'+encodeURIComponent(principalViewId)+'?contextId='+encodeURIComponent(selectedContext.id)+'&taskPage=';taskPagination='<div style="display:flex;align-items:center;justify-content:center;gap:12px;padding:10px 0;font-size:14px">';if(taskPage>1)taskPagination+='<a href="'+taskBase+(taskPage-1)+'" class="btn-sm" style="padding:4px 12px">'+esc(T('web.payments.prev_page'))+'</a>';taskPagination+='<span style="color:#666">'+esc(T('web.payments.page_of',{cur:taskPage,total:taskTotalPages}))+'</span>';if(taskPage<taskTotalPages)taskPagination+='<a href="'+taskBase+(taskPage+1)+'" class="btn-sm" style="padding:4px 12px">'+esc(T('web.payments.next_page'))+'</a>';taskPagination+='</div>'}
      const tabScript='';
      res.send(renderPage(req,T('web.a2a_principal.conversation_title',{id:principalDisplayId}),'<div id="a2a-conversation-root">'+tabs+contextHeader+taskCards+taskPagination+'</div>',{showTitle:false,nav:agentNav(agentId,agent?.agentName||agentId,T)+' › '+esc(principalDisplayId),footer:renderFooter(T,locale)+tabScript+initialLatestScrollScript('#a2a-conversation-root',{page:true})}));
    }catch(_){return notFound()}
  });
  R.get('/__legacy/agents/:agentId/a2a/:principalDisplayId',async(req,res)=>{
    const locale=req.locale||detectWebLocale(req,res),T=req.t||makeT(locale),L=key=>esc(T(key));req.locale=locale;req.t=T;
    const agentId=String(req.params.agentId||''),principalDisplayId=String(req.params.principalDisplayId||'');
    const notFound=()=>res.status(404).send(renderPage(req,T('web.a2a_principal.title'),'<div class="card error">'+L('web.a2a_principal.not_found')+'</div>',{showTitle:false,footer:renderFooter(T,locale)}));
    if(!ownsA2AAgent(agentId)||!/^A2A-[0-9a-f]{8}$/i.test(principalDisplayId))return notFound();
    try{
      const rows=(await loadA2ATaskRows(agentId)).filter(row=>String(row.direction).toLowerCase()!=='outbound'&&String(row.principal_display_id||'')===principalDisplayId);
      if(!rows.length||!opts.a2aMailboxClient)return notFound();
      const requested=String(req.query.taskId||''),selected=rows.find(row=>String(row.task_id)===requested)||rows[0];
      const task=await opts.a2aMailboxClient.getInboundTask(selected.task_id);
      if(!task||String(task.local_agent_id)!==agentId||String(task.principal_display_id||'')!==principalDisplayId)return notFound();
      const agent=await getAgentInfo(handlers,agentId);
      const pageTitle=T('web.a2a_principal.conversation_title',{id:principalDisplayId});
      const taskState=value=>L('web.agent.a2a.state.'+String(value||'unknown').toLowerCase()),deliveryState=value=>L('web.agent.a2a.delivery.'+String(value||'unknown').toLowerCase());
      const eventLabel=value=>L('web.a2a_task.event.'+String(value||'unknown').toLowerCase()),events=Array.isArray(task.events)?task.events:[];
      const timeline=events.length?'<ol>'+events.map(event=>'<li><strong>'+eventLabel(event.event_type)+'</strong> <span class="meta">'+esc(fmtTime(event.created_at))+' · #'+esc(event.gateway_sequence)+'</span></li>').join('')+'</ol>':'<p class="meta">'+L('web.a2a_task.no_events')+'</p>';
      const tabs='<style>'+CONVERSATION_TAB_CSS+'</style><div class="conversation-tab-shell"><button type="button" class="conversation-tab-arrow" id="a2a-tabs-prev" aria-label="'+esc(T('web.payments.prev_page'))+'">‹</button><div class="conversation-tab-rail" id="a2a-task-tab-rail" role="tablist">'+rows.map((row,index)=>'<a class="conversation-tab-card'+(row.task_id===selected.task_id?' active':'')+'" role="tab" aria-selected="'+(row.task_id===selected.task_id)+'" href="/agents/'+encodeURIComponent(agentId)+'/a2a/'+encodeURIComponent(principalDisplayId)+'?taskId='+encodeURIComponent(row.task_id)+'" title="'+esc(row.task_id)+'">'+esc(T('web.a2a_principal.task_tab',{index:index+1}))+' · '+esc(String(row.task_id).slice(0,8))+'…</a>').join('')+'</div><button type="button" class="conversation-tab-arrow" id="a2a-tabs-next" aria-label="'+esc(T('web.payments.next_page'))+'">›</button></div>';
      const tabScript='<script>(function(){var rail=document.getElementById("a2a-task-tab-rail"),prev=document.getElementById("a2a-tabs-prev"),next=document.getElementById("a2a-tabs-next");function state(){if(!rail)return;var max=Math.max(0,rail.scrollWidth-rail.clientWidth);prev.disabled=rail.scrollLeft<2;next.disabled=rail.scrollLeft>=max-2}function move(dir){rail.scrollBy({left:dir*Math.max(180,rail.clientWidth*.7),behavior:"smooth"})}prev.onclick=function(){move(-1)};next.onclick=function(){move(1)};rail.addEventListener("scroll",state,{passive:true});window.addEventListener("resize",state);var active=rail.querySelector(".conversation-tab-card.active");if(active)active.scrollIntoView({inline:"center",block:"nearest"});state()})();</script>';
      const conversation=renderA2ATaskConversation(task,principalDisplayId,T);
      const body=tabs+conversation+'<div class="card"><dl><dt>'+L('web.a2a_task.context')+'</dt><dd><code>'+esc(task.context_id)+'</code></dd><dt>'+L('web.a2a_task.state')+'</dt><dd>'+taskState(task.standard_state)+'</dd><dt>'+L('web.a2a_task.delivery')+'</dt><dd>'+deliveryState(task.delivery_state)+'</dd></dl></div><details class="card"><summary><strong>'+L('web.a2a_task.timeline')+'</strong></summary>'+timeline+'</details>';
      res.send(renderPage(req,pageTitle,body,{showTitle:false,nav:agentNav(agentId,agent?.agentName||agentId,T)+' › '+esc(principalDisplayId),footer:renderFooter(T,locale)+tabScript}));
    }catch(_){return notFound()}
  });
  R.get('/a2a-tasks/:taskId',async(req,res)=>{
    const locale=req.locale||detectWebLocale(req,res),T=req.t||makeT(locale),L=key=>esc(T(key));req.locale=locale;req.t=T;
    const taskState=value=>L('web.agent.a2a.state.'+String(value||'unknown').toLowerCase()),deliveryState=value=>L('web.agent.a2a.delivery.'+String(value||'unknown').toLowerCase());
    const eventLabel=value=>L('web.a2a_task.event.'+String(value||'unknown').toLowerCase());
    try{
      if(!opts.a2aMailboxClient)return res.status(503).send(renderPage(req,T('web.a2a_task.title'),'<h1>'+L('web.a2a_task.title')+'</h1><div class="card error">'+L('web.a2a_task.unavailable')+'</div>',{footer:renderFooter(T,locale)}));
      const task=await opts.a2aMailboxClient.getInboundTask(req.params.taskId);
      if(!task||!ownsA2AAgent(task.local_agent_id))return res.status(404).send(renderPage(req,T('web.a2a_task.title'),'<h1>'+L('web.a2a_task.title')+'</h1><div class="card error">'+L('web.a2a_task.not_found')+'</div>',{footer:renderFooter(T,locale)}));
      const events=Array.isArray(task.events)?task.events:[];
      const timeline=events.length?'<ol>'+events.map(event=>'<li><strong>'+eventLabel(event.event_type)+'</strong> <span class="meta">'+esc(fmtTime(event.created_at))+' · #'+esc(event.gateway_sequence)+'</span></li>').join('')+'</ol>':'<p class="meta">'+L('web.a2a_task.no_events')+'</p>';
      const body='<nav><a href="/agents/'+encodeURIComponent(task.local_agent_id)+'?tab=a2a">'+L('web.agent.tab.a2a_tasks')+'</a> › '+L('web.a2a_task.breadcrumb')+'</nav><h1>'+L('web.a2a_task.title')+'</h1><div class="card"><dl><dt>'+L('web.a2a_task.agent')+'</dt><dd>'+esc(task.local_agent_id)+'</dd><dt>'+L('web.a2a_task.context')+'</dt><dd><code>'+esc(task.context_id)+'</code></dd><dt>'+L('web.a2a_task.state')+'</dt><dd>'+taskState(task.standard_state)+'</dd><dt>'+L('web.a2a_task.delivery')+'</dt><dd>'+deliveryState(task.delivery_state)+'</dd></dl></div><section class="card"><h2>'+L('web.a2a_task.timeline')+'</h2>'+timeline+'</section>';
      res.send(renderPage(req,T('web.a2a_task.title'),body,{footer:renderFooter(T,locale)}));
    }catch(_){res.status(404).send(renderPage(req,T('web.a2a_task.title'),'<h1>'+L('web.a2a_task.title')+'</h1><div class="card error">'+L('web.a2a_task.not_found')+'</div>',{footer:renderFooter(T,locale)}))}
  });
  R.get('/api/a2a/tasks',async(req,res)=>{
    try{if(!authorizeA2AApi(req))return res.status(401).json({error:'WEB_AUTH_REQUIRED'});const agentId=String(req.query.agentId||'');if(agentId&&!ownsA2AAgent(agentId))return res.status(404).json({error:'A2A_TASK_NOT_FOUND'});
      const tasks=opts.a2aMailboxClient?await opts.a2aMailboxClient.listInboundTasks(agentId||undefined):[];res.json({tasks})
    }catch(_){res.status(503).json({error:'A2A_SERVICE_UNAVAILABLE'})}
  });
  R.get('/api/a2a/tasks/:taskId',async(req,res)=>{
    try{if(!authorizeA2AApi(req))return res.status(401).json({error:'WEB_AUTH_REQUIRED'});if(!opts.a2aMailboxClient)return res.status(503).json({error:'A2A_SERVICE_UNAVAILABLE'});const task=await opts.a2aMailboxClient.getInboundTask(req.params.taskId);
      if(!task||!ownsA2AAgent(task.local_agent_id))return res.status(404).json({error:'A2A_TASK_NOT_FOUND'});res.json({task})
    }catch(_){res.status(404).json({error:'A2A_TASK_NOT_FOUND'})}
  });
  R.get('/api/a2a/agents/:agentId/principals/:principalViewId/contexts/:contextId',async(req,res)=>{
    try{if(!authorizeA2AApi(req))return res.status(401).json({error:'WEB_AUTH_REQUIRED'});if(!opts.a2aMailboxClient)return res.status(503).json({error:'A2A_SERVICE_UNAVAILABLE'});
      const agentId=String(req.params.agentId||''),principalViewId=String(req.params.principalViewId||''),contextId=String(req.params.contextId||'');
      if(!ownsA2AAgent(agentId)||!/^pv_[0-9a-f]{32}$/i.test(principalViewId))return res.status(404).json({error:'A2A_CONTEXT_NOT_FOUND'});
      const tasks=await opts.a2aMailboxClient.listInboundTasks(agentId);
      const scoped=tasks.filter(task=>String(task.local_agent_id)===agentId&&String(task.principal_view_id||'')===principalViewId&&String(task.context_id)===contextId);
      if(!scoped.length)return res.status(404).json({error:'A2A_CONTEXT_NOT_FOUND'});res.json({contextId,tasks:scoped})
    }catch(_){res.status(503).json({error:'A2A_SERVICE_UNAVAILABLE'})}
  });
  R.post('/api/a2a/tasks/:taskId/cancel',async(req,res)=>{
    try{if(!authorizeA2AApi(req,{csrf:true}))return res.status(403).json({error:'WEB_AUTH_REQUIRED'});
      if(!opts.a2aMailboxClient)return res.status(503).json({error:'A2A_SERVICE_UNAVAILABLE'});const task=await opts.a2aMailboxClient.getInboundTask(req.params.taskId);
      if(!task||!ownsA2AAgent(task.local_agent_id))return res.status(404).json({error:'A2A_TASK_NOT_FOUND'});res.json(await opts.a2aMailboxClient.cancelInboundTask(req.params.taskId))
    }catch(error){res.status(Number(error?.status)||409).json({error:'A2A_CANCEL_UNSUPPORTED_OR_TOO_LATE'})}
  });

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
    const css='<style>.voko-auth-dialog{width:min(440px,calc(100% - 32px));padding:0;border:0;border-radius:14px;box-shadow:0 22px 70px rgba(15,23,42,.28)}.voko-auth-dialog::backdrop{background:rgba(15,23,42,.48)}.voko-auth-box{padding:24px}.voko-auth-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.voko-auth-head h2{margin:0;font-size:20px;border:0}.voko-auth-close{min-width:0;margin:0;padding:3px 10px;background:#fff;color:#667085;border:0;font-size:22px}.voko-auth-otp{position:relative;display:grid;grid-template-columns:repeat(6,1fr);gap:8px;margin-top:4px}.voko-auth-otp-cell{height:52px;display:flex;align-items:center;justify-content:center;border:2px solid #e0e4ea;border-radius:10px;background:#f8f9fb;font-size:22px;font-weight:700}.voko-auth-otp:focus-within .voko-auth-otp-cell.active{border-color:#1a73e8;box-shadow:0 0 0 4px rgba(26,115,232,.1);background:#fff}.voko-auth-otp-input{position:absolute;inset:0;width:100%;height:100%;margin:0;padding:0;opacity:0;cursor:text}.voko-auth-actions{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:12px}.voko-auth-actions button{margin:0;min-width:0}.voko-auth-message{margin-top:12px;padding:9px 11px;border-radius:8px;font-size:14px}.voko-auth-message.error{background:#fce8e6;color:#b42318}.voko-auth-message.success{background:#e6f4ea;color:#0f7b45}@media(max-width:480px){.voko-auth-otp{gap:6px}.voko-auth-otp-cell{height:47px;border-radius:8px}}</style>';
    const html='<dialog id="voko-auth-dialog" class="voko-auth-dialog"><div class="voko-auth-box"><div class="voko-auth-head"><h2>'+L('web.reauth.title')+'</h2><button type="button" id="voko-auth-close" class="voko-auth-close" aria-label="'+L('common.btn.close')+'">×</button></div><p class="meta" style="margin:5px 0 12px">'+L('web.reauth.desc')+'</p><div id="voko-auth-fields"><label for="voko-auth-email">'+L('register.login.email')+'</label><input type="email" id="voko-auth-email" value="'+esc(email)+'" autocomplete="email"><label for="voko-auth-code">'+L('register.login.code')+'</label><div class="voko-auth-otp"><span class="voko-auth-otp-cell active" aria-hidden="true"></span><span class="voko-auth-otp-cell" aria-hidden="true"></span><span class="voko-auth-otp-cell" aria-hidden="true"></span><span class="voko-auth-otp-cell" aria-hidden="true"></span><span class="voko-auth-otp-cell" aria-hidden="true"></span><span class="voko-auth-otp-cell" aria-hidden="true"></span><input type="text" id="voko-auth-code" class="voko-auth-otp-input" maxlength="6" inputmode="numeric" pattern="[0-9]{6}" autocomplete="one-time-code" aria-label="'+L('register.login.code')+'"></div><div class="voko-auth-actions"><button type="button" class="btn-outline" id="voko-auth-send">'+L('register.login.send_code')+'</button><button type="button" class="btn-success" id="voko-auth-verify">'+L('web.reauth.verify')+'</button></div></div><div id="voko-auth-message" class="voko-auth-message" hidden aria-live="polite"></div></div></dialog>';
    const script='<script>(function(){var nativeFetch=window.fetch.bind(window),dlg=document.getElementById("voko-auth-dialog"),email=document.getElementById("voko-auth-email"),code=document.getElementById("voko-auth-code"),send=document.getElementById("voko-auth-send"),verify=document.getElementById("voko-auth-verify"),close=document.getElementById("voko-auth-close"),message=document.getElementById("voko-auth-message"),fields=document.getElementById("voko-auth-fields"),pending=null;function cookie(name){var p=name+"=",x=document.cookie.split(";").map(function(v){return v.trim()}).find(function(v){return v.indexOf(p)===0});return x?decodeURIComponent(x.slice(p.length)):""}function publicPath(path){return path==="/login"||path==="/reauth"||path==="/bug-report"||path==="/api/bug-report"||path==="/register"||path.indexOf("/api/login/")===0||path.indexOf("/api/agent-registration")===0||path.indexOf("/join/")===0}function isSensitive(url,init){var u=new URL(url,location.href),method=String((init&&init.method)||"GET").toUpperCase();return u.origin===location.origin&&["GET","HEAD","OPTIONS"].indexOf(method)===-1&&!publicPath(u.pathname)}function showMessage(text,kind){message.hidden=false;message.textContent=text;message.className="voko-auth-message "+kind}function authorize(){if(pending)return pending;fields.hidden=false;message.hidden=true;code.value="";dlg.showModal();code.focus();pending=new Promise(function(resolve,reject){dlg._resolve=resolve;dlg._reject=reject});return pending}async function authPost(action){var r=await nativeFetch("/reauth",{method:"POST",headers:{"Accept":"application/json","Content-Type":"application/json"},body:JSON.stringify({action:action,email:email.value.trim(),code:code.value.trim()})}),j=await r.json();if(!r.ok||!j.success)throw new Error(j.error||'+JSON.stringify(T('common.action.failed'))+');return j}close.addEventListener("click",function(){dlg.close();if(dlg._reject)dlg._reject(new Error('+JSON.stringify(T('web.reauth.cancelled'))+'));pending=null});send.addEventListener("click",async function(){send.disabled=true;try{await authPost("sendCode");showMessage('+JSON.stringify(T('web.reauth.code_sent'))+',"success");code.focus()}catch(e){showMessage(e.message,"error")}finally{send.disabled=false}});verify.addEventListener("click",async function(){verify.disabled=true;try{await authPost("verify");fields.hidden=true;showMessage("✓ "+'+JSON.stringify(T('web.reauth.success'))+',"success");setTimeout(function(){dlg.close();var done=dlg._resolve;pending=null;if(done)done()},700)}catch(e){showMessage(e.message,"error")}finally{verify.disabled=false}});code.addEventListener("keydown",function(e){if(e.key==="Enter")verify.click()});window.fetch=async function(input,init){var requestUrl=typeof input==="string"?input:input.url,options=Object.assign({},init||{});if(!isSensitive(requestUrl,options))return nativeFetch(input,options);options.headers=new Headers(options.headers||{});options.headers.set("X-VOKO-CSRF",cookie("voko_csrf"));options.headers.set("Accept",options.headers.get("Accept")||"application/json");var response=await nativeFetch(input,options);if((response.status===401||response.status===403)&&((await response.clone().json().catch(function(){return{}})).code==="WEB_AUTH_REQUIRED")){await authorize();options.headers.set("X-VOKO-CSRF",cookie("voko_csrf"));response=await nativeFetch(input,options)}return response};document.addEventListener("submit",async function(event){var form=event.target;if(!(form instanceof HTMLFormElement)||event.defaultPrevented||String(form.method).toUpperCase()!=="POST"||form.method==="dialog")return;var url=new URL(form.getAttribute("action")||location.href,location.href);if(url.origin!==location.origin||publicPath(url.pathname))return;event.preventDefault();var data=new FormData(form);if(event.submitter&&event.submitter.name)data.append(event.submitter.name,event.submitter.value);var body=form.enctype==="multipart/form-data"?data:new URLSearchParams(Array.from(data.entries()).map(function(x){return[x[0],String(x[1])] }));try{var response=await window.fetch(url.href,{method:"POST",body:body});if(response.redirected){location.assign(response.url);return}var type=response.headers.get("content-type")||"";if(type.indexOf("text/html")!==-1){document.open();document.write(await response.text());document.close();return}var result=await response.json().catch(function(){return{}});if(result.success)location.reload();else throw new Error(result.error||'+JSON.stringify(T('common.action.failed'))+')}catch(e){if(e&&e.message!=='+JSON.stringify(T('web.reauth.cancelled'))+')window.alert(e.message||'+JSON.stringify(T('common.action.failed'))+')}})})();</'+'script>';
    const otpScript='<script>(function(){var dialog=document.getElementById("voko-auth-dialog"),code=document.getElementById("voko-auth-code"),verify=document.getElementById("voko-auth-verify"),cells=Array.from(document.querySelectorAll(".voko-auth-otp-cell")),lastSubmittedCode="";if(!dialog||!code||!verify)return;function render(){var value=code.value.replace(/\\D/g,"").slice(0,6);code.value=value;cells.forEach(function(cell,index){cell.textContent=value[index]||"";cell.classList.toggle("active",value.length<6&&index===value.length)});if(value.length===6&&value!==lastSubmittedCode){lastSubmittedCode=value;verify.click()}}code.addEventListener("input",render);dialog.addEventListener("close",function(){code.value="";lastSubmittedCode="";render()});render()})();</'+'script>';
    return css+html+script.replace('window.alert','showVokoMessage')+otpScript;
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
    const isConversationDetail=req.method==='GET'&&/^\/agents\/[^/]+\/c\/[^/]+$/.test(req.path);
    return page(title,body,{...options,showTitle:isConversationDetail?false:options.showTitle,footer:options.footer===undefined?renderFooter(req.t,req.locale):options.footer},req.t,req.locale);
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
      const deliveryScript='<script>(function(){var el=document.getElementById("delivery-status");if(!el)return;var aid=el.getAttribute("data-agent-id"),cid=el.getAttribute("data-channel-id"),labels={processing:'+JSON.stringify(t('web.conversation.delivery_processing'))+',pending:'+JSON.stringify(t('web.conversation.delivery_pending'))+',completed:'+JSON.stringify(t('web.conversation.delivery_completed'))+',failed:'+JSON.stringify(t('web.conversation.delivery_failed'))+'};function show(s){if(!s||s.agentId!==aid||String(s.channelId||s.visitorId||"")!==cid)return;var text=labels[s.status];if(!text)return;el.textContent=text;el.style.display="block";el.style.color=s.status==="failed"?"#d93025":s.status==="completed"?"#0f9d58":"#e37400";if(s.status==="completed")setTimeout(function(){if(el.textContent===text)el.style.display="none"},1800)}function connect(){try{var ws=new WebSocket("ws://"+location.host+"/ws");ws.onmessage=function(e){try{var d=JSON.parse(e.data);if(d.event==="agent-delivery:status")show(d.data||{})}catch(_){}};ws.onclose=function(){setTimeout(connect,3000)}}catch(_){setTimeout(connect,5000)}}connect()})();</script>';
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
        +'</div>'+deliveryScript;
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
      res.set('Cache-Control','no-store, no-cache, must-revalidate');
      const T=req.t,L=k=>esc(T(k));
      // Query parameters select a notice kind only. Never reflect their caller-controlled value.
      if(req.query.ok)req.query.ok=T('common.home.success');
      if(req.query.warn)req.query.warn=T('common.home.warning');
      if(req.query.err)req.query.err=T('common.action.failed');
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
      const agentListData=await handlers.list_agents({limit:500});
      let agents=agentListData.agents||[];
      // pagination + search
      const page = parseInt(req.query.page, 10) || 1;
      const keyword = req.query.keyword || '';
      let filtered=agents;
      if(keyword){const kw=keyword.toLowerCase();filtered=agents.filter(a=>(a.agentName||'').toLowerCase().includes(kw)||(a.agentId||'').toLowerCase().includes(kw))}
      const limit=20,totalPages=Math.ceil(filtered.length/limit);
      const pageAgents=filtered.slice((page-1)*limit,page*limit);
      const rows=[];const jd=[];const a2aPublicByAgent=new Map(),a2aRuntimeEnabled=!!opts.a2aModule?.enabled;
      for(const item of pageAgents){try{const local=db.prepare('SELECT did,publish_status,ability FROM agents WHERE agent_id=?').get(item.agentId);const{serverAgentIdFromDid}=require('../core/agent-invitations');const publicId=serverAgentIdFromDid(local?.did)||item.agentId;const published=a2aRuntimeEnabled&&local?.publish_status==='published';let declared=false;try{const abilities=JSON.parse(local?.ability||'null');declared=Array.isArray(abilities)&&abilities.length>0}catch{}a2aPublicByAgent.set(item.agentId,{published,publicId,declared})}catch{}}
      const reviewByPublicAgent=new Map();
      try{
        const token=getUserAccessToken(db,ownerEmail);
        let reviewAgents=[];
        if(Array.isArray(opts.agentReviewStatuses))reviewAgents=opts.agentReviewStatuses;
        else if(token&&String(token).startsWith('ut_')){
          const response=await fetch(VOKO_API_URL+'/api/external/v1/agents/statuses',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(2500)});
          const payload=await response.json();
          if(response.ok&&payload?.success)reviewAgents=payload.data?.agents||[];
        }
        for(const item of reviewAgents){const id=String(item.agentId||item.id||'');if(id)reviewByPublicAgent.set(id,item)}
      }catch(_){}

      for(const a of pageAgents){
        const publicAgent=a2aPublicByAgent.get(a.agentId);
        const review=reviewByPublicAgent.get(String(a.agentId))||reviewByPublicAgent.get(String(publicAgent?.publicId||''));
        const auditStatus=review&&Number.isInteger(Number(review.auditStatus))?Number(review.auditStatus):null;
        const auditBlocked=auditStatus!==null&&auditStatus!==1;
        const auditText=auditStatus===0?L('web.home.audit.pending'):auditStatus===2?L('web.home.audit.rejected'):'';
        const auditTip=auditStatus===0?L('web.home.audit.pending_tip'):auditStatus===2?L('web.home.audit.rejected_tip'):'';
        let connStatus='<span class="unknown">'+L('common.status.unknown')+'</span>';
        let agentOnline=null;
        let messageMode=L('web.home.message_mode.loading');
        let messageModeDetected=false;
        try{
          const st=await getAgentStatus(handlers,a.agentId);
          const ag=st.agent;
          if(ag){agentOnline=ag.imConnected===true;connStatus=agentOnline?'<span class="online">'+L('common.status.online')+'</span>':'<span class="offline">'+L('common.status.offline')+'</span>'}
          const mode=getMessageMode(st,T);
          messageMode=mode.text;
          messageModeDetected=mode.detected;
        }catch{}
        var bt=a.backendType||'-';
        const agentNameFull=String(a.agentName||a.agentId||'');
        const agentNameDisplay=truncateAgentName(agentNameFull);
        const agentNameHint=agentNameDisplay===agentNameFull?'':' title="'+esc(agentNameFull)+'" aria-label="'+esc(agentNameFull)+'"';
        var visitorValue='<span class="home-access-value" style="font-size:13px">'+L('web.home.access.not_generated')+'</span>',visitorAction='<button class="btn btn-sm btn-outline home-access-action" data-role="gen-link" data-agent="'+esc(a.agentId)+'"'+(auditBlocked?' disabled title="'+auditTip+'"':'')+'>'+L('common.btn.generate_link')+'</button>',accessRow=null;
        if(db){try{accessRow=db.prepare('SELECT short_link_url, imUid FROM agents WHERE agent_id=?').get(a.agentId);if(accessRow&&accessRow.short_link_url){var su=esc(accessRow.short_link_url);visitorValue='<a class="home-access-value" href="'+su+'" target="_blank" rel="noopener noreferrer">'+su.substring(0,35)+(su.length>35?'…':'')+'</a>';visitorAction=copyButton({esc,label:L('web.home.access.copy_visitor'),attrs:'data-voko-copy-value="'+su+'"'})}}catch(ex){}}
        if(auditBlocked&&accessRow?.short_link_url)visitorValue='<span class="home-access-value">'+L('web.home.access.unavailable')+'</span>';
        const a2a=publicAgent;const a2aCard=a2a?.published?String(ENDPOINTS.api.baseUrl||'').replace(/\/+$/,'')+'/a2a/agents/'+encodeURIComponent(a2a.publicId)+'/.well-known/agent-card.json':'';
        const a2aItem=auditBlocked?'<button type="button" class="home-access-compact-item home-access-copy-item" disabled title="'+auditTip+'"><span class="home-access-label">'+accessIcon('a2a')+'A2A Card</span></button>':!a2a?.declared?'<a class="home-access-compact-item home-access-compact-link home-a2a-declare-link" href="/agents/'+encodeURIComponent(a.agentId)+'/caps" title="'+L('web.home.access.declare_a2a')+'" aria-label="'+L('web.home.access.declare_a2a')+'"><span class="home-access-label">'+accessIcon('a2a')+'A2A Card</span><span class="voko-copy-button" aria-hidden="true">'+jumpIcon()+'</span></a>':'<button type="button" class="home-access-compact-item home-access-copy-item" title="'+L('web.home.access.copy_a2a')+'" aria-label="'+L('web.home.access.copy_a2a')+'"'+(a2a?.published?' data-voko-copy-value="'+esc(a2aCard)+'" data-voko-copy-icon-target=".home-copy-action-icon"':' disabled')+'><span class="home-access-label">'+accessIcon('a2a')+'A2A Card</span><span class="voko-copy-button home-copy-action-icon" aria-hidden="true">'+COPY_ICON+'</span></button>';
        const imUid=String(accessRow&&accessRow.imUid||''),imUidItem='<button type="button" class="home-access-compact-item home-access-copy-item" title="'+(auditBlocked?auditTip:L('web.home.access.copy_im_uid'))+'" aria-label="'+L('web.home.access.copy_im_uid')+'"'+(imUid&&!auditBlocked?' data-voko-copy-value="'+esc(imUid)+'" data-voko-copy-icon-target=".home-copy-action-icon"':' disabled')+'><span class="home-access-label">'+accessIcon('im')+'IM UID</span><span class="voko-copy-button home-copy-action-icon" aria-hidden="true">'+COPY_ICON+'</span></button>';
        var accessModeButton='<button type="button" class="btn btn-sm btn-outline home-mode-toggle home-access-mode '+(a.accessMode==='private'?'home-mode-private':'home-mode-public')+'" style="margin:1px!important;padding:1px 6px!important;min-width:auto!important;min-height:auto!important;font-size:11px!important;line-height:1.4!important;border-width:2px" data-role="toggle-acc" data-agent="'+esc(a.agentId)+'" data-acc-mode="'+(a.accessMode==='private'?'private':'public')+'" title="'+(auditBlocked?auditTip:esc(a.accessMode==='private'?T('common.acc.title_private'):T('common.acc.title_public')))+'"'+(auditBlocked?' disabled':'')+'>'+L(a.accessMode==='private'?'common.acc.private':'common.acc.public')+'</button>';
        const externalItem=auditBlocked?'<span class="home-access-compact-item home-access-compact-link" title="'+auditTip+'"><span class="home-access-label">'+accessIcon('external')+L('web.home.access.external')+'</span></span>':'<a class="home-access-compact-item home-access-compact-link" href="/external-integrations?agentId='+encodeURIComponent(a.agentId)+'"><span class="home-access-label">'+accessIcon('external')+L('web.home.access.external')+'</span></a>';
        var shortCell=(auditBlocked?'<div class="home-audit-notice" role="status">'+auditText+'</div>':'')+'<div class="home-access-stack"><div class="home-access-row home-access-visitor-row"><span class="home-access-label">'+accessIcon('visitor')+L('web.home.access.visitor')+'</span>'+visitorValue+accessModeButton+visitorAction+'</div><div class="home-access-row home-access-protocol-row">'+a2aItem+imUidItem+externalItem+'</div></div>';
        var actionHtml='<a href="/agents/'+esc(a.agentId)+'/edit" class="btn btn-sm btn-outline home-agent-edit" style="margin:1px;padding:1px 6px;font-size:11px;min-height:auto">'+L('common.btn.edit')+'</a> <button type="button" class="btn btn-sm home-mode-toggle '+(a.publishStatus==='published'?'home-mode-published':'home-mode-unpublished')+'" data-role="toggle-pub" data-agent="'+esc(a.agentId)+'" data-pub-status="'+(a.publishStatus==='published'?'published':'unpublished')+'" title="'+esc(auditBlocked?auditTip:(a.publishStatus==='published'?T('common.pub.title_published'):T('common.pub.title_unpublished')))+'"'+(auditBlocked?' disabled':'')+'>'+L(a.publishStatus==='published'?'common.pub.published':'common.pub.unpublished')+'</button>';
        const messageModePicker='<details class="home-message-mode-picker'+(agentOnline===false?' is-agent-offline':'')+'" data-role="message-mode-picker" data-agent="'+esc(a.agentId)+'" data-agent-online="'+(agentOnline===false?'false':'true')+'"><summary data-role="message-mode-summary">'+esc(messageMode)+'</summary><div class="home-message-mode-menu" data-role="message-mode-menu"><span class="home-message-mode-loading">'+L('web.home.message_mode.checking')+'</span></div></details>';
        rows.push('<tr class="'+(auditBlocked?'home-agent-row is-audit-blocked':'home-agent-row')+'" data-agent-id="'+esc(a.agentId)+'" data-audit-status="'+(auditStatus===null?'unknown':auditStatus)+'"><td class="home-agent-name"><a href="/agents/'+esc(a.agentId)+'"'+agentNameHint+'>'+esc(agentNameDisplay)+'</a></td><td style="white-space:nowrap;font-size:14px;text-align:center">'+esc(bt)+'</td><td data-role="connection-status" style="white-space:nowrap;font-size:14px;text-align:center">'+connStatus+'</td><td data-role="message-mode" data-message-mode-detected="'+(messageModeDetected?'true':'false')+'" style="white-space:nowrap;font-size:14px;text-align:center">'+messageModePicker+'</td><td class="home-agent-short'+(agentOnline===false?' is-agent-offline':'')+(auditBlocked?' is-agent-audit-blocked':'')+'" data-agent-online="'+(agentOnline===null?'unknown':agentOnline?'true':'false')+'" style="font-size:13px">'+shortCell+'</td><td class="home-agent-actions" style="white-space:nowrap;font-size:13px;text-align:center">'+actionHtml+'</td></tr>');        jd.push({name:a.agentName,identifier:a.agentId})
      }

      let pgBar='';
      const kwHome=keyword?'&keyword='+encodeURIComponent(keyword):'';
      if(totalPages>1){
        pgBar='<div class="home-pagination" role="navigation" aria-label="'+esc(T('web.payments.page_of',{cur:page,total:totalPages}))+'">';
        if(page>1)pgBar+='<a href="/?page='+(page-1)+kwHome+'" class="btn-sm" style="padding:4px 12px">'+esc(T('web.payments.prev_page'))+'</a>';
        pgBar+='<span style="color:#666">'+esc(T('web.payments.page_of',{cur:page,total:totalPages}))+'</span>';
        if(page<totalPages)pgBar+='<a href="/?page='+(page+1)+kwHome+'" class="btn-sm" style="padding:4px 12px">'+esc(T('web.payments.next_page'))+'</a>';
        pgBar+='</div>'
      }

      // 信息栏
      const messageModeStyle='<style>.home-message-mode-picker{position:relative;display:inline-block}.home-message-mode-picker summary{list-style:none;cursor:pointer;color:#175cd3;border-radius:6px;padding:2px 18px 2px 6px;position:relative}.home-message-mode-picker summary::-webkit-details-marker{display:none}.home-message-mode-picker summary:after{content:"▾";position:absolute;right:4px;color:#667085}.home-message-mode-picker[open] summary{background:#eff6ff}.home-message-mode-picker.is-agent-offline summary{color:#b0b5bd;cursor:not-allowed;pointer-events:none}.home-message-mode-picker.is-agent-offline summary:after{color:#c8ccd2}.home-message-mode-menu{position:absolute;z-index:30;top:calc(100% + 5px);left:50%;transform:translateX(-50%);width:260px;padding:6px;background:#fff;border:1px solid #d0d5dd;border-radius:10px;box-shadow:0 10px 28px rgba(15,23,42,.16);text-align:left}.home-message-mode-picker.is-dropup .home-message-mode-menu{top:auto;bottom:calc(100% + 5px)}.home-message-mode-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:4px}.home-message-mode-option{display:grid;grid-template-columns:10px minmax(0,1fr) auto;align-items:center;gap:7px;width:100%;margin:0;padding:8px;border:0;border-radius:7px;background:transparent;color:#344054;text-align:left;font-size:13px;cursor:pointer}.home-message-mode-option:hover:not(:disabled){background:#f2f7ff}.home-message-mode-option:disabled{cursor:not-allowed;color:#98a2b3}.home-message-mode-option.is-selected{background:#edf9f1}.home-message-mode-settings{margin:0;padding:4px 7px;min-width:auto;min-height:auto;border:1px solid #d0d5dd;border-radius:6px;background:#fff;color:#175cd3;font-size:11px}.home-message-mode-dot{width:8px;height:8px;border-radius:50%}.home-message-mode-dot.is-success{background:#12b76a}.home-message-mode-dot.is-warning{background:#f79009}.home-message-mode-dot.is-danger-warning{background:#f04438}.home-message-mode-dot.is-danger{background:#d92d20}.home-message-mode-dot.is-muted{background:#98a2b3}.home-message-mode-name{font-weight:600}.home-message-mode-state{font-size:11px;color:#667085;white-space:nowrap}.home-message-mode-state.is-success{color:#067647}.home-message-mode-state.is-warning{color:#b54708}.home-message-mode-state.is-danger-warning{color:#c4320a}.home-message-mode-state.is-danger{color:#b42318}.home-message-mode-state.is-muted{color:#667085}.home-message-mode-loading{display:block;padding:9px;color:#667085;font-size:12px;text-align:center}.home-message-mode-loading.is-error{color:#b42318}.home-message-mode-setup{display:grid;gap:7px;padding:8px;color:#344054;font-size:12px}.home-message-mode-setup p{margin:0;color:#667085;line-height:1.45}.home-message-mode-setup .voko-command-inline{min-width:0}.home-message-mode-setup .voko-command-inline code{display:inline-block;overflow:hidden;overflow-wrap:normal;padding:6px;border-radius:6px;background:#f2f4f7;color:#101828}.home-message-mode-setup>button{justify-self:end;margin:0;width:auto;min-width:168px;min-height:30px}.home-message-mode-setup .voko-copy-button{width:28px;min-width:28px;min-height:28px}</style>';
      const auditRowStyle='<style>.home-agent-row.is-audit-blocked>td{background:#f7f8fa;color:#98a2b3}.home-agent-row.is-audit-blocked .home-agent-name a,.home-agent-row.is-audit-blocked [data-role=connection-status],.home-agent-row.is-audit-blocked [data-role=message-mode]{opacity:.55}.home-agent-row.is-audit-blocked .home-agent-edit{opacity:1;background:#fff;color:#344054;border-color:#98a2b3;pointer-events:auto}.home-agent-row.is-audit-blocked [data-role=toggle-pub]{opacity:.45}</style>';
      const body=messageModeStyle+auditRowStyle+'<div class="info-bar" style="display:flex;flex-wrap:nowrap;justify-content:space-between;align-items:center;gap:8px">'
        +'<span style="display:flex;align-items:center;gap:6px;white-space:nowrap">'
        +'<strong>👤 '+esc(ownerEmail)+'</strong>'
        +'<a href="javascript:void(0)" data-role="logout-btn" class="btn btn-sm btn-outline" style="margin:0;min-width:auto;min-height:auto;padding:2px 8px;font-size:12px;line-height:1.4">'+L('common.btn.switch')+'</a>'
        +'</span>'
        +(filtered.length>0?'<span style="white-space:nowrap"><a href="/agent/add?new=1" class="btn btn-sm" style="margin:0;min-width:auto;min-height:auto;padding:3px 10px;font-size:13px;line-height:1.4">'+L('common.btn.register')+'</a></span>':'')
        +'</div>'
        +(filtered.length>0
          ?'<style>.home-agent-table{table-layout:fixed;min-width:0}.home-agent-name a{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.home-agent-actions{white-space:nowrap}.home-agent-actions .btn{white-space:nowrap;margin:1px;padding:1px 6px;min-width:auto;min-height:auto;font-size:11px}.home-audit-notice{margin:0 0 5px;padding:4px 8px;border:1px solid #f2c94c;border-radius:6px;background:#fff8db;color:#8a5a00;font-size:12px;font-weight:700}.home-access-stack{display:grid;gap:0;min-width:0}.home-access-row{display:grid;grid-template-columns:88px minmax(0,1fr) auto;align-items:center;gap:7px;min-height:28px}.home-access-visitor-row{grid-template-columns:88px minmax(0,1fr) auto auto}.home-access-protocol-row{grid-template-columns:minmax(0,.9fr) minmax(0,.85fr) minmax(0,1.25fr);gap:6px}.home-access-compact-item{display:flex;align-items:center;justify-content:space-between;gap:2px;min-width:0;font-size:12px}.home-access-compact-item+.home-access-compact-item{border-left:1px solid #d9e0e8;padding-left:6px}.home-access-compact-link{color:#475467;text-decoration:none;font-weight:400;padding:0}.home-access-compact-link:hover{color:#1a73e8}.home-agent-short.is-agent-audit-blocked .home-access-stack{opacity:.55}.home-agent-short.is-agent-audit-blocked a,.home-agent-short.is-agent-audit-blocked button{pointer-events:none}.home-access-row+.home-access-row{border-top:1px dashed #d9e0e8;padding-top:5px;margin-top:5px}.home-access-label{display:inline-flex;align-items:center;gap:4px;color:#475467;white-space:nowrap}.home-access-value{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#667085;font-size:12px}.home-access-action{margin:1px!important;padding:1px 6px!important;min-width:auto!important;min-height:auto!important;font-size:11px!important;line-height:1.4}.home-access-mode{margin:0!important;padding:3px 7px!important;min-width:auto!important;min-height:26px!important;font-size:11px!important;line-height:1.3;white-space:nowrap}.home-copy-icon{display:inline-flex;align-items:center;justify-content:center;width:27px;height:27px;margin:0;padding:0;min-width:27px;min-height:27px;border:0;background:transparent;color:#667085;border-radius:6px;cursor:pointer;transition:color .15s ease,background .15s ease,transform .15s ease}.home-copy-icon:hover{color:#1677e8;background:#f2f7ff}.home-copy-icon:focus-visible{outline:2px solid #84adff;outline-offset:1px}.home-copy-icon.is-copied{color:#168447;background:#edf9f1;transform:scale(1.05)}.home-a2a-action{color:#175cd3}.home-mode-toggle:disabled{cursor:not-allowed}.home-mode-published{color:#0f7a43;background:#e9f7ef;border-color:#8fd3ae}.home-mode-published:hover{background:#d8f0e2}.home-mode-unpublished{color:#667085;background:#f2f4f7;border-color:#cfd4dc}.home-mode-unpublished:hover{background:#e4e7ec}.home-mode-public{color:#175cd3;background:#eff6ff;border-color:#9ec5fe}.home-mode-public:hover{background:#dbeafe}.home-mode-private{color:#b54708;background:#fff7e6;border-color:#f0c36d}.home-mode-private:hover{background:#ffedc2}@media(max-width:820px){.home-agent-table{min-width:820px}}</style><div class="table-wrap"><table class="home-agent-table"><colgroup><col style="width:20%"><col style="width:11%"><col style="width:9%"><col style="width:12%"><col style="width:35%"><col style="width:13%"></colgroup><thead><tr><th style="text-align:center">'+L('web.home.col.agent')+'</th><th style="text-align:center">'+L('web.home.col.type')+'</th><th style="text-align:center">'+L('web.home.col.status')+'</th><th style="text-align:center">'+L('web.home.col.message_mode')+'</th><th style="text-align:center">'+L('web.home.col.access')+'</th><th style="text-align:center">'+L('web.home.col.manage')+'</th></tr></thead><tbody>'+rows.join('\n')+'</tbody></table></div>'
          :'<div style="text-align:center;padding:60px 0"><p class="meta" style="font-size:16px;margin:0 0 20px">'+L('web.home.empty')+'</p><a href="/agent/add?new=1" class="btn" style="font-size:18px;padding:14px 40px">'+L('common.btn.register')+'</a></div>')
        +(filtered.length>0
          ?'<style>.home-list-toolbar{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center;gap:8px;margin:12px 0 6px}.home-list-search{display:flex;align-items:center;gap:8px;margin:0;min-width:0}.home-pagination{grid-column:2;display:flex;align-items:center;justify-content:center;gap:12px;font-size:14px;white-space:nowrap}@media(max-width:720px){.home-list-toolbar{grid-template-columns:1fr}.home-list-search{justify-content:center;flex-wrap:wrap}.home-pagination{grid-column:1}}</style><div class="home-list-toolbar"><form class="home-list-search" method="GET" action="/"><input type="text" name="keyword" value="'+esc(keyword)+'" placeholder="'+esc(T('web.home.search_ph'))+'" style="width:200px;max-width:100%;margin:0;font-size:14px;padding:6px 10px">'+(keyword?'<a href="/" class="btn-sm btn-outline" style="margin:0;padding:6px 10px;min-width:auto;min-height:auto">✕</a>':'')+'<button type="submit" class="btn-sm" style="margin:0;padding:6px 12px;min-width:auto;min-height:auto" data-agent-action="agent.search">'+L('web.agent.search_btn')+'</button></form>'+pgBar+'</div>'+'<h2 style="margin:18px 0 8px 0;">'+L('web.home.ops_title')+'</h2><div class="ops">'
          +(trustedRemoteEnabled?'<a href="/trusted-remote" class="op-card" data-agent-kind="link" data-agent="nav_card">'+L('web.home.op.trusted_remote')+'</a>':'')
          +'<a href="/audit-rules" class="op-card" data-agent-kind="link" data-agent="nav_card">'+L('web.home.op.audit')+'</a>'
          +'<a href="/payments" class="op-card" data-agent-kind="link" data-agent="nav_card">'+L('web.home.op.payments')+'</a>'
          +'<a href="/voko-im.log" class="op-card" data-agent-kind="link" data-agent="nav_card">'+L('web.home.op.logs')+'</a>'
          +'</div>'
          :'');
      var logoutDlg='<dialog id="dlg-logout" style="border:none;border-radius:12px;padding:28px;text-align:center;max-width:360px"><h3 style="margin:0 0 8px;font-size:18px">'+L('web.home.logout.title')+'</h3><p style="color:#666;margin:0 0 16px">'+L('web.home.logout.confirm')+'</p><form method="dialog" style="display:flex;gap:8px;justify-content:center"><button class="btn btn-outline" value="cancel">'+L('common.btn.cancel')+'</button><a href="/api/logout" class="btn btn-danger">'+L('common.btn.logout')+'</a></form></dialog>';var shortLinkDlg='<dialog id="dlg-short-link-security" style="border:none;border-radius:12px;padding:0;max-width:350px;width:calc(100% - 40px);box-shadow:0 12px 36px rgba(15,23,42,.18)"><div style="padding:20px 22px 18px"><p style="color:#667085;font-size:14px;line-height:1.65;margin:0 0 16px;text-align:left">'+L('web.home.short_link.security_tip')+'</p><form method="dialog" style="display:flex;gap:8px;justify-content:flex-end"><button class="btn-sm btn-outline" value="cancel" style="margin:0;padding:6px 16px;min-height:auto">'+L('common.btn.cancel')+'</button><button type="button" class="btn-sm" data-role="confirm-gen-link" style="margin:0;padding:6px 16px;min-height:auto">'+L('common.btn.generate_link')+'</button></form></div></dialog>';var toastDlg='<dialog id="dlg-toast" style="border:none;border-radius:12px;padding:24px;text-align:center;max-width:360px"><p id="toast-msg" style="font-size:16px;margin:0 0 12px 0"></p><form method="dialog"><button class="btn-sm" style="margin:0;padding:6px 24px;font-size:14px">'+L('common.toast.ok')+'</button></form></dialog>';const homeMsg=req.query.ok?{success:true,text:esc(req.query.ok)}:req.query.warn?{warning:true,text:esc(req.query.warn)}:req.query.err?{success:false,text:esc(req.query.err)}:null;res.send(renderPage(req,T('web.home.title'),body+logoutDlg+shortLinkDlg+toastDlg,{subtitle:T('web.home.subtitle_count',{count:filtered.length}),msg:homeMsg,jsonld:{'@context':'https://schema.org','@type':'ItemList',itemListElement:jd},footer:renderFooter(T, req.locale)+agentWsScript(T)}))
    }catch(e){next(e)}
  });

  R.get('/api/external-integrations',async(req,res)=>{
    try{
      const result=await externalGatewayRequest(externalGatewayPath);
      res.json({success:true,data:{integrations:result.data?.integrations||[]}});
    }catch(error){res.status(Number(error.status)||502).json({success:false,error:externalGatewayErrorText(req.t,error.message),code:String(error.message||'')})}
  });

  R.post('/api/external-integrations',async(req,res)=>{
    try{
      const agent=externalGatewayAgent(req.body?.agentId);
      const name=String(req.body?.name||'').trim(),webhookUrl=String(req.body?.webhookUrl||'').trim();
      if(!agent)return res.status(404).json({success:false,error:req.t('web.external_gateway.agent_unavailable')});
      if(!name||name.length>128||!webhookUrl||webhookUrl.length>2048)return res.status(400).json({success:false,error:req.t('web.external_gateway.invalid_request')});
      let parsed;try{parsed=new URL(webhookUrl)}catch(_){return res.status(400).json({success:false,error:req.t('web.external_gateway.webhook_invalid')})}
      if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.hash)return res.status(400).json({success:false,error:req.t('web.external_gateway.webhook_invalid')});
      const result=await externalGatewayRequest(externalGatewayPath,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,webhookUrl,agentIds:[agent.publicAgentId]})});
      res.status(201).json({success:true,data:result.data||{}});
    }catch(error){res.status(Number(error.status)||502).json({success:false,error:externalGatewayErrorText(req.t,error.message),code:String(error.message||'')})}
  });

  R.patch('/api/external-integrations/:integrationId',async(req,res)=>{
    try{
      const integrationId=String(req.params.integrationId||''),name=String(req.body?.name||'').trim(),webhookUrl=String(req.body?.webhookUrl||'').trim();
      if(!/^[A-Za-z0-9._:-]{1,128}$/.test(integrationId)||!name||name.length>128||!webhookUrl||webhookUrl.length>2048||Object.keys(req.body||{}).some(key=>!['name','webhookUrl'].includes(key)))return res.status(400).json({success:false,error:req.t('web.external_gateway.invalid_request')});
      let parsed;try{parsed=new URL(webhookUrl)}catch(_){return res.status(400).json({success:false,error:req.t('web.external_gateway.webhook_invalid')})}
      if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.hash)return res.status(400).json({success:false,error:req.t('web.external_gateway.webhook_invalid')});
      const result=await externalGatewayRequest(externalGatewayPath+'/'+encodeURIComponent(integrationId),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,webhookUrl})});
      res.json({success:true,data:result.data||{}});
    }catch(error){res.status(Number(error.status)||502).json({success:false,error:externalGatewayErrorText(req.t,error.message),code:String(error.message||'')})}
  });

  R.post('/api/external-integrations/:integrationId/webhook-probe',async(req,res)=>{
    try{
      const integrationId=String(req.params.integrationId||'');
      if(!/^[A-Za-z0-9._:-]{1,128}$/.test(integrationId))return res.status(400).json({success:false,error:req.t('web.external_gateway.invalid_request')});
      const result=await externalGatewayRequest(externalGatewayPath+'/'+encodeURIComponent(integrationId)+'/webhook-probe',{method:'POST'});
      res.json({success:true,data:result.data||{valid:false}});
    }catch(error){res.status(Number(error.status)||502).json({success:false,error:externalGatewayErrorText(req.t,error.message),code:String(error.message||'')})}
  });

  R.delete('/api/external-integrations/:integrationId',async(req,res)=>{
    try{
      const integrationId=String(req.params.integrationId||'');
      if(!/^[A-Za-z0-9._:-]{1,128}$/.test(integrationId))return res.status(400).json({success:false,error:req.t('web.external_gateway.invalid_request')});
      await externalGatewayRequest(externalGatewayPath+'/'+encodeURIComponent(integrationId),{method:'DELETE'});
      res.json({success:true});
    }catch(error){res.status(Number(error.status)||502).json({success:false,error:externalGatewayErrorText(req.t,error.message),code:String(error.message||'')})}
  });

  R.get('/external-integrations',async(req,res)=>{
    const T=req.t,L=k=>esc(T(k)),agentId=String(req.query.agentId||'');
    const agent=externalGatewayAgent(agentId);
    if(!agent)return res.status(404).send(renderPage(req,T('web.external_gateway.title'),'<div class="card error">'+L('web.external_gateway.agent_unavailable')+'</div>',{footer:renderFooter(T,req.locale)}));
    const restEndpoint=externalGatewayBase+'/api/external/v1/gateway/agents/'+encodeURIComponent(agent.publicAgentId)+'/messages';
    let integrations=[],loadError='';
    try{const result=await externalGatewayRequest(externalGatewayPath);integrations=(result.data?.integrations||[]).filter(item=>item.status==='active'&&Array.isArray(item.agentIds)&&item.agentIds.includes(agent.publicAgentId))}
    catch(error){loadError=externalGatewayErrorText(T,error.message)}
    const pageSize=10,totalPages=Math.max(1,Math.ceil(integrations.length/pageSize)),page=Math.min(Math.max(1,parseInt(String(req.query.page||''),10)||1),totalPages);
    const pageIntegrations=integrations.slice((page-1)*pageSize,page*pageSize);
    const maskCredential=value=>{const text=String(value||'');return text.length>12?text.slice(0,8)+'…'+text.slice(-4):text||'-'};
    const credentialCell=(value,fallback,label,unavailable)=>'<span style="display:inline-flex;align-items:center;gap:4px;white-space:nowrap"><code>'+esc(value?maskCredential(value):fallback||'-')+'</code>'+(value?copyButton({esc,label,attrs:'data-voko-copy-value="'+esc(value)+'"'}):copyButton({esc,label:unavailable,attrs:'disabled'}))+'</span>';
    const rows=pageIntegrations.map(item=>{const invalid=item.webhook_health_state==='invalid';return '<tr data-role="external-integration-row" data-integration="'+esc(item.integration_id||'')+'" data-name="'+esc(item.name||'')+'" data-webhook="'+esc(item.webhook_url||'')+'" data-invalid="'+(invalid?'1':'')+'" style="'+(invalid?'opacity:.55':'')+'"><td data-role="integration-name"><strong title="'+esc(item.name||'-')+'" style="display:block;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(item.name||'-')+'</strong></td><td data-role="integration-webhook" style="white-space:normal;word-break:break-all;'+(invalid?'color:#98a2b3':'')+'">'+esc(item.webhook_url||'-')+'</td><td>'+credentialCell(item.token,String(item.token_prefix||'-')+'…',T('web.external_gateway.copy_token'),T('web.external_gateway.credential_unavailable'))+'</td><td>'+credentialCell(item.webhookSecret,'-',T('web.external_gateway.copy_secret'),T('web.external_gateway.secret_unavailable'))+'</td><td style="text-align:right"><span data-role="integration-actions" style="display:inline-flex;gap:6px;align-items:center"><button type="button" class="btn-sm btn-outline" data-role="edit-external-integration" style="margin:0;padding:5px 10px;min-height:auto">'+L('web.external_gateway.edit')+'</button><button type="button" class="btn-sm '+(invalid?'btn-outline':'btn-danger')+'" data-role="revoke-external-integration" data-integration="'+esc(item.integration_id||'')+'" data-name="'+esc(item.name||'')+'" style="margin:0;padding:5px 10px;min-height:auto"'+(invalid?' disabled':'')+'>'+(invalid?L('web.external_gateway.invalid'):L('web.external_gateway.revoke'))+'</button></span></td></tr>'}).join('');
    const list=loadError?'<div class="card error">'+esc(loadError)+'</div>':rows?'<div class="table-wrap"><table style="min-width:900px;table-layout:fixed"><colgroup><col style="width:15%"><col style="width:37%"><col style="width:18%"><col style="width:18%"><col style="width:12%"></colgroup><thead><tr><th>'+L('web.external_gateway.col.name')+'</th><th>'+L('web.external_gateway.col.webhook')+'</th><th>'+L('web.external_gateway.col.token')+'</th><th>'+L('web.external_gateway.col.secret')+'</th><th style="text-align:right">'+L('web.external_gateway.col.actions')+'</th></tr></thead><tbody>'+rows+'</tbody></table></div>':'<div class="card"><p class="meta" style="margin:0">'+L('web.external_gateway.empty')+'</p></div>';
    let pgBar='';if(!loadError&&totalPages>1){const pageBase='/external-integrations?agentId='+encodeURIComponent(agentId)+'&page=';pgBar='<div style="display:flex;align-items:center;justify-content:center;gap:12px;padding:8px 0;font-size:14px">';if(page>1)pgBar+='<a href="'+pageBase+(page-1)+'" class="btn-sm" style="padding:4px 12px">'+esc(T('web.payments.prev_page'))+'</a>';pgBar+='<span style="color:#666">'+esc(T('web.payments.page_of',{cur:page,total:totalPages}))+'</span>';if(page<totalPages)pgBar+='<a href="'+pageBase+(page+1)+'" class="btn-sm" style="padding:4px 12px">'+esc(T('web.payments.next_page'))+'</a>';pgBar+='</div>'}
    const createdNotice=req.query.created==='1'?'<div class="card success" style="max-width:760px;padding:10px 14px">✓ '+L('web.external_gateway.created_success')+'</div>':'';
    const body='<p class="meta" style="max-width:760px">'+esc(T('web.external_gateway.intro',{agent:agent.agent_name||agent.agent_id}))+'</p>'+createdNotice
      +'<section class="card" style="padding:18px 20px;max-width:760px"><h2 style="margin-top:0">'+L('web.external_gateway.create_title')+' <span class="meta" style="font-weight:400">'+L('web.external_gateway.webhook_flow')+'</span></h2><form id="external-integration-create"><input type="hidden" name="agentId" value="'+esc(agentId)+'"><label for="external-name">'+L('web.external_gateway.name')+'</label><input id="external-name" name="name" maxlength="128" required placeholder="'+L('web.external_gateway.name_placeholder')+'" style="max-width:none"><label for="external-webhook">'+L('web.external_gateway.webhook_url')+'</label><div style="display:flex;align-items:center;gap:8px"><input id="external-webhook" name="webhookUrl" type="url" maxlength="2048" required pattern="https://.*" placeholder="https://crm.example.com/voko/events" style="max-width:none;margin:0"><button type="submit" class="btn-sm" style="margin:0;white-space:nowrap">'+L('web.external_gateway.create')+'</button></div><p class="meta" style="margin:5px 0 0">'+L('web.external_gateway.webhook_help')+'</p><div id="external-create-error" class="error" style="display:none;margin-top:10px"></div></form></section>'
      +'<section class="card" style="padding:18px 20px;max-width:760px"><h2 style="margin-top:0">'+L('web.external_gateway.rest_title')+' <span class="meta" style="font-weight:400">'+L('web.external_gateway.rest_flow')+'</span></h2><div style="display:flex;align-items:center;gap:8px"><input id="external-rest-endpoint" aria-label="'+L('web.external_gateway.rest_endpoint')+'" readonly value="'+esc(restEndpoint)+'" style="max-width:none;margin:0;font-family:monospace;font-size:13px">'+copyButton({esc,label:T('web.external_gateway.copy_rest'),attrs:'data-voko-copy-value="'+esc(restEndpoint)+'"'})+'</div><p class="meta" style="margin:5px 0 0">'+L('web.external_gateway.rest_help')+'</p></section>'
      +'<h2>'+esc(T('web.external_gateway.list_title',{count:integrations.length}))+'</h2>'+list+pgBar
      +'<dialog id="external-revoke-confirm" style="border:none;border-radius:12px;padding:0;max-width:420px;width:calc(100% - 32px);box-shadow:0 12px 36px rgba(15,23,42,.22)"><div style="padding:22px 24px"><h3 style="margin:0 0 8px">'+L('web.external_gateway.revoke_title')+'</h3><p class="meta" data-role="revoke-external-message" style="margin:0 0 16px"></p><div class="error" data-role="revoke-external-error" style="display:none;margin-bottom:10px"></div><div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="btn-sm btn-outline" data-role="cancel-external-revoke" style="margin:0">'+L('common.btn.cancel')+'</button><button type="button" class="btn-sm btn-danger" data-role="confirm-external-revoke" style="margin:0">'+L('web.external_gateway.revoke')+'</button></div></div></dialog>';
    const labels={creating:T('web.external_gateway.creating'),createFailed:T('web.external_gateway.create_failed'),edit:T('web.external_gateway.edit'),save:T('common.btn.save'),cancel:T('common.btn.cancel'),editFailed:T('web.external_gateway.edit_failed'),revoke:T('web.external_gateway.revoke'),invalid:T('web.external_gateway.invalid'),revokeMessage:T('web.external_gateway.revoke_message',{name:'{name}'}),revokeFailed:T('web.external_gateway.revoke_failed')};
    const script='<script>(function(){var L='+jsonForInlineScript(labels)+',form=document.getElementById("external-integration-create"),createError=document.getElementById("external-create-error"),revoke=document.getElementById("external-revoke-confirm"),pending="";function h(value){var node=document.createElement("div");node.textContent=String(value||"");return node.innerHTML}function markInvalid(row){row.dataset.invalid="1";row.style.opacity=".55";row.querySelector("[data-role=integration-webhook]").style.color="#98a2b3";var button=row.querySelector("[data-role=revoke-external-integration]");if(button){button.disabled=true;button.className="btn-sm btn-outline";button.textContent=L.invalid}}function probeRow(row){fetch("/api/external-integrations/"+encodeURIComponent(row.dataset.integration)+"/webhook-probe",{method:"POST",headers:{Accept:"application/json"}}).then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d}})}).then(function(x){if(x.ok&&x.data.success&&x.data.data&&x.data.data.valid===false)markInvalid(row)}).catch(function(){})}if(new URL(location.href).searchParams.has("created"))history.replaceState(null,"",location.pathname+"?agentId="+encodeURIComponent(form.elements.agentId.value));form.addEventListener("submit",function(e){e.preventDefault();var button=form.querySelector("button[type=submit]"),idle=button.textContent;button.disabled=true;button.textContent=L.creating;createError.style.display="none";var data=Object.fromEntries(new FormData(form));fetch("/api/external-integrations",{method:"POST",headers:{"Content-Type":"application/json",Accept:"application/json"},body:JSON.stringify(data)}).then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d}})}).then(function(x){if(!x.ok||!x.data.success)throw new Error(x.data.error||L.createFailed);location.assign("/external-integrations?agentId="+encodeURIComponent(data.agentId)+"&created=1")}).catch(function(error){createError.textContent=error.message||L.createFailed;createError.style.display="block";button.disabled=false;button.textContent=idle})});function resetRow(row){row.querySelector("[data-role=integration-name]").innerHTML="<strong title=\\\""+h(row.dataset.name)+"\\\" style=\\\"display:block;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap\\\">"+h(row.dataset.name)+"</strong>";row.querySelector("[data-role=integration-webhook]").textContent=row.dataset.webhook;row.querySelector("[data-role=integration-actions]").innerHTML="<button type=\\\"button\\\" class=\\\"btn-sm btn-outline\\\" data-role=\\\"edit-external-integration\\\" style=\\\"margin:0;padding:5px 10px;min-height:auto\\\">"+L.edit+"</button><button type=\\\"button\\\" class=\\\"btn-sm btn-danger\\\" data-role=\\\"revoke-external-integration\\\" data-integration=\\\""+row.dataset.integration+"\\\" data-name=\\\""+h(row.dataset.name)+"\\\" style=\\\"margin:0;padding:5px 10px;min-height:auto\\\">"+L.revoke+"</button>";if(row.dataset.invalid==="1")markInvalid(row)}document.addEventListener("click",function(e){var edit=e.target.closest("[data-role=edit-external-integration]");if(edit){var row=edit.closest("tr");row.querySelector("[data-role=integration-name]").innerHTML="<input data-role=\\\"edit-name\\\" maxlength=\\\"128\\\" value=\\\""+h(row.dataset.name)+"\\\" style=\\\"min-width:110px;margin:0\\\">";row.querySelector("[data-role=integration-webhook]").innerHTML="<input data-role=\\\"edit-webhook\\\" type=\\\"url\\\" maxlength=\\\"2048\\\" value=\\\""+h(row.dataset.webhook)+"\\\" style=\\\"min-width:280px;margin:0\\\"><div class=\\\"error\\\" data-role=\\\"edit-error\\\" style=\\\"display:none;margin-top:4px\\\"></div>";row.querySelector("[data-role=integration-actions]").innerHTML="<button type=\\\"button\\\" class=\\\"btn-sm\\\" data-role=\\\"save-external-integration\\\" style=\\\"margin:0;padding:5px 10px;min-height:auto\\\">"+L.save+"</button><button type=\\\"button\\\" class=\\\"btn-sm btn-outline\\\" data-role=\\\"cancel-external-integration\\\" style=\\\"margin:0;padding:5px 10px;min-height:auto\\\">"+L.cancel+"</button>";return}var cancel=e.target.closest("[data-role=cancel-external-integration]");if(cancel){resetRow(cancel.closest("tr"));return}var save=e.target.closest("[data-role=save-external-integration]");if(save){var row=save.closest("tr"),name=row.querySelector("[data-role=edit-name]").value.trim(),webhookUrl=row.querySelector("[data-role=edit-webhook]").value.trim(),box=row.querySelector("[data-role=edit-error]");save.disabled=true;fetch("/api/external-integrations/"+encodeURIComponent(row.dataset.integration),{method:"PATCH",headers:{"Content-Type":"application/json",Accept:"application/json"},body:JSON.stringify({name:name,webhookUrl:webhookUrl})}).then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d}})}).then(function(x){if(!x.ok||!x.data.success)throw new Error(x.data.error||L.editFailed);row.dataset.name=name;row.dataset.webhook=webhookUrl;delete row.dataset.invalid;row.style.opacity="";resetRow(row);probeRow(row)}).catch(function(error){box.textContent=error.message||L.editFailed;box.style.display="block";save.disabled=false});return}var button=e.target.closest("[data-role=revoke-external-integration]");if(!button)return;pending=button.dataset.integration||"";revoke.querySelector("[data-role=revoke-external-message]").textContent=L.revokeMessage.replace("{name}",button.dataset.name||"");revoke.querySelector("[data-role=revoke-external-error]").style.display="none";revoke.showModal()});revoke.querySelector("[data-role=cancel-external-revoke]").addEventListener("click",function(){pending="";revoke.close()});revoke.querySelector("[data-role=confirm-external-revoke]").addEventListener("click",function(){var button=this;if(!pending)return;button.disabled=true;fetch("/api/external-integrations/"+encodeURIComponent(pending),{method:"DELETE",headers:{Accept:"application/json"}}).then(function(r){return r.json().then(function(d){return{ok:r.ok,data:d}})}).then(function(x){if(!x.ok||!x.data.success)throw new Error(x.data.error||L.revokeFailed);location.reload()}).catch(function(error){var box=revoke.querySelector("[data-role=revoke-external-error]");box.textContent=error.message||L.revokeFailed;box.style.display="block";button.disabled=false})});setTimeout(function(){document.querySelectorAll("[data-role=external-integration-row]").forEach(probeRow)},0)})();</script>';
    res.send(renderPage(req,T('web.external_gateway.title'),body,{nav:'<a href="/">'+L('common.nav.home')+'</a> › '+L('web.external_gateway.title'),footer:renderFooter(T,req.locale)+script}));
  });

  // ────────── 注册 ──────────
  R.get('/api/owner-chat/policy',(req,res)=>{try{if(!opts.ownerChatDatabase)return res.status(404).json({success:false,error:'OWNER_CHAT_DISABLED'});const{readOwnerChatPolicy}=require('../owner-chat');res.json({success:true,data:readOwnerChatPolicy(opts.ownerChatDatabase)})}catch(error){res.status(500).json({success:false,error:'OWNER_CHAT_POLICY_FAILED'})}});
  R.put('/api/owner-chat/policy',(req,res)=>{try{if(!opts.ownerChatDatabase)return res.status(404).json({success:false,error:'OWNER_CHAT_DISABLED'});const{updateOwnerChatPolicy}=require('../owner-chat');const patch={};if(typeof req.body?.ownerChatEnabled==='boolean')patch.ownerChatEnabled=req.body.ownerChatEnabled;if(typeof req.body?.remoteExecutionEnabled==='boolean')patch.remoteExecutionEnabled=req.body.remoteExecutionEnabled;const data=updateOwnerChatPolicy(opts.ownerChatDatabase,patch);require('../core/lite-bus').emit('owner-chat:policy',data);res.json({success:true,data})}catch(error){res.status(500).json({success:false,error:'OWNER_CHAT_POLICY_FAILED'})}});
  R.get('/api/owner-codex-config/:agentId',(req,res)=>{try{const{readOwnerCodexConfig}=require('../owner-chat');res.json({success:true,data:readOwnerCodexConfig(db,String(req.params.agentId))})}catch(error){res.status(400).json({success:false,error:String(error.message||error)})}});
  R.put('/api/owner-codex-config/:agentId',(req,res)=>{try{const{saveOwnerCodexConfig}=require('../owner-chat');const data=saveOwnerCodexConfig(db,String(req.params.agentId),{cwd:req.body?.cwd,profile:req.body?.profile});res.json({success:true,data})}catch(error){res.status(400).json({success:false,error:String(error.message||error)})}});
  R.post('/api/agents/:agentId/delivery-channels/refresh',async(req,res)=>{
    try{
      if(typeof handlers.refresh_delivery_channels!=='function')return res.status(503).json({success:false,error:'Delivery channel refresh is unavailable'});
      const result=await handlers.refresh_delivery_channels({agentId:String(req.params.agentId)});
      res.status(result&&result.success===false?400:200).json(result);
    }catch(error){res.status(400).json({success:false,error:String(error.message||error)})}
  });
  R.post('/api/agents/:agentId/delivery-channels/verify',async(req,res)=>{
    try{
      if(typeof handlers.verify_delivery_channel!=='function')return res.status(503).json({success:false,error:'Delivery channel verification is unavailable'});
      const result=await handlers.verify_delivery_channel({agentId:String(req.params.agentId),providerId:req.body&&req.body.providerId});
      res.status(result&&result.success===false?400:200).json(result);
    }catch(error){res.status(400).json({success:false,error:String(error.message||error)})}
  });
  R.post('/api/agents/:agentId/delivery-channels/select',async(req,res)=>{
    try{
      if(typeof handlers.select_delivery_channel!=='function')return res.status(503).json({success:false,error:'Delivery channel selection is unavailable'});
      const result=await handlers.select_delivery_channel({agentId:String(req.params.agentId),mode:req.body&&req.body.mode,providerId:req.body&&req.body.providerId});
      res.status(result&&result.success===false?400:200).json(result);
    }catch(error){res.status(400).json({success:false,error:String(error.message||error)})}
  });
  R.get('/api/agents/:agentId/provider-security',requireSensitiveLocalAuth,(req,res)=>{
    try{
      const service=opts.dispatcher?.providerSecurity;
      if(!service)return res.status(503).json({success:false,error:'PROVIDER_SECURITY_UNAVAILABLE'});
      const data=opts.dispatcher?.inspectProviderSecurity?.(String(req.params.agentId),req.query.transportId)
        ||service.inspect(String(req.params.agentId),req.query.transportId);
      res.json({success:true,data});
    }catch(error){res.status(String(error.message||error)==='AGENT_NOT_FOUND'?404:400).json({success:false,error:String(error.message||error)})}
  });
  R.post('/api/agents/:agentId/provider-security/preflight',requireSensitiveLocalAuth,requireSensitiveCsrf,(req,res)=>{
    try{
      const service=opts.dispatcher?.providerSecurity;
      if(!service)return res.status(503).json({success:false,error:'PROVIDER_SECURITY_UNAVAILABLE'});
      const data=service.preflight(String(req.params.agentId),req.body?.transportId,req.body?.config);
      res.json({success:true,data});
    }catch(error){res.status(400).json({success:false,error:String(error.message||error)})}
  });
  R.post('/api/agents/:agentId/provider-security/commit',requireSensitiveLocalAuth,requireSensitiveCsrf,(req,res)=>{
    try{
      const service=opts.dispatcher?.providerSecurity;
      if(!service)return res.status(503).json({success:false,error:'PROVIDER_SECURITY_UNAVAILABLE'});
      const data=service.commit(String(req.params.agentId),req.body?.preflightToken,req.body?.confirmation);
      const runtimeRestarted=opts.dispatcher?.applyProviderSecurityPolicyChange?.(data)===true;
      res.json({success:true,data:{...data,runtimeRestarted}});
    }catch(error){res.status(400).json({success:false,error:String(error.message||error)})}
  });
  R.post('/api/provider-setup',async(req,res)=>{
    try{
      if(typeof handlers.setup_provider!=='function')return res.status(503).json({success:false,error:'Provider setup is unavailable'});
      const result=await handlers.setup_provider({action:req.body&&req.body.action});
      res.status(result&&result.success===false?400:200).json(result);
    }catch(error){res.status(400).json({success:false,error:String(error.message||error)})}
  });

  R.get('/trusted-remote',async(req,res,next)=>{
    try{
      const T=req.t,L=k=>esc(T(k));
      const agentListData=await handlers.list_agents({limit:500});
      const agentCount=(agentListData.agents||[]).filter(agent=>agent.publishStatus==='published').length;
      const strings={generated:T('web.trusted_remote.generated'),copyTemplate:T('web.trusted_remote.copy_template'),creating:T('common.home.gen_creating'),generate:T('web.trusted_remote.generate'),copy:T('web.home.owner_link.copy'),copied:T('common.home.copied'),failed:T('web.home.owner_link.failed'),noDevices:T('web.home.owner_link.no_devices'),online:T('web.home.owner_link.device_online'),offline:T('web.home.owner_link.device_offline'),disconnect:T('web.home.owner_link.disconnect'),device:T('web.home.owner_link.device'),status:T('web.home.owner_link.device_status'),lastSeen:T('web.home.owner_link.device_last_seen'),expires:T('web.home.owner_link.device_expires'),summary:T('web.home.owner_link.devices_summary')};
      const policy=opts.ownerChatDatabase?require('../owner-chat').readOwnerChatPolicy(opts.ownerChatDatabase):null;
      const{readOwnerCodexConfig}=require('../owner-chat');
      const codexAgents=db.prepare("SELECT agent_id,agent_name FROM agents WHERE backend_type='codex' ORDER BY agent_name,agent_id").all();
      const codexCards=codexAgents.map(agent=>{const config=readOwnerCodexConfig(db,String(agent.agent_id));return '<form class="trusted-codex-config" data-codex-agent="'+esc(agent.agent_id)+'"><h3 style="font-size:16px;margin:0 0 10px">'+esc(agent.agent_name||agent.agent_id)+'</h3><label>'+L('web.trusted_remote.codex_workdir')+'<input name="cwd" value="'+esc(config.cwd||'')+'" placeholder="'+L('web.trusted_remote.codex_workdir_placeholder')+'"></label><label>'+L('web.trusted_remote.codex_profile')+'<input name="profile" value="'+esc(config.profile||'')+'" placeholder="default"></label><p class="meta">'+L('web.trusted_remote.codex_native_help')+'</p><button type="submit" class="btn-sm">'+L('common.btn.save')+'</button><span class="meta" data-codex-result></span></form>'}).join('');
      const body='<style>.trusted-grid{display:grid;gap:18px}.trusted-card{background:#fff;border:1px solid #e4e7ec;border-radius:12px;padding:20px}.trusted-card h2{font-size:18px;margin:0 0 10px}.trusted-card p{line-height:1.65}.trusted-link-result{display:none;margin-top:16px}.trusted-link-result textarea{width:100%;max-width:none;min-height:130px;resize:vertical;font-size:13px;line-height:1.55}.trusted-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.trusted-summary{color:#344054;margin:0 0 12px}.trusted-device-wrap{overflow-x:auto}.trusted-device-table{width:100%;min-width:680px;box-shadow:none;margin:0}.trusted-device-table th,.trusted-device-table td{text-align:left}.trusted-device-table th:last-child,.trusted-device-table td:last-child{text-align:right}.trusted-security{background:#fffbeb;border-color:#f4d38a}.trusted-switch{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 0;border-bottom:1px solid #eaecf0}.trusted-switch input{width:auto;margin:0}@media(max-width:640px){.trusted-card{padding:16px}.trusted-actions .btn,.trusted-actions .btn-sm{width:100%;text-align:center}.trusted-link-result textarea{min-height:170px}}</style>'
        +'<p><a href="/">← '+L('common.btn.home')+'</a></p><div class="trusted-grid" data-testid="trusted-remote-page">'
        +'<section class="trusted-card"><h1 style="margin:0 0 10px">'+L('web.trusted_remote.title')+'</h1><p>'+L('web.trusted_remote.description')+'</p><p class="meta">'+esc(T('web.trusted_remote.scope',{count:agentCount}))+'</p></section>'
        +'<section class="trusted-card"><h2>'+L('web.trusted_remote.new_device')+'</h2><p class="meta">'+L('web.trusted_remote.link_rule')+'</p><div class="trusted-actions"><button type="button" class="btn" id="trusted-generate">'+L('web.trusted_remote.generate')+'</button></div><div class="trusted-link-result" id="trusted-link-result"><h3 style="font-size:16px;margin:0 0 10px">'+L('web.trusted_remote.generated')+'</h3><textarea id="trusted-link-text" readonly></textarea><p class="meta" id="trusted-link-expiry"></p><button type="button" class="btn-sm btn-outline" id="trusted-copy">'+L('web.home.owner_link.copy')+'</button></div><p class="error" id="trusted-error" role="alert" style="display:none"></p></section>'
        +'<section class="trusted-card"><h2>'+L('web.trusted_remote.devices')+'</h2><p class="trusted-summary" id="trusted-device-summary"></p><div id="trusted-devices"><p class="meta">…</p></div></section>'
        +(policy?'<section class="trusted-card" id="trusted-policy"><h2>'+L('web.trusted_remote.execution_title')+'</h2><label class="trusted-switch"><span>'+L('web.trusted_remote.owner_chat_enabled')+'</span><input type="checkbox" data-policy="ownerChatEnabled" '+(policy.ownerChatEnabled?'checked':'')+'></label><label class="trusted-switch"><span>'+L('web.trusted_remote.remote_execution_enabled')+'<small class="meta" style="display:block">'+L('web.trusted_remote.remote_execution_help')+'</small></span><input type="checkbox" data-policy="remoteExecutionEnabled" '+(policy.remoteExecutionEnabled?'checked':'')+'></label></section>':'')
        +(codexCards?'<section class="trusted-card" id="trusted-codex"><h2>'+L('web.trusted_remote.codex_title')+'</h2>'+codexCards+'</section>':'')
        +'<section class="trusted-card trusted-security"><h2>'+L('web.trusted_remote.security')+'</h2><p style="margin:0">'+L('web.trusted_remote.security_text')+'</p></section></div>';
      const script='<script>(function(){var I='+jsonForInlineScript(strings)+',devices=[],loading=null;function fmt(value){var date=new Date(value||"");return Number.isNaN(date.getTime())?"-":date.toLocaleString()}function deviceName(value){var text=String(value||""),browser=text.includes("MicroMessenger")?"WeChat":text.includes("Edg/")?"Edge":text.includes("Chrome/")?"Chrome":text.includes("Safari/")?"Safari":"Browser",system=text.includes("iPhone")||text.includes("iPad")?"iPhone/iPad":text.includes("Android")?"Android":text.includes("Windows")?"Windows":text.includes("Mac OS X")?"macOS":"Device";return browser+" · "+system}function el(name,text,cls){var node=document.createElement(name);if(text!=null)node.textContent=text;if(cls)node.className=cls;return node}function render(){var online=devices.filter(function(d){return d.online}).length,summary=document.getElementById("trusted-device-summary"),box=document.getElementById("trusted-devices");summary.textContent=I.summary.replace("{authorized}",String(devices.length)).replace("{online}",String(online));box.replaceChildren();if(!devices.length){box.appendChild(el("p",I.noDevices,"meta"));return}var wrap=el("div",null,"trusted-device-wrap"),table=el("table",null,"trusted-device-table"),thead=el("thead"),head=el("tr");[I.device,I.status,I.lastSeen,I.expires,""].forEach(function(label){head.appendChild(el("th",label))});thead.appendChild(head);table.appendChild(thead);var tbody=el("tbody");devices.forEach(function(device){var row=el("tr"),name=el("strong",deviceName(device.deviceLabel)),status=el("span",device.online?I.online:I.offline,device.online?"badge-online":"badge-offline"),button=el("button",I.disconnect,"btn-sm btn-danger");button.type="button";button.dataset.deviceId=String(device.deviceId||"");row.appendChild(el("td"));row.lastChild.appendChild(name);row.appendChild(el("td"));row.lastChild.appendChild(status);row.appendChild(el("td",fmt(device.lastSeenAt),"meta"));row.appendChild(el("td",fmt(device.expiresAt),"meta"));row.appendChild(el("td"));row.lastChild.appendChild(button);tbody.appendChild(row)});table.appendChild(tbody);wrap.appendChild(table);box.appendChild(wrap)}function load(){if(loading)return loading;loading=fetch("/api/owner-link/devices",{headers:{Accept:"application/json"},cache:"no-store"}).then(function(r){return r.json().then(function(data){return{ok:r.ok,data:data}})}).then(function(result){if(!result.ok||!result.data.success)throw new Error(result.data.error||I.failed);devices=result.data.data&&result.data.data.devices||[];render()}).catch(function(error){document.getElementById("trusted-devices").replaceChildren(el("p",error.message||I.failed,"error"))}).finally(function(){loading=null});return loading}document.getElementById("trusted-generate").addEventListener("click",function(){var button=this,error=document.getElementById("trusted-error"),result=document.getElementById("trusted-link-result");button.disabled=true;button.textContent=I.creating;error.style.display="none";result.style.display="none";fetch("/api/owner-link/create",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"}).then(function(r){return r.json().then(function(data){return{ok:r.ok,data:data}})}).then(function(response){if(!response.ok||!response.data.success)throw new Error(response.data.error||I.failed);var data=response.data.data||{},expiry=fmt(data.expiresAt),copy=I.copyTemplate.replace("{url}",String(data.ownerUrl||"")).replace("{expires}",expiry);document.getElementById("trusted-link-text").value=copy;document.getElementById("trusted-link-expiry").textContent=expiry;result.style.display="block"}).catch(function(reason){error.textContent=reason.message||I.failed;error.style.display="block"}).finally(function(){button.disabled=false;button.textContent=I.generate})});document.getElementById("trusted-copy").addEventListener("click",function(){var button=this,value=document.getElementById("trusted-link-text").value,promise=window.vokoCopyText?window.vokoCopyText(value,button):navigator.clipboard.writeText(value);if(promise&&typeof promise.then==="function")promise.then(function(){button.textContent=I.copied})});document.getElementById("trusted-devices").addEventListener("click",function(event){var button=event.target.closest("[data-device-id]");if(!button)return;button.disabled=true;fetch("/api/owner-link/devices/"+encodeURIComponent(button.dataset.deviceId),{method:"DELETE",headers:{Accept:"application/json"}}).then(function(r){return r.json().then(function(data){return{ok:r.ok,data:data}})}).then(function(result){if(!result.ok||!result.data.success)throw new Error(result.data.error||I.failed);return load()}).catch(function(error){button.disabled=false;document.getElementById("trusted-devices").prepend(el("p",error.message||I.failed,"error"))})});load();if(window.EventSource){var events=new EventSource("/api/owner-link/device-events");events.addEventListener("devices",load)}})();</script>';
      const policyScript='<script>(function(){var root=document.getElementById("trusted-policy");if(!root)return;root.addEventListener("change",function(event){var input=event.target.closest("[data-policy]");if(!input)return;input.disabled=true;var body={};body[input.dataset.policy]=input.checked;fetch("/api/owner-chat/policy",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(function(r){if(!r.ok)throw new Error();return r.json()}).catch(function(){input.checked=!input.checked}).finally(function(){input.disabled=false})})})();</script>';
      const codexScript='<script>(function(){document.querySelectorAll("[data-codex-agent]").forEach(function(form){form.addEventListener("submit",function(event){event.preventDefault();var button=form.querySelector("button"),result=form.querySelector("[data-codex-result]");button.disabled=true;result.textContent="";fetch("/api/owner-codex-config/"+encodeURIComponent(form.dataset.codexAgent),{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({cwd:form.elements.cwd.value,profile:form.elements.profile.value})}).then(function(r){return r.json().then(function(data){if(!r.ok||!data.success)throw new Error(data.error||"save failed");return data.data})}).then(function(data){form.elements.cwd.value=data.cwd||"";form.elements.profile.value=data.profile||"";result.textContent="'+L('web.trusted_remote.codex_saved')+'"}).catch(function(error){result.textContent=error.message}).finally(function(){button.disabled=false})})})})();</script>';
      res.send(renderPage(req,T('web.trusted_remote.title'),body,{footer:renderFooter(T,req.locale)+script+policyScript+codexScript}));
    }catch(error){next(error)}
  });

  R.use(createRegisterRouter(handlers, db, {
    webSessions: opts.webSessions,
    uploadAgentIcon: opts.uploadAgentIcon,
    readAgentIconCandidate: opts.readAgentIconCandidate,
  }));

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

  const ownerChatLiveScript=(agentId,selector,conversationId='',fragmentUrl='',includeAgentMessages=false)=>'<script>(function(){var aid='+jsonForInlineScript(agentId)+',cid='+jsonForInlineScript(conversationId)+',selector='+jsonForInlineScript(selector)+',fragmentUrl='+jsonForInlineScript(fragmentUrl)+',includeAgentMessages='+jsonForInlineScript(includeAgentMessages)+',busy=false,timer=null;function scrollToLatest(){var scroller=document.querySelector(selector+" .owner-chat-transcript");if(scroller)scroller.scrollTop=scroller.scrollHeight}requestAnimationFrame(scrollToLatest);window.addEventListener("load",scrollToLatest,{once:true});function refresh(){if(busy)return;busy=true;fetch(fragmentUrl||location.href,{headers:{"Accept":"text/html","X-Requested-With":"voko-owner-chat"},cache:"no-store"}).then(function(r){if(!r.ok)throw new Error("refresh failed");return r.text()}).then(function(html){var doc=new DOMParser().parseFromString(html,"text/html"),fresh=doc.querySelector(selector),current=document.querySelector(selector);if(fresh&&current){var scroller=current.querySelector(".owner-chat-transcript"),nearBottom=!scroller||scroller.scrollHeight-scroller.scrollTop-scroller.clientHeight<80;current.replaceWith(fresh);var next=document.querySelector(selector+" .owner-chat-transcript");if(next&&nearBottom)next.scrollTop=next.scrollHeight}}).catch(function(){}).finally(function(){busy=false})}function queue(){clearTimeout(timer);timer=setTimeout(refresh,120)}function connect(){try{var protocol=location.protocol==="https:"?"wss://":"ws://",ws=new WebSocket(protocol+location.host+"/ws");ws.onmessage=function(e){try{var d=JSON.parse(e.data),data=d.data||{};if((d.event==="owner-chat:updated"||(includeAgentMessages&&d.event==="agent-wukongim:message"))&&data.agentId===aid&&(!cid||!data.conversationId||data.conversationId===cid))queue()}catch(_){}};ws.onclose=function(){setTimeout(connect,3000)}}catch(_){setTimeout(connect,5000)}}connect()})();</script>';

  R.get('/agents/:agentId/security',requireSensitiveLocalAuth,async(req,res,next)=>{
    try{
      const agentId=String(req.params.agentId||''),agent=await getAgentInfo(handlers,agentId);
      if(!agent)return res.status(404).send('Not Found');
      const service=opts.dispatcher?.providerSecurity;
      if(!service)return res.status(503).send('Provider security unavailable');
      const data=opts.dispatcher?.inspectProviderSecurity?.(agentId)||service.inspect(agentId),zh=String(req.locale||'zh').startsWith('zh');
      const title=zh?'访客权限与安全':'Visitor permissions & security';
      const unavailableTitle=zh?'尚未接入可验证的动态权限控制':'Verified dynamic permissions are not connected';
      const unavailable=zh?'VOKO 当前不能确定性控制这个智能体框架的 Shell、文件、浏览器或网络权限。访客安全仍依赖框架自身限制和安全提示语，不构成 VOKO 的权限边界。不会显示无法执行的通用权限开关。':'VOKO cannot currently enforce Shell, file, browser, or network permissions for this Agent framework. Visitor safety still depends on the framework and prompt instructions, not a VOKO permission boundary. Unsupported generic toggles are intentionally hidden.';
      const statusLabel=item=>{
        if(item.enforcement==='unsupported')return zh?'不支持配置':'Not configurable';
        const detail=zh?(item.statusLabel||'固定执行'):(item.statusLabelEn||'Enforced');
        return (zh?'安全策略已锁定':'Security policy locked')+' · '+detail;
      };
      const term=(value,map)=>zh?(map[value]||value):value;
      const enforcementLabels={voko_enforced:'VOKO 强制执行',provider_enforced:'智能体框架强制执行',unsupported:'不支持'};
      const applyAtLabels={next_turn:'下一轮消息生效',runtime_start:'运行时启动时生效'};
      const revocationLabels={next_invocation:'下一次调用撤销',restart_runtime:'重启运行时撤销'};
      const visibleControls=data.controls.filter(item=>item.enforcement!=='unsupported');
      const hasVisibleControls=data.supported&&visibleControls.length>0;
      const rows=visibleControls.map(item=>{
        let field='<span class="badge '+(item.enforcement==='unsupported'?'badge-offline':'badge-online')+'">'+esc(statusLabel(item))+'</span>';
        if(item.editable){const selected=item.values.find(option=>data.config[item.id]===option.value)||item.values[0],risk=selected&&selected.risk||'low';const riskText=risk==='high'?(zh?'高风险':'High risk'):risk==='medium'?(zh?'中等风险':'Medium risk'):(zh?'低风险':'Low risk');const riskClass=risk==='high'?'badge-offline':risk==='medium'?'badge-pending':'badge-online';field='<div><select name="'+esc(item.id)+'" data-control="'+esc(item.id)+'" style="margin:0;max-width:240px">'+item.values.map(option=>'<option value="'+esc(option.value)+'" data-risk="'+esc(option.risk||'low')+'"'+(data.config[item.id]===option.value?' selected':'')+'>'+esc(option.label)+'</option>').join('')+'</select><div style="margin-top:7px"><span class="badge '+riskClass+'" data-risk-indicator>'+esc(riskText)+'</span></div></div>'}
        return '<div class="card" style="display:grid;grid-template-columns:minmax(180px,1fr) minmax(180px,260px);gap:18px;align-items:center"><div><h3>'+esc(item.label)+'</h3><p class="meta" style="margin:3px 0">'+esc(item.description)+'</p><div class="meta">'+esc(term(item.enforcement,enforcementLabels))+' · '+esc(term(item.applyAt,applyAtLabels))+' · '+esc(term(item.revocation,revocationLabels))+'</div></div><div>'+field+'</div></div>';
      }).join('');
      const scope='<div class="card"><strong>'+(zh?'生效范围':'Applies to')+'</strong><p class="meta">'+(zh?'访客私聊、访客群聊、REST/Webhook Push。主人会话、A2A 与 Pull 不受此策略控制。每个尚未提交的 Turn 都读取最新策略；不区分新老对话。':'Visitor direct messages, visitor groups, and REST/Webhook Push. Owner, A2A, and Pull are excluded. Every not-yet-submitted turn reads the latest policy; conversations are not classified as old or new.')+'</p></div>';
      const confirmation='<div id="provider-security-confirmation" class="card" hidden><label for="provider-security-confirmation-input">'+(zh?'此次修改会扩大权限。请输入智能体名称以确认：':'This change expands authority. Type the Agent name to confirm:')+'</label><input id="provider-security-confirmation-input" autocomplete="off" style="margin-top:8px" /></div>';
      const form=hasVisibleControls?'<form id="provider-security-form" data-transport="'+esc(data.transportId)+'" data-agent-name="'+esc(data.agentName)+'">'+rows+(visibleControls.some(item=>item.editable)?confirmation+'<button type="submit">'+(zh?'预检并保存':'Preflight & save')+'</button>':'')+'<p id="provider-security-result" class="meta" hidden></p></form>':'<div class="card"><h2>'+esc(unavailableTitle)+'</h2><p><strong>'+(zh?'智能体框架':'Agent framework')+':</strong> '+esc(data.backendType||'-')+'</p><p class="meta">'+esc(unavailable)+'</p></div>';
      const labels={saving:zh?'正在安全预检…':'Running security preflight…',confirm:zh?'此次修改会扩大权限。请输入智能体名称以确认：':'This change expands authority. Type the Agent name to confirm:',saved:zh?'策略已保存，后续尚未提交的消息将使用新权限。':'Policy saved. Unsubmitted messages will use it.',failed:zh?'保存失败':'Save failed'};
      const script='<script>(function(){var form=document.getElementById("provider-security-form");if(!form)return;var out=document.getElementById("provider-security-result"),confirmBox=document.getElementById("provider-security-confirmation"),confirmInput=document.getElementById("provider-security-confirmation-input"),L='+jsonForInlineScript(labels)+';function show(text,kind){out.hidden=false;out.textContent=text;out.className=kind||"meta"}function updateRisk(field){var option=field.options[field.selectedIndex],risk=option&&option.dataset.risk||"low",badge=field.parentElement.querySelector("[data-risk-indicator]");if(!badge)return;badge.textContent=risk==="high"?'+jsonForInlineScript(zh?'高风险':'High risk')+':risk==="medium"?'+jsonForInlineScript(zh?'中等风险':'Medium risk')+':'+jsonForInlineScript(zh?'低风险':'Low risk')+';badge.className="badge "+(risk==="high"?"badge-offline":risk==="medium"?"badge-pending":"badge-online")}form.querySelectorAll("[data-control]").forEach(function(field){field.addEventListener("change",function(){updateRisk(field)})});form.addEventListener("submit",async function(event){event.preventDefault();var button=form.querySelector("button[type=submit]"),config={};form.querySelectorAll("[data-control]").forEach(function(field){config[field.dataset.control]=field.value});button.disabled=true;show(L.saving,"meta");try{var pre=await fetch("/api/agents/"+encodeURIComponent('+jsonForInlineScript(agentId)+')+"/provider-security/preflight",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({transportId:form.dataset.transport,config:config})}),p=await pre.json();if(!pre.ok||!p.success)throw new Error(p.error||L.failed);var confirmation="";if(p.data.requiresTypedConfirmation){confirmation=confirmInput?confirmInput.value.trim():"";if(!confirmation){if(confirmBox)confirmBox.hidden=false;if(confirmInput)confirmInput.focus();show(L.confirm,"error");return}}var commit=await fetch("/api/agents/"+encodeURIComponent('+jsonForInlineScript(agentId)+')+"/provider-security/commit",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({preflightToken:p.data.preflightToken,confirmation:confirmation})}),c=await commit.json();if(!commit.ok||!c.success)throw new Error(c.error||L.failed);if(confirmBox)confirmBox.hidden=true;if(confirmInput)confirmInput.value="";show(L.saved,"success")}catch(error){show(error.message||L.failed,"error")}finally{button.disabled=false}})})();</script>';
      const modeLabels={acp:'ACP',acp_ws:'ACP WebSocket',cli:zh?'命令行推送':'CLI push',http:'HTTP',websocket:'WebSocket',attach:zh?'连接现有服务':'Attach',pull:zh?'主动拉取':'Pull'};
      const deliveryMode=String(data.deliveryMode||'pull');
      const supportedHeader='<div class="info-bar"><span><strong>'+(zh?'智能体框架':'Agent framework')+':</strong> '+esc(data.backendType||'-')+'</span><span><strong>'+(zh?'消息推送模式':'Message delivery mode')+':</strong> '+esc(modeLabels[deliveryMode]||deliveryMode)+'</span>'+(data.transportId?'<span><strong>'+(zh?'安全适配器':'Security adapter')+':</strong> <code>'+esc(data.transportId)+'</code></span>':'')+'</div>';
      const body=supportedHeader+(hasVisibleControls?scope:'')+form+'<p><a href="/agents/'+esc(agentId)+'">← '+(zh?'返回智能体':'Back to Agent')+'</a></p>';
      res.send(renderPage(req,title,body,{nav:agentNav(agentId,agent.agentName||agentId,req.t)+' › '+esc(title),footer:renderFooter(req.t,req.locale)+script}));
    }catch(error){next(error)}
  });

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
      const requestedTab=req.query.tab==='group'?'group':req.query.tab==='owner'?'owner':req.query.tab==='a2a'?'a2a':req.query.tab==='external'?'external':'conv';
      let activeTab=requestedTab;
      const createdGroupId=String(req.query.created||'');
      let convs=[],convTotal=0,convPages=0;
      try{const cr=await handlers.list_conversations({agentId,filter:'all',limit,offset,keyword,channelType:'direct'});convs=cr.conversations||[];convTotal=cr.total||0;convPages=Math.ceil(convTotal/limit)}catch{}
      const opage=Math.max(1,parseInt(req.query.opage,10)||1),ooffset=(opage-1)*limit;
      let ownerConversations=[],ownerTotal=0,ownerPages=0;
      try{if(opts.ownerChatReadStore){ownerTotal=opts.ownerChatReadStore.countForAgent(agentId);ownerPages=Math.ceil(ownerTotal/limit);ownerConversations=opts.ownerChatReadStore.listForAgent(agentId,limit,ooffset)}}catch{}
      if(requestedTab==='owner'&&ownerTotal&&ownerConversations[0])return res.redirect('/agents/'+encodeURIComponent(agentId)+'/owner-chats/'+encodeURIComponent(ownerConversations[0].conversationId));
      if(activeTab==='owner'&&!ownerTotal)activeTab='conv';
       let a2aRows=[];let a2aReadAvailable=true;
       try{a2aRows=await loadA2ATaskRows(agentId)}catch{a2aReadAvailable=false}
       const externalRows=a2aRows.filter(row=>String(row.direction).toLowerCase()!=='outbound'&&row.source_channel==='rest_webhook');
       a2aRows=a2aRows.filter(row=>row.source_channel!=='rest_webhook');
       const a2aTotal=a2aRows.length;
       const a2aPrincipalTotal=new Set(a2aRows.map(row=>String(row.principal_view_id||'').trim()).filter(Boolean)).size;
       let hasDeclaredCapabilities=false;
       try{const row=db.prepare('SELECT ability FROM agents WHERE agent_id=? LIMIT 1').get(agentId);const ability=JSON.parse(row?.ability||'null');hasDeclaredCapabilities=Array.isArray(ability)&&ability.length>0}catch{}
       let hasExternalIntegration=false;
       try{const gatewayAgent=externalGatewayAgent(agentId);if(gatewayAgent){const result=await externalGatewayRequest(externalGatewayPath);hasExternalIntegration=(result.data?.integrations||[]).some(item=>item.status==='active'&&Array.isArray(item.agentIds)&&item.agentIds.includes(gatewayAgent.publicAgentId))}}catch{}
       const showA2ATab=a2aReadAvailable&&hasDeclaredCapabilities;
       const showExternalTab=a2aReadAvailable&&hasExternalIntegration;
       if(requestedTab==='a2a'&&!showA2ATab){
         if(a2aReadAvailable)return res.redirect('/agents/'+encodeURIComponent(agentId));
         activeTab='conv';
       }
       if(requestedTab==='external'&&!showExternalTab){
         if(a2aReadAvailable)return res.redirect('/agents/'+encodeURIComponent(agentId));
         activeTab='conv';
       }
       const a2aKeyword=String(req.query.a2aKeyword||'').trim();
       const a2aPageRequested=Math.max(1,parseInt(req.query.a2aPage,10)||1),a2aLimit=10;
       const a2aGroups=buildA2APrincipalGroups(a2aRows,T,a2aKeyword);
       const hasInboundA2A=a2aRows.some(row=>String(row.direction).toLowerCase()!=='outbound');
       const hasOutboundA2A=a2aRows.some(row=>String(row.direction).toLowerCase()==='outbound');
       const mixedA2A=hasInboundA2A&&hasOutboundA2A;
       // Principal grouping is useful for inbound-only tasks. Outbound-only and
       // mixed traffic must remain visible as individual tasks as well.
       const taskTableA2A=!hasInboundA2A||mixedA2A;
       const filteredA2ATasks=taskTableA2A?filterA2ATaskRows(a2aRows,T,a2aKeyword):[];
       const a2aPageCount=taskTableA2A?filteredA2ATasks.length:a2aGroups.length;
       const a2aPages=Math.ceil(a2aPageCount/a2aLimit),a2aPage=Math.min(a2aPageRequested,Math.max(1,a2aPages||1));
       const a2aPanelRows=taskTableA2A?filteredA2ATasks.slice((a2aPage-1)*a2aLimit,a2aPage*a2aLimit):a2aGroups.slice((a2aPage-1)*a2aLimit,a2aPage*a2aLimit).flatMap(group=>group.rows);
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
      const e2eeDebugUi=String(process.env.VOKO_E2EE_DEBUG_UI||'').trim().toLowerCase()==='true';

      // 结果提示
      let msg=null;
      if(req.query.ok)msg={success:true,text:req.query.ok};
      else if(req.query.warn)msg={warning:true,text:req.query.warn};
      else if(req.query.err)msg={success:false,text:req.query.err};

      // 信息条
      const imUid=esc(agent.imUid||'');
      const infoBar='<div class="info-bar">'+(imUid?'<span style="display:inline-flex;align-items:center;gap:4px">'+L('web.agent.info.im_uid')+': <code>'+imUid+'</code>'+copyButton({esc,label:T('web.agent.info.im_uid_copy_hint'),attrs:'data-voko-copy-value="'+imUid+'"'})+'</span>':'')+'<span>'+L('web.agent.info.status')+': <span class="badge '+stBdg+' '+stCls+'">'+stTxt+'</span></span><span>'+L('web.agent.info.backend')+': '+h(agent.backendType)+'</span><span>'+L('web.agent.info.publish')+': '+h(agent.publishStatus)+'</span>'+(agent.ownerEmail?'<span>'+L('web.agent.info.email')+': '+esc(agent.ownerEmail)+'</span>':'')+(warnings.length?'<span class="error">⚠️ '+esc(warnings.join('; '))+'</span>':'')+'</div>';

      // 搜索框
      const keywordEsc=esc(keyword);
      const searchHtml='<form method="GET" action="/agents/'+aId+'" style="display:inline-block;margin-left:8px"><input type="text" name="keyword" value="'+keywordEsc+'" placeholder="'+esc(T('web.agent.search_ph'))+'" style="width:180px;max-width:100%;display:inline-block;margin:0;font-size:14px;padding:6px 10px;vertical-align:middle">'+(keywordEsc?'<a href="/agents/'+aId+'" class="btn-sm btn-outline" style="margin:0 0 0 4px;padding:6px 10px;min-width:auto;min-height:auto;vertical-align:middle">✕</a>':'')+'<button type="submit" class="btn-sm" style="margin:0 0 0 4px;padding:6px 12px;min-width:auto;min-height:auto;vertical-align:middle" data-agent-action="agent.search"'+(!keyword&&convTotal===0?' disabled':'')+'>'+L('web.agent.search_btn')+'</button></form>';

      // 会话
      let convHtml='<p class="meta">'+L('web.agent.no_conversations')+'</p>';
      if(convs.length){
        const listMessageRenderer=createMessageRenderer(messageLabels(T));
        let e2eeStates={};
        if(e2eeDebugUi){
          try{e2eeStates=await opts.e2eeRuntime?.getChannelEncryptionStatuses?.(agentId,convs.map(c=>String(c.channelId)))||{};}catch(_){e2eeStates={};}
          for(const c of convs){const channelId=String(c.channelId);if(!e2eeStates[channelId]&&opts.e2eeRuntime?.isChannelActive?.(agentId,channelId))e2eeStates[channelId]='active';}
        }
        // 补昵称（user_cache 有则用，无则回退 channelId）
        let convNickMap={};
        try{const cids=convs.map(c=>c.channelId);const rows=db.prepare('SELECT uid, nickname FROM user_cache WHERE uid IN ('+cids.map(()=>'?').join(',')+')').all(...cids);rows.forEach(r=>{convNickMap[r.uid]=r.nickname||'';});}catch(_){}
        convHtml='<div class="table-wrap"><table><thead><tr><th>'+L('web.agent.col.visitor')+'</th><th>'+L('web.agent.col.last_msg')+'</th><th style="text-align:center">'+L('web.agent.col.last_from')+'</th><th style="text-align:center">'+L('web.agent.col.time')+'</th></tr></thead><tbody>';
        for(const c of convs){
          const lastFrom='<span class="meta">'+(c.lastIsMe===2||c.lastContentType===11?L('web.agent.last_from.system'):(c.needsReply?L('web.agent.last_from.visitor'):L('web.agent.last_from.ai')))+'</span>';
          const msg=listMessageRenderer.previewHtml(c.lastContentType,c.lastMessage,60);
          const unreadBadge=c.unreadCount>0?' <span class="badge" style="background:#e74c3c;color:#fff;border-radius:10px;padding:1px 6px;font-size:11px">'+c.unreadCount+'</span>':'';
          const visitorName=String(convNickMap[c.channelId]||c.name||c.channelId||'');
          const visitorLink='<a href="/agents/'+aId+'/c/'+esc(c.channelId)+'" title="'+esc(visitorName)+'" aria-label="'+esc(visitorName)+'" style="display:inline-block;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle">'+esc(visitorName)+'</a>';
          const e2eeState=String(e2eeStates[String(c.channelId)]||'');
          const keyMeta=e2eeDebugUi&&e2eeState==='active'?['web.agent.e2ee_active','#22C55E','#16A34A']:null;
          const e2eeKey=keyMeta?' <svg role="img" aria-label="'+esc(T(keyMeta[0]))+'" style="width:16px;height:16px;vertical-align:middle" viewBox="0 0 256 256"><title>'+esc(T(keyMeta[0]))+'</title>'+(e2eeState==='checking'?'<animate attributeName="opacity" values="1;.25;1" dur="1s" repeatCount="indefinite"/>':'')+'<g transform="rotate(135 128 128)" fill="'+keyMeta[1]+'" stroke="'+keyMeta[2]+'" stroke-width="4" stroke-linejoin="round"><path fill-rule="evenodd" d="M76 70a58 58 0 1 0 43.6 96.3L218 166v-30h-26v-24h-28v24h-44.4A58 58 0 0 0 76 70Zm0 28a30 30 0 1 1 0 60 30 30 0 0 1 0-60Z"/></g></svg>':'';
          convHtml+='<tr><td style="width:180px;max-width:180px;white-space:nowrap;overflow:hidden">'+visitorLink+e2eeKey+unreadBadge+'</td><td style="white-space:normal;word-break:break-word;max-width:300px">'+msg+'</td><td style="white-space:nowrap;width:50px;text-align:center">'+lastFrom+'</td><td class="meta" style="white-space:nowrap;width:90px;text-align:center">'+timeTag(c.lastTimestamp)+'</td></tr>'
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
       const securityLabel=String(req.locale||'zh').startsWith('zh')?'访客权限与安全':'Visitor permissions & security';
       const aclOps='<h2>'+L('web.agent.acl_title')+'</h2><div class="ops" style="grid-template-columns:repeat(auto-fill,minmax(140px,1fr))"><a href="/agents/'+aId+'/security" class="op-card" data-agent-kind="link" data-agent="nav_card">'+securityLabel+'</a><a href="/agents/'+aId+'/caps" class="op-card" data-agent-kind="link" data-agent="nav_card">'+L('common.btn.caps')+'</a><a href="/capabilities?agentId='+aId+'" class="op-card" data-agent-kind="link" data-agent="nav_card">'+L('web.home.op.capabilities')+'</a><a href="/send-message?agentId='+aId+'" class="op-card" data-agent-kind="link" data-agent="nav_card">'+L('web.home.op.send_message')+'</a><a href="/interventions?agentId='+aId+'" class="op-card" data-agent-kind="link" data-agent="nav_card">'+L('web.home.op.interventions')+'</a><a href="/agents/'+aId+'/invite" class="op-card" data-agent-kind="link" data-agent="nav_card">'+L('web.agent.invite.title')+'</a><a href="/agents/'+aId+'/payment-auth" class="op-card" data-agent-kind="link" data-agent="nav_card">'+L('web.home.op.payments')+'</a><a href="/agents/'+aId+'/visibility" class="op-card" data-agent-kind="link" data-agent="nav_card">'+L('web.agent.visibility.title')+'</a><a href="/agents/'+aId+'/whitelist" class="op-card" data-agent-kind="link" data-agent="nav_card">'+L('web.agent.op.whitelist')+'</a><a href="/agents/'+aId+'/blacklist" class="op-card" data-agent-kind="link" data-agent="nav_card">'+L('web.agent.op.blacklist')+'</a><a href="/agents/'+aId+'/pricing" class="op-card" data-agent-kind="link" data-agent="nav_card">'+L('web.agent.op.pricing')+'</a></div>';;;
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

      let ownerHtml='';
      if(ownerTotal){
        const ownerStatusLabel=status=>L(status==='replied'?'web.owner_chat.status.replied':status==='failed'?'web.owner_chat.status.failed':status==='outcome_unknown'?'web.owner_chat.status.unknown':'web.owner_chat.status.processing');
        ownerHtml='<div class="owner-chat-readonly-note">'+L('web.owner_chat.readonly_notice')+'</div><div class="table-wrap"><table><thead><tr><th>'+L('web.owner_chat.col.conversation')+'</th><th>'+L('web.agent.col.last_msg')+'</th><th style="text-align:center">'+L('web.agent.col.last_from')+'</th><th style="text-align:center">'+L('web.owner_chat.col.status')+'</th><th style="text-align:center">'+L('web.agent.col.time')+'</th></tr></thead><tbody>';
        for(const item of ownerConversations){
          const message=String(item.lastMessage||''),summary=esc(message.length>60?message.substring(0,60)+'…':message);
          ownerHtml+='<tr><td><a href="/agents/'+aId+'/owner-chats/'+encodeURIComponent(item.conversationId)+'">'+L('web.owner_chat.conversation_name')+'</a></td><td style="white-space:normal;word-break:break-word;max-width:300px">'+summary+'</td><td class="meta" style="text-align:center">'+L(item.lastDirection==='agent'?'web.owner_chat.sender.agent':'web.owner_chat.sender.owner')+'</td><td class="meta" style="text-align:center">'+ownerStatusLabel(item.status)+'</td><td class="meta" style="white-space:nowrap;text-align:center">'+timeTag(item.lastActivityAt)+'</td></tr>';
        }
        ownerHtml+='</tbody></table></div>';
        if(ownerPages>1){ownerHtml+='<div style="display:flex;align-items:center;justify-content:center;gap:12px;padding:8px 0;font-size:14px">'+(opage>1?'<a href="/agents/'+aId+'?tab=owner&opage='+(opage-1)+'" class="btn-sm">'+esc(T('web.payments.prev_page'))+'</a>':'')+'<span class="meta">'+esc(T('web.payments.page_of',{cur:opage,total:ownerPages}))+'</span>'+(opage<ownerPages?'<a href="/agents/'+aId+'?tab=owner&opage='+(opage+1)+'" class="btn-sm">'+esc(T('web.payments.next_page'))+'</a>':'')+'</div>'}
      }

      // Tab（会话列表 / 群列表 / 主人会话）
      const tabBtn=(id,label,active)=>'<button type="button" data-tab="'+id+'" style="background:transparent;border:none;border-bottom:3px solid '+(active?'#1a73e8':'transparent')+';color:'+(active?'#1a73e8':'#666')+';font:inherit;font-size:16px;font-weight:'+(active?'700':'600')+';padding:10px 20px;margin-bottom:-2px;cursor:pointer">'+label+'</button>';
      const convLabel=L('web.agent.tab.conversations')+' ('+convTotal+')';
      const groupLabel=L('web.agent.tab.groups')+' ('+groupTotal+')';
      const ownerLabel=L('web.agent.tab.owner_chats')+' ('+ownerTotal+')';
      const a2aLabel=L('web.agent.tab.a2a_tasks')+' ('+a2aPrincipalTotal+')';
      const externalKeyword=String(req.query.externalKeyword||'').trim();
      const externalGroups=buildA2APrincipalGroups(externalRows,T,externalKeyword);
      const externalLabel=L('web.agent.tab.external_messages')+' ('+externalGroups.length+')';
      const externalPreviews=new Map();
      if(opts.a2aMailboxClient)await Promise.all(externalGroups.slice(0,10).map(async group=>{try{const task=await opts.a2aMailboxClient.getInboundTask(group.rows[0].task_id);const events=Array.isArray(task?.events)?task.events:[];for(let i=events.length-1;i>=0;i--){const payload=parseA2AEventPayload(events[i]);const text=typeof payload.text==='string'?payload.text:typeof payload.message==='string'?payload.message:'';if(text){externalPreviews.set(group.principalViewId,text);break}}}catch(_){}}));
      const ownerDirectTab=ownerTotal&&ownerConversations[0]?'<a href="/agents/'+aId+'/owner-chats/'+encodeURIComponent(ownerConversations[0].conversationId)+'" style="display:inline-flex;align-self:flex-end;align-items:center;height:50px;box-sizing:border-box;background:transparent;border:none;border-bottom:3px solid transparent;color:#666;font:inherit;font-size:16px;font-weight:600;line-height:27.2px;padding:10px 20px;margin:0 0 -2px;text-decoration:none">'+ownerLabel+'</a>':'';
      const tabBar='<div style="display:flex;gap:4px;border-bottom:2px solid #e0e0e0;margin-bottom:14px">'+tabBtn('conv',convLabel,activeTab==='conv')+tabBtn('group',groupLabel,activeTab==='group')+ownerDirectTab+(showA2ATab?tabBtn('a2a',a2aLabel,activeTab==='a2a'):'')+(showExternalTab?tabBtn('external',externalLabel,activeTab==='external'):'')+'</div>';
      const convPanel='<div id="tab-conv" style="'+(activeTab==='conv'?'':'display:none')+'">'+searchHtml+convHtml+pgBar+aclOps+'</div>';
      const groupPanel='<div id="tab-group" style="'+(activeTab==='group'?'':'display:none')+'">'+groupHtml+gPgBar+groupOps+'</div>';
      const ownerPanel=ownerTotal?'<div id="tab-owner" style="'+(activeTab==='owner'?'':'display:none')+'">'+ownerHtml+'</div>':'';
      const a2aKeywordEsc=esc(a2aKeyword),a2aKeywordParam=a2aKeyword?'&a2aKeyword='+encodeURIComponent(a2aKeyword):'';
      const a2aSearchHtml='<form method="GET" action="/agents/'+aId+'" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 10px"><input type="hidden" name="tab" value="a2a"><input type="search" name="a2aKeyword" value="'+a2aKeywordEsc+'" placeholder="'+esc(T('web.agent.a2a.search_ph'))+'" style="width:220px;max-width:100%;margin:0;font-size:14px;padding:6px 10px"><button type="submit" class="btn-sm" style="margin:0;padding:6px 12px;min-width:auto;min-height:auto" data-agent-action="agent.a2a.search"'+(!a2aKeyword&&a2aTotal===0?' disabled':'')+'>'+L('web.agent.search_btn')+'</button>'+(a2aKeyword?'<a href="/agents/'+aId+'?tab=a2a" class="btn-sm btn-outline" style="margin:0;padding:6px 10px;min-width:auto;min-height:auto">✕</a>':'')+'</form>';
      let a2aPgBar='';
      if(a2aPages>1){a2aPgBar='<div style="display:flex;align-items:center;justify-content:center;gap:12px;padding:8px 0;font-size:14px">';if(a2aPage>1)a2aPgBar+='<a href="/agents/'+aId+'?tab=a2a&a2aPage='+(a2aPage-1)+a2aKeywordParam+'" class="btn-sm" style="padding:4px 12px">'+esc(T('web.payments.prev_page'))+'</a>';a2aPgBar+='<span style="color:#666">'+esc(T('web.payments.page_of',{cur:a2aPage,total:a2aPages}))+'</span>';if(a2aPage<a2aPages)a2aPgBar+='<a href="/agents/'+aId+'?tab=a2a&a2aPage='+(a2aPage+1)+a2aKeywordParam+'" class="btn-sm" style="padding:4px 12px">'+esc(T('web.payments.next_page'))+'</a>';a2aPgBar+='</div>'}
      const a2aContent=taskTableA2A?renderA2ATaskRows(a2aPanelRows,{showAgent:false,T}):renderA2APrincipalRows(a2aPanelRows,agentId,T);
      const a2aPanel=showA2ATab?'<div id="tab-a2a" style="'+(activeTab==='a2a'?'':'display:none')+'">'+a2aSearchHtml+a2aContent+a2aPgBar+'</div>':'';
      const externalSearch='<form method="GET" action="/agents/'+aId+'" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 10px"><input type="hidden" name="tab" value="external"><input type="search" name="externalKeyword" value="'+esc(externalKeyword)+'" placeholder="'+L('web.agent.external.search_ph')+'" style="width:220px;max-width:100%;margin:0;font-size:14px;padding:6px 10px"><button type="submit" class="btn-sm" style="margin:0;padding:6px 12px;min-width:auto;min-height:auto"'+(!externalKeyword&&externalRows.length===0?' disabled':'')+'>'+L('web.agent.search_btn')+'</button></form>';
      const externalContent=externalGroups.length?'<div class="table-wrap"><table><thead><tr><th>'+L('web.agent.external.col.system')+'</th><th>'+L('web.agent.external.col.latest')+'</th><th style="text-align:center">'+L('web.agent.external.col.messages')+'</th><th style="text-align:center">'+L('web.agent.col.time')+'</th></tr></thead><tbody>'+externalGroups.map(group=>{const latest=group.rows[0],name=latest.principal_name||group.principalId||L('web.agent.external.unknown'),preview=externalPreviews.get(group.principalViewId)||'';return '<tr><td><a href="/agents/'+aId+'/external/'+encodeURIComponent(group.principalViewId)+'"><strong>'+esc(name)+'</strong></a></td><td style="white-space:normal;word-break:break-word;max-width:320px">'+esc(preview.length>60?preview.slice(0,60)+'…':preview||'—')+'</td><td style="text-align:center">'+group.rows.length+'</td><td class="meta" style="text-align:center;white-space:nowrap">'+timeTag(latest.updated_at)+'</td></tr>'}).join('')+'</tbody></table></div>':'<p class="meta">'+L('web.agent.external.empty')+'</p>';
      const externalPanel=showExternalTab?'<div id="tab-external" style="'+(activeTab==='external'?'':'display:none')+'">'+externalSearch+externalContent+'</div>':'';
      const body=infoBar+'<div id="agent-tabs-root">'+tabBar+convPanel+groupPanel+ownerPanel+a2aPanel+externalPanel+'</div><p><a href="/">← '+L('common.btn.home')+'</a></p>';

      const tabScript='<script>(function(){function setTab(t){["conv","group","owner","a2a","external"].forEach(function(id){var panel=document.getElementById("tab-"+id);if(panel)panel.style.display=(t===id?"":"none")});document.querySelectorAll("button[data-tab]").forEach(function(b){var on=b.getAttribute("data-tab")===t;b.style.borderBottomColor=on?"#1a73e8":"transparent";b.style.color=on?"#1a73e8":"#666";b.style.fontWeight=on?"700":"600";});var u=new URL(location.href);if(t==="group"||t==="owner"||t==="a2a"||t==="external")u.searchParams.set("tab",t);else u.searchParams.delete("tab");history.replaceState(null,"",u);}document.addEventListener("click",function(e){var b=e.target.closest("button[data-tab]");if(b)setTab(b.getAttribute("data-tab"))});})();</script>';

      res.send(renderPage(req,T('web.agent.title',{name:aName}),body,{nav:agentNav(agentId,agent.agentName||agent.agentId,T),msg,jsonld:{'@context':'https://schema.org',name:agent.agentName,identifier:agent.agentId},footer:renderFooter(T, req.locale)+tabScript+ownerChatLiveScript(agentId,'#agent-tabs-root','','',true)}))
    }catch(e){next(e)}
  });

  R.get('/agents/:agentId/owner-chats/:conversationId',async(req,res,next)=>{
    const T=req.t||makeT(req.locale||'zh'),L=k=>esc(T(k));
    try{
      const agentId=String(req.params.agentId||''),conversationId=String(req.params.conversationId||'');
      const agent=await getAgentInfo(handlers,agentId);
      const messages=opts.ownerChatReadStore?.getTranscript(agentId,conversationId)||[];
      if(!agent||!messages.length)return res.status(404).send(renderPage(req,T('web.owner_chat.not_found_title'),'<p class="error">'+L('web.owner_chat.not_found')+'</p><a href="/agents/'+esc(agentId)+'?tab=owner">← '+L('web.owner_chat.back')+'</a>'));
      const aName=esc(agent.agentName||agent.agentId),formatSize=value=>{const size=Number(value)||0;return size<1024?size+' B':size<1048576?(size/1024).toFixed(1)+' KB':(size/1048576).toFixed(1)+' MB'};
      const statusLabel=status=>L(status==='sent'||status==='replied'?'web.owner_chat.status.replied':status==='failed'||status==='failed_not_delivered'?'web.owner_chat.status.failed':status==='outcome_unknown'?'web.owner_chat.status.unknown':'web.owner_chat.status.processing');
      const bubble=message=>{
        const payload=message.payload||{},expires=Date.parse(String(payload.expiresAt||'')),resourceAvailable=!!payload.downloadUrl&&(!Number.isFinite(expires)||expires>Date.now());
        let content='';
        if(Number(message.contentType)===2){content=resourceAvailable?'<a href="'+esc(payload.downloadUrl)+'" target="_blank" rel="noopener noreferrer"><img class="owner-chat-image" src="'+esc(payload.downloadUrl)+'" alt="'+esc(payload.name||T('web.message.image'))+'"></a>':'<div class="owner-chat-file-unavailable">'+L('web.message.image')+' · '+L('web.owner_chat.resource_expired')+'</div>'}
        else if(Number(message.contentType)===3){const label=esc(payload.name||T('web.message.unknown_file'))+' ('+esc(formatSize(payload.size))+')';content=resourceAvailable?'<a class="owner-chat-file" href="'+esc(payload.downloadUrl)+'" target="_blank" rel="noopener noreferrer">'+label+'</a>':'<div class="owner-chat-file-unavailable">'+label+' · '+L('web.owner_chat.resource_expired')+'</div>'}
        if(payload.text)content+='<div class="owner-chat-text">'+esc(payload.text).replace(/\n/g,'<br>')+'</div>';
        if(!content)content='<div class="owner-chat-file-unavailable">'+L('web.owner_chat.message_unavailable')+'</div>';
        const owner=message.direction==='owner',sender=owner?L('web.owner_chat.owner_verified'):aName;
        return '<div style="padding:8px 12px;margin:4px 0;border-radius:6px;border-left:4px solid '+(owner?'#1a73e8':'#0f9d58')+';background:'+(owner?'#e8f0fe':'#e6f4ea')+'"><strong>'+sender+'</strong> <span style="color:#888;font-size:13px">['+timeTag(message.createdAt)+']</span><br>'+content+'<div class="meta" style="margin-top:4px">'+statusLabel(message.state)+'</div></div>';
      };
      const shell='<section class="owner-chat-detail" data-owner-chat-agent="'+esc(agentId)+'" data-owner-chat-conversation="'+esc(conversationId)+'"><div id="msg-count" class="meta">'+esc(T('web.conversation.count_msg',{count:messages.length}))+'</div><div id="msg-box" class="owner-chat-transcript" style="max-height:50vh;overflow-y:auto;border:1px solid #e0e0e0;padding:12px;border-radius:6px;background:#fff;margin-bottom:10px">'+messages.map(bubble).join('')+'</div><div class="card" style="color:#667085;font-size:14px">'+L('web.owner_chat.readonly_notice')+'</div><h2 style="margin:18px 0 8px">'+L('web.home.ops_title')+'</h2><div class="ops"><a href="/trusted-remote" class="op-card" data-agent-kind="link" data-agent="nav_card">'+L('web.home.op.trusted_remote')+'</a></div></section>';
      const styles='<style>.owner-chat-shell{height:min(760px,calc(100vh - 190px));min-height:500px;display:flex;flex-direction:column;overflow:hidden;border:1px solid #e4e7ec;border-radius:16px;background:#f3f5f8;box-shadow:0 12px 32px rgba(16,24,40,.08)}.owner-chat-header{min-height:72px;display:flex;align-items:center;gap:12px;padding:10px 18px;border-bottom:1px solid #e4e7ec;background:#fff}.owner-chat-back{width:34px;height:34px;display:flex;align-items:center;justify-content:center;border-radius:9px;text-decoration:none;color:#475467;font-size:23px}.owner-chat-back:hover{background:#f2f4f7}.owner-chat-header-avatar,.owner-chat-avatar{display:flex;align-items:center;justify-content:center;border-radius:50%;font-weight:700}.owner-chat-header-avatar{width:44px;height:44px;background:linear-gradient(135deg,#dbeafe,#ede9fe);color:#344054}.owner-chat-header-copy{min-width:0}.owner-chat-header-copy h1{margin:0;font-size:17px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.owner-chat-header-copy p{display:flex;align-items:center;gap:7px;margin:4px 0 0;color:#667085;font-size:12px}.owner-chat-header-copy p span{width:7px;height:7px;border-radius:50%;background:#12b76a;box-shadow:0 0 0 3px #d1fadf}.owner-chat-transcript{flex:1;min-height:0;overflow:auto;padding:24px clamp(14px,4vw,46px);display:flex;flex-direction:column;gap:18px;scroll-behavior:smooth}.owner-chat-message-row{display:flex;align-items:flex-start;gap:10px}.owner-chat-message-row.agent{flex-direction:row-reverse}.owner-chat-avatar{flex:0 0 38px;width:38px;height:38px;border:1px solid #e4e7ec;background:#fff;color:#475467;font-size:11px}.owner-chat-message-row.agent .owner-chat-avatar{background:#dbeafe;border-color:#bfdbfe;color:#175cd3}.owner-chat-message-stack{min-width:0;max-width:min(72%,680px);display:flex;flex-direction:column;align-items:flex-start}.owner-chat-message-row.agent .owner-chat-message-stack{align-items:flex-end}.owner-chat-sender{margin:0 3px 5px;font-size:12px;font-weight:600;color:#667085}.owner-chat-bubble{max-width:100%;padding:10px 14px;border:1px solid #e1e6ec;border-radius:5px 16px 16px 16px;background:#fff;box-shadow:0 2px 8px rgba(16,24,40,.04)}.owner-chat-message-row.agent .owner-chat-bubble{border-color:#2563eb;border-radius:16px 5px 16px 16px;background:#2563eb;color:#fff}.owner-chat-body{word-break:break-word;line-height:1.6}.owner-chat-meta{margin-top:5px;color:#98a2b3;font-size:11px}.owner-chat-image{display:block;max-width:min(100%,520px);max-height:420px;border-radius:10px}.owner-chat-file{display:inline-flex;padding:9px 11px;border-radius:9px;background:#f8fafc}.owner-chat-message-row.agent .owner-chat-file{background:rgba(255,255,255,.16);color:#fff}.owner-chat-file-unavailable{color:#8a8f98}.owner-chat-text{margin-top:5px}.owner-chat-readonly-note{padding:12px 18px;border-top:1px solid #e4e7ec;background:#fff;color:#667085;font-size:13px;text-align:center}@media(max-width:640px){.owner-chat-shell{height:calc(100dvh - 145px);min-height:430px;border-radius:12px}.owner-chat-header{padding:9px 10px}.owner-chat-transcript{padding:16px 10px;gap:15px}.owner-chat-avatar{width:34px;height:34px;flex-basis:34px}.owner-chat-message-stack{max-width:calc(100% - 48px)}.owner-chat-readonly-note{padding:10px 12px;font-size:12px}}</style>';
      if(String(req.query.fragment||'')==='owner-chat')return res.send(shell);
      const body=shell+'<style>.owner-chat-image{display:block;max-width:min(100%,520px);max-height:420px;border-radius:8px}.owner-chat-file{display:inline-block}.owner-chat-file-unavailable{color:#8a8f98}.owner-chat-text{margin-top:5px}</style>';
      const fragmentUrl='/agents/'+encodeURIComponent(agentId)+'/owner-chats/'+encodeURIComponent(conversationId)+'?fragment=owner-chat';
      res.send(renderPage(req,T('web.owner_chat.title',{name:agent.agentName||agent.agentId}),body,{showTitle:false,nav:agentNav(agentId,agent.agentName||agent.agentId,T),footer:renderFooter(T,req.locale)+initialLatestScrollScript('.owner-chat-transcript')+ownerChatLiveScript(agentId,'.owner-chat-detail',conversationId,fragmentUrl)}));
    }catch(error){next(error)}
  });

  // ────────── 会话详情 + 发消息 ──────────

  const webRoutingEnabled=name=>isRoutingFeatureEnabled(db,name,true);
  const publicConversation=(conversation,index)=>({
    id:conversation.id,
    label:`Conversation ${index+1}`,
    status:conversation.status,
    origin:conversation.origin,
    parentConversationId:conversation.parentConversationId||null,
    mergeStatus:conversation.mergeStatus,
    createdAt:conversation.createdAt,
    lastUsedAt:conversation.lastUsedAt,
  });

  R.get('/api/routing-conversations',(req,res)=>{
    try{
      const agentId=String(req.query.agentId||''),channelId=String(req.query.channelId||'');
      const channelType=Number(req.query.channelType)===2?2:1;
      if(!agentId||!channelId)return res.status(400).json({success:false,error:'agentId and channelId are required'});
      const rows=routingConversations.listForScope(agentId,channelId,channelType);
      res.json({success:true,conversations:rows.map(publicConversation)});
    }catch(e){res.status(500).json({success:false,error:e.message})}
  });

  R.post('/api/routing-conversations/create',(req,res)=>{
    try{
      if(!webRoutingEnabled('web_private_conversations_v1'))return res.status(404).json({success:false,error:'Feature disabled'});
      const agentId=String(req.body.agentId||''),channelId=String(req.body.channelId||'');
      const channelType=Number(req.body.channelType)===2?2:1;
      if(!agentId||!channelId)return res.status(400).json({success:false,error:'agentId and channelId are required'});
      const parent=req.body.parentConversationId
        ? routingConversations.getForScope(String(req.body.parentConversationId),agentId,channelId,channelType) : null;
      if(req.body.parentConversationId&&!parent)return res.status(403).json({success:false,error:'Parent conversation is outside the current scope'});
      const conversation=routingConversations.createPending({agentId,channelId,channelType,parentConversationId:parent?.id||null});
      res.json({success:true,conversation:publicConversation(conversation,0)});
    }catch(e){res.status(409).json({success:false,error:e.message})}
  });

  R.post('/api/routing-conversations/archive',(req,res)=>{
    try{
      const agentId=String(req.body.agentId||''),channelId=String(req.body.channelId||'');
      const channelType=Number(req.body.channelType)===2?2:1,conversationId=String(req.body.conversationId||'');
      const archived=routingConversations.archive(conversationId,agentId,channelId,channelType);
      res.status(archived?200:404).json({success:archived,error:archived?undefined:'Conversation not found'});
    }catch(e){res.status(500).json({success:false,error:e.message})}
  });

  R.get('/api/messages/:messageId/precise-reply',(req,res)=>{
    try{
      const agentId=String(req.query.agentId||''),channelId=String(req.query.channelId||'');
      const channelType=Number(req.query.channelType)===2?2:1;
      if(channelType===2&&!webRoutingEnabled('web_group_precise_reply_v1'))return res.json({success:true,supported:false,conversationId:null});
      const route=messageRoutes.getByMessage(String(req.params.messageId||''),agentId);
      const conversation=route?.conversation_id
        ? routingConversations.getForScope(route.conversation_id,agentId,channelId,channelType) : null;
      const supported=!!(route&&conversation&&route.status==='active'&&route.channel_id===channelId
        && Number(route.channel_type)===channelType&&(!route.expires_at||Number(route.expires_at)>Date.now()));
      res.json({success:true,supported,conversationId:supported?conversation.id:null});
    }catch(e){res.status(500).json({success:false,error:e.message})}
  });

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
      const webConversations=webRoutingEnabled('web_private_conversations_v1')
        ? routingConversations.listForScope(agentId,channelId,1).slice().sort((a,b)=>(Number(a.createdAt)||0)-(Number(b.createdAt)||0)||String(a.id).localeCompare(String(b.id))) : [];
      const requestedConversation=String(req.query.conversationId||'');
      const pendingConversation=webConversations.find(c=>c.status==='pending')||null;
      const allMessages=md.messages||[];
      const routeForMessage=m=>{
        const messageId=m.messageId||m.id;
        return messageId?messageRoutes.getByMessage(String(messageId),agentId):null;
      };
      const unboundMessageCount=allMessages.reduce((count,m)=>count+(routeForMessage(m)?.conversation_id?0:1),0);
      const newestMessageConversation=allMessages.map(m=>routeForMessage(m)?.conversation_id||'')
        .find(id=>webConversations.some(c=>c.id===id));
      const selectedConversation=webConversations.find(c=>c.id===requestedConversation)
        ||webConversations.find(c=>c.id===newestMessageConversation)
        ||webConversations[0]||null;
      const hasLegacyConversation=unboundMessageCount>0;
      const showLegacyHistory=req.query.history==='1'||(hasLegacyConversation&&webConversations.length===0);
      let msgs=allMessages;
      if(selectedConversation||showLegacyHistory){
        msgs=msgs.filter(m=>{
          const route=routeForMessage(m);
          if(showLegacyHistory)return !route?.conversation_id;
          return route?.conversation_id===selectedConversation.id;
        });
      }
      let conversationTabs='';
      if(webRoutingEnabled('web_private_conversations_v1')){
        const conversationPageSize=10,conversationTotalPages=Math.max(1,Math.ceil(webConversations.length/conversationPageSize)),selectedConversationIndex=selectedConversation?webConversations.findIndex(c=>c.id===selectedConversation.id):-1,conversationPage=Math.min(Math.max(1,parseInt(String(req.query.conversationPage||''),10)||(selectedConversationIndex>=0?Math.floor(selectedConversationIndex/conversationPageSize)+1:1)),conversationTotalPages),pageConversations=webConversations.slice((conversationPage-1)*conversationPageSize,conversationPage*conversationPageSize);
        const legacyConversationOffset=hasLegacyConversation?1:0;
        const cards=pageConversations.map(c=>'<a class="conversation-tab-card'+(selectedConversation?.id===c.id&&!showLegacyHistory?' active':'')+'" role="tab" aria-selected="'+(selectedConversation?.id===c.id&&!showLegacyHistory)+'" href="/agents/'+esc(agentId)+'/c/'+esc(channelId)+'?conversationId='+encodeURIComponent(c.id)+'&conversationPage='+conversationPage+'">'+esc(T('web.conversation.tab.label',{index:webConversations.indexOf(c)+1+legacyConversationOffset}))+'</a>').join('');
        const history=hasLegacyConversation?'<a class="conversation-tab-card'+(showLegacyHistory?' active':'')+'" role="tab" aria-selected="'+showLegacyHistory+'" href="/agents/'+esc(agentId)+'/c/'+esc(channelId)+'?history=1">'+esc(T('web.conversation.tab.label',{index:1}))+'</a>':'';
        const newConversationLabel=pendingConversation?L('web.conversation.action.continue_pending'):L('web.conversation.action.new');
        const conversationBase='/agents/'+esc(agentId)+'/c/'+esc(channelId)+'?conversationPage=';
        conversationTabs='<style>'+CONVERSATION_TAB_CSS+'</style><div class="conversation-tab-shell">'+(conversationPage>1?'<a class="conversation-tab-arrow" id="conversation-tabs-prev" aria-label="'+esc(T('web.payments.prev_page'))+'" href="'+conversationBase+(conversationPage-1)+'">‹</a>':'<span class="conversation-tab-arrow" aria-disabled="true">‹</span>')+'<div class="conversation-tab-rail" id="conversation-tab-rail" role="tablist">'+history+cards+'<button type="button" id="new-conversation" data-pending-conversation="'+esc(pendingConversation?.id||'')+'" class="conversation-tab-card conversation-tab-new">＋ '+newConversationLabel+'</button></div>'+(conversationPage<conversationTotalPages?'<a class="conversation-tab-arrow" id="conversation-tabs-next" aria-label="'+esc(T('web.payments.next_page'))+'" href="'+conversationBase+(conversationPage+1)+'">›</a>':'<span class="conversation-tab-arrow" aria-disabled="true">›</span>')+'</div>';
      }
      const pendingHint=selectedConversation?.status==='pending'
        ? '<p id="pending-conversation-hint" class="pending" style="margin:0 0 10px;padding:8px 12px;border-radius:6px;background:#fef7e0">'+L('web.conversation.pending_hint')+'</p>' : '';
      let mh='<p class="meta">'+L('web.conversation.no_messages')+'</p>';const jd=[];
      if(msgs.length){mh='';const s=[...msgs].reverse();for(const m of s){const sr=m.isMe?L('web.conversation.from.agent'):peerLabel;const t=timeTag(m.timestamp);if(m.contentType===11){const audit=parseAuditContent(m.content);mh+=renderAuditContent(m.content,T,t);jd.push({from:'system',content:audit.valid?audit.text:T('web.audit.message_invalid'),timestamp:m.timestamp});continue;}const c=messageRenderer.render(m.contentType,m.content);mh+='<div style="padding:8px 12px;margin:4px 0;border-radius:6px;border-left:4px solid '+(m.isMe?'#0f9d58':'#1a73e8')+';background:'+(m.isMe?'#e6f4ea':'#e8f0fe')+'"><strong>'+esc(sr)+'</strong> <span style="color:#888;font-size:13px">['+t+']</span><br>'+c+'</div>';jd.push({from:m.isMe?'agent':'visitor',content:m.content,timestamp:m.timestamp})}}
      const renderedMessageIds=Object.fromEntries(msgs.map(m=>String(m.messageId||m.id||'')).filter(Boolean).map(id=>[id,1]));
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
      const conversationControlScript='<script>(function(){var aid='+jsonForInlineScript(agentId)+',cid='+jsonForInlineScript(channelId)+',selected='+jsonForInlineScript(selectedConversation?.id||'')+',parent='+jsonForInlineScript(showLegacyHistory?'':selectedConversation?.id||'')+',draftLabel='+jsonForInlineScript(T('web.conversation.tab.label',{index:webConversations.length+(hasLegacyConversation?1:0)+1}))+',noMessages='+jsonForInlineScript(T('web.conversation.no_messages'))+',zeroCount='+jsonForInlineScript(T('web.conversation.count_msg',{count:0}))+';function conversationUrl(id){return "/agents/"+encodeURIComponent(aid)+"/c/"+encodeURIComponent(cid)+"?conversationId="+encodeURIComponent(id)}var rail=document.getElementById("conversation-tab-rail"),prev=document.getElementById("conversation-tabs-prev"),next=document.getElementById("conversation-tabs-next"),create=document.getElementById("new-conversation");function focusInput(){var input=document.getElementById("c");if(input)input.focus()}function activateDraft(){if(document.getElementById("conversation-draft-tab")){focusInput();return}if(rail)rail.querySelectorAll(".conversation-tab-card.active").forEach(function(tab){tab.classList.remove("active");tab.setAttribute("aria-selected","false")});var draft=document.createElement("button");draft.type="button";draft.id="conversation-draft-tab";draft.className="conversation-tab-card active";draft.setAttribute("role","tab");draft.setAttribute("aria-selected","true");draft.textContent=draftLabel;draft.onclick=focusInput;if(create&&create.parentNode)create.parentNode.insertBefore(draft,create);var box=document.getElementById("msg-box");if(box){box.textContent="";var empty=document.createElement("p");empty.className="meta";empty.textContent=noMessages;box.appendChild(empty)}var count=document.getElementById("msg-count");if(count)count.textContent=zeroCount;var hint=document.getElementById("pending-conversation-hint");if(hint)hint.style.display="none";var conversation=document.getElementById("web-conversation-id"),start=document.getElementById("web-conversation-start"),parentInput=document.getElementById("web-parent-conversation-id"),reply=document.getElementById("reply-to-message-id");if(conversation)conversation.value="";if(start)start.value="1";if(parentInput)parentInput.value=parent;if(reply)reply.value="";window.__vokoConversationDraftActive=true;if(draft.scrollIntoView)draft.scrollIntoView({inline:"center",block:"nearest"});focusInput();state()}if(create)create.onclick=function(){var pending=create.getAttribute("data-pending-conversation");if(pending){location.href=conversationUrl(pending);return}activateDraft()};function state(){if(!rail)return;var max=Math.max(0,rail.scrollWidth-rail.clientWidth);if(prev)prev.disabled=rail.scrollLeft<2;if(next)next.disabled=rail.scrollLeft>=max-2}function move(dir){if(rail)rail.scrollBy({left:dir*Math.max(180,rail.clientWidth*.7),behavior:"smooth"})}if(prev)prev.onclick=function(){move(-1)};if(next)next.onclick=function(){move(1)};if(rail){rail.addEventListener("scroll",state,{passive:true});window.addEventListener("resize",state);var active=rail.querySelector(".conversation-tab-card.active");if(active)active.scrollIntoView({inline:"center",block:"nearest"});state()}})();</script>';
      const initialMessageScrollScript=initialLatestScrollScript('#msg-box');
      const payBtn=hasPricing&&hasPaymentAuth?'<a href=\"/payments?action=create&agentId='+aId2+'&visitorId='+cId2+'&conversationId='+encodeURIComponent(selectedConversation?.id||'')+'\" class=\"op-card\" data-agent-kind=\"link\" data-agent=\"nav_card\">'+L('web.conversation.pay.create')+'</a>':'<span class=\"op-card\" style=\"color:#aaa;cursor:not-allowed;opacity:0.6\" title=\"'+esc(T(hasPaymentAuth?'web.conversation.pay.unconfigured_title':'web.conversation.pay.card_required_title'))+'\">'+L('web.conversation.pay.create')+'</span>';res.send(renderPage(req,T('web.conversation.title',{id:titleId}),
conversationTabs+pendingHint+'<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px"><span class="meta" id="msg-count">'+T('web.conversation.count_msg',{count:msgs.length})+'</span></div>'
+'<div id="msg-box" style="max-height:50vh;overflow-y:auto;border:1px solid #e0e0e0;padding:12px;border-radius:6px;background:#fff;margin-bottom:10px">'+mh+'</div>'
 +'<div id="delivery-status" class="meta" data-agent-id="'+aId2+'" data-channel-id="'+cId2+'" role="status" aria-live="polite" style="display:none;margin:6px 0 10px"></div>'
 +'<div class="card" id="reply" style="'+replyStyle+'"><h3>'+L('web.conversation.reply_title')+'</h3><form method="POST" action="/messages/send" data-submit-lock="1" data-submit-label="'+L('web.conversation.sending')+'"><input type="hidden" name="agentId" value="'+aId2+'"><input type="hidden" name="toUid" value="'+cId2+'"><input type="hidden" name="channelType" value="1"><input type="hidden" name="conversationId" id="web-conversation-id" value="'+esc(selectedConversation?.id||'')+'"><input type="hidden" name="webConversationStart" id="web-conversation-start" value="0"><input type="hidden" name="parentConversationId" id="web-parent-conversation-id" value=""><input type="hidden" name="replyToMessageId" id="reply-to-message-id" value=""><label for="c">'+L('web.conversation.label.content')+'</label><div class="voko-compose-row"><input type="text" id="c" name="content" required autocomplete="off" autofocus><button type="submit" class="voko-send-button" data-agent="send_msg_btn">'+L('common.btn.send')+'</button></div></form></div>'
 +'<div class="card"><h3>'+L('web.conversation.visitor_ops')+'</h3><div class="ops" style="grid-template-columns:repeat(auto-fill,minmax(140px,1fr))"><a href="/agents/'+aId2+'/visitor?uid='+cId2+'" class="op-card" data-agent-kind="link" data-agent="nav_card">'+L('web.conversation.op.profile')+'</a>'+wlBtn+''+blBtn+'<a href="/agents/'+aId2+'/human?visitorId='+cId2+'&conversationId='+encodeURIComponent(selectedConversation?.id||'')+'" class="op-card" data-agent-kind="link" data-agent="nav_card">'+L('web.conversation.op.human')+'</a><a href="/agents/'+aId2+'/upload?toUid='+encodeURIComponent(channelId)+'&channelType=1&conversationId='+encodeURIComponent(selectedConversation?.id||'')+'" class="op-card" data-agent-kind="link" data-agent="nav_card">'+L('web.conversation.op.upload')+'</a>'+payBtn+'</div></div><a href="/agents/'+aId2+'">'+T('web.conversation.back',{name:aName})+'</a>'+conversationControlScript+initialMessageScrollScript,
{nav:agentNav(agentId,aName,T)+' › '+navId,jsonld:{'@context':'https://schema.org',agentId,channelId,messages:jd},footer:renderFooter(T, req.locale)+messageRendererScript(T)+'<script>(function(){var b=document.getElementById("msg-box");if(b)b.scrollTop=b.scrollHeight;})();</script>'+'<script>var _A='+jsonForInlineScript(agentId)+',_C='+jsonForInlineScript(channelId)+',_R='+jsonForInlineScript({agent:T('web.conversation.from.agent'),visitor:peerLabel,no_msg:T('web.conversation.no_messages'),count_msg:T('web.conversation.count_msg'),auditIn:T('web.audit.message_inbound'),auditOut:T('web.audit.message_outbound'),auditBlocked:T('web.audit.message_blocked'),auditAllowed:T('web.audit.message_allowed'),auditKeyword:T('web.audit.message_keyword'),auditOriginal:T('web.audit.message_original'),auditInvalid:T('web.audit.message_invalid')})+',_seen='+jsonForInlineScript(renderedMessageIds)+';'+"(function(){function _esc(s){return String(s==null?\"\":s).replace(/[&<>\"']/g,function(c){return{\"&\":\"&amp;\",\"<\":\"&lt;\",\">\":\"&gt;\",'\"':\"&quot;\",\"'\":\"&#39;\"}[c]})}function _audit(ct,t){try{var d=JSON.parse(ct),out=d.direction===\"outbound\"||(!d.direction&&String(d.audit||\"\").indexOf(\"出站\")>=0),title=out?_R.auditOut:_R.auditIn,result=d.action===\"hard_deny\"?_R.auditBlocked:_R.auditAllowed,rows=\"\";if(d.keyword)rows+='<div class=\"audit-message-row\"><span>'+_esc(_R.auditKeyword)+\"</span>\"+_esc(d.keyword)+\"</div>\";if(d.text)rows+='<div class=\"audit-message-row\"><span>'+_esc(_R.auditOriginal)+\"</span>\"+_esc(d.text).replace(/\\n/g,\"<br>\")+\"</div>\";return '<div class=\"audit-message\"><div class=\"audit-message-head\"><strong>'+_esc(title)+'</strong><span class=\"audit-message-result\">'+_esc(result)+'</span><span class=\"meta\">'+_esc(t)+\"</span></div>\"+rows+\"</div>\"}catch(_){return '<div class=\"audit-message\"><strong>'+_esc(_R.auditInvalid)+'</strong> <span class=\"meta\">'+_esc(t)+\"</span></div>\"}}function _addMsg(m){var bx=document.getElementById(\"msg-box\"),isMe=m.isMe===true||m.isMe===1,sr=isMe?_R.agent:_R.visitor,t=new Date((m.timestamp||0)*1000).toLocaleTimeString(),ct=(m.content||\"\"),h;if(m.contentType===11){h=_audit(ct,t)}else{var bc=isMe?\"#0f9d58\":\"#1a73e8\",bg=isMe?\"#e6f4ea\":\"#e8f0fe\";h='<div style=\"padding:8px 12px;margin:4px 0;border-radius:6px;border-left:4px solid '+bc+';background:'+bg+'\"><strong>'+_esc(sr)+'</strong> <span style=\"color:#888;font-size:13px\">['+_esc(t)+']</span><br>'+window.__vokoMessageRenderer.render(m.contentType,ct)+\"</div>\"}bx.insertAdjacentHTML(\"beforeend\",h);bx.scrollTop=bx.scrollHeight;var mc=document.getElementById(\"msg-count\");if(mc){mc.textContent=_R.count_msg.replace(\"{count}\",bx.children.length)}}function _connect(){try{var ws=new WebSocket(\"ws://\"+location.host+\"/ws\");ws.onmessage=function(e){try{var d=JSON.parse(e.data);if(d.event===\"agent-wukongim:message\"){var m=d.data;if(m.agentId===_A&&m.channelId===_C&&m.messageId&&!_seen[m.messageId]){_seen[m.messageId]=1;_addMsg(m)}}}catch(_){}};ws.onclose=function(){setTimeout(_connect,3000)}}catch(_){setTimeout(_connect,5000)}}_connect()})();"+'</script>'}))
    }catch(e){next(e)}
  });

  // 群详情 / 建群 / 群操作 已迁至 web/group.js（createGroupRouter）

  // 标记会话已读：UI 按钮已移除，handler 保留并通过 /api/console + /api/handlers 暴露给 agent

  R.post('/messages/send',async(req,res,next)=>{
    try{
      const{agentId,toUid,content,channelType,conversationId,replyToMessageId,validateRecipientUid,
        webConversationStart,parentConversationId}=req.body;
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
          if(group&&group.success===false)throw new Error(group.error||req.t('common.action.failed'));
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
      if(validateRecipientUid==='1'&&Number(channelType||1)!==2){
        try{
          const recipient=await validateImUidExists(toUid);
          if(!recipient.exists){
            const error=req.t('web.send_message.uid_not_found');
            if(req.is('json'))return res.status(404).json({success:false,error,code:'RECIPIENT_NOT_FOUND'});
            return res.status(404).send(renderPage(req,req.t('web.send_message.title'),'<p class="error">'+esc(error)+'</p><a href="/send-message?agentId='+encodeURIComponent(agentId)+'&toUid='+encodeURIComponent(toUid)+'">'+esc(req.t('common.btn.back'))+'</a>'));
          }
        }catch(_){
          const error=req.t('web.send_message.uid_check_failed');
          if(req.is('json'))return res.status(503).json({success:false,error,code:'RECIPIENT_CHECK_UNAVAILABLE'});
          return res.status(503).send(renderPage(req,req.t('web.send_message.title'),'<p class="error">'+esc(error)+'</p><a href="javascript:history.back()">'+esc(req.t('common.btn.back'))+'</a>'));
        }
      }
      const r=await handlers.send_message({agentId,toUid,content,channelType:channelType?Number(channelType):undefined,mentions,conversationId,replyToMessageId,
        webRequest:Number(channelType)!==2&&webRoutingEnabled('web_private_conversations_v1'),
        webConversationStart:webConversationStart==='1',parentConversationId:String(parentConversationId||'')||undefined});
      if(req.is('json'))return res.status(r.success===false?400:200).json(r.success!==false?{
        success:true,messageId:r.messageId,messageSeq:r.messageSeq,
        conversationId:r.conversationId||null,conversationStatus:r.conversationStatus||null,
        conversationDisposition:r.conversationDisposition||null,mergedIntoConversationId:r.mergedIntoConversationId||null,
      }:{success:false,error:r.error||'Send failed',code:r.code});
      const selectedQuery=r.conversationId?'&conversationId='+encodeURIComponent(r.conversationId):'';
      r.success?res.redirect('/agents/'+esc(agentId)+'/c/'+esc(toUid)+'?ok='+encodeURIComponent('消息已发送')+selectedQuery):res.send(renderPage(req,'发送失败','<p class="error">❌ '+esc(r.error||'未知错误')+'</p><a href="/agents/'+esc(agentId)+'/c/'+esc(toUid)+'">返回</a>'))
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
      let currentType='',currentInstanceId='';
      if(req.query.agentId){
        try{const row=db.prepare('SELECT backend_type, backend_instance_id FROM agents WHERE agent_id=?').get(String(req.query.agentId));currentType=String(row?.backend_type||'');currentInstanceId=String(row?.backend_instance_id||'');}catch(_){}
      }
      if(currentType){
        const instanceCapable=supportsProviderInstances(currentType);
        let currentInstances=[];
        if(instanceCapable){
          if(currentInstanceId)currentInstances=[{id:currentInstanceId,name:currentInstanceId}];
          else currentInstances=discoverProviderInstances(currentType);
        }
        return res.json({success:true,types:types.map(t=>({
          value:t.value,label:t.value==='others'?T('db.backend_type.others'):t.label,
          instanceTerm:getProviderInstanceTerm(t.value),
          detected:t.value===currentType,instanceCapable:supportsProviderInstances(t.value),
          instances:t.value===currentType?currentInstances:[],currentInstanceId:t.value===currentType?currentInstanceId:null,
        }))});
      }
      let detected=new Set();
      let environment={detected:[]};
      try{environment=createRegistrationOrchestrator({db}).inspectEnvironment();detected=new Set(environment.detected.map(x=>x.type));}catch(_){}
      res.json({success:true,types:types.map(t=>{
        const provider=environment.detected.find(x=>x.type===t.value);
        const instanceCapable=supportsProviderInstances(t.value);
        const instances=t.value==='workbuddy'?discoverWorkBuddyAgents():(provider?.instances||[]);
        return {value:t.value,label:t.value==='others'?T('db.backend_type.others'):t.label,instanceTerm:getProviderInstanceTerm(t.value),detected:detected.has(t.value),instanceCapable,instances:instanceCapable?instances:[],currentInstanceId:currentType===t.value?currentInstanceId:null};
      })});
    }catch(e){res.status(500).json({success:false,error:e.message})}
  });

  R.get('/agents/:agentId/edit',async(req,res,next)=>{
    try{
      const T=req.t,L=k=>esc(T(k));
      const{agentId}=req.params;
      let p={};
      try{const r=await handlers.get_agent_profile({agentId});if(r.success)p=r.data||{};else p={}}catch{}
      // 回退：从 whoami 获取基本数据（agent 可能不在本地 DB）
      if(!p.agentId){try{const w=await handlers.list_agents({limit:500});const a=(w.agents||[]).find(x=>x.agentId===agentId);if(a)p={agentId:a.agentId,agentName:a.agentName,backendType:a.backendType,backendInstanceId:a.backendInstanceId,category:a.category,description:a.description,shortDescription:a.shortDescription,iconUrl:a.iconUrl,contactPhone:a.contactPhone,address:a.address,tags:a.tags}}catch{}}
      try{const row=db.prepare('SELECT backend_instance_id FROM agents WHERE agent_id=?').get(agentId);if(row?.backend_instance_id)p.backendInstanceId=row.backend_instance_id;else if(p.backendInstanceId===undefined)p.backendInstanceId=null}catch{}
      const aname=p.agentName||agentId;
      let catList=[];
      try{const resp=await fetch(VOKO_API_URL+'/api/agent-categories');const d=await resp.json();if(d.success&&Array.isArray(d.data))catList=d.data;}catch(_){}
      if(!catList.length)catList=[{code:'general'},{code:'other'}];
      const catOpts=catList.map(c=>{const key='db.agent.category.'+c.code;const lbl=T(key);const label=lbl!==key?lbl:(c.label||c.code);return '<option value="'+esc(c.code)+'"'+(p.category===c.code?' selected':'')+'>'+esc(label)+'</option>';}).join('');
      const btTypes=getBackendTypes(db);const knownVals=getBackendTypeValues(db);
      var btInitValue='',btInitText=T('web.agent.edit.select_backend_type');
      if(p.backendType&&knownVals.includes(p.backendType)){var tm=btTypes.find(function(x){return x.value===p.backendType});btInitValue=p.backendType;btInitText=tm?(tm.value==='others'?T('db.backend_type.others'):tm.label):p.backendType;}
      else if(p.backendType){btInitValue=p.backendType;btInitText=T('db.backend_type.others');}
      const f=function(l,id,v,attr){return '<div><label for="'+id+'">'+esc(l)+'</label><input type="text" id="'+id+'" name="'+id+'" value="'+esc(v||'')+'" '+(attr||'')+'></div>'};
      const instanceField='<div id="bt-instance-field" style="display:'+(supportsProviderInstances(btInitValue)?'block':'none')+';margin-top:8px;padding:10px 12px;border:1px solid #dfe4ec;border-left:3px solid #a7c0f4;border-radius:8px;background:#fafcff;max-width:460px">'
        +'<label for="bt-instance" id="bt-instance-label">'+esc(getProviderInstanceTerm(btInitValue))+'</label>'
        +'<div style="display:flex;align-items:flex-end;gap:8px"><select id="bt-instance" style="flex:1;min-width:0;margin:3px 0 0" disabled><option value="">'+L('web.agent.edit.instances_loading')+'</option></select>'
        +'<input type="hidden" id="bt-instance-value"'+(p.backendInstanceId?' name="backendInstanceId"':'')+' value="'+esc(p.backendInstanceId||'')+'">'
        +(p.backendInstanceId?'':'<button type="button" class="btn-sm" id="bt-bind-once" style="flex:none">绑定</button>')
        +'</div>'+(p.backendInstanceId?'':'<span class="meta" id="bt-bind-status"></span>')
        +'</div>';
      const backendField='<div class="edit-backend-details" style="display:flex;flex-direction:column;height:100%"><label for="bt-readonly">'+T('web.agent.edit.backend_type')+'</label>'
        +'<input id="bt-readonly" value="'+esc(btInitText)+'" readonly style="background:#f2f4f7;color:#98a2b3;cursor:not-allowed">'
        +'<input type="hidden" id="bt" name="backendType" value="'+esc(btInitValue)+'">'
        +instanceField+'<div class="edit-contact-details" style="margin-top:auto">'
        +f(T('web.agent.edit.phone'),'contact_phone',p.contactPhone)
        +f(T('web.agent.edit.address'),'address',p.address)
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
      const profileDetailsField='<div class="edit-profile-details" style="display:flex;flex-direction:column;height:100%">'
        +f(T('web.agent.edit.short_desc'),'short_description',p.shortDescription)
        +f(T('web.agent.edit.tags'),'tags',Array.isArray(p.tags)?p.tags.join(', '):(p.tags||''),'placeholder="'+esc(T('web.agent.edit.tags_ph'))+'"')
        +iconField+'</div>';
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
        +profileDetailsField
        +'<div class="full" style="display:flex;gap:10px;align-items:center;margin-top:4px"><button type="submit">'+L('common.btn.save')+'</button>'
        +'<span class="meta">'+T('web.agent.edit.sync_hint')+'</span></div>'
        +'</form>'
        +'<script>(function(){'
        +'var w=document.getElementById("bt-wrapper"),tr=document.getElementById("bt-trigger"),dd=document.getElementById("bt-dropdown"),bs=document.getElementById("bt-search"),bt=document.getElementById("bt"),tx=document.getElementById("bt-text"),oc=document.getElementById("bt-options"),ifield=document.getElementById("bt-instance-field"),ilabel=document.getElementById("bt-instance-label"),isel=document.getElementById("bt-instance"),ivalue=document.getElementById("bt-instance-value");'
         +'var all=[],loaded=false,loading=false,backendTypes=[],INSTANCE_TYPES={openclaw:true,hermes:true,zeroclaw:true,workbuddy:true,opencode:true,"github-copilot":true,"claude-code":true,codex:true,kiro:true},TXT_NO_MATCH='+jsonForInlineScript(T('web.agent.edit.no_match'))+',TXT_LOADING='+jsonForInlineScript(T('web.agent.edit.types_loading'))+',TXT_FAILED='+jsonForInlineScript(T('web.agent.edit.types_load_failed'))+',TXT_LOCAL='+jsonForInlineScript(T('register.flow.provider.local'))+',TXT_MORE='+jsonForInlineScript(T('register.flow.provider.more'))+',TXT_INSTANCE_LOADING='+jsonForInlineScript(T('web.agent.edit.instances_loading'))+',TXT_INSTANCE_NONE='+jsonForInlineScript(T('web.agent.edit.instances_none'))+',TXT_INSTANCE_STALE='+jsonForInlineScript(T('web.agent.edit.instance_stale'))+',AGENT_ID='+jsonForInlineScript(agentId)+',INITIAL_TYPE='+jsonForInlineScript(p.backendType||'')+',INITIAL_INSTANCE='+jsonForInlineScript(p.backendInstanceId||'')+';'
        +'function esc3(s){return String(s==null?"":s).replace(/[&<>"\']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",\'"\':"&quot;","\'":"&#39;"}[c]})}'
        +'function renderInstance(){if(!ifield||!isel||!ivalue)return;if(!backendTypes.length){if(!INSTANCE_TYPES[bt.value]){ifield.style.display="none";isel.disabled=true;ivalue.value="";}return;}var item=backendTypes.find(function(x){return x.value===bt.value});if(ilabel)ilabel.textContent=item&&item.instanceTerm||"Instance";var capable=!!(item&&INSTANCE_TYPES[item.value]);if(!capable){ifield.style.display="none";isel.disabled=true;isel.innerHTML="";ivalue.value="";return}var instances=(item.instances||[]).slice(),current=item.currentInstanceId||(bt.value===INITIAL_TYPE?INITIAL_INSTANCE:"");if(current&&!instances.some(function(x){return String(x.id)===String(current)}))instances.push({id:current,name:current,stale:true});if(!instances.length){ifield.style.display="none";isel.disabled=true;isel.innerHTML=\'<option value="">\'+esc3(TXT_INSTANCE_NONE)+"</option>";return}ifield.style.display="block";isel.innerHTML=instances.map(function(x){var id=String(x.id||""),label=String(x.name||id)+(x.stale?" ("+TXT_INSTANCE_STALE+")":"");return \'<option value="\'+esc3(id)+\'">\'+esc3(label)+"</option>"}).join("");if(current)isel.value=current;if(!isel.value)isel.selectedIndex=0;ivalue.value=isel.value||"";isel.disabled=!!INITIAL_INSTANCE}'
        +'function loadInstanceTypes(){fetch("/api/agent-backend-types?agentId="+encodeURIComponent(AGENT_ID),{headers:{Accept:"application/json"}}).then(function(r){return r.ok?r.json():null}).then(function(j){if(j&&j.success){backendTypes=j.types||[];renderInstance()}}).catch(function(){})}'
        +'function loadTypes(){if(loaded||loading)return;loading=true;oc.innerHTML=\'<div class="voko-option voko-option-empty">\'+esc3(TXT_LOADING)+"</div>";fetch("/api/agent-backend-types",{headers:{Accept:"application/json"}}).then(function(r){if(!r.ok)throw new Error("load failed");return r.json()}).then(function(j){if(!j.success)throw new Error(j.error||"load failed");var local=j.types.filter(function(x){return x.detected}),more=j.types.filter(function(x){return !x.detected});function opts(xs){return xs.map(function(x){return \'<div class="voko-option" data-value="\'+esc3(x.value)+\'">\'+esc3(x.label)+"</div>"}).join("")}oc.innerHTML=(local.length?\'<div class="voko-option-group">\'+esc3(TXT_LOCAL)+"</div>"+opts(local):"")+\'<div class="voko-option-group">\'+esc3(TXT_MORE)+"</div>"+opts(more);all=Array.from(oc.querySelectorAll(".voko-option:not(.voko-option-empty)"));loaded=true}).catch(function(){oc.innerHTML=\'<div class="voko-option voko-option-empty">\'+esc3(TXT_FAILED)+"</div>"}).finally(function(){loading=false})}'
        +'function open(){dd.style.display="block";loadTypes();bs.focus();}'
        +'function close(){dd.style.display="none";bs.value="";all.forEach(function(o){o.style.display="";});var h=oc.querySelector(".voko-option-empty");if(h)h.remove();}'
        +'if(tr&&dd){tr.addEventListener("click",function(e){e.stopPropagation();if(dd.style.display==="block")close();else open();});}'
        +'if(bs&&oc){bs.addEventListener("input",function(){var q=bs.value.toLowerCase(),hm=false;all.forEach(function(o){if(!q||o.textContent.toLowerCase().indexOf(q)!==-1){o.style.display="";hm=true;}else{o.style.display="none";}});var h=oc.querySelector(".voko-option-empty");if(!hm&&q){if(!h){h=document.createElement("div");h.className="voko-option voko-option-empty";h.textContent=TXT_NO_MATCH;oc.appendChild(h);}}else if(h){h.remove();}});bs.addEventListener("click",function(e){e.stopPropagation();});}'
        +'if(oc){oc.addEventListener("click",function(e){var opt=e.target.closest(".voko-option");if(!opt||opt.classList.contains("voko-option-empty"))return;ivalue.value="";bt.value=opt.getAttribute("data-value");tx.textContent=opt.textContent;renderInstance();close();});}'
        +'if(isel){isel.addEventListener("change",function(){ivalue.value=isel.value||"";});}'
        +'if(bs){bs.addEventListener("keydown",function(e){if(e.key==="Escape"){close();tr.focus();}});}'
        +'if(tr){tr.addEventListener("keydown",function(e){if(e.key==="Enter"||e.key===" "){e.preventDefault();open();}});}'
        +'document.addEventListener("click",function(e){if(w&&!w.contains(e.target))close();});'
        +'var bindOnce=document.getElementById("bt-bind-once"),bindStatus=document.getElementById("bt-bind-status");if(bindOnce){bindOnce.addEventListener("click",function(){var instanceId=isel&&isel.value||"";if(!instanceId)return;bindOnce.disabled=true;if(bindStatus)bindStatus.textContent="Binding...";fetch("/api/agents/"+encodeURIComponent(AGENT_ID)+"/action",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({_action:"bind_instance_once",backendInstanceId:instanceId})}).then(function(r){return r.json().then(function(j){if(!r.ok||!j.success)throw new Error(j.error||"Bind failed");return j})}).then(function(){location.reload()}).catch(function(e){bindOnce.disabled=false;if(bindStatus)bindStatus.textContent=e.message||"Bind failed"})})}'
        +'loadInstanceTypes();renderInstance();if(INITIAL_INSTANCE&&isel)isel.disabled=true;'
        +'})();(function(){var b=document.getElementById("agent-icon-button"),f=document.getElementById("agent-icon-file"),img=document.getElementById("agent-icon-preview"),hidden=document.getElementById("iconUrl"),status=document.getElementById("agent-icon-status");if(!b||!f)return;var aid='+jsonForInlineScript(agentId)+',fallback="/favicon.png";function setStatus(text,kind){status.textContent=text||"";status.className="agent-icon-status"+(kind?" "+kind:"")}b.addEventListener("click",function(){if(!b.disabled)f.click()});f.addEventListener("change",function(){var file=f.files&&f.files[0];if(file)upload(file)});async function upload(file){var allowed=["image/png","image/jpeg","image/webp","image/gif"];if(allowed.indexOf(file.type)===-1){setStatus('+jsonForInlineScript(T('web.agent.edit.icon_invalid'))+',"error");f.value="";return}if(file.size>500*1024){setStatus('+jsonForInlineScript(T('web.agent.edit.icon_too_large'))+',"error");f.value="";return}var previous=hidden.value||fallback,preview=URL.createObjectURL(file);img.src=preview;b.disabled=true;setStatus('+jsonForInlineScript(T('web.agent.edit.icon_uploading'))+',"pending");var fd=new FormData();fd.append("file",file,file.name);try{var r=await fetch("/api/agents/"+encodeURIComponent(aid)+"/icon",{method:"POST",body:fd});var j=await r.json();if(!r.ok||!j.success)throw new Error(j.error||'+jsonForInlineScript(T('web.agent.edit.icon_upload_failed'))+');hidden.value=j.iconUrl;var u=new URL(j.iconUrl,location.href);u.searchParams.set("_v",Date.now());img.src=u.href;setStatus('+jsonForInlineScript(T('web.agent.edit.icon_updated'))+',"success")}catch(e){img.src=previous;setStatus(e.message||'+jsonForInlineScript(T('web.agent.edit.icon_upload_failed'))+',"error")}finally{URL.revokeObjectURL(preview);b.disabled=false;f.value=""}}})();</script>'
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

  // ── 外部展现范围（与访客白名单访问模式分离）──
  R.get('/agents/:agentId/visibility',async(req,res,next)=>{
    try{
      const T=req.t;
      const{agentId}=req.params;const agent=await getAgentInfo(handlers,agentId);if(!agent)return res.redirect('/');
      const raw=Number(agent.visibilityType);const visibility=[0,1,2].includes(raw)?raw:0;
      res.send(renderAgentFormPage(T('web.agent.visibility.title'),agentId,agent.agentName||agentId,
        '<p class="meta">'+esc(T('web.agent.visibility.hint'))+'</p>'+actionForm(agentId,'set_visibility',[
          {id:'av',name:'visibility',label:T('web.agent.visibility.label'),type:'select',options:{0:T('web.agent.visibility.private_opt'),1:T('web.agent.visibility.public_opt'),2:T('web.agent.visibility.hidden_opt')},val:String(visibility)},
        ],T('common.btn.save'),null,'agent.visibility.set'),req.t,req.locale));
    }catch(e){next(e)}
  });

  // ── 订阅 ──
  R.get('/agents/:agentId/pricing',async(req,res,next)=>{
    try{
      const T=req.t;
      const{agentId}=req.params;const agent=await getAgentInfo(handlers,agentId);if(!agent)return res.redirect('/');
      const paymentAuth=getAgentPaymentAuth(db,agentId),hasPaymentAuth=!!paymentAuth;
      let p={pricingModel:'free',price:null,durationMinutes:null,trialMinutes:3};
      try{const pr=await handlers.agent_pricing({agentId});if(pr.pricingModel)p=pr}catch{}
      const displayModel=req.query.mode==='timed'?'timed':p.pricingModel;
      const displayDuration=pricingDurationDisplay(p.durationMinutes);
      const curLabel=p.pricingModel==='free'?T('web.agent.pricing.free'):T('web.agent.pricing.paid',{price:p.price,duration:p.durationMinutes});
      const unitLabels={minute:T('web.agent.pricing.unit_minute'),hour:T('web.agent.pricing.unit_hour'),day:T('web.agent.pricing.unit_day'),week:T('web.agent.pricing.unit_week'),month:T('web.agent.pricing.unit_month')};
      const unitOptions=Object.entries(unitLabels).map(function([unit,label]){return'<option value="'+unit+'"'+(displayDuration.unit===unit?' selected':'')+'>'+esc(label)+'</option>'}).join('');
      const paymentReturn='/agents/'+agentId+'/pricing?mode=timed',paymentLink='/agents/'+esc(agentId)+'/payment-auth?returnTo='+encodeURIComponent(paymentReturn);
      const paymentWarning=!hasPaymentAuth?'<div id="pricing-payment-required" style="margin-top:8px;padding:9px 12px;border:1px solid #f0c36d;border-radius:6px;background:#fff8e1;color:#7a4f01" hidden>'+T('web.agent.pricing.payment_required')+' <a href="'+paymentLink+'">'+T('web.agent.pricing.configure_payment')+'</a></div>':'';
      const ownerName=String(paymentAuth?.name||''),ownerMask=ownerName?ownerName[0]+'*'.repeat(Math.max(1,ownerName.length-1)):T('web.agent.pricing.payment_owner');
      const paymentBound=hasPaymentAuth?'<span id="pricing-payment-bound">'+T('web.agent.pricing.payment_bound')+'：<strong>'+esc(ownerMask+' · '+(paymentAuth.bank_name||'')+' •••• '+String(paymentAuth.bank_card||'').slice(-4))+'</strong> <a href="'+paymentLink+'">'+T('web.agent.pricing.rebind_payment')+'</a></span>':'';
      res.send(renderAgentFormPage(T('web.agent.pricing.title'),agentId,agent.agentName||agentId,
        '<style>.pricing-model-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.pricing-model-row>select{width:260px;flex:none;margin:3px 0 0}.pricing-model-row #pricing-payment-bound{display:inline-flex;align-items:center;gap:5px;padding:7px 10px;border:1px solid #b7dfc5;border-radius:6px;background:#edf8f1;color:#176b3a;font-size:14px;white-space:nowrap}.pricing-pair{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px 18px;max-width:760px}.pricing-duration-input{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.pricing-duration-input select{width:110px;flex:none;margin:3px 0 0}.pricing-duration-input input[type=number]{width:120px;flex:none;margin:3px 0 0}.pricing-duration-total{color:#667085;font-size:14px;white-space:nowrap}.pricing-trial{width:180px;max-width:100%}@media(max-width:620px){.pricing-pair{grid-template-columns:1fr}.pricing-model-row>select{width:100%}.pricing-model-row #pricing-payment-bound{white-space:normal}}</style><div class="card"><p>'+T('web.agent.pricing.current')+'：<strong>'+curLabel+'</strong></p><form method="POST" action="/agents/'+esc(agentId)+'" data-agent-kind="action" data-agent-action="agent.pricing.set"><input type="hidden" name="_action" value="set_pricing"><label for="pm">'+esc(T('web.agent.pricing.model'))+'</label><div class="pricing-model-row"><select id="pm" name="pricingModel"><option value="free"'+(displayModel==='free'?' selected':'')+'>'+esc(T('web.agent.pricing.free_opt'))+'</option><option value="timed"'+(displayModel==='timed'?' selected':'')+'>'+esc(T('web.agent.pricing.duration_opt'))+'</option></select>'+paymentBound+'</div>'+paymentWarning+'<div id="pricing-paid-fields"><div class="pricing-pair"><div><label for="pp">'+esc(T('web.agent.pricing.price'))+'</label><input id="pp" name="price" type="number" step="0.01" min="0.01" required value="'+esc(p.price??'')+'"></div><div><label for="pd">'+esc(T('web.agent.pricing.duration'))+'</label><div class="pricing-duration-input"><input id="pd" type="number" min="1" step="1" required value="'+esc(displayDuration.value)+'"><select id="pricing-duration-unit" aria-label="'+esc(T('web.agent.pricing.duration_unit'))+'">'+unitOptions+'</select><span class="pricing-duration-total" id="pricing-duration-total"></span><input id="pricing-duration-minutes" name="durationMinutes" type="hidden" value="'+esc(p.durationMinutes??1)+'"></div></div></div><label for="pt">'+esc(T('web.agent.pricing.trial'))+'</label><input class="pricing-trial" id="pt" name="trialMinutes" type="number" min="0" step="1" required value="'+esc(p.trialMinutes??3)+'"></div><button type="submit">'+esc(T('common.btn.save'))+'</button></form><script>(function(){var model=document.getElementById("pm"),form=model.form,submit=form.querySelector("button[type=submit]"),warning=document.getElementById("pricing-payment-required"),fields=document.getElementById("pricing-paid-fields"),unit=document.getElementById("pricing-duration-unit"),duration=document.getElementById("pd"),minutes=document.getElementById("pricing-duration-minutes"),total=document.getElementById("pricing-duration-total"),totalTemplate='+jsonForInlineScript(T('web.agent.pricing.total_minutes'))+',hasPayment='+String(hasPaymentAuth)+',multipliers={minute:1,hour:60,day:1440,week:10080,month:43200};function updateMinutes(){var value=Number(duration.value)*multipliers[unit.value];minutes.value=Number.isFinite(value)?String(value):"";total.textContent=totalTemplate.replace("{minutes}",Number.isFinite(value)?String(value):"-")}function sync(){var paid=model.value==="timed",blocked=paid&&!hasPayment;fields.hidden=!paid;Array.from(fields.querySelectorAll("input,select")).forEach(function(input){input.disabled=!paid||blocked});if(warning)warning.hidden=!blocked;submit.disabled=blocked}duration.addEventListener("input",updateMinutes);unit.addEventListener("change",updateMinutes);form.addEventListener("submit",updateMinutes);model.addEventListener("change",sync);updateMinutes();sync()})();</script></div><p class="meta" style="margin-top:10px">'+T('web.agent.pricing.auth_hint')+'</p>',req.t,req.locale))
    }catch(e){next(e)}
  });

  // ── 能力声明 ──
  R.get('/agents/:agentId/caps',async(req,res,next)=>{
    try{
      const T=req.t,L=k=>esc(T(k));
      const{agentId}=req.params;const agent=await getAgentInfo(handlers,agentId);if(!agent)return res.redirect('/');
      let abilities=[],agentDescription=String(agent.description||'');
      try{const r=await handlers.get_agent_profile({agentId});if(r.success&&r.data){if(Array.isArray(r.data.ability))abilities=r.data.ability;if(r.data.description!=null)agentDescription=String(r.data.description)}}catch{}
      const capsMsg=req.query.ok?{success:true,text:req.query.ok}:req.query.warn?{warning:true,text:req.query.warn}:req.query.err?{success:false,text:req.query.err}:null;
      const capsValidationScript='<script>(function(){var original='+JSON.stringify({abilities,agentDescription}).replace(/</g,'\\u003c')+',noChanges='+JSON.stringify(T('web.agent.caps.no_changes')).replace(/</g,'\\u003c')+',invalid='+JSON.stringify(T('web.agent.caps.invalid_local')).replace(/</g,'\\u003c')+';function canonical(items){return items.map(function(item){return{id:String(item.id||""),name:String(item.name||"").trim(),description:String(item.description||"").trim(),tags:Array.isArray(item.tags)?item.tags.map(String).map(function(v){return v.trim()}).filter(Boolean):[],examples:Array.isArray(item.examples)?item.examples.map(String).map(function(v){return v.trim()}).filter(Boolean):[],fields:Array.isArray(item.fields)?item.fields.map(function(field){return{name:String(field.name||"").trim(),type:String(field.type||"string")}}):[]}})}document.addEventListener("DOMContentLoaded",function(){var form=document.getElementById("caps-form");if(!form)return;var submit=form.querySelector("button[type=submit]"),status=document.createElement("div");status.id="caps-local-status";status.setAttribute("role","status");status.setAttribute("aria-live","polite");status.style.cssText="display:none;margin:8px 0";form.insertBefore(status,submit);form.addEventListener("submit",function(event){var raw;try{raw=JSON.parse(document.getElementById("caps-json").value||"[]")}catch(_){raw=null}var description=String(form.querySelector("[name=agentDescription]").value||"").trim(),valid=description&&Array.isArray(raw)&&raw.every(function(item){return item&&typeof item==="object"&&String(item.name||"").trim()&&String(item.description||"").trim()&&Array.isArray(item.tags)&&item.tags.length>0&&Array.isArray(item.fields)&&item.fields.every(function(field){return field&&String(field.name||"").trim()})});if(!valid){event.preventDefault();status.textContent=invalid;status.className="error";status.style.display="block";return}var current={abilities:canonical(raw),agentDescription:description},before={abilities:canonical(original.abilities||[]),agentDescription:String(original.agentDescription||"").trim()};if(JSON.stringify(current)===JSON.stringify(before)){event.preventDefault();status.textContent=noChanges;status.className="meta";status.style.display="block"}else status.style.display="none"})})})();</script>';
      const initial=JSON.stringify(abilities).replace(/</g,'\\u003c');
      res.send(renderAgentFormPage(T('web.agent.caps.title'),agentId,agent.agentName||agentId,
        '<style>.a2a-section{margin:14px 0}.a2a-section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:4px}.a2a-section-title{margin:0;font-size:17px;color:#344054}.a2a-field-note{display:block;margin-top:2px;color:#667085;font-size:12px}.a2a-standard-grid{display:grid;grid-template-columns:150px minmax(0,1fr);gap:8px 14px;align-items:start;font-size:15px}.a2a-standard-grid dt{font-size:15px;font-weight:700;color:#475467}.a2a-standard-grid dd{margin:0;min-width:0;font-size:15px}.a2a-standard-grid code{font-size:14px}.a2a-public-info{width:100%;border-top:1px solid #e8edf3;padding-top:10px}.a2a-public-info summary{cursor:pointer;color:#1677e8;font-size:14px;font-weight:600;line-height:1.5;list-style-position:inside}.a2a-public-body{padding:7px 0 0 18px}.a2a-public-row{display:grid;grid-template-columns:145px minmax(0,1fr) auto;align-items:center;gap:8px;margin:6px 0}.a2a-public-row strong{white-space:nowrap;font-size:13px;font-weight:600;color:#344054}.a2a-public-row code{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:6px 8px;border-radius:6px;background:#f7f9fc;font-size:12px;color:#475467}.a2a-public-actions{display:flex;gap:5px;white-space:nowrap}.a2a-public-actions .btn-sm{display:inline-flex;align-items:center;margin:0;padding:5px 9px;min-height:0;font-size:12px;line-height:1.35;text-decoration:none}.a2a-public-actions a.btn-sm{border:1px solid #1677e8;border-radius:6px;background:#fff;color:#1677e8}.a2a-publication-options{display:flex;align-items:center;gap:22px;flex-wrap:wrap;margin:18px 0 10px}.a2a-publication-options label{margin:0;display:flex;align-items:center;gap:7px;font-size:15px;font-weight:600}.a2a-publication-options input{width:auto;margin:0}.cap-card{border-left:4px solid #84adff}@media(max-width:700px){.a2a-standard-grid,.a2a-public-row{grid-template-columns:1fr}.a2a-public-body{padding-left:10px}.a2a-public-actions{white-space:normal;flex-wrap:wrap}}</style><form method="POST" action="/agents/'+esc(agentId)+'" id="caps-form" data-agent-action="agent.caps.declare"><input type="hidden" name="_action" value="declare_caps"><input type="hidden" name="ability" id="caps-json"><section class="card a2a-section"><h2 class="a2a-section-title">'+L('web.agent.caps.card_identity')+'</h2><p class="meta">'+L('web.agent.caps.card_identity_hint')+'</p><dl class="a2a-standard-grid"><dt>'+L('web.agent.caps.card_name')+'</dt><dd><strong>'+esc(agent.agentName||agentId)+'</strong><span class="a2a-field-note">'+L('web.agent.caps.card_name_note')+'</span></dd><dt><label for="agent-card-description" style="margin:0">'+L('web.agent.caps.card_description')+' *</label></dt><dd><textarea id="agent-card-description" name="agentDescription" rows="3" maxlength="1000" required style="max-width:none;margin:0">'+esc(agentDescription)+'</textarea><span class="a2a-field-note">'+L('web.agent.caps.card_description_note')+'</span></dd><dt>'+L('web.agent.caps.protocol_version')+'</dt><dd><code>1.0</code></dd><dt>'+L('web.agent.caps.default_input_modes')+'</dt><dd><code>text/plain</code></dd><dt>'+L('web.agent.caps.default_output_modes')+'</dt><dd><code>text/plain</code></dd></dl></section><section class="a2a-section"><div class="a2a-section-head"><h2 class="a2a-section-title">Skills</h2><button type="button" id="caps-add" class="btn-sm btn-outline" style="margin:0">'+L('web.agent.caps.add')+'</button></div><p class="meta">'+L('web.agent.caps.skills_hint')+'</p><div id="caps-list"></div></section><button type="submit">'+L('web.agent.caps.declare_btn')+'</button></form>'
        +'<script>(function(){var list=document.getElementById("caps-list"),form=document.getElementById("caps-form"),initial='+initial+',labels='+JSON.stringify({name:T('web.agent.caps.name'),namePh:T('web.agent.caps.name_ph'),description:T('web.agent.caps.description'),descriptionPh:T('web.agent.caps.description_ph'),tags:T('web.agent.caps.tags'),tagsPh:T('web.agent.caps.tags_ph'),examples:T('web.agent.caps.examples'),examplesPh:T('web.agent.caps.examples_ph'),fields:T('web.agent.caps.fields'),fieldPh:T('web.agent.caps.field_ph'),addField:T('web.agent.caps.add_field'),remove:T('common.btn.remove'),removeCap:T('web.agent.caps.remove'),empty:T('web.agent.caps.empty')}).replace(/</g,'\\u003c')+';function esc4(s){return String(s==null?"":s).replace(/[&<>"\']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",\'"\':"&quot;","\'":"&#39;"}[c]})}function meta(v){return encodeURIComponent(JSON.stringify(v||{}))}function field(f){f=f||{};return \'<div class="cap-field" data-meta="\'+meta(f)+\'" style="display:flex;gap:10px;align-items:center;margin:8px 0"><input class="cf-name" value="\'+esc4(f.name||"")+\'" placeholder="\'+esc4(labels.fieldPh)+\'" required style="flex:1;max-width:none;margin:0"><button type="button" class="cap-remove-field" style="margin:0;padding:8px 14px;min-width:0;background:#f5e9ff;color:#b067e8;border:1px solid #d8b4fe">\'+esc4(labels.remove)+"</button></div>"}function capability(c){c=c||{};var el=document.createElement("div");el.className="card cap-card";el.dataset.meta=meta(c);el.style.cssText="padding:20px;border-radius:10px;margin:14px 0";el.innerHTML=\'<label style="margin-top:0">\'+esc4(labels.name)+\'</label><input class="cap-name" value="\'+esc4(c.name||"")+\'" placeholder="\'+esc4(labels.namePh)+\'" required style="max-width:none"><label>\'+esc4(labels.description)+\'</label><textarea class="cap-description" rows="2" placeholder="\'+esc4(labels.descriptionPh)+\'" required style="max-width:none">\'+esc4(c.description||"")+\'</textarea><div class="form-grid"><div><label>\'+esc4(labels.tags)+\'</label><input class="cap-tags" value="\'+esc4(Array.isArray(c.tags)?c.tags.join(", "):"")+\'" placeholder="\'+esc4(labels.tagsPh)+\'" required style="max-width:none"></div><div><label>\'+esc4(labels.examples)+\'</label><input class="cap-examples" value="\'+esc4(Array.isArray(c.examples)?c.examples.join(" | "):"")+\'" placeholder="\'+esc4(labels.examplesPh)+\'" style="max-width:none"></div></div><div style="padding:8px 28px 0"><label>\'+esc4(labels.fields)+\'</label><div class="cap-fields"></div><button type="button" class="cap-add-field" style="margin:4px 0 0;padding:0;min-width:0;background:none;border:0;color:#5b7cfa;font-size:15px">+ \'+esc4(labels.addField)+\'</button></div><div style="display:flex;justify-content:flex-end;margin-top:10px"><button type="button" class="cap-remove" style="margin:0;padding:9px 18px;min-width:0;background:#ef5350;border-color:#e53935">\'+esc4(labels.removeCap)+"</button></div>";var fs=el.querySelector(".cap-fields");(Array.isArray(c.fields)?c.fields:[]).forEach(function(x){fs.insertAdjacentHTML("beforeend",field(x))});return el}function add(c){list.appendChild(capability(c))}if(initial.length)initial.forEach(add);else list.innerHTML=\'<p class="meta" id="caps-empty">\'+esc4(labels.empty)+"</p>";document.getElementById("caps-add").onclick=function(){var e=document.getElementById("caps-empty");if(e)e.remove();add({})};list.addEventListener("click",function(e){var b=e.target.closest("button");if(!b)return;if(b.classList.contains("cap-remove"))b.closest(".cap-card").remove();if(b.classList.contains("cap-add-field"))b.previousElementSibling.insertAdjacentHTML("beforeend",field({}));if(b.classList.contains("cap-remove-field"))b.closest(".cap-field").remove()});form.addEventListener("submit",function(){var data=Array.from(list.querySelectorAll(".cap-card")).map(function(c){var out={};try{out=JSON.parse(decodeURIComponent(c.dataset.meta))}catch(_){}if(!out.id)out.id=crypto.randomUUID();out.name=c.querySelector(".cap-name").value.trim();out.description=c.querySelector(".cap-description").value.trim();out.tags=c.querySelector(".cap-tags").value.split(",").map(function(v){return v.trim()}).filter(Boolean);out.examples=c.querySelector(".cap-examples").value.split("|").map(function(v){return v.trim()}).filter(Boolean);out.fields=Array.from(c.querySelectorAll(".cap-field")).map(function(f){var x={type:"string"};try{x=JSON.parse(decodeURIComponent(f.dataset.meta))}catch(_){}x.name=f.querySelector(".cf-name").value.trim();return x});return out});document.getElementById("caps-json").value=JSON.stringify(data)});})();</script>',req.t,req.locale,{msg:capsMsg}))
    }catch(e){next(e)}
  });

  R.post('/agents/:agentId/caps/verify-a2a-card',async(req,res)=>{
    try{const row=db.prepare('SELECT did,publish_status FROM agents WHERE agent_id=?').get(req.params.agentId);if(!row||row.publish_status!=='published')return res.status(404).json({success:false,error:req.t('web.agent.caps.verify_not_published')});
      const{serverAgentIdFromDid}=require('../core/agent-invitations');const publicId=serverAgentIdFromDid(row.did)||req.params.agentId;const base=String(require('../endpoints.json').api.baseUrl||'').replace(/\/+$/,'');const expected=base+'/a2a/v1/agents/'+encodeURIComponent(publicId);const response=await fetch(base+'/a2a/agents/'+encodeURIComponent(publicId)+'/.well-known/agent-card.json',{headers:{accept:'application/a2a+json, application/json'},signal:AbortSignal.timeout(8000)});if(!response.ok)return res.status(502).json({success:false,error:req.t('web.agent.caps.verify_http_error',{status:response.status})});const card=await response.json();const validEndpoint=Array.isArray(card.supportedInterfaces)&&card.supportedInterfaces.some(function(item){return item&&item.url===expected&&item.protocolVersion==='1.0'});if(!validEndpoint||!Array.isArray(card.skills)||Object.prototype.hasOwnProperty.call(card,"protocolVersion"))return res.status(502).json({success:false,error:req.t('web.agent.caps.verify_invalid')});return res.json({success:true,message:req.t('web.agent.caps.verify_success',{count:card.skills.length})})
    }catch(error){return res.status(502).json({success:false,error:req.t('web.agent.caps.verify_failed')})}
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
          {id:'hc',name:'conversationId',label:'',type:'hidden',val:esc(req.query.conversationId||'')},
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
      const uploadConversationId=String(req.query.conversationId||'');
      const uploadReplyToMessageId=String(req.query.replyToMessageId||'');
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
          'btn.addEventListener("click",async function(){if(uploading||!selectedFile)return;if(!to.value.trim()){to.focus();return}uploading=true;var file=selectedFile,uploadName=fn.value||selectedFile.name;btn.disabled=true;btn.setAttribute("aria-busy","true");btn.innerHTML=\'<span class="voko-spinner" aria-hidden="true"></span>\'+'+jsonForInlineScript(T('web.agent.upload.uploading'))+';f.disabled=true;fn.disabled=true;to.disabled=true;ct.disabled=true;msg.disabled=true;z.setAttribute("aria-busy","true");z.style.opacity=".55";z.style.cursor="not-allowed";prog.style.display="block";resDiv.innerHTML="";'+
            'var fd=new FormData();fd.append("file",file,uploadName);'+
            'var initialDisplay=to.getAttribute("data-initial-display")||"",storedUid=to.getAttribute("data-to-uid")||"",recipient=to.value.trim()===initialDisplay&&storedUid?storedUid:to.value.trim();var params=new URLSearchParams({toUid:recipient,channelType:ct.value,message:msg.value.trim(),conversationId:'+jsonForInlineScript(uploadConversationId)+',replyToMessageId:'+jsonForInlineScript(uploadReplyToMessageId)+'});'+
            'try{var r=await fetch("/api/agents/'+aid+'/send-file?"+params,{method:"POST",body:fd});var j=await r.json();'+
              'if(j.success){location.href='+jsonForInlineScript(returnPath)+';return}'+
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
          conversationId: String(req.query.conversationId||'')||undefined,
          replyToMessageId: String(req.query.replyToMessageId||'')||undefined,
          webRequest: Number(req.query.channelType)!==2&&webRoutingEnabled('web_private_conversations_v1'),
          filePath: tmpPath,
          fileName: filename,
        });
        require('fs').rmSync(uploadDir, { recursive: true, force: true });
        res.json(result);
      } catch (e) {
        try { require('fs').rmSync(uploadDir, { recursive: true, force: true }); } catch (_) {}
        res.json({ success: false, error: '附件上传失败: ' + e.message });
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
      const iconUrl=await uploader(file.data,objectName,type.mime,req.params.agentId);
      const updated=await handlers.update_agent_profile({agentId:req.params.agentId,iconUrl});
      if(updated?.success===false||updated?.error)return res.status(502).json({success:false,error:updated.error||req.t('web.agent.edit.icon_upload_failed')});
      return res.json({success:true,iconUrl});
    }catch(e){return res.status(500).json({success:false,error:e.message||req.t('web.agent.edit.icon_upload_failed')})}
  });

  R.post('/api/web/agents/restart',requireSensitiveLocalAuth,requireSensitiveCsrf,async(req,res)=>{
    try{
      if(typeof handlers.restart_agent_runtime!=='function')return res.status(503).json({success:false,error:'Agent runtime restart is unavailable'});
      const result=await handlers.restart_agent_runtime();
      const status=result?.code==='OWNER_SWITCH_IN_PROGRESS'?409:(result?.success===false?500:(result?.restarting?202:200));
      return res.status(status).json(result);
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
            short_description:Object.prototype.hasOwnProperty.call(req.body,'short_description')?req.body.short_description:undefined,category:req.body.category||undefined,
            tags:req.body.tags?JSON.stringify(req.body.tags.replace(/，/g,',').split(',').map(t=>t.trim()).filter(Boolean)):undefined,iconUrl:req.body.iconUrl||undefined,
            address:req.body.address||undefined,contact_phone:req.body.contact_phone||undefined,
            backendType:req.body.backendType||undefined,backendInstanceId:req.body.backendInstanceId
          }),'common.action.profile_updated');break;
           case'set_status':await handleAction(req,res,handlers.set_agent_status({agentId,status:parseInt(req.body.status,10)}),'common.action.status_updated');break;
           case'set_visibility':await handleAction(req,res,handlers.set_agent_status({agentId,visibility:parseInt(req.body.visibility,10)}),'common.action.status_updated');break;
          case'add_whitelist':await handleAction(req,res,handlers.manage_whitelist({agentId,action:'add',visitorId:req.body.visitorId,reason:req.body.reason||''}),'common.action.whitelist_added');break;
          case'add_blacklist':await handleAction(req,res,handlers.manage_blacklist({agentId,action:'add',visitorId:req.body.visitorId,reason:req.body.reason||''}),'common.action.blacklist_added');break;
          case'remove_blacklist':await handleAction(req,res,handlers.manage_blacklist({agentId,action:'remove',visitorId:req.body.visitorId}),'common.action.blacklist_removed');break;
          case'remove_whitelist':await handleAction(req,res,handlers.manage_whitelist({agentId,action:'remove',visitorId:req.body.visitorId}),'common.action.whitelist_removed');break;
          case'set_access_mode':await handleAction(req,res,handlers.set_private_mode({agentId,enabled:req.body.enabled==='true'}),'common.action.access_mode_changed');break;
          case'declare_caps':{
            let ab;try{ab=JSON.parse(req.body.ability)}catch{ab=req.body.ability}
            const description=String(req.body.agentDescription||'').trim();
            if(!description)return res.redirect(actionResultLocation('/agents/'+encodeURIComponent(agentId)+'/caps','err',req.t('web.agent.caps.invalid_local')));
            const profileResult=await handlers.update_agent_profile({agentId,description});
            if(profileResult&&profileResult.success===false)return res.redirect(actionResultLocation('/agents/'+encodeURIComponent(agentId)+'/caps','err',profileResult.error||req.t('common.action.failed')));
            const r=await handlers.declare_capabilities({agentId,ability:ab});
            const capsPath='/agents/'+encodeURIComponent(agentId)+'/caps';
            if(r.success===false||r.error)return res.redirect(actionResultLocation(capsPath,'err',r.error||req.t('common.action.failed')));
            if(!opts.syncA2ARegistration)return res.redirect(actionResultLocation(capsPath,'warn',req.t('web.agent.caps.voko_only')));
             try{await opts.syncA2ARegistration();
             }catch(error){console.error('[A2A] capability registration sync failed:',error.message);return res.redirect(actionResultLocation(capsPath,'warn',req.t('web.agent.caps.voko_only')))}
            return res.redirect(actionResultLocation(capsPath,'ok',req.t('web.agent.caps.declared_a2a')))
          }
          case'set_pricing':{
            if(req.body.pricingModel==='timed'&&!hasAgentPaymentAuth(db,agentId))return res.redirect(actionResultLocation('/agents/'+encodeURIComponent(agentId)+'/pricing','err',req.t('web.agent.pricing.payment_required')));
            if(req.body.pricingModel==='timed'&&!validPaidPricing(req.body.price,req.body.durationMinutes,req.body.trialMinutes))return res.redirect(actionResultLocation('/agents/'+encodeURIComponent(agentId)+'/pricing','err',req.t('web.agent.pricing.invalid_numbers')));
            await handleAction(req,res,handlers.agent_pricing({
            agentId,pricingModel:req.body.pricingModel||'free',
            price:req.body.price?parseFloat(req.body.price):undefined,
            durationMinutes:req.body.durationMinutes?parseInt(req.body.durationMinutes,10):undefined,
            trialMinutes:req.body.trialMinutes!==undefined&&req.body.trialMinutes!==''?parseInt(req.body.trialMinutes,10):undefined
            }),'common.action.pricing_updated');break;
          }
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
            agentId,visitorId:req.body.visitorId,problem:req.body.problem,suggestion:req.body.suggestion||'',
            conversationId:req.body.conversationId||undefined,replyToMessageId:req.body.replyToMessageId||undefined,
            channelId:req.body.channelId||undefined,channelType:Number(req.body.channelType)||1
          }),'common.action.human_requested');break;
          default:res.redirect('/agents/'+esc(agentId)+'?err='+encodeURIComponent(req.t('common.action.unknown')))
        }
      }catch(e){res.redirect(a==='declare_caps'?actionResultLocation('/agents/'+encodeURIComponent(agentId)+'/caps','err',e.message):'/agents/'+esc(agentId)+'?err='+encodeURIComponent(e.message))}
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
        case 'bind_instance_once':
          r = await handlers.bind_agent_instance_once({ agentId, backendInstanceId: params.backendInstanceId });
          break;
        case 'update_profile':
          r = await handlers.update_agent_profile({ agentId,
            name: params.name, description: params.description,
            short_description: params.short_description, category: params.category,
            tags: params.tags, iconUrl: params.iconUrl,
            address: params.address, contact_phone: params.contact_phone,
            backendType: params.backendType, backendInstanceId: params.backendInstanceId });
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
          if (params.pricingModel === 'timed' && !hasAgentPaymentAuth(db, agentId)) return res.json({ success: false, error: req.t('web.agent.pricing.payment_required') });
          if (params.pricingModel === 'timed' && !validPaidPricing(params.price, params.durationMinutes, params.trialMinutes)) return res.json({ success: false, error: req.t('web.agent.pricing.invalid_numbers') });
          r = await handlers.agent_pricing({ agentId, pricingModel: params.pricingModel, price: params.price, durationMinutes: params.durationMinutes, trialMinutes: params.trialMinutes });
          break;
        case 'ask_human':
          r = await handlers.ask_human_for_help({ agentId, visitorId: params.visitorId, problem: params.problem,
            suggestion: params.suggestion, conversationId: params.conversationId, replyToMessageId: params.replyToMessageId,
            channelId: params.channelId, channelType: Number(params.channelType) || 1 });
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
  R.get('/api/audit-rules/model-assistance',requireSensitiveLocalAuth,(_req,res)=>{
    try{return res.json({success:true,config:loadSafetyClassifierConfig(db,false)})}
    catch(e){return res.status(500).json({success:false,error:e.message})}
  });
  R.post('/api/audit-rules/model-assistance',requireSensitiveLocalAuth,requireSensitiveCsrf,(req,res)=>{
    try{return res.json({success:true,config:saveSafetyClassifierConfig(db,req.body||{})})}
    catch(e){return res.status(400).json({success:false,error:e.message})}
  });
  R.post('/api/audit-rules/model-assistance/test',requireSensitiveLocalAuth,requireSensitiveCsrf,async(req,res)=>{
    try{
      const previous=loadSafetyClassifierConfig(db,true);
      const input={...previous,...(req.body||{}),apiKey:req.body?.apiKey||previous.apiKey,enabled:false};
      const result=await testSafetyClassifierConfig(input);
      const config=saveSafetyClassifierConfig(db,{...input,enabled:false,_markTested:true});
      return res.json({success:true,result,config});
    }catch(e){return res.status(400).json({success:false,error:e.message})}
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
        const w=await handlers.list_agents({limit:500});const ags=w.agents||[];
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
          const statusCell=r.skip_reply?L('web.interventions.status.no_reply'):(r.status==='unknown'?L('web.interventions.status.unknown'):(r.owner_reply?L('web.interventions.reply.done'):L('web.interventions.reply.pending')));
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
         const cbody='<div class="card"><h3>'+L('web.payments.create.heading')+'</h3>'+renderPaymentRegionNotice(T)+'<form method="POST" action="/payments"><input type="hidden" name="conversationId" value="'+esc(req.query.conversationId||'')+'"><label for="pa">'+L('web.payments.create.agent')+'</label><select id="pa" name="agentId" required>'+ao+'</select><label for="pv">'+L('web.payments.create.visitor')+'</label><input type="text" id="pv" name="visitorId" value="'+v2+'" required><label for="pa2">'+L('web.payments.create.amount')+'</label><input type="number" id="pa2" name="amount" step="0.01" min="0" required autofocus><label for="pd">'+L('web.payments.create.desc')+'</label><input type="text" id="pd" name="description"><br><br><button type="submit" class="btn-success">'+L('common.btn.create')+'</button><a href="/payments" class="btn" style="margin-left:8px">'+L('common.btn.cancel')+'</a></form></div>';
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
       const body=renderPaymentRegionNotice(T)+'<form method="GET" action="/payments">'
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
    try{
      const r=await handlers.create_payment({agentId:req.body.agentId,visitorId:req.body.visitorId,amount:parseFloat(req.body.amount),description:req.body.description||'',conversationId:req.body.conversationId||undefined});
      if(!r.success)return res.send(renderPage(req,req.t('web.payments.failed'),'<p class="error">'+esc(r.error)+'</p><a href="/payments">'+esc(req.t('common.btn.back'))+'</a>'));
      const body=renderPaymentCreationResult(req.t,r,req.body.visitorId);
      res.send(renderPage(req,req.t('web.payments.create.result_title'),body,{nav:'<a href="/">'+esc(req.t('common.nav.home'))+'</a> › <a href="/payments">'+esc(req.t('web.payments.breadcrumb'))+'</a> › '+esc(req.t('web.payments.create.result_title'))}));
    }catch(e){next(e)}
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

      const modelCfg=loadSafetyClassifierConfig(db,false);
      const csrf=opts.webSessions?.requestCsrfToken(req)||'';
      const selectedPreset=findSafetyModelPreset(modelCfg);
      const presetOptions=SAFETY_MODEL_PRESETS.map(p=>'<option value="'+esc(p.id)+'"'+(selectedPreset?.id===p.id?' selected':'')+'>'+esc(p.label)+'</option>').join('');
      const presetData=JSON.stringify(SAFETY_MODEL_PRESETS).replace(/</g,'\\u003c');
      const modelState=modelCfg.enabled?L('web.audit.model.status_enabled'):L('web.audit.model.status_disabled');
      const modelCard='<style>'+AUDIT_LAYOUT_CSS+'</style><details class="card"><summary style="cursor:pointer;font-size:1.17em;font-weight:600">'+L('web.audit.model.title')+' <span id="safety-model-state" class="badge '+(modelCfg.enabled?'badge-online':'badge-pending')+'" style="margin-left:6px">'+esc(modelState)+'</span></summary>'
        +'<div style="margin-top:14px"><p class="meta">'+L('web.audit.model.description')+'</p>'
        +'<form id="safety-model-form" method="POST" action="/audit-rules/model-assistance"><input type="hidden" name="_csrf" value="'+esc(csrf)+'">'
        +'<div class="audit-grid audit-grid-two"><div><label for="safety-model-preset">'+L('web.audit.model.preset')+'</label><select id="safety-model-preset"><option value="custom"'+(selectedPreset?'':' selected')+'>'+L('web.audit.model.custom')+'</option>'+presetOptions+'</select></div>'
        +'<div><label>'+L('web.audit.model.api_key')+'</label><input type="password" name="apiKey" value="" placeholder="'+esc(modelCfg.hasApiKey?modelCfg.apiKeyMasked:L('web.audit.model.api_key_empty'))+'" autocomplete="new-password">'
        +(modelCfg.hasApiKey?'<p class="meta" style="margin:3px 0">'+L('web.audit.model.api_key_configured')+' '+esc(modelCfg.apiKeyMasked)+'</p>':'')+'</div></div>'
        +'<div class="audit-grid audit-grid-three" style="margin-top:10px">'
        +'<div><label>'+L('web.audit.model.api_type')+'</label><select id="safety-api-type" name="apiType"><option value="openai-chat"'+(modelCfg.apiType!=='anthropic-messages'?' selected':'')+'>OpenAI compatible</option><option value="anthropic-messages"'+(modelCfg.apiType==='anthropic-messages'?' selected':'')+'>Anthropic compatible</option></select></div>'
        +'<div><label>'+L('web.audit.model.model_id')+'</label><input id="safety-model-id" name="modelId" value="'+esc(modelCfg.modelId||'')+'"></div>'
        +'<div><label>'+L('web.audit.model.base_url')+'</label><input id="safety-base-url" name="baseUrl" value="'+esc(modelCfg.baseUrl||'')+'" placeholder="https://api.example.com"></div></div>'
        +'<details style="margin-top:12px"><summary style="cursor:pointer;font-weight:600">'+L('web.audit.model.advanced')+'</summary><div class="audit-grid audit-grid-three">'
        +'<div><label>'+L('web.audit.model.timeout')+'</label><input type="number" min="1" max="15" name="timeoutSeconds" value="'+esc(modelCfg.timeoutSeconds||5)+'"><p class="meta">'+L('web.audit.model.timeout_help')+'</p></div>'
        +'<div><label for="safety-medium">'+L('web.audit.model.medium_threshold')+' <output id="safety-medium-output">'+Math.round((modelCfg.mediumThreshold??0.65)*100)+'%</output> '+L('web.audit.model.medium_recommended')+'</label><input id="safety-medium" type="range" min="0" max="0.99" step="0.01" name="mediumThreshold" value="'+esc(modelCfg.mediumThreshold??0.65)+'"></div>'
        +'<div><label for="safety-high">'+L('web.audit.model.high_threshold')+' <output id="safety-high-output">'+Math.round((modelCfg.highThreshold??0.9)*100)+'%</output> '+L('web.audit.model.high_recommended')+'</label><input id="safety-high" type="range" min="0.5" max="1" step="0.01" name="highThreshold" value="'+esc(modelCfg.highThreshold??0.9)+'"></div>'
        +'<div class="full"><p class="meta">'+L('web.audit.model.threshold_help')+'</p></div></div></details>'
        +'<div class="audit-model-actions"><button type="button" id="safety-model-test" class="btn-outline">'+L('web.audit.model.test')+'</button><label><input type="checkbox" name="enabled" value="1" style="width:auto"'+(modelCfg.enabled?' checked':'')+(modelCfg.tested?'':' disabled')+'> '+L('web.audit.model.enabled')+'</label></div>'
        +'<p class="meta" style="margin:6px 0 0">'+L('web.audit.model.test_help')+'</p>'
        +'<p id="safety-model-result" class="meta" hidden aria-live="polite"></p>'
        +'</form><script>(function(){var presets='+presetData+',form=document.getElementById("safety-model-form"),result=document.getElementById("safety-model-result"),pick=document.getElementById("safety-model-preset"),type=document.getElementById("safety-api-type"),url=document.getElementById("safety-base-url"),model=document.getElementById("safety-model-id"),key=form.querySelector("[name=apiKey]"),medium=document.getElementById("safety-medium"),high=document.getElementById("safety-high"),mediumOut=document.getElementById("safety-medium-output"),highOut=document.getElementById("safety-high-output"),enabled=form.querySelector("[name=enabled]"),test=document.getElementById("safety-model-test"),state=document.getElementById("safety-model-state"),stateOn='+JSON.stringify(T('web.audit.model.status_enabled'))+',stateOff='+JSON.stringify(T('web.audit.model.status_disabled'))+',savingText='+JSON.stringify(T('web.audit.model.saving'))+',savedText='+JSON.stringify(T('web.audit.model.save_success'))+',testText='+JSON.stringify(T('web.audit.model.processing'))+',testSuccess='+JSON.stringify(T('web.audit.model.test_success'))+',failedText='+JSON.stringify(T('web.audit.model.save_failed'))+',tested='+(modelCfg.tested?'true':'false')+',timer=0,sequence=0;function showState(){state.textContent=enabled.checked?stateOn:stateOff;state.classList.toggle("badge-online",enabled.checked);state.classList.toggle("badge-pending",!enabled.checked)}function values(){var data={};new FormData(form).forEach(function(value,name){if(name!=="_csrf")data[name]=value});data.enabled=enabled.checked;return data}function status(text,kind){result.hidden=false;result.className=kind||"meta";result.textContent=text}function invalidate(){tested=false;enabled.checked=false;enabled.disabled=true;showState()}async function save(){clearTimeout(timer);var current=++sequence;status(savingText,"meta");try{var response=await fetch("/api/audit-rules/model-assistance",{method:"POST",headers:{"Content-Type":"application/json","Accept":"application/json"},body:JSON.stringify(values())}),payload=await response.json().catch(function(){return{}});if(!response.ok||!payload.success)throw new Error(payload.error||failedText);if(current!==sequence)return;tested=payload.config&&payload.config.tested===true;enabled.disabled=!tested;if(key.value&&payload.config){key.value="";key.placeholder=payload.config.apiKeyMasked||key.placeholder}status(savedText,"success")}catch(error){if(current!==sequence)return;status(error.message||failedText,"error")}}function schedule(){clearTimeout(timer);timer=setTimeout(save,500)}pick.addEventListener("change",function(){var p=presets.find(function(x){return x.id===pick.value});if(!p){type.value="openai-chat";url.value="";model.value=""}else{type.value=p.apiType;url.value=p.baseUrl;model.value=p.modelId}invalidate();schedule()});[type,url,model,key].forEach(function(field){field.addEventListener("change",function(){if(field!==key||key.value)invalidate();schedule()})});function show(){mediumOut.value=Math.round(Number(medium.value)*100)+"%";highOut.value=Math.round(Number(high.value)*100)+"%"}medium.addEventListener("input",function(){if(Number(medium.value)>Number(high.value))high.value=medium.value;show();schedule()});high.addEventListener("input",function(){if(Number(high.value)<Number(medium.value))medium.value=high.value;show();schedule()});form.querySelector("[name=timeoutSeconds]").addEventListener("change",schedule);enabled.addEventListener("change",function(){showState();save()});test.addEventListener("click",async function(){clearTimeout(timer);var current=++sequence,data=values();data.enabled=false;test.disabled=true;status(testText,"meta");try{var response=await fetch("/api/audit-rules/model-assistance/test",{method:"POST",headers:{"Content-Type":"application/json","Accept":"application/json"},body:JSON.stringify(data)}),payload=await response.json().catch(function(){return{}});if(!response.ok||!payload.success)throw new Error(payload.error||failedText);if(current!==sequence)return;tested=true;enabled.checked=false;enabled.disabled=false;showState();if(key.value&&payload.config){key.value="";key.placeholder=payload.config.apiKeyMasked||key.placeholder}status(testSuccess,"success")}catch(error){if(current!==sequence)return;tested=false;enabled.checked=false;enabled.disabled=true;showState();status(error.message||failedText,"error")}finally{test.disabled=false}});form.addEventListener("submit",function(event){event.preventDefault()});show();showState()})();</'+'script></div></details>';
      const body=modelCard+'<form method="GET" action="/audit-rules" style="display:flex;gap:8px;margin-bottom:10px">'
        +(dir?'<input type="hidden" name="direction" value="'+esc(dir)+'">':'')
        +'<div><label for="aq" style="font-size:14px;margin:0">'+L('web.audit.search_label')+'</label><input type="text" id="aq" name="q" value="'+esc(keyword)+'" style="width:200px;padding:6px 10px;font-size:14px" placeholder="'+esc(T('web.audit.search_ph'))+'" autofocus></div>'
        +'<button type="submit" class="btn-sm" style="margin:0;margin-top:18px" data-testid="search-btn" data-agent="search_btn">'+L('common.btn.search')+'</button>'
        +(keyword?'<a href="/audit-rules'+(dir?'?direction='+encodeURIComponent(dir):'')+'" class="btn-sm btn-outline" style="margin:0;margin-top:18px">'+L('web.audit.clear')+'</a>':'')
        +'</form>'
        +'<div class="table-wrap" aria-live="polite"><table style="font-size:14px"><thead><tr><th style="text-align:center">'+L('web.audit.col.direction')+'</th><th>'+L('web.audit.col.keyword')+'</th><th>'+L('web.audit.col.prompt')+'</th><th style="text-align:center">'+L('web.audit.col.action')+'</th><th style="text-align:center">'+L('web.audit.col.op')+'</th></tr></thead><tbody>'+rowsHtml+'</tbody></table></div>'
        +pg
        +'<div class="card audit-rule-add-card"><h3>'+L('web.audit.add_title')+'</h3><form method="POST" action="/audit-rules"><input type="hidden" name="action" value="add"><div class="audit-grid audit-grid-three"><div><label for="rd">'+L('web.audit.lbl.direction')+'</label><select id="rd" name="direction">'+dOpts+'</select></div><div><label for="ra">'+L('web.audit.lbl.action')+'</label><select id="ra" name="actionType">'+aOpts+'</select></div><div><label for="rk">'+L('web.audit.lbl.keyword')+'</label><input type="text" id="rk" name="keyword" required></div></div><div class="audit-rule-prompt-row"><div><label for="rp">'+L('web.audit.lbl.prompt')+'</label><input type="text" id="rp" name="prompt"></div><button type="submit">'+L('common.btn.add')+'</button></div></form></div>';
      res.send(renderPage(req,title,body,{nav:'<a href="/">'+L('common.nav.home')+'</a> › '+title}))
    }catch(e){next(e)}
  });  R.post('/audit-rules',async(req,res,next)=>{
    try{const r=await handlers.manage_audit_rules({action:req.body.action,ruleId:req.body.ruleId||undefined,direction:req.body.direction||undefined,keyword:req.body.keyword||undefined,actionType:req.body.actionType||undefined,prompt:req.body.prompt||undefined});r.success!==false?res.redirect('/audit-rules'):res.send(renderPage(req,req.t('common.label.failed'),'<p class="error">'+esc(r.error)+'</p><a href="/audit-rules">'+esc(req.t('common.btn.back'))+'</a>'))}catch(e){next(e)}
  });
  R.post('/audit-rules/model-assistance',requireSensitiveLocalAuth,requireSensitiveCsrf,async(req,res,next)=>{
    try{
      const previous=loadSafetyClassifierConfig(db,true);
      const input={...req.body,enabled:req.body.enabled==='1',apiKey:req.body.apiKey||previous.apiKey};
      if(req.body.mode==='test'){
        await testSafetyClassifierConfig({...input,enabled:false});
        saveSafetyClassifierConfig(db,{...input,enabled:false,_markTested:true});
      }else saveSafetyClassifierConfig(db,input);
      res.redirect('/audit-rules');
    }catch(e){res.status(400).send(renderPage(req,req.t('common.label.failed'),'<p class="error">'+esc(e.message)+'</p><a href="/audit-rules">'+esc(req.t('common.btn.back'))+'</a>'))}
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
try{const _wl=await handlers.list_agents({limit:500});agents=_wl.agents||[]}catch{}
const defAgent=agentId||(agents.length?agents[0].agentId:'');
            const agentOpts=agents.map(a=>'<option value="'+esc(a.agentId)+'"'+(defAgent===a.agentId?' selected':'')+'>'+esc(a.agentName||a.agentId)+'</option>').join('\n');

            if(keyword&&agentId){
        try{
          const r=await handlers.search_capabilities({agent_id:agentId,keyword,page:curPage2,limit});

          if(r.success===false){errMsg=r.code==='SEARCH_AUTH_REQUIRED'?T('web.capabilities.err_auth_required'):T('web.capabilities.err_search_failed')}
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
+'## All Actions ('+ACTION_GROUPS.reduce((s,g)=>s+g.actions.length,0)+', details at /api/handlers)\n'
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
  R.get('/api/im-users/:uid/exists',async(req,res)=>{
    try{
      const result=await validateImUidExists(req.params.uid);
      if(!result.exists)return res.status(404).json({success:false,exists:false,code:'RECIPIENT_NOT_FOUND'});
      let isOnline=null;
      if(result.isAgent===true){
        let localAgent=null;
        try{localAgent=db.prepare('SELECT agent_id FROM agents WHERE imUid = ?').get(req.params.uid)}catch{}
        if(localAgent){
          try{isOnline=(await getAgentStatus(handlers,localAgent.agent_id)).agent.imConnected===true}catch{}
        }else if(req.query.agentId){
          try{
            const found=await handlers.search_capabilities({agent_id:String(req.query.agentId),keyword:String(req.params.uid),page:1,limit:20});
            const match=(found.data||found.agents||found.results||[]).find(agent=>String(agent.imUid||agent.im_uid||'')===String(req.params.uid));
            if(match&&typeof match.isOnline==='boolean')isOnline=match.isOnline;
          }catch{}
        }
      }
      return res.json({success:true,exists:true,isAgent:result.isAgent===true,isOnline});
    }catch(_){
      return res.status(503).json({success:false,code:'RECIPIENT_CHECK_UNAVAILABLE'});
    }
  });
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
      try{const a=await handlers.list_agents({limit:500});agents=a.agents||[]}catch{}
      let agentOpts='';
      const defAgent=prefillAgent||(agents.length?agents[0].agentId:'');for(const a of agents)agentOpts+='<option value="'+esc(a.agentId)+'"'+(defAgent===a.agentId?' selected':'')+'>'+esc(a.agentName||a.agentId)+'</option>';
      res.send(renderPage(req,T('web.send_message.title'),'<div class="card"><form method="POST" action="/messages/send" data-agent="send_msg_form" data-submit-lock="1" data-submit-label="'+L('web.conversation.sending')+'"><input type="hidden" name="validateRecipientUid" value="1">'
        +'<label for="sma">'+L('web.send_message.from_agent')+'</label><select id="sma" name="agentId" required style="width:100%" data-agent="send_agent_sel" autofocus>'+agentOpts+'</select>'
        +'<label for="smu">'+L('web.send_message.to_uid')+'</label><input type="text" id="smu" name="toUid" value="'+prefillUid+'" required style="width:100%" autocomplete="off" data-agent="send_uid_input" placeholder="'+esc(T('web.send_message.to_uid_ph'))+'">'
        +'<p id="smu-status" class="meta" role="status" aria-live="polite" style="margin:5px 0 0"></p>'
        +'<label for="smc">'+L('web.send_message.content')+'</label><textarea id="smc" name="content" required rows="4" style="width:100%" data-agent="send_content_input" placeholder="'+esc(T('web.send_message.content_ph'))+'"></textarea>'
        +'<br><br><button type="submit" class="voko-send-button" data-agent="send_submit_btn">'+L('common.btn.send')+'</button>'
        +'<a href="/send-message" class="btn" style="margin-left:8px">'+L('web.send_message.reset')+'</a></form></div><script>(function(){var form=document.querySelector("[data-agent=send_msg_form]"),sender=document.getElementById("sma"),input=document.getElementById("smu"),status=document.getElementById("smu-status"),button=form&&form.querySelector("[type=submit]"),verified="",checking='+jsonForInlineScript(T('web.send_message.uid_checking'))+',valid='+jsonForInlineScript(T('web.send_message.uid_valid'))+',agentOnline='+jsonForInlineScript(T('web.send_message.agent_online'))+',agentOffline='+jsonForInlineScript(T('web.send_message.agent_offline'))+',agentUnknown='+jsonForInlineScript(T('web.send_message.agent_status_unknown'))+',notFound='+jsonForInlineScript(T('web.send_message.uid_not_found'))+',failed='+jsonForInlineScript(T('web.send_message.uid_check_failed'))+';async function check(){var uid=input.value.trim();verified="";if(!uid){status.textContent="";button.disabled=true;return false}status.className="meta";status.textContent=checking;button.disabled=true;try{var url="/api/im-users/"+encodeURIComponent(uid)+"/exists?agentId="+encodeURIComponent(sender.value||""),r=await fetch(url,{headers:{Accept:"application/json"}}),j=await r.json().catch(function(){return{}});if(!r.ok||!j.success){status.className="error";status.textContent=r.status===404?notFound:failed;return false}verified=uid;if(j.isAgent){status.className=j.isOnline===true?"online":j.isOnline===false?"offline":"unknown";status.textContent=j.isOnline===true?"● "+agentOnline:j.isOnline===false?"○ "+agentOffline:"○ "+agentUnknown}else{status.className="success";status.textContent=valid}button.disabled=false;return true}catch(_){status.className="error";status.textContent=failed;return false}}input.addEventListener("input",function(){if(input.value.trim()!==verified){verified="";button.disabled=true;status.textContent=""}});sender.addEventListener("change",function(){if(input.value.trim())check()});input.addEventListener("blur",check);form.addEventListener("submit",function(e){if(input.value.trim()!==verified){e.preventDefault();check()}});button.disabled=true;if(input.value.trim())check()})();</'+'script>'
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

  R.get('/api/owner-link/device-events', async (req, res) => {
    const controller=new AbortController();
    req.on('close',()=>controller.abort());
    try {
      const ownerEmail=String(currentOwnerEmail()).trim().toLowerCase();
      const userAccessToken=getUserAccessToken(db,ownerEmail);
      if(!userAccessToken)return res.status(401).end();
      const base=String(ENDPOINTS.api.baseUrl||'').replace(/\/+$/,'');
      const response=await fetch(base+'/api/owner-links/v1/device-events',{headers:{Authorization:'Bearer '+userAccessToken,Accept:'text/event-stream'},signal:controller.signal});
      if(!response.ok||!response.body)return res.status(response.status||502).end();
      res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform',Connection:'keep-alive','X-Accel-Buffering':'no'});
      for await(const chunk of response.body){if(res.destroyed)break;res.write(Buffer.from(chunk))}
      if(!res.destroyed)res.end();
    }catch(error){if(error?.name!=='AbortError'&&!res.headersSent)res.status(502).end()}
  });

  R.get('/api/owner-link/devices', async (req, res) => {
    try {
      const ownerEmail=String(currentOwnerEmail()).trim().toLowerCase();
      const userAccessToken=getUserAccessToken(db,ownerEmail);
      if(!userAccessToken)return res.status(401).json({success:false,error:req.t('web.home.owner_link.login_required')});
      const base=String(ENDPOINTS.api.baseUrl||'').replace(/\/+$/,'');
      const response=await fetch(base+'/api/owner-links/v1/devices',{headers:{Authorization:'Bearer '+userAccessToken},signal:AbortSignal.timeout(10000)});
      const result=await response.json().catch(()=>({}));
      if(!response.ok||!result.success)return res.status(response.status||502).json({success:false,error:result?.error?.message||result?.error?.code||req.t('web.home.owner_link.failed')});
      res.json({success:true,data:{devices:result.data?.devices||[]}});
    }catch(error){res.status(502).json({success:false,error:error?.name==='TimeoutError'?req.t('web.home.owner_link.timeout'):req.t('web.home.owner_link.failed')})}
  });

  R.delete('/api/owner-link/devices/:deviceId', async (req, res) => {
    try {
      const ownerEmail=String(currentOwnerEmail()).trim().toLowerCase();
      const userAccessToken=getUserAccessToken(db,ownerEmail);
      if(!userAccessToken)return res.status(401).json({success:false,error:req.t('web.home.owner_link.login_required')});
      const base=String(ENDPOINTS.api.baseUrl||'').replace(/\/+$/,'');
      const response=await fetch(base+'/api/owner-links/v1/devices/'+encodeURIComponent(String(req.params.deviceId||'')),{method:'DELETE',headers:{Authorization:'Bearer '+userAccessToken},signal:AbortSignal.timeout(10000)});
      const result=await response.json().catch(()=>({}));
      if(!response.ok||!result.success)return res.status(response.status||502).json({success:false,error:result?.error?.message||result?.error?.code||req.t('web.home.owner_link.failed')});
      res.json({success:true});
    }catch(error){res.status(502).json({success:false,error:error?.name==='TimeoutError'?req.t('web.home.owner_link.timeout'):req.t('web.home.owner_link.failed')})}
  });

  R.post('/api/owner-link/create', async (req, res) => {
    try {
      const localAgentId=String(req.body?.agentId||'').trim();
      let ownerEmail=String(currentOwnerEmail()).trim().toLowerCase();
      let requestBody={};
      if(localAgentId){
        const row=db.prepare('SELECT did,owner_email FROM agents WHERE agent_id=? LIMIT 1').get(localAgentId);
        if(!row)return res.status(404).json({success:false,error:req.t('web.agent.not_found_title')});
        ownerEmail=String(row.owner_email||ownerEmail).trim().toLowerCase();
        const{serverAgentIdFromDid}=require('../core/agent-invitations');
        const serverAgentId=serverAgentIdFromDid(row.did);
        if(!serverAgentId)return res.status(409).json({success:false,error:req.t('web.home.owner_link.identity_required')});
        requestBody={agentId:serverAgentId};
      }
      const userAccessToken=getUserAccessToken(db,ownerEmail);
      if(!userAccessToken)return res.status(401).json({success:false,error:req.t('web.home.owner_link.login_required')});
      const base=String(ENDPOINTS.api.baseUrl||'').replace(/\/+$/,'');
      const response=await fetch(base+'/api/owner-links/v1',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+userAccessToken},body:JSON.stringify(requestBody),signal:AbortSignal.timeout(10000)});
      const result=await response.json().catch(()=>({}));
      if(!response.ok||!result.success){const error=result?.error?.message||result?.error?.code||req.t('web.home.owner_link.failed');return res.status(response.status||502).json({success:false,error})}
      const data=result.data||{};
      if(typeof data.ownerUrl!=='string'||!data.ownerUrl.startsWith('https://'))return res.status(502).json({success:false,error:req.t('web.home.owner_link.failed')});
      res.status(201).json({success:true,data:{ownerUrl:data.ownerUrl,expiresAt:data.expiresAt||null}});
    }catch(error){res.status(502).json({success:false,error:error?.name==='TimeoutError'?req.t('web.home.owner_link.timeout'):req.t('web.home.owner_link.failed')})}
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
      const agentListResult = await handlers.list_agents({ limit: 500 });
      const agents = agentListResult.agents || [];
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
