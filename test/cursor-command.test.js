const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');

const { findWindowsBundle } = require('../build/core/dispatcher/cursor-command');

describe('Cursor Windows runtime resolution', () => {
  it('resolves the newest versioned runtime behind the official launcher', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-cursor-'));
    try {
      fs.writeFileSync(path.join(root, 'cursor-agent.cmd'), '@echo off\r\n');
      for (const version of ['2026.08.30-a1', '2026.08.31-b2']) {
        const dir = path.join(root, 'versions', version);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'node.exe'), 'test');
        fs.writeFileSync(path.join(dir, 'index.js'), 'test');
      }

      assert.deepEqual(findWindowsBundle(root), {
        command: path.join(root, 'versions', '2026.08.31-b2', 'node.exe'),
        prefixArgs: [path.join(root, 'versions', '2026.08.31-b2', 'index.js')],
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
