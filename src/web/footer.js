const pkg = require('../../package.json');
const { renderLanguageSwitcher } = require('./language-switcher');

const esc = (value) => String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function renderSystemFooter(db, tFn, locale) {
  const t = tFn || ((key) => key);
  const language = renderLanguageSwitcher(locale);
  const report = '<a href="/bug-report" style="font-size:13px">' + esc(t('web.bug_report.link')) + '</a>';
  try {
    const row = db && db.prepare("SELECT data FROM config WHERE type='runtime'").get();
    if (!row) return '<div data-voko-system-footer style="display:flex;justify-content:flex-end;gap:14px;align-items:center;margin-top:20px">' + report + language + '</div>';
    const runtime = JSON.parse(row.data);
    let updateNotice = '';
    let updateDialog = '';
    try {
      const updateRow = db.prepare("SELECT data FROM config WHERE type='update_status'").get();
      const update = updateRow && updateRow.data ? JSON.parse(updateRow.data) : null;
      if (update && update.updateAvailable) {
        updateNotice = ' <button type="button" data-voko-update-hint onclick="document.getElementById(\'voko-update-dialog\').showModal()" style="margin:0 0 0 8px;padding:1px 7px;min-width:0;min-height:0;border:1px solid #e37400;border-radius:10px;background:#fff7e6;color:#b45309;font:inherit;font-weight:700;line-height:1.5;cursor:pointer">' + esc(t('common.footer.update_available')) + '</button>';
        updateDialog = '<dialog id="voko-update-dialog" style="width:min(460px,calc(100vw - 32px));border:0;border-radius:14px;padding:0;color:#1a1a2e;box-shadow:0 18px 60px rgba(21,31,46,.28)"><div style="padding:24px 26px 18px"><div style="margin-bottom:8px"><strong style="font-size:19px">' + esc(t('common.footer.update_title')) + '</strong></div><p style="margin:8px 0 14px;color:#667085;font-size:14px;line-height:1.7">' + esc(t('common.footer.update_instruction')) + '</p><div style="display:flex;align-items:center;gap:8px;padding:10px 12px;border:1px solid #d9e2ef;border-radius:8px;background:#f7f9fc"><code id="voko-update-command" style="flex:1;font-size:15px;font-weight:700;color:#26364a">voko update</code><button type="button" id="voko-copy-update" style="margin:0;padding:6px 12px;min-width:0;font-size:13px">' + esc(t('common.footer.copy_command')) + '</button></div><div id="voko-copy-feedback" role="status" style="min-height:22px;margin-top:6px;color:#0f9d58;font-size:13px"></div></div><form method="dialog" style="display:flex;justify-content:flex-end;padding:12px 20px;background:#f7f9fc;border-top:1px solid #e8ebef"><button type="submit" style="margin:0;padding:7px 18px;min-width:0">' + esc(t('common.btn.close')) + '</button></form></dialog><script>(function(){var b=document.getElementById("voko-copy-update"),f=document.getElementById("voko-copy-feedback"),command="voko update";if(!b)return;b.addEventListener("click",function(){var done=function(){f.textContent=' + JSON.stringify(t('common.footer.command_copied')).replace(/</g, '\\u003c') + ';setTimeout(function(){f.textContent=""},2000)};if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(command).then(done).catch(function(){fallback(done)})}else fallback(done)});function fallback(done){var a=document.createElement("textarea");a.value=command;a.style.position="fixed";a.style.opacity="0";document.body.appendChild(a);a.select();try{document.execCommand("copy");done()}finally{a.remove()}}})();</script>';
      }
    } catch (_) {}
    let statusKey = 'common.footer.status_init', color = '#888';
    if (runtime.agents && runtime.agents.length) {
      if (runtime.agents.some((agent) => agent.imConnected === false)) { statusKey = 'common.footer.status_im_down'; color = '#d93025'; }
      else { statusKey = 'common.footer.status_ok'; color = '#0f9d58'; }
    }
    return '<div class="info-bar" data-voko-system-footer style="margin-top:20px;font-size:13px;color:#888;display:flex;justify-content:space-between;align-items:center"><span>'
      + '<span>' + esc(t('common.footer.version')) + ': V' + esc(pkg.version) + '</span>'
      + updateNotice
      + (runtime.port ? ' <span>' + esc(t('common.footer.port')) + ': ' + esc(runtime.port) + '</span>' : '')
      + ' <span>PID: ' + esc(runtime.pid || '') + '</span> <span>' + esc(t('common.footer.status')) + ': <span id="footer-status-text" style="color:' + color + ';font-weight:700">' + esc(t(statusKey)) + '</span></span></span>'
      + '<span style="display:flex;gap:14px;align-items:center">' + report + language + '</span></div>' + updateDialog;
  } catch (_) {
    return '<div data-voko-system-footer style="display:flex;justify-content:flex-end;gap:14px;align-items:center;margin-top:20px">' + report + language + '</div>';
  }
}

module.exports = { renderSystemFooter };
