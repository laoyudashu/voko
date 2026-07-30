const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const LITE_DIR = ROOT;
const BUILD_SCRIPT = path.join(LITE_DIR, 'scripts', 'build-ts.js');
const REQUIRED_OUTPUTS = [
  'index.js',
  'core/audit.js',
  'core/dispatcher/index.js',
  'core/dispatcher/providers/openclaw-ws.js',
  'core/dispatcher/providers/hermes-http.js',
  'core/dispatcher/providers/zeroclaw-acp.js',
  'channels/registry.js',
  'channels/voko-email.js',
  'server/voko-email-handler.js',
].map((relative) => path.join(LITE_DIR, 'build', relative));

function runBuild() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BUILD_SCRIPT], {
      cwd: LITE_DIR,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`build-ts exited ${code}: ${stderr}`));
    });
  });
}

test('concurrent Lite builds never expose a partially deleted build tree', async () => {
  for (const output of REQUIRED_OUTPUTS) {
    assert.equal(fs.existsSync(output), true, `missing baseline output: ${output}`);
  }

  let observedMissing = null;
  const monitor = setInterval(() => {
    const missing = REQUIRED_OUTPUTS.filter((output) => !fs.existsSync(output));
    if (missing.length > 0 && !observedMissing) observedMissing = missing;
  }, 2);

  try {
    await Promise.all([runBuild(), runBuild()]);
  } finally {
    clearInterval(monitor);
  }

  assert.deepEqual(observedMissing, null, `build outputs disappeared: ${observedMissing}`);
  for (const output of REQUIRED_OUTPUTS) {
    assert.equal(fs.existsSync(output), true, `missing promoted output: ${output}`);
  }
});
