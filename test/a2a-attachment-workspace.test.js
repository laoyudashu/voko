'use strict';
const assert=require('node:assert/strict');const crypto=require('node:crypto');const fs=require('node:fs');
const os=require('node:os');const path=require('node:path');const test=require('node:test');
const {A2AAttachmentWorkspace}=require('../build/a2a');

test('plaintext attachment workspace verifies input and uploads only task-scoped outputs',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'voko-a2a-attachments-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const bytes=Buffer.from('safe input');const hash=crypto.createHash('sha256').update(bytes).digest('hex');const audits=[];const uploads=[];
  const client={async downloadAttachment(){return new Response(bytes,{headers:{'content-type':'text/plain','content-length':String(bytes.length),
    'x-content-sha256':hash,'content-disposition':"attachment; filename*=UTF-8''input.txt"}});},async uploadArtifact(_task,input){uploads.push(input);return{artifactRef:'artifact-ref-1'};}};
  const workspace=new A2AAttachmentWorkspace(root);const prepared=await workspace.prepare('task-1',['extatt_abcdefghijklmnop'],client,
    {async assertAllowed(content,direction){audits.push([content,direction]);}});
  assert.equal(fs.readFileSync(prepared.inputs[0].path,'utf8'),'safe input');assert.match(prepared.prompt('review'),/untrusted input data/);
  fs.writeFileSync(path.join(prepared.outputDirectory,'answer.txt'),'safe output');
  const output=await workspace.uploadOutputs('task-1',prepared.outputDirectory,client,{async assertAllowed(content,direction){audits.push([content,direction]);}});
  assert.equal(output[0].part.artifactRef,'artifact-ref-1');assert.equal(uploads[0].filename,'answer.txt');
  assert.deepEqual(audits,[['safe input','inbound'],['safe output','outbound']]);await prepared.cleanup();assert.equal(fs.existsSync(path.join(root,'task-1')),false);
});

test('attachment integrity mismatch is rejected before a Provider can see a path',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'voko-a2a-attachments-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const client={async downloadAttachment(){return new Response('changed',{headers:{'content-type':'text/plain','content-length':'7','x-content-sha256':'00'.repeat(32)}});}};
  await assert.rejects(()=>new A2AAttachmentWorkspace(root).prepare('task-1',['extatt_abcdefghijklmnop'],client),/INTEGRITY/);
  assert.equal(fs.existsSync(path.join(root,'task-1')),false);
});

test('attachment declared MIME must match its bytes',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'voko-a2a-attachments-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const bytes=Buffer.from('not a png');const hash=crypto.createHash('sha256').update(bytes).digest('hex');
  const client={async downloadAttachment(){return new Response(bytes,{headers:{'content-type':'image/png','content-length':String(bytes.length),
    'x-content-sha256':hash}});}};
  await assert.rejects(()=>new A2AAttachmentWorkspace(root).prepare('task-mime',['extatt_abcdefghijklmnop'],client),/CONTENT_TYPE_MISMATCH/);
  assert.equal(fs.existsSync(path.join(root,'task-mime')),false);
});
