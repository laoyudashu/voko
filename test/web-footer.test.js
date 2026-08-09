const test = require('node:test');
const assert = require('node:assert/strict');

const { renderSystemFooter } = require('../src/web/footer');
const { version: packageVersion } = require('../package.json');

const nextVersion = packageVersion.replace(/(\d+)$/, (patch) => String(Number(patch) + 1));

test('shared web footer renders runtime status and global actions', () => {
  const runtime = { port: 3100, pid: 48264, agents: [{ imConnected: true }] };
  const db = { prepare: (sql) => ({ get: () => sql.includes("type='runtime'") ? { data: JSON.stringify(runtime) } : null }) };
  const labels = {
    'common.footer.version': '版本',
    'common.footer.port': '端口',
    'common.footer.status': '运行状态',
    'common.footer.status_ok': '正常',
    'web.bug_report.link': '错误上报',
  };
  const html = renderSystemFooter(db, (key) => labels[key] || key, 'zh');

  assert.match(html, /data-voko-system-footer/);
  assert.match(html, /class="info-bar" data-voko-system-footer style="display:block;width:100%/);
  assert.match(html, /display:grid;grid-template-columns:minmax\(0,1fr\) auto minmax\(0,1fr\);align-items:center;gap:12px;overflow-x:auto/);
  assert.ok(html.includes(`版本: V${packageVersion}`));
  assert.match(html, /端口: 3100/);
  assert.match(html, /PID: 48264/);
  assert.match(html, /运行状态:[\s\S]*正常/);
  assert.match(html, /href="\/bug-report"[\s\S]*错误上报/);
  assert.match(html, /href="https:\/\/www\.vokovoko\.com\/docs\.html" target="_blank" rel="noopener noreferrer"[^>]*>common\.footer\.docs<\/a>/);
  assert.match(html, /href="https:\/\/github\.com\/laoyudashu\/voko" target="_blank" rel="noopener noreferrer"[^>]*>common\.footer\.github<\/a>/);
  assert.ok(html.indexOf('href="/bug-report"') < html.indexOf('href="https://www.vokovoko.com/docs.html"'));
  assert.ok(html.indexOf('href="https://www.vokovoko.com/docs.html"') < html.indexOf('href="https://github.com/laoyudashu/voko"'));
  assert.match(html, /role="navigation" aria-label="common\.footer\.links_aria"/);
  assert.match(html, /role="navigation"[^>]*flex-wrap:nowrap/);
  assert.doesNotMatch(html, /<nav\b/);
  assert.match(html, /class="voko-footer-copyright"[^>]*justify-self:center[^>]*white-space:nowrap/);
  assert.doesNotMatch(html, /display:block;width:100%;margin-top:8px/);
  assert.ok(html.indexOf('common.footer.copyright') < html.indexOf('href="/bug-report"'));
  assert.match(html, /common\.footer\.copyright/);
  assert.match(html, /data-voko-language-switcher/);
});

test('shared web footer shows a compact manual update hint without the latest version', () => {
  const runtime = { port: 3100, pid: 48264, agents: [{ imConnected: true }] };
  const update = { updateAvailable: true, latestVersion: nextVersion };
  const db = { prepare: (sql) => ({ get: () => sql.includes("type='runtime'") ? { data: JSON.stringify(runtime) } : { data: JSON.stringify(update) } }) };
  const labels = {
    'common.footer.version': '版本',
    'common.footer.port': '端口',
    'common.footer.status': '运行状态',
    'common.footer.status_ok': '正常',
    'common.footer.update_available': '有更新',
    'common.footer.update_title': '更新 VOKO',
    'common.footer.update_instruction': '请在终端运行以下命令。升级完成后，重新启动 VOKO 即可使用新版本。',
    'common.footer.copy_command': '复制',
    'common.footer.command_copied': '已复制升级命令',
    'common.btn.close': '关闭',
    'web.bug_report.link': '错误上报',
  };
  const html = renderSystemFooter(db, (key) => labels[key] || key, 'zh');

  assert.match(html, /data-voko-update-hint/);
  assert.match(html, />有更新<\/button>/);
  assert.match(html, /id="voko-update-dialog"/);
  assert.match(html, /id="voko-update-command"[\s\S]*voko update/);
  assert.match(html, /id="voko-copy-update"[\s\S]*复制/);
  assert.match(html, /升级完成后/);
  assert.ok(!html.includes(nextVersion));
});

test('shared web footer keeps navigation when runtime data is unavailable', () => {
  const db = { prepare: () => ({ get: () => null }) };
  const labels = {
    'common.footer.docs': 'Documentation',
    'common.footer.github': 'GitHub',
    'common.footer.copyright': '© VOKO · All rights reserved',
    'common.footer.links_aria': 'Footer links',
    'web.bug_report.link': 'Report a bug',
  };
  const html = renderSystemFooter(db, (key) => labels[key] || key, 'en');

  assert.match(html, /href="https:\/\/www\.vokovoko\.com\/docs\.html"[^>]*>Documentation<\/a>/);
  assert.match(html, /href="https:\/\/github\.com\/laoyudashu\/voko"[^>]*>GitHub<\/a>/);
  assert.match(html, /© VOKO · All rights reserved/);
});
