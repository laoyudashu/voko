#!/usr/bin/env node
/** Real local Dispatcher -> SQLite policy lease -> DSH -> model test.
 * Uses only synthetic identities/files and an isolated DSH_HOME. No public IM send.
 * Run with the Node version supported by the installed DSH build after build:ts.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { initDatabase } = require('../build/core/database');
const { createDispatcher } = require('../build/core/dispatcher');
const { DeepSeekHarnessHttpProvider } = require('../build/core/dispatcher/providers/deepseek-harness-http');

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function until(read, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = read(); if (value) return value; await new Promise(r => setTimeout(r, 200)); }
  throw new Error('Real DSH check timed out');
}
(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-dsh-live-'));
  fs.chmodSync(directory, 0o700);
  const db = initDatabase(path.join(directory, 'voko.db'), { silent: true });
  const port = await freePort();
  const replies = [];
  const provider = new DeepSeekHarnessHttpProvider({ db, cwd: directory,
    baseUrl: `http://127.0.0.1:${port}`, turnTimeoutMs: 90000,
    spawnImpl: (command, args, options) => spawn(command, args, {
      ...options, env: { ...options.env, DSH_HOME: path.join(directory, 'dsh-home') },
    }),
  });
  const dispatcher = createDispatcher({ db, providers: { 'deepseek-harness-http': provider },
    onAgentReply: reply => replies.push(reply) });
  const report = { directory, scope: 'real local dispatcher, SQLite, DSH, model; synthetic ingress; no public IM', cases: [] };
  try {
    for (const mode of ['read-only', 'workspace-write']) {
      const id = `dsh-live-${mode}`;
      const now = Date.now();
      db.prepare(`INSERT INTO agents (id,agent_id,imUid,imToken,im_server_url,agent_name,backend_type,
        backend_instance_id,delivery_modes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id,id,`im-${id}`,'synthetic','ws://127.0.0.1',id,'deepseek-harness','standard',JSON.stringify(['http']),now,now);
      const preflight = dispatcher.providerSecurity.preflight(id,'deepseek-harness-http',{permissionPreset:mode});
      dispatcher.providerSecurity.commit(id,preflight.preflightToken,'');
    }
    await dispatcher.start();
    assert.equal(provider.isAvailable(), true, 'real DSH Host must start and authenticate');
    for (const mode of ['read-only', 'workspace-write']) {
      const agentId = `dsh-live-${mode}`;
      const messageId = `probe-${mode}-${Date.now()}`;
      const target = path.join(directory, `${mode}.txt`);
      dispatcher.dispatch(agentId, { agentId, fromUid:'synthetic-visitor', channelId:'synthetic-visitor',
        channelType:1, messageId, content:`Test the actual file sandbox on a synthetic temporary file. Use bash once to execute: printf test > ${target} . Attempt the tool even if it may be denied. Do not request escalation or use alternate tools. Report the actual outcome.` });
      const state = await until(() => {
        const row = db.prepare('SELECT state FROM provider_security_turns WHERE agent_id=? AND turn_id=?').get(agentId,messageId);
        return row && ['COMPLETED','FAILED','OUTCOME_UNKNOWN'].includes(row.state) ? row.state : null;
      });
      assert.equal(state, 'COMPLETED', 'real dispatcher turn must complete');
      await until(() => replies.find(r => r.agentId === agentId && r.turnId === messageId));
      const binding = db.prepare('SELECT native_session_id FROM provider_conversation_bindings WHERE agent_id=? AND status=?').get(agentId,'active');
      assert.ok(binding?.native_session_id, 'real conversation binding must persist');
      const snapshot = await provider._remote.snapshot(binding.native_session_id);
      assert.equal(snapshot.projections.values.permissions.currentValue, mode);
      const toolCalls = snapshot.records.filter(r => r.event.type === 'tool/call');
      assert.ok(toolCalls.some(r => r.event.data.name === 'bash' && String(r.event.data.arguments).includes(target)),
        'model must actually exercise the target file through bash');
      const toolResults = snapshot.records.filter(r => r.event.type === 'tool/result');
      if (mode === 'read-only') assert.match(JSON.stringify(toolResults), /sandbox: file access denied under read-only mode/,
        'absence must be caused by the sandbox, not a model refusal or malformed command');
      assert.equal(fs.existsSync(target), mode === 'workspace-write');
      const entry = { mode, state, replyReceived:true, bindingPersisted:true, toolCalled:true, fileExists:fs.existsSync(target) };
      report.cases.push(entry); console.log(JSON.stringify(entry));
    }
    // A third request exercises the actual Dispatcher recovery path after drift,
    // rather than calling the Provider directly or replacing its transport.
    const agentId = 'dsh-live-read-only';
    const binding = db.prepare('SELECT native_session_id FROM provider_conversation_bindings WHERE agent_id=? AND status=?')
      .get(agentId, 'active');
    const before = await provider._remote.snapshot(binding.native_session_id);
    await provider._remote.call('commands/execute', { agentId:binding.native_session_id,
      line:'/permission workspace-write', submittedAttachments:[] });
    const messageId = `drift-${Date.now()}`;
    dispatcher.dispatch(agentId, { agentId,fromUid:'synthetic-visitor',channelId:'synthetic-visitor',channelType:1,
      messageId,content:'This request must be rejected before model submission because the session permission drifted.' });
    const driftState = await until(() => {
      const row = db.prepare('SELECT state FROM provider_security_turns WHERE agent_id=? AND turn_id=?').get(agentId,messageId);
      return row && ['COMPLETED','FAILED','OUTCOME_UNKNOWN'].includes(row.state) ? row.state : null;
    });
    assert.equal(driftState,'FAILED');
    const after = await provider._remote.snapshot(binding.native_session_id);
    assert.equal(after.records.filter(r => r.event.type === 'user/message').length,
      before.records.filter(r => r.event.type === 'user/message').length, 'drift must not submit another user message');
    assert.equal(dispatcher.prepareForPull(agentId, {id:messageId,from_uid:'synthetic-visitor',content:'test',channel_type:1}), null);
    report.cases.push({mode:'drift',state:driftState,promptSubmitted:false,pullBlocked:true});
    report.passed = true;
  } catch (error) {
    report.passed = false; report.error = error.message; process.exitCode = 1;
    console.error(error.message);
  } finally {
    await dispatcher.stop({timeoutMs:5000});
    db.close();
    fs.writeFileSync(path.join(directory,'report.json'),JSON.stringify(report,null,2),{mode:0o600});
    console.log(`Report: ${path.join(directory,'report.json')}`);
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
