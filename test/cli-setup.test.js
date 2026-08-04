const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

describe('voko setup', () => {
  it('diagnoses a first-run headless environment without opening a browser or creating a database', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-setup-'));
    const dbPath = path.join(directory, 'voko.db');
    try {
      const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'build', 'index.js'), 'setup'], {
        encoding: 'utf8',
        env: { ...process.env, VOKO_DB_PATH: dbPath },
        timeout: 10_000,
        windowsHide: true,
      });
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.success, true);
      assert.equal(output.headlessCompatible, true);
      assert.equal(output.browserOpened, false);
      assert.equal(output.database.exists, false);
      assert.equal(output.nextAction.type, 'login');
      assert.equal(path.isAbsolute(output.stableCommands.mcp.command), true);
      assert.equal(path.isAbsolute(output.stableCommands.mcp.args[0]), true);
      assert.equal(fs.existsSync(dbPath), false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
