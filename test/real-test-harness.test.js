const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { createReporter, durationMs, redact } = require('../scripts/real-test');

test('real acceptance refuses to run without an explicit local config', () => {
  const missing = path.join(__dirname, 'fixtures', 'missing-real-test.env');
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'real-test.js'), 'smoke'], {
    env: { ...process.env, VOKO_REAL_ENV: missing },
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /real-test config not found/);
});

test('real acceptance writes sanitized JSON and HTML reports', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-real-report-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const reporter = createReporter('smoke', root);
  reporter.check('sample <check>', true, 'token-like text is report data, not configuration');
  assert.equal(reporter.finish(), true);
  const reportDir = path.join(root, reporter.runId);
  const summary = JSON.parse(fs.readFileSync(path.join(reportDir, 'summary.json'), 'utf8'));
  const html = fs.readFileSync(path.join(reportDir, 'report.html'), 'utf8');
  assert.equal(summary.ok, true);
  assert.match(html, /sample &lt;check&gt;/);
  assert.equal(durationMs('30m'), 1_800_000);
  assert.equal(redact('Bearer abcdefghi'), 'Bearer [REDACTED]');
  assert.equal(redact('secret-value', { API_KEY: 'secret-value' }), '[REDACTED]');
});
