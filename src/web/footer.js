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
    try {
      const updateRow = db.prepare("SELECT data FROM config WHERE type='update_status'").get();
      const update = updateRow && updateRow.data ? JSON.parse(updateRow.data) : null;
      if (update && update.updateAvailable && update.latestVersion) updateNotice = ' <span style="color:#b45309;font-weight:700">' + esc(t('common.footer.update_available', { version: update.latestVersion })) + '</span>';
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
      + '<span style="display:flex;gap:14px;align-items:center">' + report + language + '</span></div>';
  } catch (_) {
    return '<div data-voko-system-footer style="display:flex;justify-content:flex-end;gap:14px;align-items:center;margin-top:20px">' + report + language + '</div>';
  }
}

module.exports = { renderSystemFooter };
