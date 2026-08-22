'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { existsSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join, resolve } = require('node:path');

if (process.platform !== 'darwin') throw new Error('macOS fault injection requires darwin');

const root = resolve(__dirname, '..');
const localCargo = join(homedir(), '.cargo', 'bin', 'cargo');
const cargo = process.env.CARGO || (existsSync(localCargo) ? localCargo : 'cargo');
const outputArg = process.argv.find((value) => value.startsWith('--output='));
const output = resolve(root, outputArg ? outputArg.slice('--output='.length) : 'e2ee-macos-fault-summary.json');

execFileSync(cargo, ['build', '--quiet', '--locked', '--manifest-path', 'e2ee/Cargo.toml',
  '--bin', 'voko-e2ee-canary-endpoint'], { cwd: root, stdio: 'inherit' });
const executable = join(root, 'e2ee', 'target', 'debug', 'voko-e2ee-canary-endpoint');
if (!existsSync(executable)) throw new Error('Canary endpoint executable was not built');

function endpoint(role, device, ownerScope) {
  const child = spawn(executable, [`--role=${role}`, '--principal=macos-fault-principal', `--device=${device}`,
    '--agent=did:voko:macos-fault-agent', '--group=macos-fault-group',
    '--conversation=macos-fault-conversation', `--owner-scope=${ownerScope}`],
  { cwd: root, stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout });
  const pending = [];
  let exited = false;
  const exitedPromise = new Promise((resolveExit) => child.once('exit', (code, signal) => {
    exited = true;
    while (pending.length) pending.shift().reject(new Error(`endpoint exited code=${code} signal=${signal}`));
    resolveExit({ code, signal });
  }));
  lines.on('line', (line) => {
    const waiter = pending.shift();
    if (!waiter) return;
    try { waiter.resolve(JSON.parse(line)); } catch (error) { waiter.reject(error); }
  });
  const request = (command) => new Promise((resolveRequest, reject) => {
    if (exited) return reject(new Error('endpoint already exited'));
    pending.push({ resolve: resolveRequest, reject });
    if (command) child.stdin.write(`${JSON.stringify(command)}\n`);
  }).then((result) => {
    if (!result.success) throw new Error(result.error || 'endpoint failed');
    return result;
  });
  return {
    child,
    ready: request(null),
    request,
    async crash() {
      child.kill('SIGKILL');
      const result = await exitedPromise;
      assert.equal(result.signal, 'SIGKILL');
      lines.close();
    },
    close() {
      if (!exited) child.stdin.end();
      lines.close();
    },
  };
}

(async () => {
  const nonce = `${process.pid}-${Date.now()}`;
  const creatorScope = `voko-e2ee-macos-fault-creator-${nonce}`;
  const recipientScope = `voko-e2ee-macos-fault-recipient-${nonce}`;
  let creator = endpoint('creator', 'macos-browser-device', creatorScope);
  let recipient = endpoint('recipient', 'macos-owner-device', recipientScope);
  const faults = [];
  try {
    const [, recipientReady] = await Promise.all([creator.ready, recipient.ready]);
    const prepared = await creator.request({ op: 'prepare_add', key_package: recipientReady.keyPackage });
    await recipient.request({ op: 'join', welcome: prepared.welcome });
    await creator.request({ op: 'accept_add' });

    const ack = await recipient.request({ op: 'encrypt', message_id: 'macos-established', text: 'GROUP_ESTABLISHED' });
    assert.equal((await creator.request({ op: 'decrypt', envelope: ack.envelope })).text, 'GROUP_ESTABLISHED');
    const outbound = await creator.request({ op: 'encrypt', message_id: 'macos-before-crash', text: 'fixed ciphertext' });
    assert.equal((await recipient.request({ op: 'decrypt', envelope: outbound.envelope })).text, 'fixed ciphertext');

    const [creatorSnapshot, recipientSnapshot] = await Promise.all([
      creator.request({ op: 'seal_snapshot' }), recipient.request({ op: 'seal_snapshot' }),
    ]);

    await recipient.crash();
    faults.push('recipient_sigkill');
    recipient = endpoint('recipient', 'macos-owner-device', recipientScope);
    await recipient.ready;
    await recipient.request({ op: 'restore_sealed', sealed_snapshot: recipientSnapshot.sealedSnapshot });
    await assert.rejects(recipient.request({ op: 'decrypt', envelope: outbound.envelope }));
    faults.push('replay_rejected_after_restart');

    const reply = await recipient.request({ op: 'encrypt', message_id: 'macos-after-crash', text: 'recovered endpoint' });
    assert.equal((await creator.request({ op: 'decrypt', envelope: reply.envelope })).text, 'recovered endpoint');

    await creator.crash();
    faults.push('creator_sigkill');
    creator = endpoint('creator', 'macos-browser-device', creatorScope);
    await creator.ready;
    await creator.request({ op: 'restore_sealed', sealed_snapshot: creatorSnapshot.sealedSnapshot });

    await recipient.request({ op: 'revoke_vault' });
    await recipient.crash();
    recipient = endpoint('recipient', 'macos-owner-device', recipientScope);
    await recipient.ready;
    await assert.rejects(recipient.request({ op: 'restore_sealed', sealed_snapshot: recipientSnapshot.sealedSnapshot }));
    faults.push('revoked_keychain_fails_closed');

    await creator.request({ op: 'revoke_vault' });
    const summary = { schemaVersion: 1, passed: true, platform: process.platform, arch: process.arch,
      faults, plaintextFallbacks: 0, createdAt: new Date().toISOString() };
    writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`macOS E2EE fault injection passed; evidence=${output}`);
  } finally {
    creator.close();
    recipient.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
