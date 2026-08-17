'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { existsSync } = require('node:fs');
const { homedir } = require('node:os');
const { join, resolve } = require('node:path');

const root = resolve(__dirname, '..');
const cargo = process.env.CARGO || join(homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo');
execFileSync(cargo, ['build', '--quiet', '--locked', '--manifest-path', 'e2ee/Cargo.toml',
  '--bin', 'voko-e2ee-canary-endpoint'], { cwd: root, stdio: 'inherit' });
const executable = join(root, 'e2ee', 'target', 'debug', process.platform === 'win32'
  ? 'voko-e2ee-canary-endpoint.exe' : 'voko-e2ee-canary-endpoint');
if (!existsSync(executable)) throw new Error('Canary endpoint executable was not built');

function endpoint(role, device) {
  const child = spawn(executable, [`--role=${role}`, '--principal=canary-principal', `--device=${device}`,
    '--agent=did:voko:canary-agent', '--group=canary-real-group', '--conversation=canary-real-conversation'],
  { cwd: root, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  const pending = [];
  lines.on('line', (line) => pending.shift()?.resolve(JSON.parse(line)));
  child.once('exit', (code) => {
    while (pending.length) pending.shift().reject(new Error(`endpoint exited ${code}`));
  });
  const request = (command) => new Promise((resolveRequest, reject) => {
    pending.push({ resolve: resolveRequest, reject });
    if (command) child.stdin.write(`${JSON.stringify(command)}\n`);
  }).then((result) => {
    if (!result.success) throw new Error(result.error || 'endpoint failed');
    return result;
  });
  return { child, ready: request(null), request, close() { child.stdin.end(); lines.close(); } };
}

(async () => {
  let creator = endpoint('creator', 'browser-device');
  let recipient = endpoint('recipient', 'owner-device');
  try {
    const [creatorReady, recipientReady] = await Promise.all([creator.ready, recipient.ready]);
    assert.equal(creatorReady.role, 'creator');
    assert.equal(recipientReady.role, 'recipient');
    assert.match(recipientReady.keyPackage, /^[A-Za-z0-9_-]+$/);
    const prepared = await creator.request({ op: 'prepare_add', key_package: recipientReady.keyPackage });
    await recipient.request({ op: 'join', welcome: prepared.welcome });
    await creator.request({ op: 'accept_add' });
    const ack = await recipient.request({ op: 'encrypt', message_id: 'established-ack', text: 'GROUP_ESTABLISHED' });
    assert.equal((await creator.request({ op: 'decrypt', envelope: ack.envelope })).text, 'GROUP_ESTABLISHED');
    const outbound = await creator.request({ op: 'encrypt', message_id: 'message-1', text: 'browser to Lite' });
    assert.equal((await recipient.request({ op: 'decrypt', envelope: outbound.envelope })).text, 'browser to Lite');
    const [creatorSnapshot, recipientSnapshot] = await Promise.all([
      creator.request({ op: 'snapshot' }), recipient.request({ op: 'snapshot' }),
    ]);
    creator.close(); recipient.close();
    creator = endpoint('creator', 'browser-device');
    recipient = endpoint('recipient', 'owner-device');
    await Promise.all([creator.ready, recipient.ready]);
    await creator.request({ op: 'restore', snapshot: creatorSnapshot.snapshot });
    await recipient.request({ op: 'restore', snapshot: recipientSnapshot.snapshot });
    const reply = await recipient.request({ op: 'encrypt', message_id: 'message-2', text: 'Lite to browser' });
    assert.equal((await creator.request({ op: 'decrypt', envelope: reply.envelope })).text, 'Lite to browser');
    await assert.rejects(recipient.request({ op: 'decrypt', envelope: outbound.envelope }));
    console.log('E2EE Canary endpoint bidirectional and restart test passed.');
  } finally { creator.close(); recipient.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
