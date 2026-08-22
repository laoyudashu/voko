'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { DatabaseSync } = require('node:sqlite');

const root = path.resolve(__dirname, '..');
const CONTENT_TYPE_E2EE = 13;

function localAgent() {
  const dbPath = process.env.VOKO_E2EE_PRODUCTION_TEST_DB
    || path.join(process.env.APPDATA || '', 'voko', 'voko.db');
  const agentId = process.env.VOKO_E2EE_PRODUCTION_TEST_AGENT_ID || 'gym';
  const db = new DatabaseSync(dbPath, { readOnly:true });
  try {
    const row = db.prepare(`SELECT agent_id,did FROM agents
      WHERE agent_id=? AND publish_status='published' AND did IS NOT NULL`).get(agentId);
    if (!row?.did) throw new Error('E2EE_PRODUCTION_TEST_AGENT_UNAVAILABLE');
    const hex = String(row.did).split(':').pop().replaceAll('-', '');
    if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error('E2EE_PRODUCTION_TEST_AGENT_DID_INVALID');
    return { localAgentId:String(row.agent_id),targetAgentDid:String(row.did),
      serverAgentId:`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`.toLowerCase() };
  } finally { db.close(); }
}

function endpoint(scope) {
  const executable = process.env.VOKO_E2EE_PRODUCTION_TEST_ENDPOINT
    || path.join(root,'e2ee','target','native-release','voko-e2ee-endpoint-win32-x64.exe');
  if (!path.isAbsolute(executable) || !fs.existsSync(executable)) throw new Error('E2EE_PRODUCTION_TEST_ENDPOINT_MISSING');
  const child = spawn(executable,[`--role=creator`,`--principal=${scope.principal}`,`--device=${scope.device}`,
    `--agent=${scope.agent}`,`--group=${scope.group}`,`--conversation=${scope.conversation}`,
    `--owner-scope=${scope.principal}`,'--key-epoch=1'],{ cwd:root,stdio:['pipe','pipe','pipe'],windowsHide:true });
  const lines = createInterface({ input:child.stdout });
  const pending = [];
  lines.on('line',line => {
    if (!String(line).trim()) return;
    const next = pending.shift();
    if (!next) return;
    try { next.resolve(JSON.parse(line)); } catch (error) { next.reject(error); }
  });
  child.once('exit',code => { while (pending.length) pending.shift().reject(new Error(`E2EE endpoint exited ${code}`)); });
  const request = command => new Promise((resolve,reject) => {
    pending.push({ resolve,reject });
    if (command) child.stdin.write(`${JSON.stringify(command)}\n`);
  }).then(result => { if (!result?.success) throw new Error(result?.error || 'E2EE endpoint failed'); return result; });
  return { ready:request(null),request,close() { child.stdin.end(); lines.close(); } };
}

async function request(baseUrl,pathName,options = {},attempt = 0) {
  const body = options.body == null ? undefined : JSON.stringify(options.body);
  const response = await fetch(`${baseUrl}${pathName}`,{ method:options.method || (body ? 'POST' : 'GET'),
    headers:{ accept:'application/json',...(body ? {'content-type':'application/json'} : {}),
      ...(options.token ? { authorization:`Bearer ${options.token}` } : {}) },body,
    signal:AbortSignal.timeout(options.timeoutMs || 20_000) });
  if (response.status === 429 && attempt < 2) {
    const seconds = Math.min(Math.max(Number.parseInt(response.headers.get('retry-after') || '5',10) || 5,1),60);
    await new Promise(resolve => setTimeout(resolve,seconds * 1000));
    return request(baseUrl,pathName,options,attempt + 1);
  }
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.success === false) throw Object.assign(new Error(data?.error?.code || `HTTP_${response.status}`),
    { status:response.status,code:`${pathName}:${data?.error?.code || `HTTP_${response.status}`}` });
  return data?.data ?? data;
}

async function waitForReply(baseUrl,token,guestAgentId,serverAgentId,requestMessageId,timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let cursor = 0;
  let malformed = 0;
  while (Date.now() < deadline) {
    const result = await request(baseUrl,'/guest/v1/messages/fetch',{ token,timeoutMs:35_000,body:{
      agentId:guestAgentId,channelId:serverAgentId,messageSeq:cursor,onlyReplies:true,limit:50,blockTimeout:20 } });
    for (const message of result.items || []) {
      cursor = Math.max(cursor,Number(message.messageSeq) || 0);
      if (Number(message.contentType) !== CONTENT_TYPE_E2EE || !String(message.content || '').trim()) continue;
      try {
        const envelope = JSON.parse(message.content);
        if (String(envelope?.messageId || '') === requestMessageId) continue;
        return envelope;
      } catch { malformed += 1; }
    }
  }
  if (malformed) throw new Error(`E2EE_PRODUCTION_REPLY_MALFORMED_${malformed}`);
  throw new Error('E2EE_PRODUCTION_REPLY_TIMEOUT');
}

(async () => {
  if (process.platform !== 'win32') throw new Error('E2EE_PRODUCTION_TEXT_PROBE_REQUIRES_WINDOWS');
  const baseUrl = String(process.env.VOKO_E2EE_PRODUCTION_TEST_BASE_URL || require('../src/endpoints.json').api.baseUrl).replace(/\/+$/,'');
  const agent = localAgent();
  const runId = `production-e2ee-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const group = crypto.randomBytes(24).toString('base64url');
  const conversation = crypto.randomBytes(24).toString('base64url');
  const expected = `E2EE_PRODUCTION_TEXT_OK_${crypto.randomBytes(5).toString('hex')}`;
  const guest = await request(baseUrl,'/guest/v1/sessions',{ method:'POST',body:{} });
  const token = guest.token;
  let creator;
  try {
    const identity = await request(baseUrl,'/guest/v1/e2ee/identity',{ token });
    creator = endpoint({ principal:identity.principalId,device:`browser-${crypto.randomUUID()}`,
      agent:agent.targetAgentDid,group,conversation });
    await creator.ready;
    const reservation = await request(baseUrl,'/guest/v1/e2ee/key-packages/reserve',{ token,body:{
      agentId:agent.serverAgentId,targetAgentDid:agent.targetAgentDid } });
    const prepared = await creator.request({ op:'prepare_add',key_package:reservation.keyPackage });
    const establishment = await request(baseUrl,'/guest/v1/e2ee/establishments',{ token,body:{
      reservationId:reservation.reservationId,agentId:agent.serverAgentId,
      groupId:group,conversationScope:conversation,
      commit:prepared.commit,welcome:prepared.welcome } });
    await creator.request({ op:'accept_add' });
    let active;
    for (let attempt = 0; attempt < 45; attempt += 1) {
      active = await request(baseUrl,'/guest/v1/e2ee/establishments/status',{ token,body:{ establishmentId:establishment.establishmentId } });
      if (active.state === 'active') break;
      if (active.state !== 'commit_accepted') throw new Error(`E2EE_ESTABLISHMENT_${active.state}`);
      await new Promise(resolve => setTimeout(resolve,1_000));
    }
    if (active?.state !== 'active' || !active.ack) throw new Error('E2EE_ESTABLISHMENT_TIMEOUT');
    const ack = JSON.parse(Buffer.from(active.ack,'base64url').toString('utf8'));
    if ((await creator.request({ op:'decrypt',envelope:ack })).text !== 'GROUP_ESTABLISHED') throw new Error('E2EE_ACK_INVALID');
    const messageId = `${runId}-request`;
    const encrypted = await creator.request({ op:'encrypt',message_id:messageId,
      text:`请只回复以下测试码，不要添加其他内容：${expected}` });
    await request(baseUrl,'/guest/v1/messages',{ token,body:{ agentId:guest.agentId,toUid:agent.serverAgentId,
      content:JSON.stringify(encrypted.envelope),contentType:CONTENT_TYPE_E2EE,clientMsgNo:messageId } });
    const reply = await waitForReply(baseUrl,token,guest.agentId,agent.serverAgentId,messageId,180_000);
    const plaintext = String((await creator.request({ op:'decrypt',envelope:reply })).text || '').trim();
    if (!plaintext.includes(expected)) {
      const category = plaintext === 'NO_REPLY' ? 'NO_REPLY' : plaintext.length === 0 ? 'EMPTY' : `UNEXPECTED_LENGTH_${plaintext.length}`;
      throw new Error(`E2EE_PRODUCTION_REPLY_MISMATCH_${category}`);
    }
    console.log(JSON.stringify({ passed:true,agentId:agent.localAgentId,protocolVersion:'voko.e2ee/1',
      contentType:CONTENT_TYPE_E2EE,plaintextFallbacks:0 }));
  } finally {
    creator?.close();
    if (token) await request(baseUrl,'/guest/v1/sessions/current',{ method:'DELETE',token }).catch(() => {});
  }
})().catch(error => { console.error(`Production E2EE text probe failed: ${error.code || error.message}`); process.exitCode=1; });
