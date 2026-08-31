'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { createWebRouter } = require('../build/web');
const { ProviderSecurityPolicyService } = require('../build/core/provider-security-policy');
const { createLocalWebSessionStore } = require('../build/core/local-web-session');

test('Provider security page and API expose only controls supported by the Agent Provider', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE agents(agent_id TEXT PRIMARY KEY,agent_name TEXT,backend_type TEXT,owner_email TEXT);
    INSERT INTO agents VALUES('agent-1','陈老师','workbuddy',NULL);
    INSERT INTO agents VALUES('agent-2','A诊','codex',NULL);
    INSERT INTO agents VALUES('agent-3','Goose助手','goose',NULL);
    CREATE TABLE provider_conversation_bindings(
      id TEXT PRIMARY KEY,agent_id TEXT,adapter_type TEXT,status TEXT,updated_at INTEGER
    );
  `);
  const providerSecurity = new ProviderSecurityPolicyService(db);
  const dispatcher = { providerSecurity, applyProviderSecurityPolicyChange: () => true };
  const webSessions = createLocalWebSessionStore(db);
  const handlers = {
    list_agents: async () => ({ agents: [
      { agentId: 'agent-1', agentName: '陈老师', backendType: 'workbuddy' },
      { agentId: 'agent-2', agentName: 'A诊', backendType: 'codex' },
      { agentId: 'agent-3', agentName: 'Goose助手', backendType: 'goose' },
    ] }),
  };
  const app = express();
  app.use(express.json());
  app.use(createWebRouter(handlers, db, { dispatcher, webSessions, localAuthToken: 'local-test-token' }));
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  t.after(() => db.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const auth = { 'X-VOKO-Token': 'local-test-token', Accept: 'application/json' };

  const page = await fetch(`${origin}/agents/agent-1/security`, { headers: auth });
  const html = await page.text();
  assert.equal(page.status, 200, html);
  assert.match(html, /访客权限与安全/);
  assert.match(html, /name="dataFileAccess"/);
  assert.doesNotMatch(html, /name="shell"/);
  assert.doesNotMatch(html, /Shell/);
  assert.match(html, /REST\/Webhook Push/);
  assert.match(html, /智能体框架强制执行/);
  assert.match(html, /运行时启动时生效/);
  assert.match(html, /重启运行时撤销/);
  assert.doesNotMatch(html, /运行证据/);
  assert.doesNotMatch(html, /策略修订/);
  assert.match(html, /id="provider-security-confirmation-input"/);
  assert.doesNotMatch(html, /window\.prompt/);

  const unsupportedDetail = await fetch(`${origin}/agents/agent-2`, { headers: auth });
  const unsupportedDetailHtml = await unsupportedDetail.text();
  assert.equal(unsupportedDetail.status, 200, unsupportedDetailHtml);
  assert.match(unsupportedDetailHtml, /href="\/agents\/agent-2\/security" class="op-card"/);

  const codexPage = await fetch(`${origin}/agents/agent-2/security`, { headers: auth });
  const codexHtml = await codexPage.text();
  assert.equal(codexPage.status, 200, codexHtml);
  assert.match(codexHtml, /命令与文件沙箱/);
  assert.match(codexHtml, /name="sandboxMode"/);
  assert.match(codexHtml, /只读沙箱/);
  assert.match(codexHtml, /允许写工作区/);
  assert.doesNotMatch(codexHtml, /网络访问/);

  const goosePage = await fetch(`${origin}/agents/agent-3/security`, { headers: auth });
  const gooseHtml = await goosePage.text();
  assert.equal(goosePage.status, 200, gooseHtml);
  assert.match(gooseHtml, /尚未接入可验证的动态权限控制/);
  assert.doesNotMatch(gooseHtml, /工具权限/);

  const preflightResponse = await fetch(`${origin}/api/agents/agent-1/provider-security/preflight`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ transportId: 'workbuddy-http', config: { dataFileAccess: 'none' } }),
  });
  const preflight = await preflightResponse.json();
  assert.equal(preflightResponse.status, 200);
  assert.equal(preflight.data.requiresTypedConfirmation, false);
  const commitResponse = await fetch(`${origin}/api/agents/agent-1/provider-security/commit`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ preflightToken: preflight.data.preflightToken }),
  });
  const committed = await commitResponse.json();
  assert.equal(commitResponse.status, 200);
  assert.equal(committed.data.config.dataFileAccess, 'none');
  assert.equal(committed.data.runtimeRestarted, true);

  const stalePreflightResponse = await fetch(`${origin}/api/agents/agent-1/provider-security/preflight`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ transportId: 'workbuddy-http', config: { dataFileAccess: 'read' } }),
  });
  const stalePreflight = await stalePreflightResponse.json();
  const session = webSessions.create('owner@example.com');
  db.prepare('UPDATE local_web_sessions SET created_at=? WHERE token_hash=?')
    .run(Date.now()-10*60*1000,webSessions.digest(session.token));
  const staleCommit = await fetch(`${origin}/api/agents/agent-1/provider-security/commit`, {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json',
      Cookie: `voko_session=${session.token}; voko_csrf=${session.csrfToken}`, 'X-VOKO-CSRF': session.csrfToken },
    body: JSON.stringify({ preflightToken: stalePreflight.data.preflightToken, confirmation: '陈老师' }),
  });
  assert.equal(staleCommit.status, 200);
  const staleCommitted = await staleCommit.json();
  assert.equal(staleCommitted.data.config.dataFileAccess, 'read');
});
