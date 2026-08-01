/**
 * register.js — 登录 & 添加 Agent
 *
 * 两个独立页面：
 *   /login       — 邮箱 + 验证码登录
 *   /agent/add   — 已登录用户添加新 Agent
 */

const { Router } = require('express');
const { VOKO_API_URL } = require('../core/api-signature');
const { discoverHermes } = require('../server/hermes-discovery');
const { getClientBundle } = require('../core/i18n');
const { createRegistrationOrchestrator } = require('../core/registration-orchestrator');
const { runWithRegistrationCaller } = require('../core/registration-caller-context');
const { renderLanguageFooter } = require('./language-switcher');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ═══════════════════════════════════════════════════════════════
//  CSS
// ═══════════════════════════════════════════════════════════════

const CSS = `@charset "UTF-8";
*{box-sizing:border-box}
[hidden]{display:none!important}
body{font-family:'PingFang SC','Microsoft YaHei','Noto Sans SC','Hiragino Sans GB',sans-serif;background:linear-gradient(135deg,#f0f4ff 0%,#f5f7fa 100%);color:#1a1a2e;margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px}
a{color:#1a73e8;font-weight:600;text-decoration:none}
.card{background:#fff;border:none;border-radius:16px;padding:28px 32px;box-shadow:0 4px 24px rgba(0,0,0,0.06);width:100%;max-width:420px;margin:0 auto}
.card h2{font-size:22px;font-weight:700;margin:0 0 4px 0;color:#1a1a2e;text-align:center;border:none}
.card p.desc{font-size:14px;color:#888;margin:0 0 20px 0;text-align:center}
label{display:block;margin-top:16px;font-weight:600;font-size:14px;color:#444}
label:first-child{margin-top:0}
input,select,textarea{width:100%;padding:11px 14px;margin-top:4px;background:#f8f9fb;color:#1a1a2e;border:2px solid #e0e4ea;border-radius:10px;font-size:15px;font-family:inherit;outline:none;transition:border-color 0.2s,box-shadow 0.2s}
input:focus,select:focus{border-color:#1a73e8;box-shadow:0 0 0 4px rgba(26,115,232,0.1);background:#fff}
input.error{border-color:#d93025;box-shadow:0 0 0 4px rgba(217,48,37,0.1)}
input.success{border-color:#0f9d58;box-shadow:0 0 0 4px rgba(15,157,88,0.1)}
button,.btn{display:inline-flex;align-items:center;justify-content:center;margin-top:12px;padding:11px 20px;font-size:15px;font-weight:600;cursor:pointer;font-family:inherit;background:#1a73e8;color:#fff;border:none;border-radius:10px;text-decoration:none;transition:background 0.2s,transform 0.1s}
button:hover{background:#1557b0;transform:translateY(-1px)}
.btn-success{background:#0f9d58}
.btn-success:hover{background:#0b8043}
.btn-outline{background:#fff;color:#1a73e8;border:2px solid #1a73e8}
.btn-outline:hover{background:#e8f0fe}.btn-outline:disabled{opacity:0.5;cursor:not-allowed;transform:none}
.btn-sm{padding:8px 14px;font-size:13px;min-width:auto;margin:0}
.meta{color:#888;font-size:14px}
.error{color:#d93025;font-weight:600}
.alert{padding:10px 14px;border-radius:10px;margin-bottom:14px;font-size:14px;font-weight:600}
.alert-error{background:#fce8e6;color:#d93025}
.alert-warning{background:#fff4ce;color:#8a5a00;border:1px solid #f2d675}
.alert-success{background:#e6f4ea;color:#0f9d58}
.oauth-buttons{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:18px}.oauth-buttons[hidden]{display:none}.oauth-btn{display:flex;align-items:center;justify-content:center;gap:8px;min-width:0;width:100%;margin:0;padding-left:10px;padding-right:10px;background:#fff;color:#344054;border:1px solid #d0d5dd;box-shadow:0 1px 2px rgba(16,24,40,.05);font-size:13px;white-space:nowrap}.oauth-btn:hover{background:#f9fafb;color:#1a73e8}.oauth-btn:disabled{opacity:.55;cursor:not-allowed;transform:none}.oauth-icon{width:18px;height:18px;flex:none}.oauth-status{display:none;margin-top:12px;padding:10px 12px;border-radius:9px;background:#f1f6ff;color:#344054;font-size:13px;text-align:center}.oauth-status.error{display:block;background:#fce8e6;color:#b42318}.oauth-status.active{display:block}
.name-status{font-size:13px;margin-top:4px;min-height:20px}
.name-status.checking{color:#e37400}
.name-status.available{color:#0f9d58}
.name-status.taken{color:#d93025}
.code-row{display:flex;gap:8px;align-items:flex-end;margin-top:8px}
.code-row input{flex:1}
.code-row button{margin:0;padding:11px 18px;min-width:80px}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 16px}
.form-actions{display:flex;justify-content:space-between;align-items:center;margin-top:16px;gap:8px}
.form-actions .btn{flex:1;margin:0}
.voko-select{position:relative;width:100%;max-width:460px;margin-top:4px}
.voko-select-trigger{display:flex;align-items:center;justify-content:space-between;padding:11px 14px;background:#f8f9fb;color:#1a1a2e;border:2px solid #e0e4ea;border-radius:10px;font-size:15px;cursor:pointer;transition:border-color 0.2s,box-shadow 0.2s;user-select:none}
.voko-select-trigger:focus{border-color:#1a73e8;box-shadow:0 0 0 4px rgba(26,115,232,0.1);background:#fff;outline:none}
.voko-select-arrow{font-size:11px;color:#888;margin-left:8px;transition:transform 0.2s}
.voko-select-dropdown{display:none;position:absolute;top:100%;left:0;right:0;z-index:100;margin-top:4px;background:#fff;border:2px solid #e0e4ea;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,0.12);overflow:hidden}
.voko-select-search{width:100%;padding:10px 14px;margin:0;background:#f8f9fb;color:#1a1a2e;border:none;border-bottom:2px solid #e0e4ea;border-radius:10px 10px 0 0;font-size:14px;font-family:inherit;outline:none;box-sizing:border-box}
.voko-select-search:focus{background:#fff}
.voko-select-options{max-height:220px;overflow-y:auto;padding:4px 0}
.voko-option{padding:9px 14px;font-size:15px;color:#1a1a2e;cursor:pointer;transition:background 0.12s}
.voko-option:hover{background:#e8f0fe}
.voko-option.selected{background:#e8f0fe;color:#1a73e8;font-weight:600}
@media(max-width:480px){.card{padding:20px 18px}}
.voko-logo{text-align:center;margin-bottom:24px;font-size:20px;font-weight:700;color:#1a73e8;letter-spacing:1px}
.wizard{background:#fff;border-radius:18px;box-shadow:0 12px 40px rgba(20,40,80,.09);width:min(920px,100%);overflow:hidden}
.wizard-head{padding:26px 34px 22px;border-bottom:1px solid #e3e7ee}
.wizard-head h2{text-align:left;margin:0 0 5px;font-size:24px}.wizard-head p{margin:0;color:#667085}
.wizard-steps{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:22px}
.wizard-step{border-top:3px solid #e4e7ec;padding-top:8px;color:#8b95a5;font-weight:600}
.wizard-step.active{border-color:#1a73e8;color:#1a73e8}.wizard-step.done{border-color:#9bbcf7;color:#50617d}
.wizard-step b{display:inline-grid;place-items:center;width:21px;height:21px;border-radius:50%;background:#edf0f4;margin-right:5px;font-size:12px}
.wizard-step.active b{background:#1a73e8;color:#fff}
.wizard-body{padding:30px 34px;min-height:500px}.wizard-panel{display:none}.wizard-panel.active{display:block}
.wizard-footer{display:flex;gap:10px;padding:17px 34px;border-top:1px solid #e3e7ee;background:#fcfcfd}.wizard-footer .spacer{flex:1}
.wizard-footer button{margin:0}.wide-field{max-width:720px}
.detect-banner{margin:18px 0;padding:11px 13px;border-radius:9px;background:#edf4ff;color:#2854a3;font-weight:600}
.provider-list,.delivery-list{display:grid;gap:11px;margin-top:12px}
.provider-card,.delivery-card{display:grid;grid-template-columns:22px minmax(0,1fr);gap:11px;border:1px solid #dfe4ec;border-radius:11px;padding:14px;cursor:pointer}
.provider-card.selected,.delivery-card.selected{border-color:#1a73e8;background:#f1f6ff;box-shadow:inset 0 0 0 1px #1a73e8}
.provider-card input,.delivery-card input{width:auto;margin:3px 0 0;box-shadow:none}.card-title{font-weight:700}.card-desc{display:block;color:#667085;font-size:13px;margin-top:2px}
.tag{display:inline-block;border-radius:999px;padding:2px 7px;background:#e8f6ed;color:#137a46;font-size:12px}.tag.warn{background:#fff3d9;color:#9a5c00}
.instance-panel{width:calc(100% - 10px);margin:-4px 0 4px 10px;padding:10px 12px;border:1px solid #dfe4ec;border-left:3px solid #a7c0f4;border-radius:10px;background:#fafcff;font-size:12px}
.instance-panel label{font-size:12px;margin:7px 0}.instance-panel input{width:auto;margin-right:5px}
.group-label{margin:19px 0 7px;font-weight:700;color:#46536a}.method-meta{display:flex;align-items:center;gap:7px;margin-top:8px}
.method-action{margin:0;padding:4px 9px;font-size:12px;background:#fff;color:#1a73e8;border:1px solid #1a73e8;border-radius:7px}
.method-action:hover{background:#eaf2ff}.config-panel{display:none;margin-top:17px;padding:15px;border:1px solid #b8caee;border-radius:10px;background:#f7f9ff}.config-panel.show{display:block}
.priority-list{margin:8px 0 0;padding-left:22px}.result-card{padding:18px;border:1px solid #a8ddbf;border-radius:12px;background:#ecf8f1}
.result-grid{display:grid;grid-template-columns:105px 1fr;gap:7px 12px;margin-top:15px;padding:13px;background:#fff;border-radius:9px}.result-grid dt{color:#667085}.result-grid dd{margin:0;font-weight:600}
.security-notice{margin-top:16px;padding:12px 13px;border:1px solid #edcf92;border-radius:9px;background:#fff6e3;color:#704600}
.registration-tabs{display:grid;grid-template-columns:1fr 1fr;padding:8px;background:#f4f6f9;border-bottom:1px solid #e3e7ee;gap:8px}.registration-tab{margin:0;background:transparent;color:#667085;border:0;border-radius:9px;padding:10px 14px}.registration-tab:hover{background:#fff;color:#1a73e8;transform:none}.registration-tab.active{background:#fff;color:#1a73e8;box-shadow:0 1px 5px rgba(20,40,80,.09)}.registration-pane[hidden]{display:none}.agent-register-pane{padding:30px 34px}.agent-register-pane h2{margin:0 0 6px}.agent-prompt{width:100%;min-height:360px;resize:vertical;background:#f8fafc;font-family:Consolas,'SFMono-Regular',monospace;font-size:13px;line-height:1.65}.agent-copy-row{display:flex;align-items:center;gap:12px;margin-top:12px}.agent-copy-row button{margin:0}
@media(max-width:600px){.wizard-head,.wizard-body,.wizard-footer{padding-left:18px;padding-right:18px}.wizard-step{font-size:0}.wizard-step b{font-size:12px}.result-grid{grid-template-columns:82px 1fr}}`;

function esc(s) { return (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

function page(title, body, tFn, locale) {
  const loc = locale || 'zh';
  const lang = loc === 'en' ? 'en' : (loc === 'ja' ? 'ja' : 'zh-CN');
  const boot = '<script>window.__LOCALE__=' + JSON.stringify(loc) + ';window.__I18N__=' + JSON.stringify(getClientBundle(loc)) + '</script>';
  const footer = renderLanguageFooter(loc, 'margin-top:18px;font-size:13px;color:#667085;display:flex;justify-content:center');
  return '<!DOCTYPE html>\n<html lang="' + lang + '">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width,initial-scale=1.0">\n<link rel="icon" href="/favicon.png">\n<title>VOKO — ' + esc(title) + '</title>\n<style>' + CSS + '</style>\n' + boot + '\n</head>\n<body>\n' + body + footer + '\n</body>\n</html>';
}

// ═══════════════════════════════════════════════════════════════
//  页面组件
// ═══════════════════════════════════════════════════════════════

const LOGIN_JS = null; // 兼容占位，实际用 loginJs(t)

function loginJs(t) {
  const sent = JSON.stringify(t('register.login.sent'));
  const resend = JSON.stringify(t('register.login.resend'));
  const sendFailed = JSON.stringify(t('register.login.send_failed'));
  const oauthWaiting = JSON.stringify(t('register.login.oauth_waiting'));
  const oauthFailed = JSON.stringify(t('register.login.oauth_failed'));
  return '<script>var I18N_SENT=' + sent + ',I18N_RESEND=' + resend + ',I18N_SEND_FAILED=' + sendFailed + ',I18N_OAUTH_WAITING=' + oauthWaiting + ',I18N_OAUTH_FAILED=' + oauthFailed + ';setTimeout(function(){if(document.querySelector(".alert-error")){var m=document.getElementById("sent-msg");if(m)m.remove()}},0);async function sendCode(){var e=document.getElementById("email").value.trim();if(!e)return;var b=document.getElementById("send-btn");var s=document.getElementById("sent-msg");var se=document.getElementById("sent-email");if(b)b.disabled=true;try{var r=await fetch("/login",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:"action=sendCode&email="+encodeURIComponent(e)});var d=await r.json();if(!r.ok||!d.success)throw new Error(d.error||I18N_SEND_FAILED);s.style.display="block";se.textContent=e;var c=60;var timer=setInterval(function(){b.textContent=I18N_RESEND+"("+c+"s)";c--;if(c<0){clearInterval(timer);b.disabled=false;b.textContent=I18N_RESEND}},1000);var cd=document.getElementById("code");if(cd)cd.focus()}catch(err){if(b)b.disabled=false;window.alert(err.message||I18N_SEND_FAILED)}}async function oauthLogin(provider){var buttons=document.querySelectorAll(".oauth-btn"),status=document.getElementById("oauth-status");buttons.forEach(function(b){b.disabled=true});status.className="oauth-status active";status.textContent=I18N_OAUTH_WAITING;try{var r=await fetch("/api/login/oauth/start",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({provider:provider})}),d=await r.json();if(!r.ok||!d.success)throw new Error(d.error||I18N_OAUTH_FAILED);var popup=window.open(d.authorizeUrl,"_blank");if(!popup)throw new Error(I18N_OAUTH_FAILED);try{popup.opener=null}catch(e){}var delay=Math.max(2,d.pollIntervalSeconds||2)*1000,deadline=Date.parse(d.expiresAt)||Date.now()+600000;while(Date.now()<deadline){await new Promise(function(resolve){setTimeout(resolve,delay)});var sr=await fetch("/api/login/oauth/status/"+encodeURIComponent(d.sessionId)),sd=await sr.json();if(sr.status===410)throw new Error(sd.error||I18N_OAUTH_FAILED);if(!sr.ok||!sd.success)throw new Error(sd.error||I18N_OAUTH_FAILED);if(sd.status==="failed")throw new Error((sd.error&&sd.error.message)||I18N_OAUTH_FAILED);if(sd.status==="authorized"){var er=await fetch("/api/login/oauth/exchange",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sessionId:d.sessionId,exchangeCode:sd.exchangeCode})}),ed=await er.json();if(!er.ok||!ed.success)throw new Error(ed.error||I18N_OAUTH_FAILED);location.href="/login/oauth/complete";return}}throw new Error(I18N_OAUTH_FAILED)}catch(err){status.className="oauth-status error";status.textContent=err.message||I18N_OAUTH_FAILED;buttons.forEach(function(b){b.disabled=false})}}fetch("/api/login/oauth/providers").then(function(r){return r.json()}).then(function(d){if(!d.success)return;(d.providers||[]).forEach(function(p){var b=document.querySelector("[data-oauth-provider="+p.id+"]");if(b)b.hidden=false})}).catch(function(){})</'+'script>';
}

function loginBody(email, err, tFn) {
  const t = tFn || (k => k);
  var alertHtml = err ? '<div class="alert alert-error">' + esc(err) + '</div>' : '';
  alertHtml += '<div class="alert alert-success" id="sent-msg" style="display:none">' + esc(t('register.login.sent')) + ' <span id="sent-email"></span></div>';
  const googleIcon = '<svg class="oauth-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.9h5.4a4.6 4.6 0 0 1-2 3v2.6h3.3c1.9-1.8 2.9-4.4 2.9-7.5Z"/><path fill="#34A853" d="M12 22c2.7 0 5-.9 6.7-2.3l-3.3-2.6c-.9.6-2.1 1-3.4 1a5.9 5.9 0 0 1-5.5-4.1H3.1v2.6A10 10 0 0 0 12 22Z"/><path fill="#FBBC05" d="M6.5 14a6 6 0 0 1 0-3.9V7.4H3.1a10 10 0 0 0 0 9.2L6.5 14Z"/><path fill="#EA4335" d="M12 6c1.5 0 2.8.5 3.9 1.5l2.9-2.9A9.8 9.8 0 0 0 3.1 7.4l3.4 2.7A5.9 5.9 0 0 1 12 6Z"/></svg>';
  const githubIcon = '<svg class="oauth-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 .7a11.5 11.5 0 0 0-3.6 22.4c.6.1.8-.2.8-.5v-2.2c-3.3.7-4-1.4-4-1.4-.5-1.4-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.7 1.3 3.4 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.4 11.4 0 0 1 6 0C14.5 4.8 15.5 5 15.5 5c.6 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.2c0 .3.2.6.8.5A11.5 11.5 0 0 0 12 .7Z"/></svg>';
  return '<div class="voko-logo">VOKO</div>'
    + '<div class="card">'
    + '<h2>' + esc(t('register.login.title')) + '</h2>'
    + '<p class="desc">' + esc(t('register.login.desc')) + '</p>'
    + alertHtml
    + '<form method="POST" action="/login" id="login-form">'
    + '<label for="email">' + esc(t('register.login.email')) + '</label>'
    + '<input type="email" id="email" name="email" value="' + esc(email) + '" required autocomplete="email" autofocus placeholder="you@example.com">'
    + '<div class="code-row" style="margin-top:8px">'
    + '<button type="button" class="btn-outline" style="flex:1;margin:0" id="send-btn" onclick="sendCode()">' + esc(t('register.login.send_code')) + '</button>'
    + '</div>'
    + '<label for="code" style="margin-top:12px">' + esc(t('register.login.code')) + '</label>'
    + '<div class="code-row">'
    + '<input type="text" id="code" name="code" required maxlength="6" autocomplete="one-time-code" placeholder="' + esc(t('register.login.code_ph')) + '">'
    + '<button type="submit" name="action" value="verify" class="btn-success" style="margin:0">' + esc(t('register.login.login_btn')) + '</button>'
    + '</div>'
    + '</form>'
    + '<div class="oauth-buttons" hidden>'
    + '<button type="button" class="oauth-btn" data-oauth-provider="google" onclick="oauthLogin(\'google\')">' + googleIcon + '<span>' + esc(t('register.login.google')) + '</span></button>'
    + '<button type="button" class="oauth-btn" data-oauth-provider="github" onclick="oauthLogin(\'github\')">' + githubIcon + '<span>' + esc(t('register.login.github')) + '</span></button>'
    + '</div><div id="oauth-status" class="oauth-status"></div>'
    + '<p class="desc" style="margin-top:18px"><a href="/bug-report">' + esc(t('web.bug_report.link')) + '</a></p>'
    + '</div>';
}

const { getBackendTypes } = require('../core/agent-backend-types');

function addAgentBody(email, categories, openclawAgents, hermesProfiles, db, tFn) {
  const t = tFn || (k => k);
  const defaultName = t('register.add.default_name', { prefix: (email.split('@')[0] || '') });
  const catOptions = (categories || []).map(c => {
    const key = 'db.agent.category.' + c.code;
    const translated = t(key);
    const label = translated !== key ? translated : c.label;
    const sel = c.code === 'general' ? ' selected' : '';
    return '<option value="' + esc(c.code) + '"' + sel + '>' + esc(label) + '</option>';
  }).join('');
  const ocOptions = (openclawAgents || []).map(a =>
    '<option value="' + esc(a.id) + '">' + esc(a.name || a.id) + '</option>'
  ).join('');
  const hpOptions = (hermesProfiles || []).map(p =>
    '<option value="' + esc(p.name) + '">' + esc(p.name) + (p.isDefault ? ' [' + esc(t('register.add.default')) + ']' : '') + '</option>'
  ).join('');
  const btOpts = getBackendTypes(db).map(bt => {
    const lbl = bt.value === 'others' ? t('db.backend_type.others') : bt.label;
    return '<div class="voko-option" data-value="' + esc(bt.value) + '">' + esc(lbl) + '</div>';
  }).join('');
  return '<div class="voko-logo">VOKO</div>'
    + '<div class="card">'
    + '<h2>' + esc(t('register.add.title')) + '</h2>'
    + '<p class="desc">' + esc(t('register.add.email_label')) + esc(email) + '</p>'
    + '<form method="POST" action="/agent/add" id="agent-form">'
    + '<input type="hidden" name="action" value="createAgent">'
    + '<input type="hidden" name="email" value="' + esc(email) + '">'
    // Agent 类型（可搜索下拉）
    + '<label>' + esc(t('register.add.backend_type')) + '</label>'
    + '<div class="voko-select" id="bt-wrapper">'
    + '<div class="voko-select-trigger" id="bt-trigger" tabindex="0"><span class="voko-select-text" id="bt-text">' + esc(t('register.add.select_ph')) + '</span><span class="voko-select-arrow">▼</span></div>'
    + '<div class="voko-select-dropdown" id="bt-dropdown">'
    + '<input type="text" class="voko-select-search" id="bt-search" placeholder="' + esc(t('register.add.search_ph')) + '" autocomplete="off">'
    + '<div class="voko-select-options" id="bt-options">'
    + btOpts
    + '<div class="voko-option" data-value="__custom__" style="color:#1a73e8;font-weight:600">' + esc(t('register.add.custom_short')) + '</div>'
    + '</div></div>'
    + '<input type="hidden" name="backendType" id="bt" value="">'
    + '<div id="bt-custom-wrap" style="display:none;margin-top:8px">'
    + '<input type="text" id="bt-custom" placeholder="' + esc(t('register.add.custom_ph')) + '" style="width:100%">'
    + '</div>'
    + '</div>'
    // 二级菜单：OpenClaw
    + '<div id="sub-oc" style="display:none;margin-top:8px">'
    + '<label>' + esc(t('register.add.select_oc')) + '</label>'
    + '<select name="openclawAgent"><option value="" disabled selected>' + esc(t('register.add.select_ph')) + '</option>' + ocOptions + '</select>'
    + '</div>'
    // 二级菜单：Hermes
    + '<div id="sub-hp" style="display:none;margin-top:8px">'
    + '<label>' + esc(t('register.add.select_hp')) + '</label>'
    + '<select name="hermesProfile"><option value="" disabled selected>' + esc(t('register.add.select_ph')) + '</option>' + hpOptions + '</select>'
    + '</div>'
    // 名称（带焦点检测）
    + '<label for="an" style="margin-top:16px">' + esc(t('register.add.name')) + ' <span class="meta" style="font-weight:400">(' + esc(t('register.add.name_hint')) + ')</span></label>'
    + '<input type="text" id="an" name="agentName" value="' + esc(defaultName) + '" required placeholder="' + esc(t('register.add.name_ph')) + '">'
    + '<div class="name-status" id="name-status"></div>'
    // 描述
    + '<label for="desc">' + esc(t('register.add.desc')) + '</label>'
    + '<textarea id="desc" name="description" rows="2" placeholder="' + esc(t('register.add.desc_ph')) + '"></textarea>'
    // 分类
    + '<label for="cat">' + esc(t('register.add.category')) + '</label>'
    + '<select id="cat" name="category" required>'
    + '<option value="" disabled>' + esc(t('register.add.select_ph')) + '</option>' + catOptions + '</select>'
    + '<div style="text-align:center;margin-top:16px">'
    + '<button type="submit" class="btn-success" id="create-btn" style="min-width:160px">' + esc(t('register.add.create_btn')) + '</button>'
    + '</div>'
    + '</form>'
    + '</div>';
}

function doneBody(agentName, tFn) {
  const t = tFn || (k => k);
  return '<div class="voko-logo">VOKO</div>'
    + '<div class="card" style="text-align:center">'
    + '<div style="font-size:48px;margin-bottom:10px">✅</div>'
    + '<h2>' + esc(t('register.done.title')) + '</h2>'
    + '<p class="desc">' + t('register.done.msg', { name: esc(agentName) }) + '</p>'
    + '<a href="/" class="btn btn-success" style="margin-top:8px;padding:12px 32px;font-size:16px">' + esc(t('register.done.start')) + '</a>'
    + '</div>';
}

function uniqueDefaultAgentName(email, db, tFn) {
  const t = tFn || (k => k);
  const base = t('register.add.default_name', { prefix: (email.split('@')[0] || '') });
  for (let attempt = 0; attempt < 20; attempt++) {
    const suffix = require('crypto').randomBytes(3).toString('hex').slice(0, 4);
    const candidate = base + '-' + suffix;
    try {
      if (!db?.prepare('SELECT 1 FROM agents WHERE agent_name=? LIMIT 1').get(candidate)) return candidate;
    } catch (_) {
      return candidate;
    }
  }
  return base + '-' + Date.now().toString(36).slice(-6);
}

function addAgentWizardBody(email, categories, db, tFn) {
  const t = tFn || (k => k);
  const categoryOptions = (categories || []).map((category) =>
    '<option value="' + esc(category.code) + '"' + (category.code === 'general' ? ' selected' : '') + '>' + esc(category.label) + '</option>'
  ).join('');
  const defaultName = uniqueDefaultAgentName(email, db, t);
  const agentPrompt = t('register.agent.prompt');
  return '<div class="voko-logo">VOKO</div>'
    + '<main class="wizard" id="registration-wizard" data-email="' + esc(email) + '">'
    + '<nav class="registration-tabs" aria-label="Registration mode"><button type="button" class="registration-tab active" data-registration-tab="human">' + esc(t('register.mode.human')) + '</button><button type="button" class="registration-tab" data-registration-tab="agent">' + esc(t('register.mode.agent')) + '</button></nav>'
    + '<div class="registration-pane" id="registration-human-pane">'
    + '<header class="wizard-head"><h2>' + esc(t('register.add.title')) + '</h2><p>' + esc(t('register.flow.subtitle')) + '</p>'
    + '<div class="wizard-steps">'
    + '<div class="wizard-step active"><b>1</b>' + esc(t('register.flow.step.basic')) + '</div>'
    + '<div class="wizard-step"><b>2</b>' + esc(t('register.flow.step.provider')) + '</div>'
    + '<div class="wizard-step"><b>3</b>' + esc(t('register.flow.step.delivery')) + '</div>'
    + '<div class="wizard-step"><b>4</b>' + esc(t('register.flow.step.done')) + '</div>'
    + '</div></header>'
    + '<div class="wizard-body">'
    + '<section class="wizard-panel active" data-step="1"><h3>' + esc(t('register.flow.basic.title')) + '</h3><p class="meta">' + esc(t('register.flow.basic.desc')) + '</p>'
    + '<div class="wide-field"><label for="wf-name">' + esc(t('register.add.name')) + ' *</label><input id="wf-name" value="' + esc(defaultName) + '" required>'
    + '<div class="name-status" id="wf-name-status"></div>'
    + '<label for="wf-desc">' + esc(t('register.add.desc')) + '</label><textarea id="wf-desc" rows="3" placeholder="' + esc(t('register.add.desc_ph')) + '"></textarea>'
    + '<label for="wf-category">' + esc(t('register.add.category')) + '</label><select id="wf-category">' + categoryOptions + '</select></div></section>'
    + '<section class="wizard-panel" data-step="2"><h3>' + esc(t('register.flow.provider.title')) + '</h3><p class="meta">' + esc(t('register.flow.provider.desc')) + '</p>'
    + '<div class="detect-banner" id="wf-detect">' + esc(t('register.flow.detecting')) + '</div><div id="wf-providers"></div></section>'
    + '<section class="wizard-panel" data-step="3"><h3>' + esc(t('register.flow.delivery.title')) + '</h3><p class="meta" id="wf-delivery-desc"></p>'
    + '<div class="delivery-list" id="wf-deliveries"></div>'
    + '<div class="config-panel" id="wf-config"><h3 id="wf-config-title"></h3><p class="meta" id="wf-config-desc"></p><pre id="wf-config-log" style="display:none;max-height:180px;overflow:auto;background:#182033;color:#b8f7c8;padding:9px;border-radius:7px;white-space:pre-wrap"></pre>'
    + '<button type="button" class="btn-outline btn-sm" id="wf-config-back">' + esc(t('common.btn.cancel')) + '</button> '
    + '<button type="button" class="btn-success btn-sm" id="wf-config-confirm">' + esc(t('register.flow.configure.confirm')) + '</button></div>'
    + '<div class="alert alert-warning" id="wf-pull-warning" style="display:none;margin-top:15px">' + esc(t('register.flow.pull_only')) + '</div>'
    + '<div style="margin-top:18px"><strong>' + esc(t('register.flow.delivery.order')) + '</strong><ol class="priority-list" id="wf-order"></ol></div></section>'
    + '<section class="wizard-panel" data-step="4"><h3 id="wf-step4-title">' + esc(t('register.flow.access.title')) + '</h3><p class="meta" id="wf-access-desc">' + esc(t('register.flow.access.desc')) + '</p><div id="wf-result"></div></section>'
    + '</div>'
    + '<footer class="wizard-footer"><button type="button" class="btn-outline" id="wf-prev" style="visibility:hidden">' + esc(t('register.flow.previous')) + '</button><span class="spacer"></span><button type="button" id="wf-next">' + esc(t('register.flow.next')) + '</button></footer></div>'
    + '<section class="registration-pane agent-register-pane" id="registration-agent-pane" hidden>'
    + '<h2>' + esc(t('register.agent.title')) + '</h2><p class="meta">' + esc(t('register.agent.desc')) + '</p>'
    + '<textarea class="agent-prompt" id="agent-registration-prompt" readonly>' + esc(agentPrompt) + '</textarea>'
    + '<div class="agent-copy-row"><button type="button" id="copy-agent-registration">' + esc(t('register.agent.copy')) + '</button><span class="meta" id="copy-agent-registration-status" aria-live="polite"></span></div></section>'
    + '</main>';
}

function wizardJs(t) {
  const I = {
    next: t('register.flow.next'), enter: t('register.done.start'),
    detecting: t('register.flow.detecting'), detected: t('register.flow.detected'),
    local: t('register.flow.provider.local'), more: t('register.flow.provider.more'),
    others: t('db.backend_type.others'), othersDesc: t('register.flow.provider.others_desc'),
    detectedTag: t('register.flow.detected_tag'), manualTag: t('register.flow.manual_tag'),
    instance: t('register.flow.instance.title'), deliveryDesc: t('register.flow.delivery.for_provider'),
    primary: t('register.flow.delivery.primary'), fallback: t('register.flow.delivery.fallback'),
    configure: t('register.flow.configure'), test: t('register.flow.test'),
    configuring: t('register.flow.configuring'), configured: t('register.flow.configured'),
    testing: t('register.flow.testing'), testOk: t('register.flow.test_ok'), testFailed: t('register.flow.test_failed'),
    configureDesc: t('register.flow.configure.desc'), configureConfirm: t('register.flow.configure.confirm'),
    create: t('register.add.create_btn'), creating: t('register.add.creating'),
    created: t('register.flow.done.created'), deliveryOrder: t('register.flow.delivery.order'),
    priority: t('register.flow.priority'), backup: t('register.flow.backup'), finalFallback: t('register.flow.final_fallback'),
    only: t('register.flow.only'), pullOnly: t('register.flow.pull_only'),
    securityTitle: t('register.flow.security_title'), security: t('register.flow.security'),
    name: t('register.add.name'), description: t('register.add.desc'), category: t('register.add.category'),
    provider: t('register.add.backend_type'), instanceLabel: t('register.flow.instance.label'),
    nameTaken: t('register.add.name_taken'),
    accessTitle: t('register.flow.access.title'), accessDesc: t('register.flow.access.desc'),
    privateMode: t('register.flow.access.private'), privateDesc: t('register.flow.access.private_desc'),
    publicMode: t('register.flow.access.public'), publicDesc: t('register.flow.access.public_desc'),
    accessMode: t('register.flow.access.label'), searchableBy: t('register.flow.done.searchable_by'),
    searchName: t('register.flow.done.search_name'), searchEmail: t('register.flow.done.search_email'),
    exactId: t('register.flow.done.exact_id'),
    copied: t('register.agent.copied'),
    error: t('register.create_failed_default'),
  };
  return `<script>
(function(){
  var I=${JSON.stringify(I)}, root=document.getElementById('registration-wizard');
  if(!root)return;
  var step=1, regId='', state=null, selectedProvider='', selectedInstance='', selectedAccessMode='private', configMode='', discardDraft=false;
  var draftKey='voko.agentRegistrationDraft', restoredDraft=null;
  var panels=Array.from(document.querySelectorAll('.wizard-panel')), steps=Array.from(document.querySelectorAll('.wizard-step'));
  var next=document.getElementById('wf-next'), prev=document.getElementById('wf-prev');
  var nameInput=document.getElementById('wf-name'),nameStatus=document.getElementById('wf-name-status'),nameCheckedValue='',nameBlocked=false;
  var tabs=Array.from(document.querySelectorAll('[data-registration-tab]')),humanPane=document.getElementById('registration-human-pane'),agentPane=document.getElementById('registration-agent-pane'),tabModeKey='voko.agentRegistrationMode';
  function activateRegistrationTab(mode){var agent=mode==='agent';tabs.forEach(function(item){item.classList.toggle('active',item.dataset.registrationTab===mode)});humanPane.hidden=agent;agentPane.hidden=!agent;try{sessionStorage.setItem(tabModeKey,mode)}catch(_){}}
  tabs.forEach(function(tab){tab.addEventListener('click',function(){activateRegistrationTab(tab.dataset.registrationTab)})});
  try{activateRegistrationTab(sessionStorage.getItem(tabModeKey)==='agent'?'agent':'human')}catch(_){activateRegistrationTab('human')}
  document.getElementById('copy-agent-registration').addEventListener('click',async function(){var prompt=document.getElementById('agent-registration-prompt').value,status=document.getElementById('copy-agent-registration-status');try{await navigator.clipboard.writeText(prompt)}catch(_){var area=document.getElementById('agent-registration-prompt');area.focus();area.select();document.execCommand('copy')}status.textContent=I.copied});
  function api(action,data){return fetch('/api/agent-registration',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({action:action,registrationId:regId},data||{}))}).then(async function(r){var d=await r.json();if(!r.ok||d.success===false)throw new Error(d.error||I.error);return d})}
  function show(n){step=n;panels.forEach(function(p,i){p.classList.toggle('active',i===n-1)});steps.forEach(function(s,i){s.classList.toggle('active',i===n-1);s.classList.toggle('done',i<n-1)});prev.style.visibility=n===1||state&&state.status==='created'?'hidden':'visible';next.textContent=n===4?(state&&state.status==='created'?I.enter:I.create):I.next;saveDraft()}
  function escHtml(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
  function readDraft(){try{var d=JSON.parse(sessionStorage.getItem(draftKey)||'null');return d&&d.email===root.dataset.email?d:null}catch(_){return null}}
  function saveDraft(){if(discardDraft)return;try{sessionStorage.setItem(draftKey,JSON.stringify({email:root.dataset.email,registrationId:regId,step:step,name:nameInput.value,description:document.getElementById('wf-desc').value,category:document.getElementById('wf-category').value,provider:selectedProvider,instance:selectedInstance,accessMode:selectedAccessMode,moreExpanded:moreProvidersExpanded}))}catch(_){}}
  function applyDraftFields(d){if(!d)return;nameInput.value=d.name||nameInput.value;document.getElementById('wf-desc').value=d.description||'';if(d.category)document.getElementById('wf-category').value=d.category;selectedProvider=d.provider||'';selectedInstance=d.instance||'';selectedAccessMode=d.accessMode==='public'?'public':'private';moreProvidersExpanded=!!d.moreExpanded}
  function restore(d){
    state=d;
    if(d.basicInfo){nameInput.value=d.basicInfo.agentName||nameInput.value;document.getElementById('wf-desc').value=d.basicInfo.description||'';document.getElementById('wf-category').value=d.basicInfo.category||'general'}
    if(d.provider){selectedProvider=d.provider.type||selectedProvider;selectedInstance=d.provider.instanceId||selectedInstance}
    if(d.status==='provider_selection_required'){renderProviders(d.environment);show(2)}
    else if(d.status==='delivery_selection_required'){if(d.environment)renderProviders(d.environment);renderDeliveries(d);show(3)}
    else if(d.status==='ready_to_create'){if(d.environment)renderProviders(d.environment);renderDeliveries(d);renderAccess();show(4)}
    else if(d.status==='created'){renderResult(d);show(4)}
    else show(1);
    next.disabled=false;
  }
  function start(){var forceNew=new URLSearchParams(location.search).get('new')==='1';if(forceNew){try{sessionStorage.removeItem(draftKey)}catch(_){}try{history.replaceState(null,'',location.pathname)}catch(_){}}restoredDraft=forceNew?null:readDraft();applyDraftFields(restoredDraft);if(restoredDraft&&restoredDraft.registrationId){regId=restoredDraft.registrationId;api('status').then(restore).catch(function(){sessionStorage.removeItem(draftKey);regId='';api('start',{email:root.dataset.email}).then(function(d){regId=d.registrationId;saveDraft()}).catch(fail)});return}api('start',{email:root.dataset.email}).then(function(d){regId=d.registrationId;saveDraft()}).catch(fail)}
  function fail(e){window.alert(e.message||I.error);next.disabled=false;next.textContent=I.next}
  function checkName(){
    var name=nameInput.value.trim();
    if(!name){nameBlocked=true;nameStatus.className='name-status taken';nameStatus.textContent=I.nameTaken;return Promise.resolve(false)}
    if(name===nameCheckedValue&&!nameBlocked)return Promise.resolve(true);
    return fetch('/api/agent/check-name?name='+encodeURIComponent(name)).then(function(r){if(!r.ok)throw new Error('NAME_CHECK_UNAVAILABLE');return r.json()}).then(function(d){
      if(d.available){nameCheckedValue=name;nameBlocked=false;nameStatus.className='name-status';nameStatus.textContent='';nameInput.className='';return true}
      nameBlocked=true;nameStatus.className='name-status taken';nameStatus.textContent=I.nameTaken;nameInput.className='error';return false
    }).catch(function(){nameBlocked=false;nameStatus.className='name-status';nameStatus.textContent='';nameInput.className='';return true})
  }
  nameInput.addEventListener('blur',function(){if(step===1)next.disabled=true;checkName().then(function(ok){if(step===1)next.disabled=!ok})});
  nameInput.addEventListener('input',function(){nameCheckedValue='';nameBlocked=false;nameStatus.className='name-status';nameStatus.textContent='';nameInput.className='';if(step===1)next.disabled=false});
  function providerCard(p,detected){var detail=detected?'':'<span class="card-desc">'+escHtml(I.othersDesc)+'</span>';return '<label class="provider-card'+(selectedProvider===p.type?' selected':'')+'"><input type="radio" name="wf-provider" value="'+escHtml(p.type)+'"'+(selectedProvider===p.type?' checked':'')+'><span><span class="card-title">'+escHtml(p.label)+'</span> <span class="tag '+(detected?'':'warn')+'">'+escHtml(detected?I.detectedTag:I.manualTag)+'</span>'+detail+'</span></label>'}
  var moreProvidersExpanded=false;
  function renderProviders(env){
    var detected=env.detected||[];if(!selectedProvider)selectedProvider=detected[0]?detected[0].type:'others';
    var html='<div class="group-label">'+escHtml(I.local)+'</div><div class="provider-list">';
    detected.forEach(function(p){html+=providerCard(p,true);if(selectedProvider===p.type&&p.instances&&p.instances.length>1){html+='<div class="instance-panel"><strong>'+escHtml(p.instances.length+' '+I.instance)+'</strong>';p.instances.forEach(function(ins,i){var checked=selectedInstance?selectedInstance===ins.id:i===0;if(checked&&!selectedInstance)selectedInstance=ins.id;html+='<label><input type="radio" name="wf-instance" value="'+escHtml(ins.id)+'"'+(checked?' checked':'')+'> '+escHtml(ins.name)+'</label>'});html+='</div>'}});
    html+='</div><details id="wf-more-providers"'+(moreProvidersExpanded?' open':'')+'><summary class="group-label">'+escHtml(I.more)+'</summary><div class="provider-list">';
    (env.more||[]).forEach(function(p){html+=providerCard(p,false)});
    html+=providerCard({type:'others',label:I.others,instances:[]},false)+'</div></details>';
    document.getElementById('wf-providers').innerHTML=html;
    document.getElementById('wf-more-providers').addEventListener('toggle',function(e){moreProvidersExpanded=e.target.open;saveDraft()});
    document.getElementById('wf-detect').textContent=I.detected.replace('{providers}',env.summary.providerCount).replace('{modes}',env.summary.deliveryModeCount);
  }
  document.getElementById('wf-providers').addEventListener('change',function(e){if(e.target.name==='wf-provider'){selectedProvider=e.target.value;selectedInstance='';renderProviders(state.environment)}else if(e.target.name==='wf-instance'){selectedInstance=e.target.value}saveDraft()});
  function modeCard(m){
    var disabled=m.required||m.status!=='ready', checked=m.required||m.selected;
    return '<label class="delivery-card'+(checked?' selected':'')+'"><input type="checkbox" data-mode="'+escHtml(m.mode)+'"'+(checked?' checked':'')+(disabled?' disabled':'')+'><span><span class="card-title">'+escHtml(m.label)+'</span><span class="card-desc">'+escHtml(m.description)+'</span><span class="method-meta"><span class="tag '+(m.status==='configuration_required'?'warn':'')+'">'+escHtml(m.status==='configuration_required'?I.configure:m.status==='ready'?I.configured:I.testFailed)+'</span>'+(m.action?'<button type="button" class="method-action" data-action="'+escHtml(m.action)+'" data-mode="'+escHtml(m.mode)+'">'+escHtml(m.action==='configure'?I.configure:I.test)+'</button>':'')+'</span></span></label>'
  }
  function renderDeliveries(d){
    state=d;var modes=d.deliveryModes||[],html='';
    document.getElementById('wf-delivery-desc').textContent=I.deliveryDesc.replace('{provider}',d.provider.type);
    var primary=modes.filter(function(m){return m.role==='primary'}),fallback=modes.filter(function(m){return m.role!=='primary'});
    if(primary.length)html+='<div class="group-label">'+escHtml(I.primary)+'</div>'+primary.map(modeCard).join('');
    html+='<div class="group-label">'+escHtml(I.fallback)+'</div>'+fallback.map(modeCard).join('');
    document.getElementById('wf-deliveries').innerHTML=html;updateOrder();
  }
  function selectedModes(){return Array.from(document.querySelectorAll('#wf-deliveries input:checked')).map(function(x){return x.dataset.mode})}
  function updateOrder(){var names=Array.from(document.querySelectorAll('#wf-deliveries input:checked')).map(function(x){return x.closest('.delivery-card').querySelector('.card-title').textContent});document.getElementById('wf-order').innerHTML=names.map(function(n,i){var role=i===names.length-1&&n.indexOf('主动')>=0?(names.length===1?I.only:I.finalFallback):(i===0?I.priority:I.backup);return '<li>'+escHtml(n)+' <span class="tag">'+escHtml(role)+'</span></li>'}).join('');document.getElementById('wf-pull-warning').style.display=names.length===1?'block':'none'}
  document.getElementById('wf-deliveries').addEventListener('change',function(e){if(e.target.type==='checkbox'){e.target.closest('.delivery-card').classList.toggle('selected',e.target.checked);updateOrder()}});
  function renderAccess(){document.getElementById('wf-step4-title').textContent=I.accessTitle;document.getElementById('wf-access-desc').textContent=I.accessDesc;document.getElementById('wf-result').innerHTML='<div class="provider-list"><label class="provider-card'+(selectedAccessMode==='private'?' selected':'')+'"><input type="radio" name="wf-access" value="private"'+(selectedAccessMode==='private'?' checked':'')+'><span><span class="card-title">'+escHtml(I.privateMode)+'</span><span class="card-desc">'+escHtml(I.privateDesc)+'</span></span></label><label class="provider-card'+(selectedAccessMode==='public'?' selected':'')+'"><input type="radio" name="wf-access" value="public"'+(selectedAccessMode==='public'?' checked':'')+'><span><span class="card-title">'+escHtml(I.publicMode)+'</span><span class="card-desc">'+escHtml(I.publicDesc)+'</span></span></label></div>'}
  document.getElementById('wf-result').addEventListener('change',function(e){if(e.target.name==='wf-access'){selectedAccessMode=e.target.value;renderAccess();saveDraft()}});
  var configApprovalToken='';
  document.getElementById('wf-deliveries').addEventListener('click',function(e){var b=e.target.closest('.method-action');if(!b)return;e.preventDefault();if(b.dataset.action==='configure'){configMode=b.dataset.mode;b.disabled=true;api('configure_delivery',{mode:configMode}).then(function(r){configApprovalToken=r.approvalToken||'';document.getElementById('wf-config-title').textContent=I.configure+' '+b.closest('.delivery-card').querySelector('.card-title').textContent;document.getElementById('wf-config-desc').textContent=(r.changePlan&&r.changePlan.message)||I.configureDesc;document.getElementById('wf-config').classList.add('show');b.disabled=false}).catch(function(e2){b.disabled=false;fail(e2)})}else{b.disabled=true;b.textContent=I.testing;api('test_delivery',{mode:b.dataset.mode}).then(function(r){b.disabled=false;b.textContent=r.ready?I.testOk:I.testFailed}).catch(fail)}});
  document.getElementById('wf-config-back').onclick=function(){document.getElementById('wf-config').classList.remove('show')};
  document.getElementById('wf-config-confirm').onclick=function(){var b=this;b.disabled=true;b.textContent=I.configuring;api('configure_delivery',{mode:configMode,approved:true,approvalToken:configApprovalToken}).then(function(r){configApprovalToken='';poll(r.taskId,b)}).catch(function(e){b.disabled=false;b.textContent=I.configureConfirm;fail(e)})};
  function poll(taskId,b){var log=document.getElementById('wf-config-log');log.style.display='block';var timer=setInterval(function(){api('configuration_status',{taskId:taskId}).then(function(r){log.textContent=(r.logs||[]).join('\\n');if(r.done){clearInterval(timer);b.disabled=false;b.textContent=I.configureConfirm;if(r.ok){api('status').then(renderDeliveries);document.getElementById('wf-config').classList.remove('show')}}}).catch(function(e){clearInterval(timer);fail(e)})},1000)}
  next.onclick=function(){
    next.disabled=true;
    if(step===1){checkName().then(function(ok){if(!ok){next.disabled=true;return}return api('set_basic_info',{agentName:nameInput.value,description:document.getElementById('wf-desc').value,category:document.getElementById('wf-category').value}).then(function(d){state=d;renderProviders(d.environment);show(2);next.disabled=false})}).catch(fail);return}
    if(step===2){api('select_provider',{providerType:selectedProvider,instanceId:selectedInstance}).then(function(d){renderDeliveries(d);show(3);next.disabled=false}).catch(fail);return}
    if(step===3){api('select_delivery',{deliveryModes:selectedModes()}).then(function(d){state=d;renderAccess();show(4);next.disabled=false}).catch(fail);return}
    if(step===4&&(!state||state.status!=='created')){next.textContent=I.creating;api('complete',{accessMode:selectedAccessMode}).then(function(d){state=d;renderResult(d);show(4);next.disabled=false}).catch(fail);return}
    discardDraft=true;
    try{sessionStorage.removeItem(draftKey)}catch(_){}
    location.href='/';
  };
  prev.onclick=function(){if(step>1){show(step-1)}};
  root.addEventListener('input',saveDraft);
  root.addEventListener('change',saveDraft);
  window.addEventListener('pagehide',saveDraft);
  function renderResult(d){var r=d.result||{},p=r.provider||{},rows=(r.deliveryOrder||[]).map(function(m){var role=m.role==='primary'?I.priority:m.role==='fallback'?I.backup:m.role==='only'?I.only:I.finalFallback;return '<div>'+m.priority+'. '+escHtml(m.label)+' <span class="tag">'+escHtml(role)+'</span></div>'}).join('');document.getElementById('wf-step4-title').textContent=I.created;document.getElementById('wf-access-desc').textContent='';document.getElementById('wf-result').innerHTML='<div class="result-card"><h3>✓ '+escHtml(I.created)+'</h3><dl class="result-grid"><dt>'+escHtml(I.name)+'</dt><dd>'+escHtml(r.agentName)+'</dd><dt>'+escHtml(I.description)+'</dt><dd>'+escHtml(r.description||'-')+'</dd><dt>'+escHtml(I.category)+'</dt><dd>'+escHtml(r.category)+'</dd><dt>'+escHtml(I.provider)+'</dt><dd>'+escHtml(p.type||'others')+'</dd><dt>'+escHtml(I.instanceLabel)+'</dt><dd>'+escHtml(p.instanceName||'-')+'</dd><dt>'+escHtml(I.accessMode)+'</dt><dd>'+escHtml(r.accessMode==='public'?I.publicMode:I.privateMode)+'</dd><dt>'+escHtml(I.deliveryOrder)+'</dt><dd>'+rows+'</dd></dl><h4>'+escHtml(I.searchableBy)+'</h4><dl class="result-grid"><dt>'+escHtml(I.searchName)+'</dt><dd>'+escHtml(r.agentName)+'</dd><dt>'+escHtml(I.searchEmail)+'</dt><dd>'+escHtml(r.ownerEmail||root.dataset.email)+'</dd><dt>'+escHtml(I.exactId)+'</dt><dd>'+escHtml(r.agentId)+'</dd></dl><div class="security-notice"><strong>'+escHtml(I.securityTitle)+'</strong><br>'+escHtml(I.security)+'</div></div>'}
  start();
})();
</script>`;
}

// ═══════════════════════════════════════════════════════════════
//  JS：名称焦点检测 + 分类加载
// ═══════════════════════════════════════════════════════════════

function pageJs(t) {
  const i18nObj = {
    checking: t('register.add.name_checking'),
    available: t('register.add.name_available'),
    taken: t('register.add.name_taken'),
    no_match: t('register.add.no_match'),
    custom: t('register.add.custom_short'),
    creating: t('register.add.creating'),
    detecting: t('register.add.detecting'),
    create: t('register.add.create_btn'),
    gw_warn: t('register.add.gw_warn'),
    gw_cli: t('register.add.gw_cli'),
    gw_after: t('register.add.gw_after'),
    gw_setup: t('register.add.gw_setup'),
    gw_skip: t('register.add.gw_skip'),
    gw_retry: t('register.add.gw_retry'),
    gw_configuring: t('register.add.gw_configuring'),
    gw_starting: t('register.add.gw_starting'),
    gw_start_failed: t('register.add.gw_start_failed'),
    gw_success: t('register.add.gw_success'),
    gw_incomplete: t('register.add.gw_incomplete'),
    unknown: t('register.add.unknown'),
  };
  return `<script>
var I = ${JSON.stringify(i18nObj)};

(function(){
  // ── Agent 名称：光标移至末尾 ──
  var nameInput = document.getElementById('an');
  if (nameInput) {
    nameInput.focus();
    nameInput.setSelectionRange(nameInput.value.length, nameInput.value.length);
  }

  // ── Agent 名称焦点离开检测 ──
  if (nameInput) {
  var nameStatus = document.getElementById('name-status');
  if (nameInput && nameStatus) {
    var checkTimer = null;
    nameInput.addEventListener('blur', function(){
      var name = nameInput.value.trim();
      if (!name) { nameStatus.className = 'name-status'; nameStatus.textContent = ''; return; }
      nameStatus.className = 'name-status checking';
      nameStatus.textContent = I.checking;
      nameInput.className = '';
      fetch('/api/agent/check-name?name=' + encodeURIComponent(name)).then(function(r){return r.json()}).then(function(d){
        if (d.available) {
          nameStatus.className = 'name-status available';
          nameStatus.textContent = I.available;
          nameInput.className = 'success';
        } else {
          nameStatus.className = 'name-status taken';
          nameStatus.textContent = I.taken;
          nameInput.className = 'error';
        }
      }).catch(function(){
        nameStatus.className = 'name-status';
        nameStatus.textContent = '';
      });
    });
    // 输入时清除状态
    nameInput.addEventListener('input', function(){
      nameStatus.className = 'name-status';
      nameStatus.textContent = '';
      nameInput.className = '';
    });
  }
  }

  // ── 创建前：检测长连接条件（openclaw/hermes），不配可用 CLI 兜底 ──
  var createBtn = document.getElementById('create-btn');
  var agentForm = document.getElementById('agent-form');
  var btWrapper = document.getElementById('bt-wrapper');
  var btTrigger = document.getElementById('bt-trigger');
  var btDropdown = document.getElementById('bt-dropdown');
  var btSearch = document.getElementById('bt-search');
  var btHidden = document.getElementById('bt');
  var btText = document.getElementById('bt-text');
  var btOptionsContainer = document.getElementById('bt-options');
  var btAllOptions = btOptionsContainer ? Array.from(btOptionsContainer.querySelectorAll('.voko-option')) : [];
  var btSel = btHidden; // 向后兼容：表单提交处理中通过 btSel.value 读取

  // ── 下拉展开/收起 ──
  function openDropdown() {
    btDropdown.style.display = 'block';
    btSearch.focus();
  }
  function closeDropdown() {
    btDropdown.style.display = 'none';
    btSearch.value = '';
    btAllOptions.forEach(function(o){ o.style.display = ''; });
    var hint = btOptionsContainer.querySelector('.voko-option-empty');
    if (hint) hint.remove();
  }
  if (btTrigger && btDropdown) {
    btTrigger.addEventListener('click', function(e){
      e.stopPropagation();
      if (btDropdown.style.display === 'block') { closeDropdown(); }
      else { openDropdown(); }
    });
  }

  // ── 模糊搜索：在下拉框内输入关键字过滤 ──
  if (btSearch && btOptionsContainer) {
    btSearch.addEventListener('input', function(){
      var q = btSearch.value.toLowerCase();
      var hasMatch = false;
      btAllOptions.forEach(function(o){
        if (!q || o.textContent.toLowerCase().indexOf(q) !== -1) {
          o.style.display = ''; hasMatch = true;
        } else {
          o.style.display = 'none';
        }
      });
      var hint = btOptionsContainer.querySelector('.voko-option-empty');
      if (!hasMatch && q) {
        if (!hint) { hint = document.createElement('div'); hint.className = 'voko-option voko-option-empty'; hint.style.cssText = 'color:#999;cursor:default'; hint.textContent = I.no_match; btOptionsContainer.appendChild(hint); }
      } else if (hint) { hint.remove(); }
    });
    btSearch.addEventListener('click', function(e){ e.stopPropagation(); });
  }

  // ── 选项点击 ──
  var btCustomWrap = document.getElementById('bt-custom-wrap');
  var btCustomInput = document.getElementById('bt-custom');
  if (btOptionsContainer) {
    btOptionsContainer.addEventListener('click', function(e){
      var opt = e.target.closest('.voko-option');
      if (!opt || opt.classList.contains('voko-option-empty')) return;
      var val = opt.getAttribute('data-value');
      if (val === '__custom__') {
        btHidden.value = '';
        btText.textContent = I.custom;
        if (btCustomWrap) btCustomWrap.style.display = 'block';
        if (btCustomInput) { btCustomInput.focus(); btCustomInput.value = ''; }
        closeDropdown();
        return;
      }
      if (btCustomWrap) btCustomWrap.style.display = 'none';
      btHidden.value = val;
      btText.textContent = opt.textContent;
      closeDropdown();
      btHidden.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }
  if (btCustomInput) {
    btCustomInput.addEventListener('input', function(){
      btHidden.value = btCustomInput.value.trim();
    });
  }

  if (btSearch) {
    btSearch.addEventListener('keydown', function(e){
      if (e.key === 'Escape') { closeDropdown(); btTrigger.focus(); }
    });
  }
  if (btTrigger) {
    btTrigger.addEventListener('keydown', function(e){
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDropdown(); }
    });
  }

  document.addEventListener('click', function(e){
    if (btWrapper && !btWrapper.contains(e.target)) { closeDropdown(); }
  });

  // ── 选 openclaw/hermes 时立即检测长连接条件 ──
  if (btHidden) {
    btHidden.addEventListener('change', function(){
      var b = btHidden.value;
      var subOc = document.getElementById('sub-oc');
      var subHp = document.getElementById('sub-hp');
      if (subOc) subOc.style.display = b === 'openclaw' ? 'block' : 'none';
      if (subHp) subHp.style.display = b === 'hermes' ? 'block' : 'none';
      if (b === 'openclaw' || b === 'hermes') {
        fetch('/api/gateway/check?backend=' + encodeURIComponent(b))
          .then(function(r){return r.json()})
          .then(function(info){ if (!info.ready) { _showGatewayPanel(b); createBtn.style.display = 'none'; } else { var p=document.getElementById('gw-panel');if(p)p.remove();createBtn.style.display=''; } })
          .catch(function(){});
      } else {
        var p = document.getElementById('gw-panel'); if (p) p.remove();
        createBtn.style.display = '';
      }
    });
  }
  if (createBtn && agentForm) {
    agentForm.addEventListener('submit', function(e){
      var backend = btSel ? btSel.value : '';
      if (btCustomWrap && btCustomWrap.style.display !== 'none' && !backend) {
        e.preventDefault();
        if (btCustomInput) { btCustomInput.focus(); btCustomInput.className = 'error'; }
        return;
      }
      if (backend !== 'openclaw' && backend !== 'hermes') {
        createBtn.disabled = true; createBtn.textContent = I.creating;
        return;
      }
      e.preventDefault();
      createBtn.disabled = true; createBtn.textContent = I.detecting;
      fetch('/api/gateway/check?backend=' + encodeURIComponent(backend))
        .then(function(r){return r.json()})
        .then(function(info){
          if (info.ready) { createBtn.textContent = I.creating; agentForm.submit(); return; }
          createBtn.disabled = false; createBtn.textContent = I.create;
          _showGatewayPanel(backend);
          createBtn.style.display = 'none';
        })
        .catch(function(){ createBtn.textContent = I.creating; agentForm.submit(); });
    });
  }

  function _showGatewayPanel(backend) {
    var old = document.getElementById('gw-panel'); if (old) old.remove();
    var modeName = backend === 'openclaw' ? 'WebSocket' : 'HTTP API';
    var panel = document.createElement('div');
    panel.id = 'gw-panel';
    panel.style.cssText = 'margin-top:16px;padding:14px;border:2px solid #e37400;border-radius:10px;background:#fff8f0;font-size:14px;text-align:left';
    panel.innerHTML =
      '<div style="font-weight:700;color:#e37400;margin-bottom:8px">' + I.gw_warn.replace('{mode}', modeName) + '</div>'
      + '<div style="color:#555;line-height:1.6;margin-bottom:6px">' + I.gw_cli + '</div>'
      + '<div style="color:#555;line-height:1.6;margin-bottom:12px">' + I.gw_after.replace('{mode}', modeName) + '</div>'
      + '<div style="display:flex;gap:8px">'
      + '<button type="button" id="gw-setup-btn" class="btn-success" style="margin:0;white-space:nowrap">' + I.gw_setup + '</button>'
      + '<button type="button" id="gw-skip-btn" class="btn-outline" style="margin:0;white-space:nowrap">' + I.gw_skip + '</button>'
      + '</div>'
      + '<pre id="gw-log" style="display:none;margin-top:10px;font-size:12px;line-height:1.5;max-height:200px;overflow-y:auto;background:#1a1a2e;color:#0f0;padding:8px;border-radius:6px;white-space:pre-wrap;word-break:break-all;margin-bottom:0"></pre>';
    createBtn.parentElement.insertBefore(panel, createBtn);
    document.getElementById('gw-skip-btn').addEventListener('click', function(){
      createBtn.disabled = true; createBtn.textContent = I.creating; agentForm.submit();
    });
    document.getElementById('gw-setup-btn').addEventListener('click', function(){ _runGatewaySetup(backend); });
  }

  function _resetSetupBtn() {
    var sb = document.getElementById('gw-setup-btn'); var kb = document.getElementById('gw-skip-btn');
    if (sb) { sb.disabled = false; sb.textContent = I.gw_retry; }
    if (kb) kb.disabled = false;
  }

  function _runGatewaySetup(backend) {
    var setupBtn = document.getElementById('gw-setup-btn');
    var skipBtn = document.getElementById('gw-skip-btn');
    var logEl = document.getElementById('gw-log');
    setupBtn.disabled = true; setupBtn.textContent = I.gw_configuring;
    if (skipBtn) skipBtn.disabled = true;
    logEl.style.display = 'block'; logEl.textContent = I.gw_starting;
    var agentId = null;
    if (backend === 'hermes') { var hp = document.querySelector('[name=hermesProfile]'); agentId = hp ? hp.value : null; }
    fetch('/api/gateway/setup', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ backend: backend, agentId: agentId }) })
      .then(function(r){return r.json()})
      .then(function(d){
        if (!d.taskId) { logEl.textContent += '\\n' + I.gw_start_failed + ': ' + (d.error || I.unknown); _resetSetupBtn(); return; }
        _pollGatewaySetup(d.taskId);
      })
      .catch(function(e){ logEl.textContent += '\\n❌ ' + e.message; _resetSetupBtn(); });
  }

  var _gwPoll = null;
  function _pollGatewaySetup(taskId) {
    var logEl = document.getElementById('gw-log');
    if (_gwPoll) clearInterval(_gwPoll);
    _gwPoll = setInterval(function(){
      fetch('/api/gateway/setup-status?id=' + encodeURIComponent(taskId))
        .then(function(r){return r.json()})
        .then(function(s){
          if (s.logs) logEl.textContent = s.logs.join('\\n');
          logEl.scrollTop = logEl.scrollHeight;
          if (s.done) {
            clearInterval(_gwPoll); _gwPoll = null;
            if (s.ok) {
              logEl.textContent += '\\n' + I.gw_success;
              createBtn.disabled = true; createBtn.textContent = I.creating;
              setTimeout(function(){ agentForm.submit(); }, 800);
            } else {
              logEl.textContent += '\\n' + I.gw_incomplete.replace('{err}', s.error ? (': ' + s.error) : '');
              _resetSetupBtn();
            }
          }
        }).catch(function(){});
    }, 1500);
  }
})();
</script>`;
}

// ═══════════════════════════════════════════════════════════════
//  Router
// ═══════════════════════════════════════════════════════════════

function createRegisterRouter(handlers, db) {
  const R = Router();

  function getLoggedEmail() {
    if (!db) return null;
    try {
      const row = db.prepare("SELECT data FROM config WHERE type='user_access_token'").get();
      if (row) {
        const d = JSON.parse(row.data);
        const keys = Object.keys(d);
        return keys.length > 0 ? keys[0] : null;
      }
    } catch (_) {}
    return null;
  }

  const registrationOrchestrator = createRegistrationOrchestrator({
    db,
    sendCode: (params) => handlers.register_agent(params),
    loginByCode: (params) => handlers.login_by_code(params),
    completeAgent: (params) => handlers.create_agent_by_token(params),
    getLoggedEmail,
  });

  // Web、Agent 本地 API、MCP、CLI 共用同一注册状态机。
  R.post('/api/agent-registration', async (req, res) => {
    const input = { ...(req.body || {}) };
    if (input.action === 'start' && !input.email) input.email = getLoggedEmail();
    const result = await runWithRegistrationCaller(
      { source: 'web' },
      () => registrationOrchestrator.manage(input),
    );
    res.status(result.success === false ? 400 : 200).json(result);
  });

  // ═══════════════════════════════════════════════
  //  代理 API：分类列表（透传后端）
  // ═══════════════════════════════════════════════

  R.get('/api/agent-categories', async (req, res) => {
    const T = (k, d) => req.t(k, d);
    const translate = (items) => items.map(c => {
      const key = 'db.agent.category.' + c.code;
      const translated = T(key);
      return { ...c, label: translated !== key ? translated : c.label };
    });
    try {
      const resp = await fetch(VOKO_API_URL + '/api/agent-categories');
      const data = await resp.json();
      if (data.success && data.data) data.data = translate(data.data);
      res.json(data);
    } catch (e) {
      res.json({ success: true, data: translate([
        { code: 'general', label: req.t('db.agent.category.general') },
        { code: 'business', label: req.t('db.agent.category.business') },
        { code: 'education', label: req.t('db.agent.category.education') },
        { code: 'finance', label: req.t('db.agent.category.finance') },
        { code: 'health_fitness', label: req.t('db.agent.category.health_fitness') },
        { code: 'travel', label: req.t('db.agent.category.travel') },
        { code: 'other', label: req.t('db.agent.category.other') },
      ])});
    }
  });

  // ═══════════════════════════════════════════════
  //  代理 API：OpenClaw Agent 列表
  // ═══════════════════════════════════════════════

  R.get('/api/agent/openclaw-agents', (req, res) => {
    try {
      const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
      if (!fs.existsSync(configPath)) return res.json({ success: true, data: [] });
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const agents = (config.agents?.list || []).map(a => ({
        id: a.id,
        name: a.name || a.id,
        workspace: a.workspace,
        model: a.model || '',
      }));
      res.json({ success: true, data: agents });
    } catch (e) {
      res.json({ success: true, data: [] });
    }
  });

  // ═══════════════════════════════════════════════
  //  代理 API：Hermes Profile 列表
  // ═══════════════════════════════════════════════

  R.get('/api/agent/hermes-profiles', (req, res) => {
    try {
      const profiles = discoverHermes();
      res.json({ success: true, data: profiles });
    } catch (e) {
      res.json({ success: true, data: [] });
    }
  });

  // ═══════════════════════════════════════════════
  //  代理 API：检测 Agent 名称是否可用
  // ═══════════════════════════════════════════════

  R.get('/api/agent/check-name', async (req, res) => {
    const name = (req.query.name || '').trim();
    if (!name) return res.json({ available: false });
    try {
      const path = '/api/external/v1/agents/search';
      const body = { keyword: name, page: 1, limit: 10 };
      const { getUserAccessToken } = require('../core/database');
      const email = getLoggedEmail();
      const token = email ? getUserAccessToken(db, email) : null;
      if (!token) return res.status(401).json({ available: false, error: 'LOGIN_REQUIRED' });
      const resp = await fetch(VOKO_API_URL + path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token,
        },
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      const agents = data.agents || data.data || [];
      const taken = agents.some(a => (a.name || a.agentName || '').toLowerCase() === name.toLowerCase());
      return res.json({ available: !taken });
    } catch (_) {
      return res.status(503).json({ available: false, error: 'NAME_CHECK_UNAVAILABLE' });
    }
  });

  // ═══════════════════════════════════════════════
  //  /login
  // ═══════════════════════════════════════════════

  R.get('/login', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const email = req.query.email || '';
    const err = req.query.err || '';
    let body = loginBody(email, err, req.t);
    res.send(page(req.t('register.login.page_title'), body, req.t, req.locale) + loginJs(req.t));
  });

  R.get('/api/login/oauth/providers', async (_req, res) => {
    const r = await handlers.oauth_providers();
    res.status(r.success ? 200 : (r.status || 503)).json({
      success: !!r.success,
      providers: r.data?.providers || [],
      error: r.error,
    });
  });

  R.post('/api/login/oauth/start', async (req, res) => {
    const r = await handlers.oauth_start({ provider: req.body?.provider });
    res.status(r.success ? 201 : (r.status || 400)).json({
      success: !!r.success,
      ...(r.data || {}),
      error: r.error,
    });
  });

  R.get('/api/login/oauth/status/:sessionId', async (req, res) => {
    const r = await handlers.oauth_status({ sessionId: req.params.sessionId });
    res.status(r.success ? 200 : (r.status || 400)).json({
      success: !!r.success,
      ...(r.data || {}),
      error: r.error,
    });
  });

  R.post('/api/login/oauth/exchange', async (req, res) => {
    const r = await handlers.oauth_exchange(req.body || {});
    res.status(r.success ? 200 : (r.status || 400)).json({
      success: !!r.success,
      error: r.error,
    });
  });

  R.get('/login/oauth/complete', (req, res) => {
    let agentCount = 0;
    try {
      const row = db?.prepare('SELECT COUNT(*) as c FROM agents').get();
      agentCount = row ? row.c : 0;
    } catch (_) {}
    const dest = agentCount === 0 ? '/agent/add' : '/';
    res.send('<!DOCTYPE html><meta charset="UTF-8"><title>VOKO</title><body><p id="switch-error" style="color:#d93025"></p><script>(async function(){var s=document.getElementById("switch-error");try{var r=await fetch("/api/agents/restart",{method:"POST"}),d=await r.json();if(!r.ok||!d.success)throw new Error(d.error||"Worker restart failed");location.href=' + JSON.stringify(dest) + '}catch(e){s.textContent=e.message||"Worker restart failed"}})()</'+'script></body>');
  });

  R.post('/login', async (req, res, next) => {
    try {
      const action = req.body.action;
      const email = req.body.email || '';

      if (action === 'sendCode') {
        const r = await handlers.register_agent({ email });
        if (r.success) return res.json({ success: true });
        return res.status(r.status || 400).json({ success: false, error: r.error || req.t('register.login.send_failed') });
      }

      if (action === 'verify') {
        const code = req.body.code;
        const r = await handlers.login_by_code({ email, code });
        if (r.success) {
          let agentCount = 0;
          try {
            if (db) {
              const row = db.prepare('SELECT COUNT(*) as c FROM agents').get();
              agentCount = row ? row.c : 0;
            }
          } catch (_) {}

          const dest = agentCount === 0 ? '/agent/add' : '/';
          // 返回过渡页：自动重启运行环境后跳转
          const _lang = req.locale === 'en' ? 'en' : 'zh-CN';
          const transitionPage = '<!DOCTYPE html>\n<html lang="' + _lang + '">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width,initial-scale=1.0">\n<title>VOKO — ' + esc(req.t('register.login.switching_title')) + '</title>\n<style>body{font-family:"PingFang SC","Microsoft YaHei",sans-serif;background:linear-gradient(135deg,#f0f4ff,#f5f7fa);display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;color:#1a1a2e}div{text-align:center}p{font-size:16px;margin:8px 0}.spinner{width:32px;height:32px;border:3px solid #e0e4ea;border-top-color:#1a73e8;border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 16px}@keyframes spin{to{transform:rotate(360deg)}}</style>\n</head>\n<body>\n<div><div class="spinner"></div><p>' + esc(req.t('register.login.switching')) + '</p><p style="font-size:13px;color:#888">' + esc(req.t('register.login.switching_hint')) + '</p></div>\n<script>\n(async function(){var d="' + dest + '";try{await fetch("/api/agents/restart",{method:"POST"})}catch(e){}location.href=d})();\n</script>\n</body>\n</html>';
          const checkedTransitionPage = transitionPage
            .replace('</div>\n<script>', '<p id="switch-error" style="display:none;font-size:13px;color:#d93025"></p></div>\n<script>')
            .replace(
              'try{await fetch("/api/agents/restart",{method:"POST"})}catch(e){}location.href=d',
              'var s=document.getElementById("switch-error");try{var r=await fetch("/api/agents/restart",{method:"POST"}),j=await r.json();if(!r.ok||!j.success)throw new Error(j.error||"Worker restart failed");location.href=d}catch(e){s.textContent=e.message||"Worker restart failed";s.style.display="block"}',
            );
          return res.send(checkedTransitionPage);
        }
        return res.redirect('/login?email=' + encodeURIComponent(email) + '&err=' + encodeURIComponent(r.error || req.t('register.login.code_invalid')));
      }

      res.redirect('/login?err=' + encodeURIComponent(req.t('register.login.unknown_action')));
    } catch (e) { next(e); }
  });

  // ═══════════════════════════════════════════════
  //  /agent/add
  // ═══════════════════════════════════════════════

  // 预加载分类列表（缓存 5 分钟）
  let _catCache = null, _catCacheTs = 0;
  async function _loadCategories() {
    if (_catCache && Date.now() - _catCacheTs < 300000) return _catCache;
    try {
      const resp = await fetch(VOKO_API_URL + '/api/agent-categories');
      const data = await resp.json();
      if (data.success && data.data) { _catCache = data.data; _catCacheTs = Date.now(); return _catCache; }
    } catch (_) {}
    const { t, getLocale } = require('../core/i18n');
    const T = (k) => t(k, {}, getLocale());
    return [{ code: 'general', label: T('db.agent.category.general') }, { code: 'other', label: T('db.agent.category.other') }];
  }

  function _loadOpenclawAgents() {
    try {
      const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
      if (!fs.existsSync(configPath)) return [];
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      return (config.agents?.list || []).map(a => ({ id: a.id, name: a.name || a.id, model: a.model || '' }));
    } catch (_) { return []; }
  }

  function _loadHermesProfiles() {
    try { return discoverHermes().map(p => ({ name: p.name, model: p.model || '', isDefault: !!p.isDefault })); }
    catch (_) { return []; }
  }

  R.get('/agent/add', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.query.done) {
      return res.send(page(req.t('register.done.page_title'), doneBody(req.query.done, req.t), req.t, req.locale));
    }
    const email = getLoggedEmail();
    if (!email) return res.redirect('/login');
    const categories = await _loadCategories();
    const body = addAgentWizardBody(email, categories, db, req.t);
    res.send(page(req.t('register.add.page_title'), body, req.t, req.locale) + wizardJs(req.t));
  });

  R.post('/agent/add', async (req, res, next) => {
    try {
      const action = req.body.action;
      const email = getLoggedEmail();
      if (!email) return res.redirect('/login?err=' + encodeURIComponent(req.t('register.err_login_first')));

      // 创建 Agent（用 access-token，无需验证码）
      if (action === 'createAgent') {
        const agentName = req.body.agentName || undefined;
        const description = req.body.description || undefined;
        const category = req.body.category;
        const backendType = req.body.backendType;

        const started = await registrationOrchestrator.start({ email });
        if (!started.success) throw new Error(started.error || '无法启动注册流程');
        const basic = registrationOrchestrator.setBasicInfo(started.registrationId, { agentName, category, description });
        if (!basic.success) throw new Error(basic.error || '基本信息无效');
        const selectedProvider = registrationOrchestrator.selectProvider(started.registrationId, {
          providerType: backendType,
          instanceId: req.body.openclawAgent || req.body.hermesProfile || undefined,
        });
        if (!selectedProvider.success) throw new Error(selectedProvider.error || 'Agent 类型无效');
        const defaultModes = selectedProvider.deliveryModes.filter((mode) => mode.selected).map((mode) => mode.mode);
        const selectedDelivery = registrationOrchestrator.selectDelivery(started.registrationId, { deliveryModes: defaultModes });
        if (!selectedDelivery.success) throw new Error(selectedDelivery.error || '消息接收方式无效');
        const completed = await registrationOrchestrator.complete(started.registrationId);
        const r = completed.success
          ? { success: true, agentId: completed.result?.agentId, agentName: completed.result?.agentName }
          : completed;
        if (r.success) {
          return res.redirect('/agent/add?done=' + encodeURIComponent(agentName || r.agentId));
        }
        // token 失效 → 重新登录
        if (r.noToken) return res.redirect('/login?err=' + encodeURIComponent(req.t('register.err_token_expired')));
        // 名称被占用特殊提示
        if (r.error && r.error.includes('名称')) {
          return res.send(page(req.t('register.create_failed_title'), '<div class="card"><p class="error">' + esc(r.error) + '</p><a href="/agent/add" class="btn">' + esc(req.t('register.rename_btn')) + '</a></div>', req.t, req.locale));
        }
        return res.send(page(req.t('register.create_failed_title'), '<div class="card"><p class="error">' + esc(r.error || req.t('register.create_failed_default')) + '</p><a href="/agent/add" class="btn">' + esc(req.t('register.retry_btn')) + '</a></div>', req.t, req.locale));
      }

      res.redirect('/agent/add');
    } catch (e) { next(e); }
  });

  // ═══════════════════════════════════════════════
  //  /register → /login
  // ═══════════════════════════════════════════════

  R.get('/register', (req, res) => res.redirect('/login' + (req.query.email ? '?email=' + encodeURIComponent(req.query.email) : '')));
  R.post('/register', (req, res) => res.redirect('/login'));

  return R;
}

module.exports = { createRegisterRouter };
