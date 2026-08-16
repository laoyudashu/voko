'use strict';

const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const { homedir, tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const readline = require('node:readline');
const crypto = require('node:crypto');

const root = resolve(__dirname, '..');
const cargo = existsSync(join(homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo'))
  ? join(homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo')
  : 'cargo';
const target = join(tmpdir(), 'voko-e2ee-witness-processes');
execFileSync(cargo, ['build', '--locked', '--manifest-path', 'e2ee/Cargo.toml', '--bin', 'voko-e2ee-witness-endpoint'], {
  cwd: root, env: { ...process.env, CARGO_TARGET_DIR: target }, stdio: 'inherit', windowsHide: true,
});
const executable = join(target, 'debug', process.platform === 'win32' ? 'voko-e2ee-witness-endpoint.exe' : 'voko-e2ee-witness-endpoint');

function endpoint() {
  const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'inherit'], shell: false, windowsHide: true });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = [];
  lines.on('line', (line) => pending.shift()?.(JSON.parse(line)));
  return {
    request(entries) {
      return new Promise((resolveResponse) => {
        pending.push(resolveResponse);
        child.stdin.write(`${JSON.stringify({ entries })}\n`);
      });
    },
    close() { child.stdin.end(); lines.close(); },
  };
}

function verify(response) {
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  const key = crypto.createPublicKey({ key: Buffer.concat([prefix, Buffer.from(response.witnessKey, 'hex')]), format: 'der', type: 'spki' });
  const domain = Buffer.from('voko.transparency.checkpoint/1\0');
  const size = Buffer.alloc(8);
  size.writeBigUInt64BE(BigInt(response.treeSize));
  return crypto.verify(null, Buffer.concat([domain, size, Buffer.from(response.rootHash, 'hex')]), key, Buffer.from(response.signature, 'hex'));
}

(async () => {
  const first = endpoint();
  const second = endpoint();
  const entries = [1, 2].map((epoch) => ({
    identityScope: 'owner-scope', deviceKeyId: `device-${epoch}`, keyEpoch: epoch,
    credentialPublicKey: `credential-${epoch}`,
  }));
  try {
    const [a, b] = await Promise.all([first.request(entries), second.request(entries)]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.notEqual(a.witnessKey, b.witnessKey);
    assert.equal(a.rootHash, b.rootHash);
    assert.equal(verify(a), true);
    assert.equal(verify(b), true);

    const extended = [...entries, { identityScope: 'owner-scope', deviceKeyId: 'device-3', keyEpoch: 3, credentialPublicKey: 'credential-3' }];
    assert.equal((await first.request(extended)).ok, true);
    assert.equal((await second.request(extended)).ok, true);
    const fork = [{ identityScope: 'owner-scope', deviceKeyId: 'fork', keyEpoch: 9, credentialPublicKey: 'fork' }];
    assert.deepEqual(await first.request(fork), { ok: false, treeSize: null, rootHash: null, witnessKey: null, signature: null, error: 'split_view' });
    assert.deepEqual(await second.request(fork), { ok: false, treeSize: null, rootHash: null, witnessKey: null, signature: null, error: 'split_view' });
    console.log('Two independent Witness processes signed one append-only view and rejected a fork.');
  } finally {
    first.close();
    second.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
