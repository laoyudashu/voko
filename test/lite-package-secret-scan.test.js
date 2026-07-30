const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { scanFiles } = require('../scripts/scan-package-secrets');

test('package secret scan reports locations without returning secret values', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-secret-scan-'));
  try {
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(
      path.join(root, 'src', 'config.js'),
      "const password = 'this-must-not-ship';\nconst ok = process.env.PASSWORD;\n",
    );

    const findings = scanFiles(root, ['src']);
    assert.deepEqual(findings, [{ rule: 'literal-secret', file: path.join('src', 'config.js'), line: 1 }]);
    assert.equal(JSON.stringify(findings).includes('this-must-not-ship'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('package secret scan accepts environment-only secret configuration', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-secret-scan-'));
  try {
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.writeFileSync(
      path.join(root, 'scripts', 'config.js'),
      'const secretKey = process.env.OSS_ACCESS_KEY_SECRET;\n',
    );
    assert.deepEqual(scanFiles(root, ['scripts']), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
