'use strict';

const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');

const cargo = process.env.CARGO || 'cargo';
const child = spawn(cargo, [
  'run', '--quiet', '--locked', '--manifest-path', 'e2ee/Cargo.toml',
  '-p', 'voko-e2ee-core', '--bin', 'voko-e2ee-relay-poc',
], { stdio: ['pipe', 'pipe', 'inherit'], shell: false });
const lines = createInterface({ input: child.stdout });
const pending = [];
lines.on('line', (line) => pending.shift()?.(JSON.parse(line)));

function request(command) {
  return new Promise((resolve) => {
    pending.push(resolve);
    child.stdin.write(`${JSON.stringify(command)}\n`);
  });
}

(async () => {
  const canary = 'E2EE_CANARY_SERVER_MUST_NOT_SEE';
  const encrypted = await request({ op: 'browser_encrypt', message_id: 'relay-message-1', text: canary });
  if (!encrypted.success) throw new Error(encrypted.error);
  const storedByRelay = JSON.stringify(encrypted.envelope);
  if (storedByRelay.includes(canary)) throw new Error('fake relay observed plaintext');

  const decrypted = await request({ op: 'lite_decrypt', envelope: encrypted.envelope });
  if (!decrypted.success || decrypted.text !== canary) throw new Error(decrypted.error || 'decryption mismatch');

  const tampered = structuredClone(encrypted.envelope);
  tampered.targetAgentDid = 'did:voko:another-agent';
  const rejected = await request({ op: 'lite_decrypt', envelope: tampered });
  if (rejected.success) throw new Error('tampered Agent route was accepted');

  console.log('E2EE fake relay ciphertext-only and route-tamper checks passed.');
})().finally(() => {
  child.stdin.end();
  lines.close();
}).catch((error) => {
  console.error(error);
  child.kill();
  process.exitCode = 1;
});
