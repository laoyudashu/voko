const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('native release builder never embeds the private release key', () => {
  const source = fs.readFileSync(path.join(__dirname,'..','scripts','build-e2ee-native-release.js'),'utf8');
  assert.match(source,/E2EE_RELEASE_PRIVATE_KEY_REQUIRED/);
  assert.match(source,/createPublicKey/);
  assert.doesNotMatch(source,/privateKeyPem\s*:/);
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type:'pkcs8',format:'pem' }).toString();
  assert.doesNotMatch(source,new RegExp(pem.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
});
