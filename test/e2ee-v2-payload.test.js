'use strict';

const assert=require('node:assert/strict');
const test=require('node:test');
const {decodeE2eePayload,E2EE_V2_PAYLOAD_VERSION}=require('../build/e2ee/v2-payload');

test('attachment payload preserves an optional caption for a single provider invocation',()=>{
  const decoded=decodeE2eePayload(JSON.stringify({
    version:E2EE_V2_PAYLOAD_VERSION,
    kind:'attachment_manifest',
    attachment:{messageId:'attachment-1'},
    caption:'请说明图片内容',
  }));
  assert.equal(decoded.structured,true);
  assert.equal(decoded.kind,'attachment_manifest');
  assert.equal(decoded.caption,'请说明图片内容');
});

test('attachment payload rejects an invalid caption instead of forwarding it',()=>{
  assert.throws(()=>decodeE2eePayload(JSON.stringify({
    version:E2EE_V2_PAYLOAD_VERSION,
    kind:'attachment_manifest',
    attachment:{messageId:'attachment-1'},
    caption:{text:'invalid'},
  })),/E2EE_V2_PAYLOAD_INVALID/);
});
