const test = require('node:test');
const assert = require('node:assert/strict');

const { renderSystemFooter } = require('../src/web/footer');

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
  assert.match(html, /版本: V0\.4\.0/);
  assert.match(html, /端口: 3100/);
  assert.match(html, /PID: 48264/);
  assert.match(html, /运行状态:[\s\S]*正常/);
  assert.match(html, /href="\/bug-report"[\s\S]*错误上报/);
  assert.match(html, /data-voko-language-switcher/);
});
