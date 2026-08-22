const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const runtime = fs.readFileSync(path.join(__dirname,'../src/e2ee/canary-runtime.ts'),'utf8');

test('Lite E2EE diagnostics retain only bounded error records',()=>{
  for(const stage of ['lite.parse_authorize','lite.reserve','lite.decrypt','lite.prepare','lite.provider_execute',
    'lite.provider_accepted','lite.reply_encrypt','lite.reply_deliver']) {
    assert.match(runtime,new RegExp(stage.replace('.','\\.')));
  }
  const diagnostic = runtime.slice(runtime.indexOf('private diagnostic('),runtime.indexOf('async handle('));
  assert.match(diagnostic,/if \(outcome !== 'error'\) return/);
  assert.match(diagnostic,/group:short\(fields\.group\)/);
  assert.match(diagnostic,/message:short\(fields\.message\)/);
  assert.doesNotMatch(diagnostic,/fields\.(plaintext|ciphertext|encryptedState|nativeSession|principal|cipherDigest|stateBefore|stateAfter|errorClass)/);
});

test('Lite E2EE does not trace successful messages or hash cryptographic state',()=>{
  assert.doesNotMatch(runtime,/this\.diagnostic\([^\n]+,'(?:ok|skip)'/);
  assert.doesNotMatch(runtime,/private (?:fingerprint|errorClass)\(/);
  assert.doesNotMatch(runtime,/(?:cipherDigest|stateBefore|stateAfter|errorClass):/);
  assert.match(runtime,/this\.diagnostic\(stage,'error'/);
});
