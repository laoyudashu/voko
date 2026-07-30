/**
 * payment-auth.js — 银行卡管理 & 银行搜索
 *
 * 路由：
 *   GET/POST  /payment-auth             — 银行卡列表 + 添加
 *   GET/POST  /payment-auth/:id/delete   — 删除确认 + 执行
 *   GET/POST  /payment-auth/:id/apply    — 认证申请 + 执行
 *   GET/POST  /agents/:agentId/payment-auth — 为 Agent 绑定或更换银行卡
 *   GET       /banks                     — 银行搜索
 */

const { Router } = require('express');
const { SUPPORTED_LOCALES, getClientBundle } = require('../core/i18n');
const { renderLanguageFooter } = require('./language-switcher');

// ═══════════════════════════════════════════════════════════════
//  CSS
// ═══════════════════════════════════════════════════════════════

const CSS = `@charset "UTF-8";*{box-sizing:border-box}body{font-family:'PingFang SC','Microsoft YaHei','Noto Sans SC','Hiragino Sans GB',sans-serif;background:#f5f7fa;color:#1a1a2e;margin:0;padding:20px;font-size:18px;line-height:1.7;max-width:1100px;margin-left:auto;margin-right:auto;-webkit-font-smoothing:antialiased}a{color:#1a73e8;font-weight:600;padding:4px 2px;display:inline-block}h1{font-size:24px;border-bottom:3px solid #1a73e8;padding-bottom:8px;margin:0 0 10px 0}h2{font-size:20px;margin:18px 0 8px 0;color:#1a1a2e}h3{font-size:17px;margin:0 0 4px 0;color:#1a73e8}nav{font-size:14px;color:#666;margin-bottom:10px;padding:6px 0;border-bottom:1px solid #ddd}.table-wrap{width:100%;overflow-x:auto;margin:6px 0 12px 0}table{width:100%;min-width:500px;border-collapse:collapse;background:#fff;border-radius:6px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,0.06)}th,td{padding:10px 12px;text-align:left;border:1px solid #e0e0e0;font-size:15px;white-space:nowrap}th{background:#e8f0fe;font-weight:700;font-size:14px}tr:nth-child(even){background:#fafbfc}label{display:block;margin-top:10px;font-weight:700;font-size:15px;color:#1a1a2e}input,select,textarea{width:100%;max-width:460px;padding:10px 12px;margin-top:3px;background:#fff;color:#1a1a2e;border:2px solid #b0b0b0;border-radius:6px;font-size:16px;font-family:inherit;outline:none}input:focus,select:focus{border-color:#1a73e8;box-shadow:0 0 0 3px rgba(26,115,232,0.12)}button,.btn{display:inline-block;margin-top:10px;padding:10px 22px;min-width:100px;font-size:16px;font-weight:700;cursor:pointer;text-align:center;font-family:inherit;background:#1a73e8;color:#fff;border:2px solid #1557b0;border-radius:6px;text-decoration:none}button:hover{background:#1557b0}.btn-success{background:#0f9d58;border-color:#0b8043}.btn-success:hover{background:#0b8043}.btn-danger{background:#d93025;border-color:#b71c1c}.btn-danger:hover{background:#b71c1c}.error{color:#d93025;font-weight:600}.meta{color:#888;font-size:14px}.card{background:#fff;border:1px solid #e0e0e0;border-radius:8px;padding:12px 16px;margin:10px 0;box-shadow:0 1px 2px rgba(0,0,0,0.04)}.btn-xs{padding:8px 14px;min-width:auto;min-height:36px;font-size:14px;font-weight:700;display:inline-block;margin:0;line-height:1.4;border-radius:4px;text-decoration:none}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 16px}.form-grid .full{grid-column:1/-1}@media(max-width:700px){.form-grid{grid-template-columns:1fr}}.voko-select{position:relative;width:100%;max-width:460px}.voko-select-trigger{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;margin-top:3px;background:#fff;color:#1a1a2e;border:2px solid #b0b0b0;border-radius:6px;font-size:16px;font-family:inherit;cursor:pointer;user-select:none}.voko-select-trigger:focus{border-color:#1a73e8;box-shadow:0 0 0 3px rgba(26,115,232,0.12);outline:none}.voko-select-arrow{font-size:11px;color:#888;margin-left:8px}.voko-select-dropdown{display:none;position:absolute;top:100%;left:0;right:0;z-index:100;margin-top:4px;background:#fff;border:2px solid #b0b0b0;border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,0.12);overflow:hidden}.voko-select-search{width:100%;padding:10px 12px;margin:0;background:#fff;color:#1a1a2e;border:none;border-bottom:1px solid #e0e0e0;font-size:14px;font-family:inherit;outline:none;box-sizing:border-box}.voko-select-options{max-height:220px;overflow-y:auto;padding:4px 0}.voko-option{padding:9px 14px;font-size:15px;color:#1a1a2e;cursor:pointer}.voko-option:hover{background:#e8f0fe}.voko-option-empty{color:#999!important;cursor:default}.field-error-text{display:none;color:#d93025;font-size:13px;margin-top:2px}.field-error-text.show{display:block}input.error{border-color:#d93025!important;box-shadow:0 0 0 3px rgba(217,48,37,0.12)!important}`;

// ═══════════════════════════════════════════════════════════════
//  工具函数
// ═══════════════════════════════════════════════════════════════

function esc(s){return(s==null?'':String(s)).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}

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
  return '<!DOCTYPE html>\n<html lang="'+lang+'">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width,initial-scale=1.0">\n<link rel="icon" href="/favicon.png">\n<title>VOKO — '+esc(title)+'</title>\n<style>'+CSS+'</style>\n'+i18nBoot+'\n</head>\n<body>\n<nav role="navigation" aria-label="'+esc(t('common.nav.aria_label'))+'">'+nav+'</nav>\n'+h1+'\n<main aria-label="'+esc(title)+'">'+msg+body+'</main>'+footer+jd+'\n</body>\n</html>'
}

// ═══════════════════════════════════════════════════════════════
//  银行搜索下拉 JS（AJAX 自动补全）
// ═══════════════════════════════════════════════════════════════

function bankSelectScript(tFn) {
  const t = tFn || (k => k);
  const i18n = JSON.stringify({
    placeholder: t('web.payment_auth.bank_placeholder'),
    select: t('web.payment_auth.bank_select'),
    no_match: t('web.payment_auth.bank_no_match') || '无匹配银行',
    loading: t('web.payment_auth.bank_loading') || '搜索中…',
  });
  return '<script>var BI18N='+i18n+';'+
'function esc(s){return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}'+
'(function(){'+
'var w=document.getElementById("bank-select-wrapper"),tr=document.getElementById("bank-select-trigger"),dd=document.getElementById("bank-select-dropdown"),bs=document.getElementById("bank-select-search"),tx=document.getElementById("bank-select-text"),oc=document.getElementById("bank-select-options"),bc=document.getElementById("bankCode"),bn=document.getElementById("bankName");'+
'var timer=null,abort=null;'+
'function open(){dd.style.display="block";bs.focus();if(!bs.value&&oc.children.length===0){search("")}}'+
'function close(){dd.style.display="none"}'+
'function doSearch(q){'+
'  if(abort)try{abort.abort()}catch(_){}'+
'  var ctrl=new AbortController();abort=ctrl;'+
'  oc.innerHTML=\'<div class="voko-option voko-option-empty">\'+BI18N.loading+\'</div>\';'+
'  fetch("/api/banks?keyword="+encodeURIComponent(q),{signal:ctrl.signal}).then(function(r){return r.json()}).then(function(data){'+
'    if(!data.success||!data.data||!data.data.length){oc.innerHTML=\'<div class="voko-option voko-option-empty">\'+BI18N.no_match+\'</div>\';return}'+
'    oc.innerHTML=data.data.map(function(b){return \'<div class="voko-option" data-code="\'+esc(b.code)+\'" data-name="\'+esc(b.name)+\'">\'+esc(b.name)+\'</div>\'}).join("");'+
'  }).catch(function(e){if(e.name!=="AbortError"){oc.innerHTML=\'<div class="voko-option voko-option-empty">\'+BI18N.no_match+\'</div>\'}});'+
'}'+
'var search=function(q){clearTimeout(timer);timer=setTimeout(function(){doSearch(q)},300)};'+
'if(tr&&dd){tr.addEventListener("click",function(e){e.stopPropagation();if(dd.style.display==="block")close();else open();});}'+
'if(bs){bs.addEventListener("input",function(){search(bs.value.trim())});bs.addEventListener("click",function(e){e.stopPropagation()});bs.placeholder=BI18N.placeholder;}'+
'if(oc){oc.addEventListener("click",function(e){var opt=e.target.closest(".voko-option");if(!opt||opt.classList.contains("voko-option-empty"))return;var code=opt.getAttribute("data-code"),name=opt.getAttribute("data-name");bc.value=code;bn.value=name;tx.textContent=name;close()});}'+
'if(bs){bs.addEventListener("keydown",function(e){if(e.key==="Escape"){close();tr.focus()}})}'+
'if(tr){tr.addEventListener("keydown",function(e){if(e.key==="Enter"||e.key===" "){e.preventDefault();open()}})}'+
'document.addEventListener("click",function(e){if(w&&!w.contains(e.target))close()});'+
'})();</script>';
}

// ═══════════════════════════════════════════════════════════════

function createPaymentAuthRouter(handlers, db) {
  const R = Router();

  function renderPage(req, title, body, opt) {
    return page(title, body, opt, req.t, req.locale);
  }

  // ── 银行卡列表 + 添加 ──
  R.get('/payment-auth', async (req, res, next) => {
    try {
      const T = req.t, L = k => esc(T(k));
      let auths = []; try { const r = await handlers.list_payment_auth({ keyword: req.query.keyword || '' }); auths = r.data || r.auths || r.paymentAuths || []; } catch {}
      let rows = '<tr><td colspan="5" class="meta" style="text-align:center">' + L('web.payment_auth.empty') + '</td></tr>';
      if (auths.length) rows = auths.map(a => {
        const status = String(a.receiverApplyStatus || '').toUpperCase();
        let primary = '<a href="/payment-auth/' + esc(a.id) + '/apply" class="btn btn-xs" style="margin-left:6px" data-agent-action="payment.auth.apply" role="button">' + L('web.payment_auth.cert_btn') + '</a>';
        if (status === 'COMPLETED') {
          primary = '';
        } else if (a.requestNo) {
          primary = '<form method="POST" action="/payment-auth/' + esc(a.id) + '/refresh" style="display:inline"><button type="submit" class="btn btn-xs" style="margin-left:6px">' + L('web.payment_auth.refresh_btn') + '</button></form>';
        }
        return '<tr><td>' + esc(a.name || '') + '</td><td>' + (a.bankCardMask || (a.bankCard ? esc(a.bankCard.substr(-4)) : '') || '') + '</td><td>' + esc(a.bankName || '') + '</td><td style="text-align:center">' + esc(a.receiverApplyStatusLabel || a.status || '') + '</td><td style="white-space:nowrap;text-align:center"><a href="/payment-auth/' + esc(a.id) + '/delete" class="btn btn-xs btn-danger" data-agent-action="payment.auth.delete" role="button">' + L('web.payment_auth.delete_btn') + '</a>' + primary + '</td></tr>';
      }).join('\n');

      // 银行选择器 HTML
      const bankHtml =
        '<div class="full"><label for="bank-select-wrapper">' + L('web.payment_auth.lbl.bankname') + '</label>' +
        '<div class="voko-select" id="bank-select-wrapper">' +
        '<div class="voko-select-trigger" id="bank-select-trigger" tabindex="0"><span class="voko-select-text" id="bank-select-text" style="color:#888">' + L('web.payment_auth.bank_select') + '</span><span class="voko-select-arrow">▼</span></div>' +
        '<div class="voko-select-dropdown" id="bank-select-dropdown">' +
        '<input type="text" class="voko-select-search" id="bank-select-search" autocomplete="off">' +
        '<div class="voko-select-options" id="bank-select-options"></div>' +
        '</div></div>' +
        '<input type="hidden" id="bankCode" name="bankCode" required>' +
        '<input type="hidden" id="bankName" name="bankName" required>' +
        '</div>';

      const validateI18n = {
        idcard: T('web.payment_auth.validate.idcard') || '身份证格式不正确，应为15或18位',
        bankcard: T('web.payment_auth.validate.bankcard') || '银行卡号格式不正确，应为16-19位数字',
        phone: T('web.payment_auth.validate.phone') || '手机号格式不正确，应为11位数字',
        bank_required: T('web.payment_auth.bank_required') || '请选择银行',
      };
      const formHtml =
        '<div class="card"><h3>' + L('web.payment_auth.add_title') + '</h3>' +
        '<form method="POST" action="/payment-auth" class="form-grid" id="add-card-form" onsubmit="return validateForm()">' +
        '<div><label for="pn">' + L('web.payment_auth.lbl.name') + '</label><input type="text" id="pn" name="name" required autocomplete="name"></div>' +
        '<div><label for="pi">' + L('web.payment_auth.lbl.idcard') + '</label><input type="text" id="pi" name="idCard" required onblur="validateIdCard()" oninput="clearError(\'pi\')"><span class="field-error-text" id="pi-err">' + esc(validateI18n.idcard) + '</span></div>' +
        '<div><label for="pb">' + L('web.payment_auth.lbl.bankcard') + '</label><input type="text" id="pb" name="bankCard" required onblur="validateBankCard()" oninput="clearError(\'pb\')"><span class="field-error-text" id="pb-err">' + esc(validateI18n.bankcard) + '</span></div>' +
        '<div><label for="pp">' + L('web.payment_auth.lbl.phone') + '</label><input type="text" id="pp" name="phone" required autocomplete="tel" onblur="validatePhone()" oninput="clearError(\'pp\')"><span class="field-error-text" id="pp-err">' + esc(validateI18n.phone) + '</span></div>' +
        bankHtml +
        '<div class="full"><button type="submit" class="btn-success" data-testid="add-btn">' + L('common.btn.add') + '</button></div>' +
        '</form></div>' +
        '<script>' +
        'var V={' +
        'idcard:' + JSON.stringify(validateI18n.idcard) + ',' +
        'bankcard:' + JSON.stringify(validateI18n.bankcard) + ',' +
        'phone:' + JSON.stringify(validateI18n.phone) + ',' +
        'bank_required:' + JSON.stringify(validateI18n.bank_required) +
        '};' +
        'function showError(id){var el=document.getElementById(id+"-err");if(el)el.classList.add("show");var inp=document.getElementById(id);if(inp)inp.classList.add("error")}' +
        'function clearError(id){var el=document.getElementById(id+"-err");if(el)el.classList.remove("show");var inp=document.getElementById(id);if(inp)inp.classList.remove("error")}' +
        'function validateIdCard(){var v=document.getElementById("pi").value.trim();if(v&&!/^\\d{15}$|^\\d{17}[\\dXx]$/.test(v)){showError("pi");return false}clearError("pi");return true}' +
        'function validateBankCard(){var v=document.getElementById("pb").value.trim();if(v&&!/^\\d{16,19}$/.test(v)){showError("pb");return false}clearError("pb");return true}' +
        'function validatePhone(){var v=document.getElementById("pp").value.trim();if(v&&!/^1\\d{10}$/.test(v)){showError("pp");return false}clearError("pp");return true}' +
        'function validateForm(){var ok=true;var bc=document.getElementById("bankCode"),bn=document.getElementById("bankName");' +
        'if(!bc.value||!bn.value){alert(V.bank_required);return false}' +
        'if(!validateIdCard())ok=false;' +
        'if(!validateBankCard())ok=false;' +
        'if(!validatePhone())ok=false;' +
        'return ok}' +
        '</script>';

      res.send(renderPage(req, T('web.payment_auth.title'),
        '<div class="table-wrap"><table><thead><tr><th>' + L('web.payment_auth.col.name') + '</th><th>' + L('web.payment_auth.col.card') + '</th><th>' + L('web.payment_auth.col.bank') + '</th><th style="text-align:center">' + L('web.payment_auth.col.status') + '</th><th style="text-align:center">' + L('web.payment_auth.col.action') + '</th></tr></thead><tbody>' + rows + '</tbody></table></div>' + formHtml,
        { nav: '<a href="/">' + L('common.nav.home') + '</a> › ' + L('web.payment_auth.breadcrumb'), footer: bankSelectScript(T) }));
    } catch (e) { next(e); }
  });

  R.post('/payment-auth', async (req, res, next) => {
    try {
      const r = await handlers.add_payment_auth({ name: req.body.name, idCard: req.body.idCard, bankCard: req.body.bankCard, phone: req.body.phone, bankCode: req.body.bankCode, bankName: req.body.bankName });
      r.success ? res.redirect('/payment-auth') : res.send(renderPage(req, req.t('common.label.failed'), '<p class="error">' + esc(r.error) + '</p><a href="/payment-auth">' + esc(req.t('common.btn.back')) + '</a>'));
    } catch (e) { next(e); }
  });

  // ── 删除银行卡确认页 ──
  R.get('/payment-auth/:id/delete', async (req, res, next) => {
    try {
      const T = req.t, L = k => esc(T(k));
      let auth = null;
      if (db) { const r = db.prepare('SELECT * FROM payment_auth WHERE id=?').all(req.params.id); if (r.length) auth = r[0]; }
      if (!auth) return res.send(renderPage(req, T('web.payment_auth.not_found_title'), '<p class="error">' + T('web.payment_auth.not_found_msg') + '</p><a href="/payment-auth">' + L('common.btn.back') + '</a>'));
      res.send(renderPage(req, T('web.payment_auth.confirm_title'), '<div class="card"><p>' + T('web.payment_auth.confirm_msg') + '</p><table><tr><th>' + L('web.payment_auth.th.name') + '</th><td>' + esc(auth.name || '') + '</td></tr><tr><th>' + L('web.payment_auth.th.bank') + '</th><td>' + esc(auth.bank_name || '') + '</td></tr><tr><th>' + L('web.payment_auth.th.card') + '</th><td>' + esc((auth.bank_card || '').substr(-4)) + '</td></tr></table><br><form method="POST" action="/payment-auth/' + esc(req.params.id) + '/delete"><button type="submit" class="btn-danger" data-testid="confirm-delete-btn">' + L('web.payment_auth.confirm_btn') + '</button><a href="/payment-auth" class="btn" style="margin-left:8px">' + L('common.btn.cancel') + '</a></form></div>', { nav: '<a href="/">' + L('common.nav.home') + '</a> › <a href="/payment-auth">' + L('web.payment_auth.breadcrumb') + '</a> › ' + L('web.payment_auth.delete_crumb') }));
    } catch (e) { next(e); }
  });

  R.post('/payment-auth/:id/delete', async (req, res, next) => {
    try { const r = await handlers.delete_payment_auth({ id: req.params.id }); r.success ? res.redirect('/payment-auth') : res.send(renderPage(req, req.t('common.label.failed'), '<p class="error">' + esc(r.error) + '</p><a href="/payment-auth">' + esc(req.t('common.btn.back')) + '</a>')); } catch (e) { next(e); }
  });

  // ── 申请认证 ──
  R.get('/payment-auth/:id/apply', (req, res) => {
    const T = req.t, L = k => esc(T(k));
    let userEmail = '';
    try { if (db) { const rt = db.prepare("SELECT data FROM config WHERE type='runtime'").get(); if (rt) { const d = JSON.parse(rt.data); userEmail = d.userEmail || ''; } } } catch {}
    res.send(renderPage(req, T('web.payment_auth.apply_title'), '<div class="card"><form method="POST" action="/payment-auth/' + esc(req.params.id) + '/apply"><p>' + T('web.payment_auth.apply_msg') + '</p><label for="ae">' + L('web.payment_auth.apply_email_lbl') + '</label><input type="email" id="ae" name="email" value="' + esc(userEmail) + '" autocomplete="email"><br><br><button type="submit" class="btn-success">' + L('web.payment_auth.apply_btn') + '</button><a href="/payment-auth" class="btn" style="margin-left:8px">' + L('common.btn.cancel') + '</a></form></div>', { nav: '<a href="/">' + L('common.nav.home') + '</a> › <a href="/payment-auth">' + L('web.payment_auth.breadcrumb') + '</a> › ' + L('web.payment_auth.apply_crumb') }));
  });

  R.post('/payment-auth/:id/apply', async (req, res, next) => {
    try { const r = await handlers.apply_payment_auth({ paymentAuthId: req.params.id, email: req.body.email || undefined }); r.success ? res.redirect('/payment-auth') : res.send(renderPage(req, req.t('common.label.failed'), '<p class="error">' + esc(r.error) + '</p><a href="/payment-auth">' + esc(req.t('common.btn.back')) + '</a>')); } catch (e) { next(e); }
  });

  R.post('/payment-auth/:id/refresh', async (req, res, next) => {
    try {
      const r = await handlers.refresh_payment_auth({ paymentAuthId: req.params.id });
      r.success ? res.redirect('/payment-auth') : res.send(renderPage(req, req.t('common.label.failed'), '<p class="error">' + esc(r.error) + '</p><a href="/payment-auth">' + esc(req.t('common.btn.back')) + '</a>'));
    } catch (e) { next(e); }
  });

  // ── 从 Agent 侧绑定或更换银行卡 ──
  R.get('/agents/:agentId/payment-auth', (req, res) => {
    const T = req.t, L = k => esc(T(k));
    const agent = db ? db.prepare('SELECT agent_id, agent_name, payment_auth_id FROM agents WHERE agent_id=?').get(req.params.agentId) : null;
    if (!agent) return res.status(404).send(renderPage(req, T('web.payment_auth.not_found_title'), '<p class="error">' + L('web.payment_auth.agent_not_found') + '</p><a href="/">' + L('common.btn.back') + '</a>'));
    const auths = db ? db.prepare("SELECT id,bank_name,bank_card FROM payment_auth WHERE UPPER(COALESCE(receiver_apply_status,''))='COMPLETED' ORDER BY updated_at DESC").all() : [];
    const options = auths.map(a => '<option value="' + esc(a.id) + '"' + (a.id === agent.payment_auth_id ? ' selected' : '') + '>' + esc((a.bank_name || '') + ' •••• ' + String(a.bank_card || '').slice(-4)) + '</option>').join('');
    const select = options
      ? '<select id="paymentAuthId" name="paymentAuthId" required><option value="">' + L('web.payment_auth.bind_select_card') + '</option>' + options + '</select>'
      : '<p class="meta">' + L('web.payment_auth.no_verified_card') + ' <a href="/payment-auth">' + L('web.payment_auth.add_or_verify_card') + '</a></p>';
    const submit = options ? '<button type="submit" class="btn-success">' + L(agent.payment_auth_id ? 'web.payment_auth.change_card_btn' : 'web.payment_auth.bind_card_btn') + '</button>' : '';
    const body = '<div class="card"><form method="POST" action="/agents/' + esc(agent.agent_id) + '/payment-auth"><p>' + esc(T('web.payment_auth.bind_for_agent', { name: agent.agent_name || agent.agent_id })) + '</p><label for="paymentAuthId">' + L('web.payment_auth.bind_card') + '</label>' + select + '<br>' + submit + '<a href="/" class="btn" style="margin-left:8px">' + L('common.btn.cancel') + '</a></form></div>';
    res.send(renderPage(req, T('web.payment_auth.bind_title'), body, { nav: '<a href="/">' + L('common.nav.home') + '</a> › ' + L('web.payment_auth.bind_title') }));
  });

  R.post('/agents/:agentId/payment-auth', async (req, res, next) => {
    try {
      const r = await handlers.bind_agent_payment_auth({ paymentAuthId: req.body.paymentAuthId, agentId: req.params.agentId });
      r.success ? res.redirect('/') : res.send(renderPage(req, req.t('common.label.failed'), '<p class="error">' + esc(r.error) + '</p><a href="/agents/' + esc(req.params.agentId) + '/payment-auth">' + esc(req.t('common.btn.back')) + '</a>'));
    } catch (e) { next(e); }
  });

  // 兼容旧书签；新入口统一从 Agent 列表进入。
  R.get('/payment-auth/:id/bind', (req, res) => {
    const T = req.t, L = k => esc(T(k));
    const agents = db ? db.prepare('SELECT agent_id, agent_name, payment_auth_id FROM agents ORDER BY agent_name, agent_id').all() : [];
    const options = agents.map(a => '<option value="' + esc(a.agent_id) + '"' + (a.payment_auth_id === req.params.id ? ' selected' : '') + '>' + esc(a.agent_name || a.agent_id) + '</option>').join('');
    const body = '<div class="card"><form method="POST" action="/payment-auth/' + esc(req.params.id) + '/bind"><label for="agentId">' + L('web.payment_auth.bind_agent') + '</label><select id="agentId" name="agentId" required><option value="">' + L('web.payment_auth.bind_select') + '</option>' + options + '</select><br><button type="submit" class="btn-success">' + L('web.payment_auth.bind_btn') + '</button><a href="/payment-auth" class="btn" style="margin-left:8px">' + L('common.btn.cancel') + '</a></form></div>';
    res.send(renderPage(req, T('web.payment_auth.bind_title'), body, { nav: '<a href="/">' + L('common.nav.home') + '</a> › <a href="/payment-auth">' + L('web.payment_auth.breadcrumb') + '</a> › ' + L('web.payment_auth.bind_title') }));
  });

  R.post('/payment-auth/:id/bind', async (req, res, next) => {
    try {
      const r = await handlers.bind_agent_payment_auth({ paymentAuthId: req.params.id, agentId: req.body.agentId });
      r.success ? res.redirect('/payment-auth') : res.send(renderPage(req, req.t('common.label.failed'), '<p class="error">' + esc(r.error) + '</p><a href="/payment-auth">' + esc(req.t('common.btn.back')) + '</a>'));
    } catch (e) { next(e); }
  });

  // ── 银行搜索 ──
  R.get('/banks', async (req, res, next) => {
    try {
      const T = req.t, L = k => esc(T(k));
      let banks = []; try { const r = await handlers.search_banks({ keyword: req.query.keyword || '' }); banks = r.banks || []; } catch {}
      let rows = '<tr><td colspan="2" class="meta" style="text-align:center">' + L('web.banks.empty') + '</td></tr>';
      if (banks.length) rows = banks.map(b => '<tr><td>' + esc(b.code || b.bankCode || '') + '</td><td>' + esc(b.name || b.bankName || '') + '</td></tr>').join('\n');
      res.send(renderPage(req, T('web.banks.title'), '<form method="GET" action="/banks" style="margin-bottom:10px"><label for="bk">' + L('web.banks.keyword') + '</label><input type="text" id="bk" name="keyword" required><button type="submit">' + L('common.btn.search') + '</button></form><div class="table-wrap"><table><thead><tr><th>' + L('web.banks.col.code') + '</th><th>' + L('web.banks.col.name') + '</th></tr></thead><tbody>' + rows + '</tbody></table></div><a href="/payment-auth">' + T('web.banks.back') + '</a>', { nav: '<a href="/">' + L('common.nav.home') + '</a> › <a href="/payment-auth">' + L('web.banks.breadcrumb') + '</a> › ' + L('web.banks.search_crumb') }));
    } catch (e) { next(e); }
  });

  return R;
}

module.exports = { createPaymentAuthRouter };
