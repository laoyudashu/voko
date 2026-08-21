const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const runtime = fs.readFileSync(path.join(__dirname,'../src/e2ee/canary-runtime.ts'),'utf8');

test('Lite E2EE diagnostics identify the failed stage without logging protected material',()=>{
  for(const stage of ['lite.parse_authorize','lite.reserve','lite.decrypt','lite.prepare','lite.provider_execute',
    'lite.provider_accepted','lite.reply_encrypt','lite.reply_deliver','lite.completed']) {
    assert.match(runtime,new RegExp(stage.replace('.','\\.')));
  }
  const diagnostic = runtime.slice(runtime.indexOf('private diagnostic('),runtime.indexOf('async handle('));
  assert.match(diagnostic,/group:short\(fields\.group\)/);
  assert.match(diagnostic,/message:short\(fields\.message\)/);
  assert.match(diagnostic,/cipherDigest:clean\(fields\.cipherDigest\)/);
  assert.match(diagnostic,/stateBefore:clean\(fields\.stateBefore\)/);
  assert.match(diagnostic,/errorClass:clean\(fields\.errorClass\)/);
  assert.doesNotMatch(diagnostic,/fields\.(plaintext|ciphertext|encryptedState|nativeSession|principal)/);
});

test('Lite E2EE correlates ciphertext and state without logging protected values',()=>{
  assert.match(runtime,/this\.diagnostic\('lite\.decrypt_before','ok'/);
  assert.match(runtime,/this\.diagnostic\('lite\.reply_encrypted','ok'/);
  assert.match(runtime,/cipherDigest:this\.fingerprint\(sealed\.envelope\?\.ciphertext\)/);
  assert.match(runtime,/stateAfter:this\.fingerprint\(sealed\.encryptedState\)/);
  assert.match(runtime,/errorClass:this\.errorClass\(error\)/);
});
