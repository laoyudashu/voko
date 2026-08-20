'use strict';
const assert = require('node:assert/strict'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const test = require('node:test');
const { A2AExecutionService, A2ALocalTaskStore, A2AScopeResolver, initA2ADatabase } = require('../build/a2a');
function envelope(task = 'task-1', principalId = 'principal-1', contextId = 'context-1') { return { agentId: 'agent-1', contextId, gatewayTaskId: task,
  bindingGeneration: 1, caller: { principalId, actorKind: 'agent', provenance: 'guest_a2a' }, payload: { text: 'hello' } }; }
function setup(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-execution-')); const db = initA2ADatabase(path.join(dir, 'a.db'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }); return { store: new A2ALocalTaskStore(db), scopes: new A2AScopeResolver(db), db }; }
test('first task stores native session and later task restores exactly it', async t => {
  const { store, scopes } = setup(t); const calls = []; const dispatcher = { async executeIsolated(options) { calls.push(options); options.onProviderAccepted?.({}); return {
    reply: { content: 'done' }, receipt: { deliveryReceipt: { nativeSessionId: 'native-1' }, provider: {
      providerId: 'codex-cli', providerType: 'codex', deliveryMode: 'cli' } } }; } };
  const service = new A2AExecutionService(store, dispatcher, undefined, undefined, scopes);
  assert.deepEqual(await service.execute(envelope()), { content: 'done' });
  await service.execute(envelope('task-2'));
  assert.equal(calls[0].timeoutMs, 120_000);
  assert.equal(calls[0].binding, null); assert.equal(calls[1].binding.nativeSessionId, 'native-1');
  assert.equal(calls[1].binding.strictSessionRoute, true);
});
test('oversized task text is rejected before Provider execution', async t => {
  const { store, scopes } = setup(t); let called = false; const service = new A2AExecutionService(store, { async executeIsolated() { called = true; } }, undefined, undefined, scopes);
  const value = envelope(); value.payload.text = 'x'.repeat(6145);
  await assert.rejects(() => service.execute(value), /Invalid/); assert.equal(called, false);
});
test('Provider dispatch rechecks that the local Agent is still eligible', async t => {
  const { store, scopes } = setup(t); let called = false;
  const service = new A2AExecutionService(store, { async executeIsolated() { called = true; } }, undefined,
    () => { throw new Error('A2A_AGENT_NOT_AVAILABLE'); }, scopes);
  await assert.rejects(() => service.execute(envelope()), /A2A_AGENT_NOT_AVAILABLE/); assert.equal(called, false);
});
test('internal no-reply sentinels never become A2A response text', async t => {
  const { store, scopes } = setup(t); const seen = [];
  const service = new A2AExecutionService(store, {
    async executeIsolated() { return { reply: { content: 'NO_REPLY' }, receipt: { provider: {} } }; },
  }, { async assertAllowed(content, direction) { seen.push([content, direction]); } }, undefined, scopes);
  assert.deepEqual(await service.execute(envelope()), { content: '', noReply: true });
  assert.deepEqual(seen, [['hello', 'inbound']]);
});
test('different principals using the same context never share a binding or session scope', async t => {
  const { store, scopes, db } = setup(t); const calls=[];let seq=0;
  const service=new A2AExecutionService(store,{async executeIsolated(options){calls.push(options);options.onProviderAccepted?.({});return {reply:{content:'ok'},receipt:{deliveryReceipt:{nativeSessionId:`native-${++seq}`},provider:{providerId:'codex-cli',providerType:'codex',deliveryMode:'cli'}}}}},undefined,undefined,scopes);
  await service.execute(envelope('task-a','principal-a','shared-context'));
  await service.execute(envelope('task-b','principal-b','shared-context'));
  assert.notEqual(calls[0].sessionScopeId,calls[1].sessionScopeId);assert.equal(calls[0].binding,null);assert.equal(calls[1].binding,null);
  const rows=db.prepare("SELECT principal_scope,session_scope_id,native_session_id FROM a2a_local_contexts WHERE context_id='shared-context'").all();
  assert.equal(rows.length,2);assert.notEqual(rows[0].native_session_id,rows[1].native_session_id);
});
test('a binding generation change fails closed before Provider execution', async t => {
  const { store, scopes } = setup(t); let calls = 0;
  const service = new A2AExecutionService(store, { async executeIsolated(options) { calls += 1; options.onProviderAccepted?.({});
    return { reply: { content: 'ok' }, receipt: { deliveryReceipt: { nativeSessionId: 'native-generation-1' },
      provider: { providerId: 'codex-cli', providerType: 'codex', deliveryMode: 'cli' } } }; } }, undefined, undefined, scopes);
  await service.execute(envelope('task-1'));
  const changed = envelope('task-2'); changed.bindingGeneration = 2;
  await assert.rejects(() => service.execute(changed), /BINDING_GENERATION_MISMATCH/);
  assert.equal(calls, 1);
});
test('tasks sharing one principal context execute one Provider turn at a time', async t => {
  const {store,scopes}=setup(t);let release;const gate=new Promise(resolve=>{release=resolve});let calls=0;
  const service=new A2AExecutionService(store,{async executeIsolated(options){calls+=1;options.onProviderAccepted?.({});await gate;return {reply:{content:'ok'},receipt:{deliveryReceipt:{nativeSessionId:'native-serial'},provider:{providerId:'codex-cli',providerType:'codex',deliveryMode:'cli'}}}}},undefined,undefined,scopes);
  const first=service.execute(envelope('task-1'));
  await new Promise(resolve=>setImmediate(resolve));
  await assert.rejects(()=>service.execute(envelope('task-2')),error=>error.deliveryOutcome==='not_delivered'&&error.message==='A2A_CONTEXT_BUSY');
  assert.equal(calls,1);release();await first;
});
test('attachment execution passes verified paths to Provider and uploads task-scoped replies',async t=>{
  const {store,scopes}=setup(t);let dispatched;let cleaned=0;
  const workspace={async prepare(){return{inputs:[{path:'safe-input.txt',name:'input.txt',mediaType:'text/plain',size:4,sha256:'11'.repeat(32)}],
    outputDirectory:'safe-output',prompt:content=>`${content} [attachments]`,cleanup:async()=>{cleaned+=1;}};},
    async uploadOutputs(){return[{artifactId:'output-1',name:'answer.txt',part:{artifactRef:'ref-1'}}];}};
  const dispatcher={async executeIsolated(options){dispatched=options;options.onProviderAccepted?.({});return{reply:{content:'done'},receipt:{provider:{}}};}};
  const service=new A2AExecutionService(store,dispatcher,undefined,undefined,scopes,{},workspace);
  const value=envelope();value.payload.attachments=[{attachmentRef:'extatt_abcdefghijklmnop'}];
  const result=await service.execute(value);assert.equal(dispatched.attachments[0].path,'safe-input.txt');
  assert.equal(dispatched.attachmentOutputDirectory,'safe-output');assert.match(dispatched.content,/attachments/);
  assert.equal(result.artifacts[0].part.artifactRef,'ref-1');assert.equal(cleaned,1);
});
