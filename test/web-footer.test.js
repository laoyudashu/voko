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
  assert.ok(html.includes(`版本: V${packageVersion}`));
  assert.match(html, /端口: 3100/);
  assert.match(html, /PID: 48264/);
  assert.match(html, /运行状态:[\s\S]*正常/);
  assert.match(html, /href="\/bug-report"[\s\S]*错误上报/);
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
