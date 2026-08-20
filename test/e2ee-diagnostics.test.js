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
  assert.doesNotMatch(diagnostic,/plaintext|ciphertext|encryptedState|nativeSession|principal/);
});
