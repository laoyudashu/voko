/**
 * group.js — 群聊管理（群详情 + 建群 + 群操作）
 *
 * 自包含（镜像 web/payment-auth.js）：自带 CSS/esc/timeTag/page/agentNav + 极简 renderFooter。
 * 路由（挂载于 /）：
 *   GET  /agents/:agentId/g/:channelId            — 群详情（消息 + 成员 role + 角色门禁管理 + 实时 WS + tip 居中）
 *   GET/POST /agents/:agentId/create-group        — 建群表单 + handler
 *   POST /agents/:agentId/g/:channelId/kick       — 踢人
 *   POST /agents/:agentId/g/:channelId/quit       — 退群
 *   POST /agents/:agentId/g/:channelId/update     — 改群名/公告/头像
 */

const { Router } = require('express');
const { getClientBundle } = require('../core/i18n');
const { renderLanguageFooter, renderLanguageSwitcher } = require('./language-switcher');
const { renderSystemFooter } = require('./footer');
const { defaultGroupName } = require('../core/group-client');
const { MESSAGE_CONTENT_CSS, createMessageRenderer, messageLabels, messageRendererScript } = require('./message-content');
const ENDPOINTS = require('../endpoints.json');

const GROUP_TIP_CONTENT_TYPE = 12; // 与 core/messenger.js CONTENT_TYPE_GROUP_TIP 一致

// ═══ CSS（与 index.js 一致，保证群页观感统一）═══
const CSS = `@charset "UTF-8";*{box-sizing:border-box}body{font-family:'PingFang SC','Microsoft YaHei','Noto Sans SC','Hiragino Sans GB',sans-serif;background:#f5f7fa;color:#1a1a2e;margin:0;padding:20px;font-size:18px;line-height:1.7;max-width:1100px;margin-left:auto;margin-right:auto;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}a{color:#1a73e8;font-weight:600;padding:4px 2px;display:inline-block}h1{font-size:24px;border-bottom:3px solid #1a73e8;padding-bottom:8px;margin:0 0 10px 0}h2{font-size:20px;margin:18px 0 8px 0;color:#1a1a2e}h3{font-size:17px;margin:0 0 4px 0;color:#1a73e8}nav{font-size:14px;color:#666;margin-bottom:10px;padding:6px 0;border-bottom:1px solid #ddd}.table-wrap{width:100%;overflow-x:auto;margin:6px 0 12px 0}table{width:100%;min-width:500px;border-collapse:collapse;background:#fff;border-radius:6px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,0.06)}th,td{padding:10px 12px;text-align:left;border:1px solid #e0e0e0;font-size:15px;white-space:nowrap}th{background:#e8f0fe;font-weight:700;font-size:14px}tr:nth-child(even){background:#fafbfc}label{display:block;margin-top:10px;font-weight:700;font-size:15px;color:#1a1a2e}input,select,textarea{width:100%;max-width:460px;padding:10px 12px;margin-top:3px;background:#fff;color:#1a1a2e;border:2px solid #b0b0b0;border-radius:6px;font-size:16px;font-family:inherit;outline:none}input:focus,select:focus{border-color:#1a73e8;box-shadow:0 0 0 3px rgba(26,115,232,0.12)}button,.btn{display:inline-block;margin-top:10px;padding:10px 22px;min-width:100px;font-size:16px;font-weight:700;cursor:pointer;text-align:center;font-family:inherit;background:#1a73e8;color:#fff;border:2px solid #1557b0;border-radius:6px;text-decoration:none}button:hover{background:#1557b0}.btn-success{background:#0f9d58;border-color:#0b8043}.btn-success:hover{background:#0b8043}.btn-danger{background:#d93025;border-color:#b71c1c}.btn-danger:hover{background:#b71c1c}.online{color:#0f9d58;font-weight:700}.offline{color:#d93025;font-weight:700}.unknown{color:#888}.pending{color:#e37400;font-weight:600}.success{color:#0f9d58;font-weight:700;font-size:17px}.error{color:#d93025;font-weight:600}.meta{color:#888;font-size:14px}.card{background:#fff;border:1px solid #e0e0e0;border-radius:8px;padding:12px 16px;margin:10px 0;box-shadow:0 1px 2px rgba(0,0,0,0.04)}.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:13px;font-weight:700;border:1px solid}.info-bar{display:flex;flex-wrap:wrap;gap:6px 14px;background:#fff;border:1px solid #e0e0e0;border-radius:6px;padding:8px 12px;margin:0 0 10px 0;font-size:15px}.info-bar span{white-space:nowrap}.ops{display:grid;gap:8px;margin:6px 0 0 0;grid-template-columns:repeat(6,1fr)}@media(max-width:900px){.ops{grid-template-columns:repeat(4,1fr)}}@media(max-width:600px){.ops{grid-template-columns:repeat(3,1fr)}}@media(max-width:400px){.ops{grid-template-columns:repeat(2,1fr)}}.op-card{display:block;background:#fff;border:2px solid #e0e0e0;border-radius:8px;padding:10px 8px;text-align:center;text-decoration:none;color:#1a1a2e;font-weight:600;font-size:14px}.op-card:hover{border-color:#1a73e8;background:#e8f0fe}button.op-card{margin:0;min-width:0;width:100%}code{background:#f0f0f0;padding:1px 4px;border-radius:3px;font-size:14px}.btn-sm{padding:8px 14px;min-width:auto;min-height:36px;font-size:14px;display:inline-block;margin:0;line-height:1.4}.btn-xs{padding:6px 10px;min-width:auto;min-height:auto;font-size:13px;font-weight:700;display:inline-block;margin:0 0 0 6px;line-height:1.4;border-radius:4px;text-decoration:none}.role-badge{display:inline-block;padding:1px 7px;border-radius:10px;font-size:12px;font-weight:700;margin-left:4px}.role-owner{background:#fef7e0;color:#b06800;border:1px solid #e37400}.role-admin{background:#e8f0fe;color:#1a73e8;border:1px solid #1a73e8}.role-member{color:#888}.tip{padding:4px 12px;margin:6px 0;border-radius:6px;background:#f0f0f0;color:#666;font-size:14px;font-style:italic;text-align:center}.gm-ops-shell{display:grid;gap:14px}.gm-ops-intro{display:flex;align-items:flex-start;gap:12px;padding:14px 16px;border:1px solid #c7d7f3;border-radius:10px;background:linear-gradient(135deg,#f7faff,#edf4ff);color:#44546a;font-size:14px}.gm-ops-intro-icon{display:flex;align-items:center;justify-content:center;flex:0 0 34px;height:34px;border-radius:9px;background:#1a73e8;color:#fff;font-size:18px;font-weight:800}.gm-ops-intro strong{display:block;color:#1a1a2e;font-size:16px;margin-bottom:2px}.gm-manage-card{margin:0;padding:18px 20px;border-color:#dfe4ea;box-shadow:0 2px 8px rgba(30,50,80,.05)}.gm-manage-card h3{margin-bottom:12px;color:#26364a}.gm-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px 16px}.gm-form-grid .gm-full{grid-column:1/-1}.gm-form-grid label{margin-top:0}.gm-toggle-grid{display:flex;gap:18px;flex-wrap:wrap;padding:10px 12px;border-radius:8px;background:#f7f9fc}.gm-manage-section{margin:0}.gm-manage-section-title{font-size:15px;color:#5f6b7a;margin:0 0 8px}.gm-action-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px}.gm-action-card{display:flex;align-items:center;gap:11px;padding:12px 14px;border:1px solid #d9e2ef;border-radius:9px;background:#fff;text-decoration:none;color:#26364a}.gm-action-card:hover{border-color:#1a73e8;background:#f5f9ff}.gm-action-icon{display:flex;align-items:center;justify-content:center;flex:0 0 34px;height:34px;border-radius:9px;background:#e8f0fe;color:#1a73e8;font-size:18px}.gm-action-card strong{display:block;font-size:15px}.gm-action-card small{display:block;color:#7b8794;font-size:12px;font-weight:400}.gm-danger-zone{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;padding-top:4px}.gm-danger-card{border-color:#f0d5d2;background:#fffafa}.gm-danger-card h3{color:#b3261e}.gm-danger-card .meta{display:block;min-height:48px}.gm-dialog{width:min(420px,calc(100vw - 32px));border:none;border-radius:14px;padding:0;overflow:hidden;background:#fff;color:#1a1a2e;box-shadow:0 18px 60px rgba(21,31,46,.28)}.gm-dialog::backdrop{background:rgba(24,34,48,.48);backdrop-filter:blur(2px)}.gm-dialog-body{padding:26px 28px 18px;text-align:center}.gm-dialog-icon{display:flex;align-items:center;justify-content:center;width:48px;height:48px;margin:0 auto 12px;border-radius:50%;background:#fce8e6;color:#d93025;font-size:24px;font-weight:800}.gm-dialog h3{margin:0 0 8px;color:#1a1a2e;font-size:19px}.gm-dialog p{margin:0;color:#667085;font-size:14px;line-height:1.65}.gm-dialog-warning{margin-top:12px!important;padding:9px 11px;border-radius:7px;background:#fff4f2;color:#b3261e!important;font-size:13px!important}.gm-dialog-feedback{min-height:22px;margin-top:8px;color:#d93025;font-size:13px}.gm-dialog-actions{display:flex;justify-content:flex-end;gap:10px;padding:14px 20px;background:#f7f9fc;border-top:1px solid #e8ebef}.gm-dialog-actions button{margin:0;min-width:96px}.gm-dialog-actions .btn-outline{background:#fff;color:#344054;border-color:#c8cdd4}.gm-dialog-actions .btn-outline:hover{background:#f1f3f5}@media(max-width:640px){.gm-form-grid{grid-template-columns:1fr}.gm-form-grid .gm-full{grid-column:auto}.gm-dialog-actions{flex-direction:column-reverse}.gm-dialog-actions button{width:100%}}`;

const EXTRA_CSS = `.btn-danger:disabled{background:#e1e4e8;border-color:#c7ccd1;color:#8a929a;cursor:not-allowed;opacity:1}.gm-audit-card{padding:10px 12px;margin:6px 0;border:1px solid #f0c7c3;border-left:4px solid #d93025;border-radius:7px;background:#fff8f7;font-size:14px}.gm-audit-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.gm-audit-result{padding:1px 7px;border-radius:9px;background:#fce8e6;color:#b3261e;font-size:12px;font-weight:700}.gm-audit-row{margin-top:6px;color:#4d5156;word-break:break-word}.gm-audit-row span{display:inline-block;min-width:72px;color:#7a828a}button:disabled{cursor:not-allowed;opacity:.55}.voko-spinner{display:inline-block;width:14px;height:14px;margin-right:7px;border:2px solid rgba(255,255,255,.45);border-top-color:#fff;border-radius:50%;vertical-align:-2px;animation:voko-spin .75s linear infinite}@keyframes voko-spin{to{transform:rotate(360deg)}}`+MESSAGE_CONTENT_CSS;

// ═══ 工具函数（与 index.js 一致）═══
function esc(s){return(s==null?'':String(s)).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}

function timeTag(ts){
  if(!ts)return'';
  const d=typeof ts==='number'&&ts<1e12?new Date(ts*1000):new Date(ts);
  const p=n=>String(n).padStart(2,'0');
  const iso=d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+'T'+p(d.getHours())+':'+p(d.getMinutes());
  const readable=p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes());
  return'<time datetime="'+iso+'">'+readable+'</time>'
}

function ajaxPaginationScript(){
  return '<script>(function(){var selections={};function remember(region){region.querySelectorAll("form").forEach(function(form){form.querySelectorAll("input[type=checkbox][name]:checked:not(:disabled)").forEach(function(input){var key=form.action+"|"+input.name;(selections[key]||(selections[key]=new Set())).add(input.value)})})}function restore(region){region.querySelectorAll("form").forEach(function(form){form.querySelectorAll("input[type=checkbox][name]:not(:disabled)").forEach(function(input){var picked=selections[form.action+"|"+input.name];if(picked&&picked.has(input.value))input.checked=true})})}document.addEventListener("click",function(event){var link=event.target.closest("a[href*=\\"page=\\" i]");if(!link||event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();var region=document.querySelector("main[data-voko-page-region]");if(!region)return location.assign(link.href);remember(region);region.setAttribute("aria-busy","true");fetch(link.href,{headers:{"X-Requested-With":"voko-pagination"}}).then(function(response){if(!response.ok)throw new Error("page request failed");return response.text()}).then(function(html){var next=new DOMParser().parseFromString(html,"text/html").querySelector("main[data-voko-page-region]");if(!next)throw new Error("page region missing");region.replaceWith(next);restore(next);history.pushState(null,"",link.href);next.scrollIntoView({block:"nearest"})}).catch(function(){location.assign(link.href)})});})();</script>'
}

function page(title,body,opt={},tFn,locale){
  const t=tFn||(k=>k);
  const loc=locale||'zh';
  const nav=opt.nav||('<a href="/">'+esc(t('common.nav.home'))+'</a>');
  const i18nBoot='<script>window.__LOCALE__='+JSON.stringify(loc)+';window.__I18N__='+JSON.stringify(getClientBundle(loc))+'</script>';
  const jd=opt.jsonld?'\n<script type="application/ld+json">'+JSON.stringify(opt.jsonld)+'</script>':'';
  const msg=opt.msg?'<div role="alert" style="padding:8px 14px;border-radius:6px;background:'+(opt.msg.success?'#e6f4ea':'#fce8e6')+';margin-bottom:10px;font-weight:600">'+(opt.msg.success?'✅ ':'❌ ')+esc(opt.msg.text)+'</div>':'';
  const st=opt.subtitle?' <span class="meta" style="font-size:14px;font-weight:400">('+esc(opt.subtitle)+')</span>':'';
  const ha=opt.headerAction||'';
  const h1=ha?'<h1 style="display:flex;justify-content:space-between;align-items:center"><span>'+esc(title)+st+'</span>'+ha+'</h1>':'<h1>'+esc(title)+st+'</h1>';
  let footer=opt.footer||'';
  if(!footer.includes('data-voko-language-switcher'))footer+=renderLanguageFooter(loc);
  const lang=loc==='en'?'en':(loc==='ja'?'ja':'zh-CN');
  return '<!DOCTYPE html>\n<html lang="'+lang+'">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width,initial-scale=1.0">\n<link rel="icon" href="/favicon.png">\n<title>VOKO — '+esc(title)+'</title>\n<style>'+CSS+EXTRA_CSS+'</style>\n'+i18nBoot+'\n</head>\n<body>\n<nav role="navigation" aria-label="'+esc(t('common.nav.aria_label'))+'">'+nav+'</nav>\n'+h1+'\n<main data-voko-page-region aria-live="polite" aria-label="'+esc(title)+'">'+msg+body+'</main>'+footer+jd+ajaxPaginationScript()+'\n</body>\n</html>'
}

function agentNav(aid,aname,tFn){const home=tFn?tFn('common.nav.home'):'首页';return'<a href="/">'+esc(home)+'</a> › <a href="/agents/'+esc(aid)+'">'+esc(aname||aid)+'</a>'}

/** 极简页脚（仅语言切换；index.js 的运行时状态条省略，保持自包含）*/
function renderFooter(tFn, locale){
  return '<div class="info-bar" style="margin-top:20px;font-size:13px;color:#888;display:flex;justify-content:flex-end">'+renderLanguageSwitcher(locale)+'</div>';
}

/** 渲染系统 tip 文本：兼容多种格式 */
function renderTipText(content){
  try{
    const p=JSON.parse(content);
    // 提取真正的 tip 文本（可能嵌套在 contentObj / content 中）
    const inner=p.contentObj||p.content||p;
    // 格式1：{type:1001, content:"已渲染文本"}
    if(inner.type>=1001&&inner.type<=2000) return inner.content||'';
    // 格式2：{content:"模板{0}", extra:[{name:"xxx"}]}
    if(typeof inner.content==='string'){
      let text=inner.content;
      (inner.extra||[]).forEach((e,i)=>{text=text.split('{'+i+'}').join(e.name||e.uid||'');});
      return text;
    }
    return String(content);
  }catch(_){return content;}
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
  if(!data.valid)return'<div class="gm-audit-card"><strong>'+esc(tFn('web.audit.message_invalid'))+'</strong>'+(timeHtml?' <span class="meta">'+timeHtml+'</span>':'')+'</div>';
  const title=tFn(data.direction==='outbound'?'web.audit.message_outbound':'web.audit.message_inbound');
  const result=tFn(data.blocked?'web.audit.message_blocked':'web.audit.message_allowed');
  const keyword=data.keyword?'<div class="gm-audit-row"><span>'+esc(tFn('web.audit.message_keyword'))+'</span>'+esc(data.keyword)+'</div>':'';
  const original=data.text?'<div class="gm-audit-row"><span>'+esc(tFn('web.audit.message_original'))+'</span>'+esc(data.text).replace(/\n/g,'<br>')+'</div>':'';
  return'<div class="gm-audit-card"><div class="gm-audit-head"><strong>'+esc(title)+'</strong><span class="gm-audit-result">'+esc(result)+'</span>'+(timeHtml?'<span class="meta">'+timeHtml+'</span>':'')+'</div>'+keyword+original+'</div>';
}


function isMentioned(mention,uid){return !!(mention&&(mention.all||(Array.isArray(mention.uids)&&uid&&mention.uids.includes(uid))))}
function mentionLabels(mention,members,tFn){
  if(!mention)return[];
  if(mention.all)return['@'+tFn('web.group.mention.all')];
  const byUid=new Map((members||[]).map(m=>[String(m.uid),m.name||m.nickname||m.uid]));
  return[...new Set((mention.uids||[]).map(uid=>'@'+(byUid.get(String(uid))||uid)).filter(Boolean))].sort((a,b)=>b.length-a.length);
}
function renderMentionContent(content,mention,members,tFn){
  let raw=String(content||'');const labels=mentionLabels(mention,members,tFn);
  if(!labels.length)return esc(raw).replace(/\n/g,'<br>');
  for(const label of labels){const i=raw.indexOf(label);if(i>=0)raw=(raw.slice(0,i)+raw.slice(i+label.length)).replace(/^[ \t]+/,'');}
  const badges=labels.map(label=>'<span class="gm-mention-token">'+esc(label)+'</span>').join(' ');
  return badges+(raw?'<br>'+esc(raw).replace(/\n/g,'<br>'):'');
}

/** role → 徽标 HTML */
function roleBadge(role,tFn){
  const t=tFn||(k=>k);
  if(role==='owner')return'<span class="role-badge role-owner">'+esc(t('web.group.role.owner'))+'</span>';
  if(role==='admin')return'<span class="role-badge role-admin">'+esc(t('web.group.role.admin'))+'</span>';
  return'<span class="role-badge role-member">'+esc(t('web.group.role.member'))+'</span>';
}

// ═══ Router ═══

function createGroupRouter(handlers, db) {
  const R = Router();
  const renderFooter = (tFn, locale) => renderSystemFooter(db, tFn, locale);

  function renderPage(req,title,body,opt){const options=opt||{};return page(title,body,{...options,footer:options.footer===undefined?renderSystemFooter(db,req.t,req.locale):options.footer},req.t,req.locale);}

  // 取 agent 展示名（nav/title 用）
  async function agentName(agentId){
    try{const d=await handlers.whoami({});const a=(d.agents||[]).find(x=>x.agentId===agentId);return a?(a.agentName||a.agentId):agentId;}catch(_){return agentId;}
  }
  // 取 acting agent 的 imUid（判定其在群里的 role）
  function actingImUid(agentId){
    try{const r=db.prepare('SELECT imUid FROM agents WHERE agent_id=?').get(agentId);return r&&r.imUid||null;}catch(_){return null;}
  }

  // ────────── 群详情 ──────────
  R.get('/agents/:agentId/g/:channelId', async (req,res,next) => {
    try{
      const T=req.t, L=(k,p)=>esc(p?T(k,p):T(k));
      const messageRenderer=createMessageRenderer(messageLabels(T));
      const {agentId,channelId}=req.params;
      const aName=await agentName(agentId);
      const myUid=actingImUid(agentId);
      const msgPage=Math.max(1,parseInt(req.query.msgPage,10)||1);
      const msgLimit=50;

      // 群上下文：群名 + 成员(含 role) + 分页消息(含 contentType)
      let ctx={groupName:channelId,members:[],messages:[],hasMore:false};
      try{
        const c=await handlers.get_group_context({agentId,channelId,limit:msgLimit,offset:(msgPage-1)*msgLimit});
        if(!c||!c.success)return res.redirect('/agents/'+esc(agentId)+'?err='+encodeURIComponent((c&&c.error)||T('common.action.failed')));
        ctx=c;
      }catch(e){return res.redirect('/agents/'+esc(agentId)+'?err='+encodeURIComponent(e.message||T('common.action.failed')))}

      try{db.prepare('UPDATE conversations SET name=?, unread_count=0 WHERE user_uid=? AND channel_id=? AND channel_type=2').run(ctx.groupName||channelId,myUid||agentId,channelId);}catch(_){}

      const groupStatus=ctx.status||'active';
      const isDissolved=groupStatus==='dissolved';
      const myRole=(ctx.members.find(m=>String(m.uid)===String(myUid))||{}).role||null;
      const isManager = myRole==='owner'||myRole==='admin';
      // 成员展示名：nickname → agentName → uid（agent 成员也显示名字而非 imUid）
      const agentNameMap={};
      try{for(const r of db.prepare('SELECT imUid, agent_name FROM agents WHERE imUid IS NOT NULL').all())if(r.imUid)agentNameMap[r.imUid]=r.agent_name;}catch(_){}
      ctx.members=(ctx.members||[]).map(m=>({...m, name:m.nickname||agentNameMap[m.uid]||m.uid}));
      const requestedMentionUid=typeof req.query.mentionUid==='string'?req.query.mentionUid:'';
      const mentionTarget=requestedMentionUid?ctx.members.find(m=>String(m.uid)===requestedMentionUid):null;
      const mentionTargetName=mentionTarget?(mentionTarget.name||mentionTarget.nickname||mentionTarget.uid):'';
      const mentionInputAttrs=mentionTarget?' value="'+esc('@'+mentionTargetName+' ')+'" data-mention-uid="'+esc(mentionTarget.uid)+'" data-mention-name="'+esc(mentionTargetName)+'"':'';
      // 当前用户是否在本群被禁言（仅影响本群回复框，不波及其他群/私聊）
      const _myM=(ctx.members||[]).find(m=>m.uid===myUid);
      const myMuted = !!(_myM && _myM.mute_until && new Date(_myM.mute_until) > new Date());

      // 消息区（气泡 + tip 居中；messages 已按时间升序）
      const msgs=ctx.messages||[];
      let mh='<p class="meta">'+L('web.conversation.no_messages')+'</p>';
      if(msgs.length){mh='';for(const m of msgs){
        if(m.contentType===11){
          mh+=renderAuditContent(m.content,T,timeTag(m.timestamp));
        }else if(m.contentType===GROUP_TIP_CONTENT_TYPE){
          mh+='<div class="tip">'+esc(renderTipText(m.content))+' <span style="font-size:12px;color:#aaa">'+timeTag(m.timestamp)+'</span></div>';
        }else{
          const t=timeTag(m.timestamp);
          const mediaHtml=messageRenderer.renderMedia(m.contentType,m.content);
          let rawContent=String(m.content||'');if(!mediaHtml&&rawContent.length>500)rawContent=rawContent.substring(0,500)+'\u2026';
          const atMe=isMentioned(m.mention,myUid);
          const contentHtml=mediaHtml||renderMentionContent(rawContent,m.mention,ctx.members,T);
          const mentionBadge=atMe?' <span class="gm-at-me-badge">'+L('web.group.mention.me_badge')+'</span>':'';
          const senderUid=String(m.fromUid||'');
          const senderName=m.senderName||m.fromUid||'?';
          const senderHtml=!isDissolved&&!myMuted&&senderUid&&senderUid!==myUid
            ? '<button type="button" class="gm-sender-mention" data-uid="'+esc(senderUid)+'" data-name="'+esc(senderName)+'" title="'+esc(T('web.group.mention.click_sender'))+'">'+esc(senderName)+'</button>'
            : '<strong>'+esc(senderName)+'</strong>';
          mh+='<div class="gm-message'+(atMe?' gm-message-at-me':'')+'">'+senderHtml+mentionBadge+' <span style="color:#888;font-size:13px">['+t+']</span><br>'+contentHtml+'</div>';
        }
      }}

      let msgPager='';
      if(msgPage>1||ctx.hasMore){
        msgPager='<div style="display:flex;align-items:center;justify-content:center;gap:12px;padding:4px 0 10px;font-size:14px">';
        if(msgPage>1)msgPager+='<a class="btn-sm" href="/agents/'+esc(agentId)+'/g/'+esc(channelId)+'?msgPage='+(msgPage-1)+'">'+L('web.payments.prev_page')+'</a>';
        msgPager+='<span class="meta">'+esc(T('web.payments.page_of',{cur:msgPage,total:ctx.hasMore?msgPage+1:msgPage}))+'</span>';
        if(ctx.hasMore)msgPager+='<a class="btn-sm" href="/agents/'+esc(agentId)+'/g/'+esc(channelId)+'?msgPage='+(msgPage+1)+'">'+L('web.payments.next_page')+'</a>';
        msgPager+='</div>';
      }

      // 成员区（role 徽标 + 状态列 + 操作：踢人/禁言；搜索 + 分页由前端控制）
      let memberHtml='<p class="meta">'+L('web.group.no_members')+'</p>';
      if((ctx.members||[]).length){
        // 排序：群主首位 → 自己其次 → 其余原序
        const sortedMembers=[...ctx.members].sort((a,b)=>{
          if(a.role==='owner'&&b.role!=='owner')return -1;
          if(b.role==='owner'&&a.role!=='owner')return 1;
          if(a.uid===myUid&&b.uid!==myUid)return -1;
          if(b.uid===myUid&&a.uid!==myUid)return 1;
          return 0;
        });
        memberHtml='<div style="margin-bottom:10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap"><input type="text" id="gm-members-search" placeholder="'+esc(T('web.group.mention.search_ph'))+'" autocomplete="off" style="max-width:260px;margin:0"><span id="gm-members-count" class="meta" style="font-size:13px"></span></div>'
          +'<div class="table-wrap"><table><thead><tr><th scope="col">'+L('web.group.col.member')+'</th><th scope="col" style="text-align:center">'+L('web.group.col.role')+'</th><th scope="col" style="text-align:center">'+L('web.group.col.status')+'</th><th scope="col" style="text-align:center">'+L('web.group.col.action')+'</th></tr></thead><tbody id="gm-members-tbody">';
        for(const m of sortedMembers){
          const canManage = !isDissolved && isManager && m.role!=='owner' && m.uid!==myUid && !(myRole==='admin'&&m.role==='admin');
          const isMuted = m.mute_until && new Date(m.mute_until) > new Date();
          const disp=m.name||m.nickname||m.uid;
          const escName = esc(disp);
          const youTag = m.uid===myUid ? ' <span class="meta" style="color:#1a73e8">('+L('web.group.you')+')</span>' : '';
          const memberUid=esc(encodeURIComponent(String(m.uid)));
          const chatBtn='<a href="/agents/'+esc(agentId)+'/c/'+memberUid+'?action=reply&amp;focus=1" class="btn btn-xs">'+L('web.group.btn.private_chat')+'</a>';
          const mentionBtn=isDissolved?'':'<a href="/agents/'+esc(agentId)+'/g/'+esc(channelId)+'?tab=messages&amp;mentionUid='+memberUid+'" class="btn btn-xs" style="background:#fff;color:#1a73e8;border-color:#1a73e8">'+L('web.group.btn.mention')+'</a>';
          const kickBtn = canManage ? '<button type="button" class="btn btn-danger btn-xs" aria-label="'+esc(T('web.group.kick_confirm',{name:disp}))+'" onclick="showKickDlg(\x27'+esc(m.uid)+'\x27,\x27'+escName+'\x27)">'+L('web.group.btn.kick')+'</button>' : '';
          const muteBtn = canManage
            ? '<form method="POST" data-group-ajax action="/agents/'+esc(agentId)+'/g/'+esc(channelId)+'/mute" style="display:inline;margin:0"><input type="hidden" name="targetUid" value="'+esc(m.uid)+'"><input type="hidden" name="muted" value="'+(isMuted?'0':'1')+'"><button type="submit" class="btn-xs" aria-label="'+(isMuted?esc(T('web.group.unmute_confirm',{name:disp})):esc(T('web.group.mute_confirm',{name:disp})))+'" style="background:#e37400;border-color:#b06800">'+(isMuted?L('web.group.btn.unmute'):L('web.group.btn.mute'))+'</button></form>'
            : '';
          const statusCell = isMuted
            ? '<td style="text-align:center;color:#e37400;font-weight:600">'+L('web.group.status.muted')+'</td>'
            : '<td style="text-align:center;color:#0f9d58">'+L('web.group.status.normal')+'</td>';
          memberHtml+='<tr data-search="'+esc(disp+' '+m.uid)+'"><td>'+esc(disp)+youTag+(m.isAgent?' <span class="meta">🤖</span>':'')+'</td><td style="text-align:center">'+roleBadge(m.role,T)+'</td>'+statusCell+'<td style="white-space:nowrap;text-align:center">'+chatBtn+mentionBtn+muteBtn+kickBtn+'</td></tr>';
        }
        memberHtml+='</tbody></table></div><div id="gm-members-pagebar" style="display:none;margin-top:8px;align-items:center;justify-content:space-between;gap:8px;font-size:13px"></div>';
      }

      // 群管理：成员均可退群；owner/admin 可管理；仅 owner 可解散
      const allowedManager = isManager && !isDissolved;
      const allowedMember = !!myRole;
      const canQuit = allowedMember && (isDissolved || myRole!=='owner');
      const dis = (ok)=>ok?'':'disabled';
      const grpVal = ctx.groupName ? (ctx.groupName!==channelId ? ctx.groupName : '') : '';
      const quitConfirm = esc(T('web.group.quit_confirm'));
      const manageIntroText=allowedManager?L('web.group.manage.intro_manager'):L('web.group.manage.intro_member');
      const managementIntroHtml='<div class="gm-ops-intro" data-agent-kind="status"><span class="gm-ops-intro-icon" aria-hidden="true">⚙</span><div><strong>'+L('web.group.manage.title')+'</strong><span>'+manageIntroText+'</span></div></div>';
      let opsHtml=allowedManager?'<div class="card gm-manage-card" data-active-only><h3>'+L('web.group.update_title')+'</h3><form onsubmit="return saveGroupProfile(event)" data-url="/agents/'+esc(agentId)+'/g/'+esc(channelId)+'/update"><div class="gm-form-grid"><div><label for="grp-name">'+L('web.group.field.name')+'</label><input type="text" name="name" id="grp-name" value="'+esc(grpVal)+'"></div><div><label for="grp-notice">'+L('web.group.field.notice')+'</label><input type="text" name="notice" id="grp-notice" value="'+esc(ctx.notice||'')+'"></div><div class="gm-full gm-toggle-grid"><label style="display:flex;align-items:center;gap:7px;font-weight:500;cursor:pointer;margin:0"><input type="checkbox" id="grp-approve" '+(ctx.approve_mode!=='auto'?'checked':'')+' style="width:auto;max-width:none;margin:0"> '+L('web.group.field.approve_mode')+'</label><label style="display:flex;align-items:center;gap:7px;font-weight:500;cursor:pointer;margin:0"><input type="checkbox" id="grp-searchable" '+(ctx.searchable!=0?'checked':'')+' style="width:auto;max-width:none;margin:0"> '+L('web.group.field.searchable')+'</label></div><div class="gm-full" style="display:flex;align-items:center;gap:10px"><button type="submit" class="btn-sm" style="margin:0" data-agent-action="group.profile.update">'+L('web.group.btn.update')+'</button><span id="save-feedback" style="font-size:14px"></span></div></div></form></div>':'';
      const dissolveHtml=myRole==='owner'&&!isDissolved?'<div class="card gm-manage-card gm-danger-card" data-active-only><h3>'+L('web.group.dissolve.title')+'</h3><span class="meta">'+L('web.group.dissolve.desc')+'</span><button type="button" class="btn btn-danger btn-sm" style="margin-top:12px" data-agent-action="group.dissolve" onclick="return showDissolveDlg()">'+L('web.group.dissolve.button')+'</button></div>':'';
      const quitHtml='<div class="card gm-manage-card gm-danger-card"><h3>'+L('web.group.btn.quit')+'</h3><span class="meta">'+L('web.group.manage.quit_desc')+'</span><form method="POST" action="/agents/'+esc(agentId)+'/g/'+esc(channelId)+'/quit"><button id="group-quit-btn" type="submit" class="btn btn-danger btn-sm" data-agent-action="group.quit" style="margin-top:12px" '+dis(canQuit)+' onclick="return confirm(\''+quitConfirm+'\')">'+L('web.group.btn.quit')+'</button>'+(myRole==='owner'&&!isDissolved?'<span id="group-owner-quit-note" class="meta" style="display:inline;margin-left:8px;min-height:0">'+L('web.group.quit_owner_warn')+'</span>':'')+'</form></div>';
      const statusText=isDissolved?L('web.group.dissolved.label'):L('web.group.status.active');
      const groupInfoHtml='<div class="info-bar"><span>'+L('web.group.field.status')+': <strong id="group-status-text" style="color:'+(isDissolved?'#d93025':'#0f9d58')+'">'+statusText+'</strong></span>'+(ctx.notice?'<span>'+L('web.group.field.notice')+': '+esc(ctx.notice)+'</span>':'')+'</div>';
      const dissolvedBanner='<div id="group-dissolved-banner" role="status" style="display:'+(isDissolved?'block':'none')+';padding:10px 14px;margin:0 0 12px;border:1px solid #d93025;border-radius:6px;background:#fce8e6;color:#b71c1c;font-weight:700">'+L('web.group.dissolved.label')+'</div>';
      // 入群申请（owner，有 pending 时显示）
      let applyHtml='';
      if(allowedManager){
        let applies=[];
        try{const ar=await handlers.list_group_applies({agentId,channelId}); if(ar&&ar.success) applies=ar.applies||[];}catch(_){}
        // 申请人展示名：nickname → agentName → uid
        const applyNameMap={};
        for(const ap of applies){const c=db.prepare('SELECT nickname FROM user_cache WHERE uid=? LIMIT 1').get(ap.uid);applyNameMap[ap.uid]=(c&&c.nickname)||agentNameMap[ap.uid]||null;}
        applyHtml='<div class="card gm-manage-card" data-active-only><h3>'+L('web.group.apply.title')+' ('+applies.length+')</h3>';
        if(applies.length){
          applyHtml+='<div class="table-wrap"><table><thead><tr><th>'+L('web.group.apply.requester')+'</th><th style="text-align:center">'+L('web.group.apply.type')+'</th><th style="text-align:center">'+L('web.group.col.action')+'</th></tr></thead><tbody>';
          for(const ap of applies){
            applyHtml+='<tr><td>'+esc(ap.name||ap.nickname||applyNameMap[ap.uid]||ap.uid)+'</td><td style="text-align:center">'+L(ap.type==='invite'?'web.group.apply.invite':'web.group.apply.apply')+'</td><td style="white-space:nowrap;text-align:center"><form method="POST" data-group-ajax action="/agents/'+esc(agentId)+'/g/'+esc(channelId)+'/apply" style="display:inline;margin:0"><input type="hidden" name="applyId" value="'+esc(ap.id)+'"><input type="hidden" name="action" value="approve"><button type="submit" class="btn btn-success btn-xs">'+L('web.group.apply.approve')+'</button></form> <form method="POST" data-group-ajax action="/agents/'+esc(agentId)+'/g/'+esc(channelId)+'/apply" style="display:inline;margin:0"><input type="hidden" name="applyId" value="'+esc(ap.id)+'"><input type="hidden" name="action" value="reject"><button type="submit" class="btn btn-danger btn-xs">'+L('web.group.apply.reject')+'</button></form></td></tr>';
          }
          applyHtml+='</tbody></table></div>';
        }else{
          applyHtml+='<p class="meta">'+L('web.group.apply.empty')+'</p>';
        }
        applyHtml+='</div>';
      }
      const aId=esc(agentId), cId=esc(channelId);
      // 三个 Tab：群消息 / 群成员 / 群操作
      const activeGTab = req.query.tab==='members' ? 'members' : (req.query.tab==='ops' ? 'ops' : 'messages');
      const gTabBtn=(id,label,active)=>'<button type="button" role="tab" aria-selected="'+active+'" aria-controls="gtab-'+id+'" id="gtab-btn-'+id+'" data-gtab="'+id+'" style="background:transparent;border:none;border-bottom:3px solid '+(active?'#1a73e8':'transparent')+';color:'+(active?'#1a73e8':'#666')+';font:inherit;font-size:16px;font-weight:'+(active?'700':'600')+';padding:10px 20px;margin-bottom:-2px;cursor:pointer">'+label+'</button>';
      const gTabBar='<div style="display:flex;gap:4px;border-bottom:2px solid #e0e0e0;margin-bottom:14px">'
        +gTabBtn('messages',L('web.group.tab.messages'),activeGTab==='messages')
        +gTabBtn('members',L('web.group.tab.members')+((ctx.members||[]).length?' ('+(ctx.members||[]).length+')':''),activeGTab==='members')
        +(allowedMember?gTabBtn('ops',L('web.group.tab.ops'),activeGTab==='ops'):'')
        +'</div>';
      const panel=(id)=>'<div id="gtab-'+id+'" role="tabpanel" aria-labelledby="gtab-btn-'+id+'" style="'+(activeGTab===id?'':'display:none')+'">';
      const replyCard=isDissolved
        ?'<div class="card" id="reply" style="opacity:0.75"><h3>'+L('web.group.reply_title')+'</h3><input type="text" disabled placeholder="'+esc(T('web.group.dissolved.placeholder'))+'" style="background:#f5f5f5;color:#999;cursor:not-allowed"></div>'
        :myMuted
        ?'<div class="card" id="reply" style="opacity:0.75"><h3>'+L('web.group.reply_title')+'</h3><input type="text" disabled placeholder="'+esc(T('web.group.you_are_muted'))+'" style="background:#f5f5f5;color:#999;cursor:not-allowed"></div>'
        :'<div class="card" id="reply"><h3>'+L('web.group.reply_title')+'</h3><form method="POST" action="/messages/send" onsubmit="return groupReplySend(event)" id="group-reply-form"><input type="hidden" name="agentId" value="'+aId+'"><input type="hidden" name="toUid" value="'+cId+'"><input type="hidden" name="channelType" value="2"><label for="group-reply-input" class="meta">'+L('web.conversation.label.content')+'</label><div class="voko-compose-row"><input type="text" id="group-reply-input" name="content" required autocomplete="off" autofocus'+mentionInputAttrs+'><a class="btn btn-outline btn-sm" style="margin:0;display:flex;align-items:center;white-space:nowrap" href="/agents/'+aId+'/upload?toUid='+encodeURIComponent(channelId)+'&channelType=2">'+L('web.conversation.op.upload')+'</a><button type="submit" class="voko-send-button">'+L('common.btn.send')+'</button></div><span id="reply-send-err" style="display:block;font-size:14px;margin-top:4px"></span></form></div>';
      const msgPanel=panel('messages')+'<div id="msg-box" style="max-height:50vh;overflow-y:auto;border:1px solid #e0e0e0;padding:12px;border-radius:6px;background:#fff;margin-bottom:10px">'+mh+'</div>'+msgPager+replyCard+'</div>';
      const opsSection = allowedManager?'<div class="gm-manage-section" data-active-only><h3 class="gm-manage-section-title">'+L('web.group.manage.quick_actions')+'</h3><div class="gm-action-grid"><a class="gm-action-card" data-agent-kind="link" data-agent-action="group.invite" href="/agents/'+aId+'/g/'+cId+'/invite"><span class="gm-action-icon" aria-hidden="true">＋</span><span><strong>'+L('web.group.op.invite')+'</strong><small>'+L('web.group.manage.invite_desc')+'</small></span></a></div></div>':'';
      const memberPanel=panel('members')+'<div class="card">'+memberHtml+'</div></div>';
      const dangerZone=(dissolveHtml||quitHtml)?'<div class="gm-manage-section"><h3 class="gm-manage-section-title">'+L('web.group.manage.danger_zone')+'</h3><div class="gm-danger-zone">'+dissolveHtml+quitHtml+'</div></div>':'';
      const opsPanel = allowedMember ? panel('ops')+'<div class="gm-ops-shell">'+managementIntroHtml+opsSection+applyHtml+opsHtml+dangerZone+'</div></div>' : '';
      // 统一危险操作 dialog：踢人 / 解散群聊
      const kickDlg='<dialog id="kick-dlg" class="gm-dialog"><div class="gm-dialog-body"><div class="gm-dialog-icon" aria-hidden="true">!</div><h3>'+L('web.group.kick_dlg_title')+'</h3><p id="kick-dlg-msg"></p></div><form id="kick-form" method="POST" data-group-ajax class="gm-dialog-actions"><button type="button" class="btn btn-outline" onclick="closeKickDlg()">'+L('web.group.kick_dlg_cancel')+'</button><button type="submit" class="btn btn-danger">'+L('web.group.kick_dlg_confirm')+'</button></form></dialog>';
      const dissolveDlg='<dialog id="dissolve-dlg" class="gm-dialog"><div class="gm-dialog-body"><div class="gm-dialog-icon" aria-hidden="true">!</div><h3>'+L('web.group.dissolve.dialog_title')+'</h3><p>'+L('web.group.dissolve.dialog_desc')+'</p><p class="gm-dialog-warning">'+L('web.group.dissolve.dialog_warning')+'</p><div id="dissolve-feedback" class="gm-dialog-feedback" role="alert"></div></div><div class="gm-dialog-actions"><button type="button" class="btn btn-outline" onclick="closeDissolveDlg()">'+L('common.btn.cancel')+'</button><button id="dissolve-confirm-btn" type="button" class="btn btn-danger" onclick="return confirmDissolveGroup()">'+L('web.group.dissolve.button')+'</button></div></dialog>';
      const dlgScript='<script>'
        +'function showKickDlg(uid,name){var d=document.getElementById("kick-dlg");var f=document.getElementById("kick-form");f.action="/agents/'+aId+'/g/'+cId+'/kick";var h=f.querySelector("input[name=targetUid]");if(!h){h=document.createElement("input");h.type="hidden";h.name="targetUid";f.appendChild(h)}h.value=uid;document.getElementById("kick-dlg-msg").textContent=name;d.showModal()}'
        +'function closeKickDlg(){document.getElementById("kick-dlg").close()}'
        +'function groupActionError(form,message){var old=form.parentNode.querySelector(".group-action-error");if(old)old.remove();var note=document.createElement("p");note.className="error group-action-error";note.style.margin="6px 0 0";note.textContent=message||"'+esc(T('common.action.failed'))+'";form.insertAdjacentElement("afterend",note)}'
        +'function refreshGroupMembers(){var url=new URL(location.href);url.searchParams.set("tab","members");return fetch(url,{headers:{"X-Requested-With":"voko-group-action"}}).then(function(r){if(!r.ok)throw new Error("refresh failed");return r.text()}).then(function(html){var next=new DOMParser().parseFromString(html,"text/html").querySelector("main[data-voko-page-region]");var current=document.querySelector("main[data-voko-page-region]");if(!next||!current)throw new Error("refresh region missing");current.replaceWith(next);history.replaceState(null,"",url)})}'
        +'document.addEventListener("submit",function(e){var f=e.target.closest("form[data-group-ajax]");if(!f)return;e.preventDefault();var b=f.querySelector("button[type=submit]");if(b)b.disabled=true;var d=document.getElementById("kick-dlg");if(d&&d.open)d.close();fetch(f.action,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded",Accept:"application/json"},body:new URLSearchParams(new FormData(f))}).then(function(r){return r.json().catch(function(){return{success:false,error:"'+esc(T('common.action.failed'))+'"}})}).then(function(data){if(!data.success)throw new Error(data.error||"'+esc(T('common.action.failed'))+'");return refreshGroupMembers()}).catch(function(err){groupActionError(f,err.message)}).finally(function(){if(b)b.disabled=false})})'
        +'function saveGroupProfile(e){e.preventDefault();var f=e.target;var b=f.querySelector("button");var s=document.getElementById("save-feedback");var d=JSON.stringify({name:document.getElementById("grp-name").value,notice:document.getElementById("grp-notice").value,approve_mode:document.getElementById("grp-approve").checked?"manual":"auto",searchable:document.getElementById("grp-searchable").checked?1:0});b.disabled=true;b.textContent="...";s.textContent="";fetch(f.dataset.url,{method:"POST",headers:{"Content-Type":"application/json",Accept:"application/json"},body:d}).then(function(r){return r.json()}).then(function(j){b.disabled=false;b.textContent='+JSON.stringify(L('web.group.btn.update'))+';if(j.success){s.style.color="#0f9d58";s.textContent="✓ '+esc(T('web.group.updated'))+'";var nn=document.getElementById("grp-name").value;if(nn){document.title="VOKO — "+nn;var h1s=document.querySelector("h1 span");var h1=document.querySelector("h1");if(h1s)h1s.textContent="'+esc(T('web.group.detail_title'))+': "+nn;else if(h1)h1.textContent="'+esc(T('web.group.detail_title'))+': "+nn;var nav=document.querySelector("nav");if(nav){var as=nav.querySelectorAll("a");if(as.length)as[as.length-1].textContent=nn}}setTimeout(function(){s.textContent=""},2000)}else{s.style.color="#d93025";s.textContent=j.error||"'+esc(T('common.action.failed'))+'"}}).catch(function(err){b.disabled=false;b.textContent='+JSON.stringify(L('web.group.btn.update'))+';s.style.color="#d93025";s.textContent=err.message});return false}'
        +'</script>';

      const groupJsonLd={'@context':'https://schema.org','@type':'Group','name':ctx.groupName||channelId,'identifier':channelId,'member':(ctx.members||[]).map(m=>({'@type':'Person',name:m.nickname||m.uid,identifier:m.uid}))};
      res.send(renderPage(req, L('web.group.detail_title')+': '+esc(ctx.groupName||channelId)+'（'+esc(channelId)+'）',
        dissolvedBanner+groupInfoHtml+gTabBar+msgPanel+memberPanel+opsPanel
        +'<script>(function(){var b=document.getElementById("msg-box");if(b)b.scrollTop=b.scrollHeight;})();</script>'
        +kickDlg+dissolveDlg+dlgScript
        +'<p><a href="/agents/'+aId+'">← '+esc(aName)+'</a></p>',
        {nav:agentNav(agentId,aName,T)+' › <a href="/agents/'+esc(agentId)+'/g/'+esc(channelId)+'">'+esc(ctx.groupName||channelId)+'</a>', jsonld:groupJsonLd, footer: renderFooter(T,req.locale)+messageRendererScript(T)+groupWsScript(agentId,channelId,myUid,ctx.members,groupStatus,isManager,T)+gTabScript()+mentionScript(T)+membersScript(T)}))
    }catch(e){next(e)}
  });

  // ────────── 邀请成员页面 ──────────
  R.get('/agents/:agentId/g/:channelId/invite', async (req,res,next) => {
    try{
      const T=req.t, L=(k,p)=>esc(p?T(k,p):T(k));
      const {agentId,channelId}=req.params;
      const aName=await agentName(agentId);

      // 取群名 + 已有成员 uid
      let groupName=channelId; const memberUids=new Set(); let groupStatus='active';
      try{const c=await handlers.get_group_context({agentId,channelId,limit:1});if(c&&c.success){groupName=c.groupName||channelId;groupStatus=c.status||'active';(c.members||[]).forEach(m=>memberUids.add(m.uid));}}catch(_){}
      if(groupStatus==='dissolved')return res.redirect('/agents/'+esc(agentId)+'/g/'+esc(channelId)+'?err='+encodeURIComponent(T('web.group.dissolved.manage_disabled')));

      // 同主人 Agent（含已在群的；imUid 优先，无 imUid 也保留用 agentId 兜底）
      let allAgents=[];
      try{const w=await handlers.whoami({});const me=(w.agents||[]).find(a=>a.agentId===agentId);const oe=me&&me.ownerEmail||'';const candidates=(w.agents||[]).filter(a=>a.agentId!==agentId&&a.ownerEmail===oe);if(candidates.length){const ids=candidates.map(a=>a.agentId);const rows=db.prepare('SELECT agent_id, imUid FROM agents WHERE agent_id IN ('+ids.map(()=>'?').join(',')+')').all(...ids);const imMap={};rows.forEach(r=>{imMap[r.agent_id]=r.imUid||''});allAgents=candidates.map(a=>({...a,imUid:imMap[a.agentId]||null}));}}catch(_){}
      // 判断已在群：同时尝试 imUid 和 agentId 匹配
      const agentInGroup=new Set();
      allAgents.forEach(a=>{const k=a.imUid||a.agentId;if((a.imUid&&memberUids.has(a.imUid))||memberUids.has(a.agentId))agentInGroup.add(k);});

      // 白名单好友（分页）
      const inviteKeyword=String(req.query.keyword||'').trim().slice(0,100);
      const wlPage=Math.max(1,parseInt(req.query.wlPage)||1), wlPageSize=10, wlOffset=(wlPage-1)*wlPageSize;
      let wlTotal=0, allFriends=[];
      try{const wl=await handlers.list_access_lists({agentId,listType:'whitelist',limit:wlPageSize,offset:wlOffset,keyword:inviteKeyword});if(wl.success){allFriends=wl.data||[];wlTotal=wl.total||0;}}catch(_){}

      // 好友昵称（从 user_cache 取，无则仅显示 ID）
      const friendNickMap={};
      if(allFriends.length){
        try{const fUids=allFriends.map(f=>f.visitor_id);const rows=db.prepare('SELECT uid, nickname FROM user_cache WHERE uid IN ('+fUids.map(()=>'?').join(',')+')').all(...fUids);rows.forEach(r=>{friendNickMap[r.uid]=r.nickname||'';});}catch(_){}
      }

      // 渲染单个 checkbox 行：label 为主显示，sub 为灰色副文本
      const checkRow=(uid,label,sub,isMember,noIm)=>{const cbId='inv-'+esc(uid);const dis=isMember||noIm;const reason=isMember?L('web.group.invite.already_member'):(noIm?L('web.group.invite.no_imuid'):'');return'<label for="'+cbId+'" style="display:flex;align-items:center;gap:8px;margin:4px 0;font-weight:400;cursor:'+(dis?'not-allowed':'pointer')+';'+(dis?'opacity:0.55':'')+'"><input type="checkbox" name="inviteUids" id="'+cbId+'" value="'+esc(uid)+'" style="width:auto;max-width:none;margin:0" '+(isMember?'checked ':'')+(dis?'disabled':'')+'>'+esc(label)+(sub?' <span class="meta" style="font-size:13px">'+esc(sub)+'</span>':'')+(reason?' <span class="meta" style="color:#888;font-size:13px">'+reason+'</span>':'')+'</label>';};

      // 构建选项 HTML
      const searchText=inviteKeyword.toLowerCase();
      const visibleAgents=searchText?allAgents.filter(a=>[a.agentName,a.agentId,a.backendType].some(v=>String(v||'').toLowerCase().includes(searchText))):allAgents;
      let opts='';
      if(visibleAgents.length){
        opts+='<h3>'+L('web.group.invite.agents')+'</h3>';
        visibleAgents.forEach(a=>{const uid=a.imUid||a.agentId;opts+=checkRow(uid,a.agentName||a.agentId,a.agentId,agentInGroup.has(uid),!a.imUid);});
      }
      if(allFriends.length){
        opts+='<h3>'+L('web.group.invite.friends')+'</h3>';
        allFriends.forEach(f=>{const nick=friendNickMap[f.visitor_id];opts+=checkRow(f.visitor_id,nick||f.visitor_id,nick?f.visitor_id:null,memberUids.has(f.visitor_id));});
      }
      if(!visibleAgents.length&&!allFriends.length) opts='<p class="meta">'+L('web.group.create.no_agents')+'</p>';

      // 好友分页栏（有好友即显示，单页也展示计数）
      const wlPages=Math.max(1,Math.ceil(wlTotal/wlPageSize));let wlPgBar='';
      if(wlTotal>0){
        wlPgBar='<div style="margin-top:8px;display:flex;align-items:center;gap:8px;font-size:14px">';
        if(wlPage>1)wlPgBar+='<button type="button" data-invite-page="'+(wlPage-1)+'" class="btn-sm" style="padding:4px 12px">'+esc(T('web.payments.prev_page'))+'</button>';
        wlPgBar+='<span style="color:#666">'+esc(T('web.payments.page_of',{cur:wlPage,total:wlPages}))+'</span>';
        if(wlPage<wlPages)wlPgBar+='<button type="button" data-invite-page="'+(wlPage+1)+'" class="btn-sm" style="padding:4px 12px">'+esc(T('web.payments.next_page'))+'</button>';
        wlPgBar+=' <span class="meta">'+esc(T('web.group.create.total_people',{count:wlTotal}))+'</span></div>';
      }
      const candidatesHtml=opts+wlPgBar;
      if(req.query.partial==='1')return res.json({success:true,html:candidatesHtml});

      // 邀请链接区（AJAX 局部刷新）
      const linkPrefixText=T('web.group.invite.link_prefix_text',{inviter:aName,group:groupName});
      const linkSection='<div class="card">'
        +'<h3>'+L('web.group.invite.link_title')+'</h3>'
        +'<p class="meta" style="margin:4px 0">'+L('web.group.invite.link_desc')+'</p>'
        +'<div style="display:flex;align-items:flex-end;gap:8px;flex-wrap:wrap;margin-bottom:8px">'
        +'<label style="margin:0;font-size:13px">'+L('web.group.invite.link_max_uses')+' <select id="invite-max-uses" style="width:auto;max-width:none;margin:0;font-size:13px;padding:6px 8px"><option value="0">'+L('web.group.invite.link_max_unlimited')+'</option><option value="1">1</option><option value="5">5</option><option value="10">10</option><option value="50">50</option><option value="100">100</option></select></label>'
        +'<label style="margin:0;font-size:13px">'+L('web.group.invite.link_expires')+' <select id="invite-expires" style="width:auto;max-width:none;margin:0;font-size:13px;padding:6px 8px"><option value="0">'+L('web.group.invite.link_never')+'</option><option value="3600">'+L('web.group.invite.link_1h')+'</option><option value="86400">'+L('web.group.invite.link_24h')+'</option><option value="604800">'+L('web.group.invite.link_7d')+'</option></select></label>'
        +'<button type="button" class="btn-sm" style="margin:0" id="gen-link-btn" onclick="generateInviteLink()">'+L('web.group.invite.link_create_btn')+'</button>'
        +'<button type="button" class="btn-sm" id="copy-link-btn" disabled style="margin:0;opacity:0.55" onclick="copyInviteLink()">'+L('web.group.invite.link_copy')+'</button>'
        +'</div>'
        +'<div id="link-result" style="display:none">'
        +'<textarea id="invite-link-text" readonly style="width:100%;max-width:600px;height:80px;font-size:14px;margin:0 0 8px 0;resize:vertical;font-family:inherit;line-height:1.6" onclick="this.select()"></textarea>'
        +'<span id="link-err" style="display:none;color:#d93025;font-size:14px;margin-left:8px"></span>'
        +'</div></div>';

      // JS 函数：生成邀请链接 + 复制
      const linkJS='<script>'
        +'var _inviteLinkPrefix='+JSON.stringify(linkPrefixText)+';'
        +'var _inviteExpiresAt='+JSON.stringify(L('web.group.invite.link_expires_at'))+';'
        +'var _inviteErrFailed='+JSON.stringify(esc(T('common.action.failed')))+';'
        +'var _inviteCopied='+JSON.stringify(esc(T('web.group.invite.link_copied')))+';'
        +'var _inviteCopy='+JSON.stringify(esc(T('web.group.invite.link_copy')))+';'
        +'var _inviteCreateUrl="/agents/'+esc(agentId)+'/g/'+esc(channelId)+'/create-invite-link";'
        +'function generateInviteLink(){var b=document.getElementById("gen-link-btn");var e=document.getElementById("link-err");var r=document.getElementById("link-result");var t=document.getElementById("invite-link-text");b.disabled=true;b.textContent="...";e.style.display="none";r.style.display="none";'
        +'var maxUses=document.getElementById("invite-max-uses").value;var expires=document.getElementById("invite-expires").value;'
        +'fetch(_inviteCreateUrl,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:"expires="+encodeURIComponent(expires)+"&max_uses="+encodeURIComponent(maxUses)})'
        +'.then(function(res){return res.json()})'
        +'.then(function(d){b.disabled=false;b.textContent='+JSON.stringify(L('web.group.invite.link_create_btn'))+';'
        +'if(!d.success){e.textContent=d.error||_inviteErrFailed;e.style.display="inline";var cb=document.getElementById("copy-link-btn");cb.disabled=true;cb.style.opacity="0.55";return}'
        +'var text=_inviteLinkPrefix;'
        +'if(d.expires_at){var dt=new Date(d.expires_at);text+=_inviteExpiresAt.replace("{date}",dt.toLocaleString())}'
        +'text+="\\n"+'+JSON.stringify(ENDPOINTS.api.baseUrl + '/join/')+'+d.code;'
        +'t.value=text;r.style.display="block";var cb2=document.getElementById("copy-link-btn");cb2.disabled=false;cb2.style.opacity="1"})'
        +'.catch(function(err){b.disabled=false;b.textContent='+JSON.stringify(L('web.group.invite.link_create_btn'))+';e.textContent=err.message;e.style.display="inline";var cb3=document.getElementById("copy-link-btn");cb3.disabled=true;cb3.style.opacity="0.55"})}'
        +'function copyInviteLink(){var t=document.getElementById("invite-link-text");t.select();navigator.clipboard.writeText(t.value);var b=document.getElementById("copy-link-btn");b.textContent=_inviteCopied;setTimeout(function(){b.textContent=_inviteCopy},2000)}'
        +'</script>';

      // 两个 Tab：邀请好友 / 邀请链接
      const inviteTab=req.query.itab==='link'?'link':'friends';
      const iTabBtn=(id,label,active)=>'<button type="button" data-itab="'+id+'" style="background:transparent;border:none;border-bottom:3px solid '+(active?'#1a73e8':'transparent')+';color:'+(active?'#1a73e8':'#666')+';font:inherit;font-size:16px;font-weight:'+(active?'700':'600')+';padding:10px 20px;margin-bottom:-2px;cursor:pointer">'+label+'</button>';
      const iTabBar='<div style="display:flex;gap:4px;border-bottom:2px solid #e0e0e0;margin-bottom:14px">'
        +iTabBtn('friends',L('web.group.invite.tab_friends'),inviteTab==='friends')
        +iTabBtn('link',L('web.group.invite.tab_link'),inviteTab==='link')
        +'</div>';
      const friendsPanel='<div id="itab-friends" style="'+(inviteTab==='friends'?'':'display:none')+'">'
        +'<form method="POST" action="/agents/'+esc(agentId)+'/g/'+esc(channelId)+'/invite" onsubmit="return inviteSubmit()">'
        +'<input type="hidden" name="members" id="invite-members">'
        +'<div style="display:flex;align-items:flex-end;gap:8px;flex-wrap:wrap;margin-bottom:12px"><label style="margin:0;flex:1;min-width:220px">'+L('web.agent.search_ph')+'<input type="search" id="invite-search" value="'+esc(inviteKeyword)+'" autocomplete="off" style="max-width:none"></label><button type="button" id="invite-search-btn" class="btn-sm">'+L('web.agent.search_btn')+'</button></div>'
        +'<div id="invite-candidates">'+candidatesHtml+'</div>'
        +'<button type="submit" id="invite-submit-btn" disabled style="margin-top:16px;opacity:0.55">'+L('web.group.invite_page_submit')+'</button>'
        +'</form></div>';
      const linkPanel='<div id="itab-link" style="'+(inviteTab==='link'?'':'display:none')+'">'+linkSection+'</div>';
      const inviteSearchErrorHtml=JSON.stringify('<p class="error">'+esc(T('web.group.search.fail'))+'</p>');

      const body=iTabBar+friendsPanel+linkPanel
        +'<script>'
        +'(function(){var btns=document.querySelectorAll("button[data-itab]");btns.forEach(function(b){b.addEventListener("click",function(){var t=b.getAttribute("data-itab");document.getElementById("itab-friends").style.display=t==="friends"?"":"none";document.getElementById("itab-link").style.display=t==="link"?"":"none";btns.forEach(function(x){var on=x.getAttribute("data-itab")===t;x.style.borderBottomColor=on?"#1a73e8":"transparent";x.style.color=on?"#1a73e8":"#666";x.style.fontWeight=on?"700":"600"});var u=new URL(location.href);if(t==="link")u.searchParams.set("itab","link");else u.searchParams.delete("itab");history.replaceState(null,"",u)})})})();'
        +'var _inviteSelected=new Set();function _bindInviteCandidates(){document.querySelectorAll("input[name=inviteUids]").forEach(function(cb){if(!cb.disabled){cb.checked=_inviteSelected.has(cb.value);cb.addEventListener("change",function(){if(cb.checked)_inviteSelected.add(cb.value);else _inviteSelected.delete(cb.value);_updateInviteBtn()})}});document.querySelectorAll("button[data-invite-page]").forEach(function(b){b.addEventListener("click",function(){_loadInviteCandidates(b.getAttribute("data-invite-page"))})})}function _updateInviteBtn(){var b=document.getElementById("invite-submit-btn");if(b){b.disabled=!_inviteSelected.size;b.style.opacity=_inviteSelected.size?"1":"0.55"}};'
        +'function _loadInviteCandidates(page){var box=document.getElementById("invite-candidates"),input=document.getElementById("invite-search"),u=new URL(location.href);u.searchParams.set("partial","1");u.searchParams.set("wlPage",page||"1");if(input.value.trim())u.searchParams.set("keyword",input.value.trim());else u.searchParams.delete("keyword");fetch(u.toString(),{headers:{Accept:"application/json"}}).then(function(r){return r.json()}).then(function(r){if(!r.success)throw new Error("failed");box.innerHTML=r.html;_bindInviteCandidates();var visible=new URL(location.href);visible.searchParams.set("wlPage",page||"1");if(input.value.trim())visible.searchParams.set("keyword",input.value.trim());else visible.searchParams.delete("keyword");history.replaceState(null,"",visible)}).catch(function(){box.insertAdjacentHTML("afterbegin",'+inviteSearchErrorHtml+')})}'
        +'document.getElementById("invite-search-btn").addEventListener("click",function(){_loadInviteCandidates("1")});document.getElementById("invite-search").addEventListener("keydown",function(e){if(e.key==="Enter"){e.preventDefault();_loadInviteCandidates("1")}});_bindInviteCandidates();'
        +'function inviteSubmit(){var uids=Array.from(_inviteSelected).join(",");document.getElementById("invite-members").value=uids;if(!uids){alert("'+esc(T('web.group.create.no_agents'))+'");return false}return true}'
        +'</script>'
        +linkJS
        +'<p style="margin-top:16px"><a href="/agents/'+esc(agentId)+'/g/'+esc(channelId)+'?tab=members">'+L('web.group.invite_page_back')+'</a></p>';

      res.send(renderPage(req, L('web.group.invite_page_title')+': '+esc(groupName), body,
        {nav:agentNav(agentId,aName,T)+' › <a href="/agents/'+esc(agentId)+'/g/'+esc(channelId)+'">'+esc(groupName)+'</a> › '+L('web.group.invite_page_title'), jsonld:{'@context':'https://schema.org','@type':'InviteAction','agent':{'@type':'Person',name:aName},'group':{'@type':'Group',name:groupName,identifier:channelId}}, footer:renderFooter(T,req.locale)}));
    }catch(e){next(e)}
  });

  // ────────── 创建邀请链接 ──────────
  R.post('/agents/:agentId/g/:channelId/create-invite-link', async (req,res,next) => {
    try{
      const T=req.t; const {agentId,channelId}=req.params;
      const expires=parseInt(req.body.expires)||0;
      const maxUses=parseInt(req.body.max_uses)||0;
      const r=await handlers.create_invite_link({agentId,channelId,expiresInSeconds:expires||null,maxUses:maxUses||null});
      res.json(r.success
        ? {success:true, code:r.code, channel_id:r.channel_id, expires_at:r.expires_at}
        : {success:false, error:r.error||T('common.action.failed')});
    }catch(e){res.json({success:false, error:e.message});}
  });

  // ────────── 通过邀请链接加入群 ──────────
  R.get('/join/:code', async (req,res) => {
    try{
      const T=req.t, L=k=>esc(T(k));
      const {code}=req.params;
      let agentOptions='';
      try{
        const w=await handlers.whoami({});
        const agents=w.agents||[];
        if(agents.length){
          const ids=agents.map(a=>a.agentId);
          const rows=db.prepare('SELECT agent_id, imUid FROM agents WHERE agent_id IN ('+ids.map(()=>'?').join(',')+')').all(...ids);
          const imMap={};rows.forEach(r=>{imMap[r.agent_id]=r.imUid||''});
          agents.filter(a=>imMap[a.agentId]).forEach(a=>{agentOptions+='<option value="'+esc(a.agentId)+'">'+esc(a.agentName||a.agentId)+'</option>';});
        }
      }catch(_){}
      const body='<div class="card" style="text-align:center;padding:30px">'
        +'<h2 style="margin-bottom:16px">'+L('web.group.invite.link_prefix')+'</h2>'
        +'<p class="meta" style="margin-bottom:16px">'+L('web.group.invite.link_desc')+'</p>'
        +(agentOptions?'<form method="POST" action="/join/'+esc(code)+'">'
        +'<label for="agentId">'+L('web.group.create.invite_agents')+'</label>'
        +'<select id="agentId" name="agentId" required autofocus style="max-width:300px;margin:8px auto;display:block">'+agentOptions+'</select>'
        +'<button type="submit" style="margin-top:12px">'+L('web.group.op.invite_btn')+'</button>'
        +'</form>':'<p class="meta">'+L('web.group.create.no_agents')+'</p>')+'</div>';
      res.send(page(L('web.group.invite.link_prefix'), body, {footer:renderFooter(T,req.locale)}, req.t, req.locale));
    }catch(e){res.status(500).send(page('Error','<p class="error">'+esc(e.message)+'</p>',{},req.t,req.locale))}
  });

  R.post('/join/:code', async (req,res) => {
    const T=req.t,L=k=>esc(T(k));
    const {code}=req.params;
    const agentId=req.body.agentId||'';
    try{
      const r=await handlers.join_by_invite_code({code,agentId});
      const body=r.already_member
        ?'<div class="card" style="text-align:center;padding:30px"><h2 class="meta">'+L('web.group.invite.already_member')+'</h2></div>'
        :'<div class="card" style="text-align:center;padding:30px;background:#e6f4ea;border-color:#0f9d58"><h2 style="color:#0f9d58">✅ '+L('web.group.apply.approve')+'</h2><p class="meta">'+esc(T('web.group.create.success_no_invite',{channelId:r.channel_id||''}))+'</p></div>';
      res.send(page(L('web.group.invite.link_prefix'), body, {footer:renderFooter(T,req.locale)}, req.t, req.locale));
    }catch(e){
      res.send(page(L('web.group.invite.link_prefix'),'<div class="card" style="text-align:center;padding:30px"><p class="error">'+esc(e.message||T('common.action.failed'))+'</p><p><a href="/join/'+esc(code)+'">'+esc(T('common.btn.retry'))+'</a></p></div>'+'<p><a href="/">← '+L('common.nav.home')+'</a></p>',{footer:renderFooter(T,req.locale)},req.t,req.locale));
    }
  });

  // ────────── 建群 ──────────
  R.get('/agents/:agentId/create-group', async (req,res,next) => {
    try{
      const T=req.t, L=(k,p)=>esc(p?T(k,p):T(k));
      const {agentId}=req.params;
      const aName=await agentName(agentId);
      // 同主人 Agent
      let allAgents=[];
      try{const w=await handlers.whoami({});const me=(w.agents||[]).find(a=>a.agentId===agentId);const ownerEmail=me&&me.ownerEmail||'';const candidates=(w.agents||[]).filter(a=>a.agentId!==agentId&&a.ownerEmail===ownerEmail);if(candidates.length){const ids=candidates.map(a=>a.agentId);const rows=db.prepare('SELECT agent_id, imUid FROM agents WHERE agent_id IN ('+ids.map(()=>'?').join(',')+')').all(...ids);const imMap={};rows.forEach(r=>{imMap[r.agent_id]=r.imUid||''});allAgents=candidates.map(a=>({...a,imUid:imMap[a.agentId]||null}));}}catch(_){}
      let agentOpts='';
      if(allAgents.length){for(const a of allAgents)agentOpts+='<label style="display:flex;align-items:center;gap:8px;margin:4px 0;font-weight:400;cursor:'+(a.imUid?'pointer':'not-allowed')+'"><input type="checkbox" name="inviteAgents" value="'+esc(a.imUid||'')+'" '+(a.imUid?'':'disabled')+' style="width:auto;max-width:none;margin:0">'+esc(a.agentName||a.agentId)+' <span class="meta" style="font-size:13px">'+esc(a.backendType||'')+'</span></label>';}
      else agentOpts='<p class="meta">'+L('web.group.create.no_agents')+'</p>';
      // 白名单好友
      const wlPage=Math.max(1,parseInt(req.query.wlPage)||1), wlPageSize=10, wlOffset=(wlPage-1)*wlPageSize;
      let wlTotal=0,wlRows=[];
      try{const wl=await handlers.list_access_lists({agentId,listType:'whitelist',limit:wlPageSize,offset:wlOffset});if(wl.success){wlRows=wl.data||[];wlTotal=wl.total||0;}}catch(_){}
      let friendOpts='';
      if(wlRows.length){for(const f of wlRows)friendOpts+='<label style="display:flex;align-items:center;gap:8px;margin:4px 0;font-weight:400;cursor:pointer"><input type="checkbox" name="inviteWhitelist" value="'+esc(f.visitor_id)+'" style="width:auto;max-width:none;margin:0">'+esc(f.visitor_id)+' <span class="meta" style="font-size:13px">'+esc(f.reason||'')+'</span></label>';}
      else friendOpts='<p class="meta">'+L('web.group.create.no_friends')+'</p>';
      const wlPages=Math.ceil(wlTotal/wlPageSize);let wlPgBar='';
      if(wlPages>1){wlPgBar='<div style="margin-top:8px">';for(let p=1;p<=wlPages;p++){if(p===wlPage)wlPgBar+='<strong style="margin:0 4px">'+p+'</strong>';else wlPgBar+='<a href="/agents/'+esc(agentId)+'/create-group?wlPage='+p+'" style="margin:0 4px">'+p+'</a>';}wlPgBar+=' <span class="meta">'+esc(T('web.group.create.total_people',{count:wlTotal}))+'</span></div>';}
      const defName=defaultGroupName();
      const hint=' <span class="meta">'+L('web.group.create.optional_hint')+'</span>';
      res.send(renderPage(req, T('web.group.create.title'),
        '<form method="POST" action="/agents/'+esc(agentId)+'/create-group">'
        +'<label for="gname">'+L('web.group.create.name_label')+'</label><input type="text" id="gname" name="name" value="'+esc(defName)+'" style="max-width:400px">'
        +'<h3 style="margin-top:16px">'+L('web.group.create.invite_agents')+hint+'</h3>'+agentOpts
        +'<h3 style="margin-top:16px">'+L('web.group.create.invite_friends')+hint+'</h3>'+friendOpts+wlPgBar
        +'<button type="submit" style="margin-top:16px">'+L('web.group.create.title')+'</button></form>'
        +'<p style="margin-top:16px"><a href="/agents/'+esc(agentId)+'">'+L('web.group.create.back')+' '+esc(aName)+'</a></p>',
        {nav:agentNav(agentId,aName,T)+' › '+L('web.group.create.title'), footer:renderFooter(T,req.locale)}))
    }catch(e){next(e)}
  });

  R.post('/agents/:agentId/create-group', async (req,res,next) => {
    try{
      const T=req.t;
      const {agentId}=req.params;
      const {name,inviteAgents,inviteWhitelist}=req.body;
      const agentList=Array.isArray(inviteAgents)?inviteAgents:(inviteAgents?[inviteAgents]:[]);
      const wlList=Array.isArray(inviteWhitelist)?inviteWhitelist:(inviteWhitelist?[inviteWhitelist]:[]);
      const allInvites=[...agentList,...wlList];
      // 建 + 邀
      const cr=await handlers.create_group({agentId,name});
      if(!cr.success){res.redirect('/agents/'+esc(agentId)+'?err='+encodeURIComponent(cr.error||T('common.action.failed')));return;}
      const failed=[];
      for(const uid of allInvites){try{const r=await handlers.invite_to_group({agentId,channelId:cr.channelId,members:[uid],groupName:name||cr.channelId});if(!r.success)failed.push(uid);}catch(_){failed.push(uid);}}
      const ok=allInvites.length-failed.length;
      let msg;
      if(allInvites.length){const fn=failed.length?T('web.group.create.failed_note',{count:failed.length}):'';msg=T('web.group.create.success',{channelId:cr.channelId,ok:String(ok),failed:fn});}
      else msg=T('web.group.create.success_no_invite',{channelId:cr.channelId});
      res.redirect('/agents/'+esc(agentId)+'?tab=group&created='+encodeURIComponent(cr.channelId)+'&ok='+encodeURIComponent(msg));
    }catch(e){next(e)}
  });

  // ────────── 群操作 ──────────
  R.post('/agents/:agentId/g/:channelId/invite', async (req,res,next) => {
    const T=req.t; const {agentId,channelId}=req.params;
    const members=String(req.body.members||'').split(',').map(s=>s.trim()).filter(Boolean);
    try{const r=await handlers.invite_to_group({agentId,channelId,members});
      res.redirect('/agents/'+esc(agentId)+'/g/'+esc(channelId)+'?tab=members&'+(r.success?'ok=':'err=')+encodeURIComponent(r.success?T('web.group.invited'):r.error||T('common.action.failed')));
    }catch(e){res.redirect('/agents/'+esc(agentId)+'/g/'+esc(channelId)+'?tab=members&err='+encodeURIComponent(e.message));}
  });

  R.post('/agents/:agentId/g/:channelId/kick', async (req,res,next) => {
    const T=req.t; const {agentId,channelId}=req.params;
    try{const r=await handlers.kick_from_group({agentId,channelId,targetUid:req.body.targetUid});
      if(req.headers.accept==='application/json')return res.json({success:!!r.success,error:r.error});
      res.redirect('/agents/'+esc(agentId)+'/g/'+esc(channelId)+'?tab=members&'+(r.success?'ok=':'err=')+encodeURIComponent(r.success?T('web.group.kicked'):r.error||T('common.action.failed')));
    }catch(e){if(req.headers.accept==='application/json')return res.status(500).json({success:false,error:e.message});res.redirect('/agents/'+esc(agentId)+'/g/'+esc(channelId)+'?err='+encodeURIComponent(e.message));}
  });

  R.post('/agents/:agentId/g/:channelId/mute', async (req,res,next) => {
    const T=req.t; const {agentId,channelId}=req.params;
    const muted=req.body.muted!=='0';
    try{const r=await handlers.mute_member({agentId,channelId,targetUid:req.body.targetUid,muted});
      if(req.headers.accept==='application/json')return res.json({success:!!r.success,error:r.error});
      res.redirect('/agents/'+esc(agentId)+'/g/'+esc(channelId)+'?tab=members&'+(r.success?'ok=':'err=')+encodeURIComponent(r.success?T(muted?'web.group.btn.mute':'web.group.btn.unmute')+' OK':r.error||T('common.action.failed')));
    }catch(e){if(req.headers.accept==='application/json')return res.status(500).json({success:false,error:e.message});res.redirect('/agents/'+esc(agentId)+'/g/'+esc(channelId)+'?tab=members&err='+encodeURIComponent(e.message));}
  });

  R.post('/agents/:agentId/g/:channelId/apply', async (req,res,next) => {
    const T=req.t; const {agentId,channelId}=req.params;
    const {applyId,action}=req.body;
    try{const r=await handlers.approve_group_apply({agentId,channelId,applyId,action});
      if(req.headers.accept==='application/json')return res.json({success:!!r.success,error:r.error});
      res.redirect('/agents/'+esc(agentId)+'/g/'+esc(channelId)+'?tab=members&'+(r.success?'ok=':'err=')+encodeURIComponent(r.success?T('web.group.apply.processed'):r.error||T('common.action.failed')));
    }catch(e){if(req.headers.accept==='application/json')return res.status(500).json({success:false,error:e.message});res.redirect('/agents/'+esc(agentId)+'/g/'+esc(channelId)+'?tab=members&err='+encodeURIComponent(e.message));}
  });

  R.get('/agents/:agentId/g/:channelId/status', async (req,res) => {
    const {agentId,channelId}=req.params;
    try{
      const r=await handlers.get_group_status({agentId,channelId});
      if(!r.success)return res.status(403).json({success:false,error:r.error});
      res.set('Cache-Control','no-store').json({success:true,status:r.status||'active',dissolvedAt:r.dissolvedAt||null});
    }catch(e){res.status(500).json({success:false,error:e.message});}
  });

  R.post('/agents/:agentId/g/:channelId/dissolve', async (req,res) => {
    const T=req.t; const {agentId,channelId}=req.params;
    try{
      const r=await handlers.dissolve_group({agentId,channelId});
      if(!r.success)return res.status(403).json({success:false,error:r.error||T('common.action.failed')});
      res.json({success:true,dissolved:true,alreadyDissolved:!!r.alreadyDissolved,channelId:r.channelId||channelId});
    }catch(e){res.status(500).json({success:false,error:e.message});}
  });

  R.post('/agents/:agentId/g/:channelId/quit', async (req,res,next) => {
    const T=req.t; const {agentId,channelId}=req.params;
    try{const r=await handlers.quit_group({agentId,channelId});
      if(r.success) res.redirect('/agents/'+esc(agentId)+'?ok='+encodeURIComponent(T('web.group.quited')));
      else res.redirect('/agents/'+esc(agentId)+'/g/'+esc(channelId)+'?err='+encodeURIComponent(r.error||T('common.action.failed')));
    }catch(e){res.redirect('/agents/'+esc(agentId)+'/g/'+esc(channelId)+'?err='+encodeURIComponent(e.message));}
  });

  R.post('/agents/:agentId/g/:channelId/update', async (req,res,next) => {
    const T=req.t; const {agentId,channelId}=req.params;
    const {name,notice,avatar,approve_mode,searchable}=req.body;
    const params={agentId,channelId};
    if(name!==undefined&&name!=='')params.name=name;
    if(notice!==undefined&&notice!=='')params.notice=notice;
    if(avatar!==undefined&&avatar!=='')params.avatar=avatar;
    if(approve_mode!==undefined)params.approve_mode=approve_mode;
    if(searchable!==undefined)params.searchable=searchable;
    try{const r=await handlers.update_group(params);
      if(req.xhr||req.headers.accept==='application/json')return res.json(r.success?{success:true}:{success:false,error:r.error||T('common.action.failed')});
      res.redirect('/agents/'+esc(agentId)+'/g/'+esc(channelId)+'?tab=ops&'+(r.success?'ok=':'err=')+encodeURIComponent(r.success?T('web.group.updated'):r.error||T('common.action.failed')));
    }catch(e){
      if(req.xhr||req.headers.accept==='application/json')return res.json({success:false,error:e.message});
      res.redirect('/agents/'+esc(agentId)+'/g/'+esc(channelId)+'?err='+encodeURIComponent(e.message));
    }
  });

  // ────────── 搜索群（搜公开群 → 看简介 → 申请入群）──────────
  R.get('/agents/:agentId/search-group', async (req,res,next) => {
    try{
      const T=req.t, L=(k,p)=>esc(p?T(k,p):T(k));
      const {agentId}=req.params;
      const aName=await agentName(agentId);
      // 预先拉 agent 所在群 channel_id 集合——兜底服务端 /v1/search 按 token currentUid(owner) 判 joined 不准
      let myGroupIds=[];
      try{const gr=await handlers.list_groups({agentId, limit:200});if(gr.success)myGroupIds=(gr.groups||[]).map(g=>g.channel_id);}catch(_){}
      const body='<div class="card"><h3>'+L('web.group.search.title')+'</h3>'
        +'<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">'
        +'<input type="text" id="gs-kw" placeholder="'+esc(T('web.group.search.ph'))+'" autocomplete="off" autofocus style="max-width:380px;margin:0">'
        +'<button type="button" onclick="window.doSearchGroup()">'+L('web.group.search.btn')+'</button>'
        +'</div><div id="gs-result" style="margin-top:12px"></div></div>'
        +'<p style="margin-top:14px"><a href="/agents/'+esc(agentId)+'?tab=group">'+L('web.group.search.back')+'</a></p>';
      res.send(renderPage(req, L('web.group.search.title'), body,
        {nav:agentNav(agentId,aName,T)+' › '+L('web.group.search.title'), footer:renderFooter(T,req.locale)+searchScript(agentId,myGroupIds,T)}));
    }catch(e){next(e)}
  });

  // 搜索 AJAX（前端 fetch）
  R.post('/agents/:agentId/search-group', async (req,res,next) => {
    try{
      const {agentId}=req.params;
      const keyword=String(req.body.keyword||'').trim();
      if(!keyword) return res.json({success:true, groups:[], total:0});
      const r=await handlers.search_groups({agentId, keyword, page:req.body.page||1, page_size:req.body.page_size||20});
      res.json(r);
    }catch(e){res.json({success:false, error:e.message});}
  });

  // 申请入群 AJAX
  R.post('/agents/:agentId/g/:channelId/apply-join', async (req,res,next) => {
    try{
      const {agentId,channelId}=req.params;
      const r=await handlers.apply_group({agentId, channelId, message:req.body.message});
      res.json(r);
    }catch(e){res.json({success:false, error:e.message});}
  });

  return R;
}

/** 群详情实时 WS 脚本（抄 1:1 页，适配群：发送者名 + tip 居中）*/
function groupWsScript(agentId, channelId, myUid, members, status, isManager, tFn){
  const t=tFn||(k=>k);
  const membersJson=JSON.stringify((members||[]).map(m=>({uid:m.uid,name:m.name||m.nickname||m.uid,isAgent:!!m.isAgent})));
  const myName=((myUid&&(members||[]).find(m=>m.uid===myUid))||{}).name||myUid||'';
  const statusUrl='/agents/'+encodeURIComponent(agentId)+'/g/'+encodeURIComponent(channelId)+'/status';
  const dissolveUrl='/agents/'+encodeURIComponent(agentId)+'/g/'+encodeURIComponent(channelId)+'/dissolve';
  return '<script>'+`window.__MY_UID__=${JSON.stringify(myUid||'')};window.__MY_NAME__=${JSON.stringify(myName)};window.__GROUP_MEMBERS__=${membersJson};window.__GROUP_STATUS__=${JSON.stringify(status||'active')};window.__IS_MANAGER__=${JSON.stringify(!!isManager)};
var _GM_MENTION_TITLE=${JSON.stringify(t('web.group.mention.click_sender'))},_GM_ME=${JSON.stringify(t('web.group.mention.me_badge'))},_GM_ALL=${JSON.stringify(t('web.group.mention.all'))},_GM_DISSOLVED=${JSON.stringify(t('web.group.dissolved.label'))},_GM_DISSOLVED_PH=${JSON.stringify(t('web.group.dissolved.placeholder'))},_GM_REPLY_TITLE=${JSON.stringify(t('web.group.reply_title'))},_GM_DISSOLVE_LABEL=${JSON.stringify(t('web.group.dissolve.button'))},_GM_SENDING=${JSON.stringify(t('web.conversation.sending'))},_GM_SEND_FAILED=${JSON.stringify(t('common.action.failed'))},_GM_NETWORK_ERROR=${JSON.stringify(t('web.group.network_error'))},_GM_AUDIT_IN=${JSON.stringify(t('web.audit.message_inbound'))},_GM_AUDIT_OUT=${JSON.stringify(t('web.audit.message_outbound'))},_GM_AUDIT_BLOCKED=${JSON.stringify(t('web.audit.message_blocked'))},_GM_AUDIT_ALLOWED=${JSON.stringify(t('web.audit.message_allowed'))},_GM_AUDIT_KEYWORD=${JSON.stringify(t('web.audit.message_keyword'))},_GM_AUDIT_ORIGINAL=${JSON.stringify(t('web.audit.message_original'))},_GM_AUDIT_INVALID=${JSON.stringify(t('web.audit.message_invalid'))},_A=${JSON.stringify(agentId)},_C=${JSON.stringify(channelId)},_STATUS_URL=${JSON.stringify(statusUrl)},_DISSOLVE_URL=${JSON.stringify(dissolveUrl)},_seen={},_gmSending=false;
function _gmNameOf(uid){var ms=window.__GROUP_MEMBERS__||[];for(var i=0;i<ms.length;i++){if(ms[i].uid===uid)return ms[i].name||uid;}return uid||"?";}
function _gmEsc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
function _gmMentioned(m){var x=m&&m.mention;return !!(x&&(x.all||(Array.isArray(x.uids)&&x.uids.indexOf(window.__MY_UID__)>=0)));}
function _gmMentionHtml(content,mention){var raw=String(content||""),labels=[];if(mention&&mention.all)labels.push("@"+_GM_ALL);else if(mention&&Array.isArray(mention.uids)){mention.uids.forEach(function(uid){var t="@"+_gmNameOf(uid);if(labels.indexOf(t)<0)labels.push(t);});}labels.sort(function(a,b){return b.length-a.length});if(!labels.length)return _gmEsc(raw).replace(/\\n/g,"<br>");labels.forEach(function(label){var i=raw.indexOf(label);if(i>=0)raw=(raw.slice(0,i)+raw.slice(i+label.length)).replace(/^[ \\t]+/,"");});var badges=labels.map(function(label){return '<span class="gm-mention-token">'+_gmEsc(label)+"</span>";}).join(" ");return badges+(raw?"<br>"+_gmEsc(raw).replace(/\\n/g,"<br>"):"");}
function _gmSenderHtml(uid,name){var label=name||uid||"?";if(window.__GROUP_STATUS__==="dissolved"||!uid||uid===window.__MY_UID__||!document.getElementById("group-reply-input"))return "<strong>"+_gmEsc(label)+"</strong>";return '<button type="button" class="gm-sender-mention" data-uid="'+_gmEsc(uid)+'" data-name="'+_gmEsc(label)+'" title="'+_gmEsc(_GM_MENTION_TITLE)+'">'+_gmEsc(label)+"</button>";}
function _gmRenderTip(ct){try{var p=JSON.parse(ct);var inner=p.contentObj||p.content||p;if(inner.type>=1001&&inner.type<=2000)return inner.content||"";if(typeof inner.content==="string"){var s=inner.content;(inner.extra||[]).forEach(function(e,i){s=s.split("{"+i+"}").join(e.name||e.uid||"")});return s;}return String(ct);}catch(_){return ct;}}
function _gmAuditHtml(ct,tm){try{var d=JSON.parse(ct),direction=d.direction||(String(d.audit||"").indexOf("出站")>=0?"outbound":"inbound"),title=direction==="outbound"?_GM_AUDIT_OUT:_GM_AUDIT_IN,result=d.action==="hard_deny"?_GM_AUDIT_BLOCKED:_GM_AUDIT_ALLOWED,rows="";if(d.keyword)rows+='<div class="gm-audit-row"><span>'+_gmEsc(_GM_AUDIT_KEYWORD)+"</span>"+_gmEsc(d.keyword)+"</div>";if(d.text)rows+='<div class="gm-audit-row"><span>'+_gmEsc(_GM_AUDIT_ORIGINAL)+"</span>"+_gmEsc(d.text).replace(/\\n/g,"<br>")+"</div>";return '<div class="gm-audit-card"><div class="gm-audit-head"><strong>'+_gmEsc(title)+'</strong><span class="gm-audit-result">'+_gmEsc(result)+'</span><span class="meta">'+_gmEsc(tm)+"</span></div>"+rows+"</div>";}catch(_){return '<div class="gm-audit-card"><strong>'+_gmEsc(_GM_AUDIT_INVALID)+'</strong> <span class="meta">'+_gmEsc(tm)+"</span></div>";}}
function _gmApplyDissolved(){window.__GROUP_STATUS__="dissolved";var banner=document.getElementById("group-dissolved-banner");if(banner)banner.style.display="block";var st=document.getElementById("group-status-text");if(st){st.textContent=_GM_DISSOLVED;st.style.color="#d93025";}var reply=document.getElementById("reply");if(reply){reply.style.opacity="0.75";reply.innerHTML='<h3>'+_gmEsc(_GM_REPLY_TITLE)+'</h3><input type="text" disabled placeholder="'+_gmEsc(_GM_DISSOLVED_PH)+'" style="background:#f5f5f5;color:#999;cursor:not-allowed">';}var selectors='[data-active-only],form[action$="/mute"],button[onclick^="showKickDlg"],a[href*="mentionUid="],.gm-sender-mention';document.querySelectorAll(selectors).forEach(function(el){el.style.display="none";});var quit=document.getElementById("group-quit-btn");if(quit)quit.disabled=false;var quitNote=document.getElementById("group-owner-quit-note");if(quitNote)quitNote.style.display="none";}
window.__gmSetDissolved=_gmApplyDissolved;
function _gmRefreshStatus(){return fetch(_STATUS_URL,{headers:{Accept:"application/json"},cache:"no-store"}).then(function(r){return r.json()}).then(function(j){if(j.success&&j.status==="dissolved")_gmApplyDissolved();}).catch(function(){});}
window.showDissolveDlg=function(){if(window.__GROUP_STATUS__==="dissolved")return false;var d=document.getElementById("dissolve-dlg"),fb=document.getElementById("dissolve-feedback");if(fb)fb.textContent="";if(d)d.showModal();return false;};
window.closeDissolveDlg=function(){var d=document.getElementById("dissolve-dlg");if(d)d.close();};
window.confirmDissolveGroup=function(){if(window.__GROUP_STATUS__==="dissolved")return false;var fb=document.getElementById("dissolve-feedback"),btn=document.getElementById("dissolve-confirm-btn");if(fb)fb.textContent="";if(btn){btn.disabled=true;btn.textContent="...";}fetch(_DISSOLVE_URL,{method:"POST",headers:{"Content-Type":"application/json",Accept:"application/json"},body:"{}"}).then(function(r){return r.json()}).then(function(j){if(j.success){closeDissolveDlg();_gmApplyDissolved();}else if(fb){fb.textContent=j.error||_GM_SEND_FAILED;}}).catch(function(e){if(fb)fb.textContent=e.message||_GM_NETWORK_ERROR;}).finally(function(){if(btn){btn.disabled=false;btn.textContent=_GM_DISSOLVE_LABEL;}});return false;};
["kick-dlg","dissolve-dlg"].forEach(function(id){var d=document.getElementById(id);if(d)d.addEventListener("click",function(e){if(e.target===d)d.close();});});
window.__gmAdd=function(m){var bx=document.getElementById("msg-box");if(!bx)return;var sender=m.senderName||_gmNameOf(m.fromUid);var h,tt=new Date((m.timestamp||0)*1000).toLocaleTimeString();if(m.contentType===11){h=_gmAuditHtml(m.content,tt);}else if(m.contentType===12){h='<div class="tip">'+_gmEsc(_gmRenderTip(m.content))+' <span style="font-size:12px;color:#aaa">'+tt+'</span></div>';}else{var tm=tt,media=window.__vokoMessageRenderer.renderMedia(m.contentType,m.content),ct=String(m.content||"");if(!media&&ct.length>500)ct=ct.substring(0,500)+"\u2026";var atMe=_gmMentioned(m),badge=atMe?' <span class="gm-at-me-badge">'+_gmEsc(_GM_ME)+"</span>":"";h='<div class="gm-message'+(atMe?" gm-message-at-me":"")+'">'+_gmSenderHtml(m.fromUid,sender)+badge+' <span style="color:#888;font-size:13px">['+tm+"]</span><br>"+(media||_gmMentionHtml(ct,m.mention))+"</div>";}bx.insertAdjacentHTML("beforeend",h);bx.scrollTop=bx.scrollHeight;};
window.groupReplySend=function(e){e.preventDefault();if(_gmSending)return false;var f=e.target;var inp=f.querySelector('input[name=content]');var btn=f.querySelector('button[type=submit]')||f.querySelector('button');var err=f.querySelector('#reply-send-err');if(window.__GROUP_STATUS__==="dissolved"){_gmApplyDissolved();if(err){err.style.color="#d93025";err.textContent=_GM_DISSOLVED_PH;}return false;}var inputContent=inp.value;if(!inputContent.trim())return false;var mentions=window.__gmCollectMentions?window.__gmCollectMentions(inputContent):null;var content=window.__gmStripMentions?window.__gmStripMentions(inputContent):inputContent.trim();if(!content)return false;_gmSending=true;var idleBtnHtml=btn.innerHTML;btn.disabled=true;btn.setAttribute("aria-busy","true");btn.innerHTML='<span class="voko-spinner" aria-hidden="true"></span>'+_gmEsc(_GM_SENDING);if(err)err.textContent="";fetch("/messages/send",{method:"POST",headers:{"Content-Type":"application/json",Accept:"application/json"},body:JSON.stringify({agentId:_A,toUid:_C,content:content,channelType:2,mentions:mentions})}).then(function(r){return r.json()}).then(function(j){if(j.success){inp.value="";window.__GROUP_MENTION_STATE__=[];inp.focus();var mid=j.messageId;var mk=j.messageSeq!=null?("seq:"+j.messageSeq):mid;if(mk&&!_seen[mk]){_seen[mk]=1;window.__gmAdd({fromUid:window.__MY_UID__,senderName:window.__MY_NAME__||_gmNameOf(window.__MY_UID__),content:content,contentType:1,timestamp:Date.now()/1000,messageId:mid,mention:mentions});}}else{if(j.code==="GROUP_DISSOLVED")_gmApplyDissolved();if(err){err.style.color="#d93025";err.textContent=j.error||_GM_SEND_FAILED;}}}).catch(function(ex){if(err){err.style.color="#d93025";err.textContent=ex.message||_GM_NETWORK_ERROR;}}).finally(function(){_gmSending=false;if(btn.isConnected){btn.disabled=false;btn.removeAttribute("aria-busy");btn.innerHTML=idleBtnHtml;}});return false;};
(function(){function connect(){try{var ws=new WebSocket("ws://"+location.host+"/ws");ws.onopen=_gmRefreshStatus;ws.onmessage=function(e){try{var d=JSON.parse(e.data);if(d.event==="agent-wukongim:message"){var m=d.data;var mk=m.messageSeq!=null?("seq:"+m.messageSeq):m.messageId;if(m.channelId===_C&&m.agentId===_A){if(m.contentType===12)_gmRefreshStatus();if(mk&&!_seen[mk]){_seen[mk]=1;window.__gmAdd(m);}}}}catch(_){}};ws.onclose=function(){setTimeout(connect,3000)};}catch(_){setTimeout(connect,5000);}}connect();})();
window.addEventListener("focus",_gmRefreshStatus);window.addEventListener("pageshow",_gmRefreshStatus);document.addEventListener("visibilitychange",function(){if(document.visibilityState==="visible")_gmRefreshStatus();});if(window.__GROUP_STATUS__==="dissolved")_gmApplyDissolved();`+'</script>';
}
/** 群详情 @提及浮层（搜索 + 翻页 + 键盘）：纯前端，JS 动态建 DOM + 注入 <style> */
function mentionScript(tFn){
  const t=tFn||(k=>k);
  const I=JSON.stringify({
    title:t('web.group.mention.title'),
    search_ph:t('web.group.mention.search_ph'),
    empty:t('web.group.mention.empty'),
    prev:t('web.group.mention.prev'),
    next:t('web.group.mention.next'),
    page_of:t('web.group.mention.page_of'),
    all:t('web.group.mention.all')
  });
  const CSS_M='.gm-ment-pop{position:absolute;z-index:9999;background:#fff;border:1px solid #d0d0d0;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.15);display:none;flex-direction:column;width:300px;max-width:92vw}'
    +'.gm-ment-title{padding:8px 12px;font-size:13px;color:#666;border-bottom:1px solid #eee;font-weight:600}'
    +'.gm-ment-search{width:100%!important;max-width:none!important;border:none!important;border-bottom:1px solid #eee!important;border-radius:0!important;padding:10px 12px!important;margin:0!important;font-size:14px!important;box-shadow:none!important}'
    +'.gm-ment-search:focus{border-color:#1a73e8!important;box-shadow:none!important}'
    +'.gm-ment-list{overflow-y:auto;max-height:220px}'
    +'.gm-ment-item{padding:8px 12px;cursor:pointer;font-size:14px;display:flex;align-items:center;gap:6px}'
    +'.gm-ment-item:hover,.gm-ment-active{background:#e8f0fe}'
    +'.gm-ment-pagebar{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 12px;border-top:1px solid #eee;font-size:13px}'
    +'.gm-ment-page{background:#f0f0f0!important;border:1px solid #ccc!important;color:#333!important;padding:4px 10px!important;min-width:auto!important;min-height:auto!important;font-size:12px!important;margin:0!important}'
    +'.gm-ment-page:disabled{opacity:.5;cursor:not-allowed}'
    +'.gm-message{padding:8px 12px;margin:4px 0;border-radius:6px;border-left:4px solid #c7cdd4;background:#f8f9fa}'
    +'.gm-message-at-me{border-left-color:#1a73e8;background:#e8f0fe;box-shadow:inset 0 0 0 1px rgba(26,115,232,.12)}'
    +'.gm-mention-token{color:#1a73e8;font-weight:700;background:#dce8fb;border-radius:3px;padding:0 2px}'
    +'.gm-at-me-badge{display:inline-block;background:#1a73e8;color:#fff;border-radius:9px;padding:0 6px;font-size:11px;font-weight:700;line-height:18px;vertical-align:1px}'
    +'.gm-sender-mention{background:none!important;border:0!important;color:#1a73e8!important;padding:0!important;margin:0!important;min-width:0!important;min-height:0!important;font:inherit!important;font-weight:700!important;line-height:inherit!important;cursor:pointer!important}'
    +'.gm-sender-mention:hover,.gm-sender-mention:focus{text-decoration:underline!important;outline:none}';
  return '<style>'+CSS_M+'</style><script>var _MI='+I+';'+
`(function(){
var PAGE_SIZE=8;
var inp=document.getElementById('group-reply-input');
if(!inp)return;
var MEMS=(window.__IS_MANAGER__?[{uid:'',name:_MI.all,mentionAll:true}]:[]).concat(window.__GROUP_MEMBERS__||[]).filter(function(member){return member.mentionAll||member.uid!==window.__MY_UID__;});
var initialUid=inp.getAttribute('data-mention-uid')||'',initialName=inp.getAttribute('data-mention-name')||'';
window.__GROUP_MENTION_STATE__=initialUid&&initialName?[{token:'@'+initialName,uid:initialUid,all:false}]:[];
if(initialUid&&initialName){var initialEnd=inp.value.length;inp.setSelectionRange(initialEnd,initialEnd);}
window.__gmCollectMentions=function(content){var st=window.__GROUP_MENTION_STATE__||[];var all=false,uids=[];st.forEach(function(x){if(content.indexOf(x.token)<0)return;if(x.all)all=true;else if(x.uid&&uids.indexOf(x.uid)<0)uids.push(x.uid);});return all?{all:true,uids:[]}:(uids.length?{all:false,uids:uids}:null);};
window.__gmStripMentions=function(content){var result=String(content||""),st=window.__GROUP_MENTION_STATE__||[];st.forEach(function(x){var i=result.indexOf(x.token);if(i>=0)result=result.slice(0,i)+result.slice(i+x.token.length);});return result.replace(/[ \\t]{2,}/g," ").trim();};
window.__gmMentionMember=function(uid,name){if(!uid||uid===window.__MY_UID__)return;var label=name||uid,token="@"+label,st=window.__GROUP_MENTION_STATE__||[],exists=false;st.forEach(function(x){if(x.uid===uid&&inp.value.indexOf(x.token)>=0)exists=true;});var caret=typeof inp.selectionStart==="number"?inp.selectionStart:inp.value.length;if(!exists){var end=typeof inp.selectionEnd==="number"?inp.selectionEnd:caret,before=inp.value.slice(0,caret),after=inp.value.slice(end),prefix=before&&!/\s$/.test(before)?" ":"",suffix=!after||!/^\s/.test(after)?" ":"";inp.value=before+prefix+token+suffix+after;caret=before.length+prefix.length+token.length+suffix.length;st.push({token:token,uid:uid,all:false});window.__GROUP_MENTION_STATE__=st;}inp.focus();inp.setSelectionRange(caret,caret);};
document.addEventListener("click",function(ev){var b=ev.target.closest?ev.target.closest(".gm-sender-mention"):null;if(!b)return;window.__gmMentionMember(b.getAttribute("data-uid")||"",b.getAttribute("data-name")||"");});
var pop=null,searchInput=null,listEl=null,pageBarEl=null;
var query='',page=1,hi=0,filtered=[],trigAt=-1;
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function buildPop(){
  pop=document.createElement('div');pop.className='gm-ment-pop';
  pop.innerHTML='<div class="gm-ment-title">'+_MI.title+'</div><input type="text" class="gm-ment-search" placeholder="'+_MI.search_ph+'" autocomplete="off"><div class="gm-ment-list"></div><div class="gm-ment-pagebar"></div>';
  document.body.appendChild(pop);
  searchInput=pop.querySelector('.gm-ment-search');listEl=pop.querySelector('.gm-ment-list');pageBarEl=pop.querySelector('.gm-ment-pagebar');
  searchInput.addEventListener('input',onSearchInput);
  pop.addEventListener('mousedown',function(ev){ev.preventDefault();});
}
function positionPop(){var r=inp.getBoundingClientRect();pop.style.left=(r.left+window.scrollX)+'px';pop.style.top=(r.bottom+window.scrollY+4)+'px';pop.style.width=Math.max(r.width,300)+'px';}
function openPop(){if(!pop)buildPop();positionPop();pop.style.display='flex';setTimeout(function(){searchInput.focus();searchInput.select();},0);}
function closePop(){if(pop)pop.style.display='none';trigAt=-1;}
function doFilter(){
  var q=query.toLowerCase();
  filtered=MEMS.filter(function(mb){var nm=(mb.name||mb.uid).toLowerCase();var uid=(''+mb.uid).toLowerCase();return !q||nm.indexOf(q)>=0||uid.indexOf(q)>=0;});
  hi=0;page=1;renderList();
}
function renderList(){
  var total=Math.ceil(filtered.length/PAGE_SIZE);
  if(total===0){listEl.innerHTML='<div style="padding:14px;color:#888;text-align:center">'+_MI.empty+'</div>';pageBarEl.style.display='none';return;}
  if(page>total)page=total;if(page<1)page=1;
  var start=(page-1)*PAGE_SIZE;var slice=filtered.slice(start,start+PAGE_SIZE);
  listEl.innerHTML=slice.map(function(mb,i){return '<div class="gm-ment-item'+(i===hi?' gm-ment-active':'')+'" data-idx="'+i+'">'+esc(mb.name||mb.uid)+(mb.isAgent?' <span class="meta">🤖</span>':'')+' <span class="meta" style="font-size:12px">'+esc(mb.uid)+'</span></div>';}).join('');
  if(total>1){pageBarEl.style.display='flex';pageBarEl.innerHTML='<span>'+_MI.page_of.replace('{cur}',page).replace('{total}',total)+'</span><span><button type="button" class="gm-ment-page" data-d="-1" '+(page<=1?'disabled':'')+'>'+_MI.prev+'</button> <button type="button" class="gm-ment-page" data-d="1" '+(page>=total?'disabled':'')+'>'+_MI.next+'</button></span>';}
  else{pageBarEl.style.display='none';}
  var nodes=listEl.querySelectorAll('.gm-ment-item');
  for(var i=0;i<nodes.length;i++){(function(el){el.addEventListener('click',function(){insertMember(filtered[start+parseInt(el.getAttribute('data-idx'),10)]);});})(nodes[i]);}
  var pgs=pageBarEl.querySelectorAll('.gm-ment-page');
  for(var j=0;j<pgs.length;j++){(function(el){el.addEventListener('click',function(){page+=parseInt(el.getAttribute('data-d'),10);if(page<1)page=1;var tt=Math.ceil(filtered.length/PAGE_SIZE);if(page>tt)page=tt;renderList();});})(pgs[j]);}
}
function insertMember(mb){
  if(trigAt<0||!mb)return;
  var val=inp.value;var after=val.slice(trigAt+1);var m2=/^([^\\s@]*)/.exec(after);var oldLen=m2?m2[1].length:0;
  var label=mb.name||mb.uid;var ins='@'+label+' ';
  inp.value=val.slice(0,trigAt)+ins+val.slice(trigAt+1+oldLen);
  window.__GROUP_MENTION_STATE__.push({token:'@'+label,uid:mb.uid||'',all:mb.mentionAll===true});
  var nc=trigAt+ins.length;inp.setSelectionRange(nc,nc);trigAt=-1;closePop();inp.focus();
}
function onSearchInput(){
  if(trigAt<0)return;
  var val=inp.value;var nq=searchInput.value;var after=val.slice(trigAt+1);var m2=/^([^\\s@]*)/.exec(after);var oldLen=m2?m2[1].length:0;
  inp.value=val.slice(0,trigAt+1)+nq+val.slice(trigAt+1+oldLen);
  var nc=trigAt+1+nq.length;inp.setSelectionRange(nc,nc);query=nq;doFilter();
}
function detect(){
  var val=inp.value,caret=inp.selectionStart;var before=val.slice(0,caret),at=before.lastIndexOf('@'),tail=at>=0?before.slice(at+1):'';
  if(at>=0&&!/[\\s@]/.test(tail)){trigAt=at;query=tail;openPop();if(searchInput.value!==query)searchInput.value=query;doFilter();}
  else{closePop();}
}
inp.addEventListener('input',detect);
inp.addEventListener('keydown',function(ev){
  if(trigAt<0)return;
  var k=ev.key;
  if(k==='ArrowDown'||k==='ArrowUp'||k==='Enter'||k==='Escape'){ev.preventDefault();}else{return;}
  if(k==='Escape'){closePop();return;}
  if(!filtered.length)return;
  var start=(page-1)*PAGE_SIZE;var pageLen=Math.min(PAGE_SIZE,filtered.length-start);
  if(k==='ArrowDown'){hi=(hi+1)%pageLen;renderList();}
  else if(k==='ArrowUp'){hi=(hi-1+pageLen)%pageLen;renderList();}
  else if(k==='Enter'){var mb=filtered[start+hi];if(mb)insertMember(mb);}
});
document.addEventListener('mousedown',function(ev){if(trigAt<0)return;if(pop&&!pop.contains(ev.target)&&ev.target!==inp){closePop();}});
})();`+'</script>';
}

/** 群详情三 Tab（群消息/群成员/群操作）切换脚本 */
function gTabScript(){
  return '<script>(function(){var ids=["messages","members","ops"];function setTab(t){ids.forEach(function(id){var p=document.getElementById("gtab-"+id);if(p)p.style.display=(id===t?"":"none");});document.querySelectorAll("button[data-gtab]").forEach(function(b){var on=b.getAttribute("data-gtab")===t;b.style.borderBottomColor=on?"#1a73e8":"transparent";b.style.color=on?"#1a73e8":"#666";b.style.fontWeight=on?"700":"600";});var u=new URL(location.href);if(t==="messages")u.searchParams.delete("tab");else u.searchParams.set("tab",t);history.replaceState(null,"",u);}document.addEventListener("click",function(e){var b=e.target.closest("button[data-gtab]");if(b)setTab(b.getAttribute("data-gtab"))});})();</script>';
}

/** 群成员表搜索 + 分页（每页 10）：SSR 已渲染全部行（含排序），前端按搜索词/页码显隐 */
function membersScript(tFn){
  const t=tFn||(k=>k);
  const I=JSON.stringify({
    prev:t('web.group.mention.prev'),
    next:t('web.group.mention.next'),
    page_of:t('web.group.mention.page_of'),
    total:t('web.group.create.total_people')
  });
  return '<script>var _MB='+I+';'+
`(function(){
var SIZE=10,page=1,query='';
var tbody=document.getElementById('gm-members-tbody');
if(!tbody)return;
var allRows=Array.prototype.slice.call(tbody.querySelectorAll('tr')).map(function(r){return {el:r,text:(r.getAttribute('data-search')||'').toLowerCase()};});
var searchInput=document.getElementById('gm-members-search');
var bar=document.getElementById('gm-members-pagebar');
var cnt=document.getElementById('gm-members-count');
function apply(){
  var q=query.toLowerCase();
  var matched=allRows.filter(function(r){return !q||r.text.indexOf(q)>=0;});
  var total=Math.ceil(matched.length/SIZE)||1;
  if(page>total)page=total;if(page<1)page=1;
  allRows.forEach(function(r){r.el.style.display='none';});
  var start=(page-1)*SIZE;
  matched.slice(start,start+SIZE).forEach(function(r){r.el.style.display='';});
  if(cnt)cnt.textContent=_MB.total.replace('{count}',matched.length);
  if(!bar)return;
  if(matched.length<=SIZE){bar.style.display='none';return;}
  bar.style.display='flex';
  bar.innerHTML='<span>'+_MB.page_of.replace('{cur}',page).replace('{total}',total)+'</span><span><button type="button" class="gm-ment-page" data-d="-1" '+(page<=1?'disabled':'')+'>'+_MB.prev+'</button> <button type="button" class="gm-ment-page" data-d="1" '+(page>=total?'disabled':'')+'>'+_MB.next+'</button></span>';
  var pgs=bar.querySelectorAll('.gm-ment-page');
  for(var i=0;i<pgs.length;i++){(function(el){el.addEventListener('click',function(){page+=parseInt(el.getAttribute('data-d'),10);if(page<1)page=1;var tt=Math.ceil(matched.length/SIZE)||1;if(page>tt)page=tt;apply();});})(pgs[i]);}
}
if(searchInput)searchInput.addEventListener('input',function(){query=searchInput.value;page=1;apply();});
apply();
})();`+'</script>';
}

/** 搜索群页脚本：输入关键词 → 拉群卡片 → 申请入群（按 status 反馈） */
function searchScript(agentId, myGroupIds, tFn){
  const t=tFn||(k=>k);
  const I=JSON.stringify({
    empty:t('web.group.search.empty'),
    apply:t('web.group.search.apply'),
    enter:t('web.group.search.enter'),
    members:t('web.group.search.members'),
    already:t('web.group.search.already'),
    pending:t('web.group.search.pending'),
    dup:t('web.group.search.dup'),
    fail:t('web.group.search.fail'),
    loading:t('web.group.search.loading'),
    msg_ph:t('web.group.search.msg_ph')
  });
  return '<script>var _GS='+I+';var _GSA='+JSON.stringify(agentId)+';var _GSMG='+JSON.stringify(myGroupIds||[])+';'+
`(function(){
var inp=document.getElementById('gs-kw');
if(!inp)return;
var box=document.getElementById('gs-result');
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function doSearch(){
  var kw=(inp.value||'').trim();
  if(!kw){box.innerHTML='';return;}
  box.innerHTML='<p class="meta">'+_GS.loading+'</p>';
  fetch('/agents/'+_GSA+'/search-group',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({keyword:kw})})
    .then(function(r){return r.json()})
    .then(function(d){
      if(!d.success){box.innerHTML='<p class="error">'+esc(d.error||_GS.fail)+'</p>';return;}
      var gs=d.groups||[];
      if(!gs.length){box.innerHTML='<p class="meta">'+_GS.empty+'</p>';return;}
      box.innerHTML=gs.map(renderCard).join('');
      var btns=box.querySelectorAll('.gs-apply:not([disabled])');
      for(var i=0;i<btns.length;i++){(function(b){b.addEventListener('click',function(){applyJoin(b.getAttribute('data-cid'));});})(btns[i]);}
    })
    .catch(function(e){box.innerHTML='<p class="error">'+esc(e.message||_GS.fail)+'</p>';});
}
function renderCard(g){
  var joined=g.joined||(_GSMG||[]).indexOf(g.channel_id)>=0;
  var av=g.avatar?'<img src="'+esc(g.avatar)+'" style="width:40px;height:40px;border-radius:8px;object-fit:cover" alt="">':'';
  var title=av?'<div style="display:flex;align-items:center;gap:8px">'+av+'<strong>'+esc(g.name)+'</strong></div>':'<strong>'+esc(g.name)+'</strong>';
  var info='<div style="flex:1;min-width:220px">'+title+' <span class="meta">'+_GS.members.replace('{count}',g.member_count)+'</span>'+(g.notice?'<br><span class="meta" style="font-size:13px">'+esc(g.notice)+'</span>':'')+'</div>';
  var act;
  if(joined){
    act='<div style="text-align:right;min-width:180px"><span class="meta" style="color:#0f9d58;display:block;margin-bottom:6px">✓ '+_GS.already+'</span><button type="button" class="btn-xs gs-apply" data-cid="'+esc(g.channel_id)+'" disabled style="opacity:0.5;cursor:not-allowed">'+_GS.apply+'</button> <a class="btn-xs" href="/agents/'+_GSA+'/g/'+esc(g.channel_id)+'">'+_GS.enter+'</a></div>';
  }else{
    act='<div style="text-align:right;min-width:220px"><input type="text" class="gs-msg" data-cid="'+esc(g.channel_id)+'" placeholder="'+_GS.msg_ph+'" style="max-width:200px;margin:0 0 6px 0;font-size:13px;padding:6px 8px"><br><button type="button" class="btn-xs gs-apply" data-cid="'+esc(g.channel_id)+'">'+_GS.apply+'</button></div>';
  }
  return '<div class="card" style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;margin:8px 0">'+info+act+'</div>';
}
function applyJoin(cid){
  var mi=box.querySelector('input.gs-msg[data-cid="'+cid+'"]');
  var msg=mi?mi.value:'';
  var btn=box.querySelector('button.gs-apply[data-cid="'+cid+'"]');
  if(btn){btn.disabled=true;btn.textContent='...';}
  fetch('/agents/'+_GSA+'/g/'+cid+'/apply-join',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({message:msg})})
    .then(function(r){return r.json()})
    .then(function(d){
      if(btn){btn.disabled=false;btn.textContent=_GS.apply;}
      if(!d.success){alert(esc(d.error||_GS.fail));return;}
      var s=d.status;
      if(s==='joined'||s==='already_member'){location.href='/agents/'+_GSA+'/g/'+cid;}
      else if(s==='duplicate'){alert(_GS.dup);}
      else{alert(_GS.pending);}
    })
    .catch(function(e){if(btn){btn.disabled=false;btn.textContent=_GS.apply;}alert(esc(e.message||_GS.fail));});
}
window.doSearchGroup=doSearch;
inp.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();doSearch();}});
})();`+'</script>';
}

module.exports = { createGroupRouter };
