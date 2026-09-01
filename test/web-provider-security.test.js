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
    INSERT INTO agents VALUES('agent-4','Hermes助手','hermes',NULL);
    INSERT INTO agents VALUES('agent-5','千问办公助手','qwen-office',NULL);
    INSERT INTO agents VALUES('agent-6','百度搭子助手','dumate',NULL);
    CREATE TABLE provider_conversation_bindings(
      id TEXT PRIMARY KEY,agent_id TEXT,adapter_type TEXT,status TEXT,updated_at INTEGER
    );
  `);
  const providerSecurity = new ProviderSecurityPolicyService(db);
  const dispatcher = {
    providerSecurity,
    applyProviderSecurityPolicyChange: () => true,
    inspectProviderSecurity(agentId) {
      const backend = db.prepare('SELECT backend_type FROM agents WHERE agent_id=?').get(agentId).backend_type;
      const mapping = backend === 'workbuddy' ? ['workbuddy-http', 'http']
        : backend === 'codex' ? ['codex-cli', 'cli']
          : backend === 'hermes' ? ['hermes-cli', 'cli']
            : backend === 'qwen-office' ? ['qwen-office-cli', 'cli']
              : backend === 'dumate' ? ['dumate-http', 'http'] : ['goose-acp', 'acp'];
      return { ...providerSecurity.inspect(agentId, mapping[0]), deliveryMode: mapping[1], selectedProvider: mapping[0] };
    },
  };
  const webSessions = createLocalWebSessionStore(db);
  const handlers = {
    list_agents: async () => ({ agents: [
      { agentId: 'agent-1', agentName: '陈老师', backendType: 'workbuddy' },
      { agentId: 'agent-2', agentName: 'A诊', backendType: 'codex' },
      { agentId: 'agent-3', agentName: 'Goose助手', backendType: 'goose' },
      { agentId: 'agent-4', agentName: 'Hermes助手', backendType: 'hermes' },
      { agentId: 'agent-5', agentName: '千问办公助手', backendType: 'qwen-office' },
      { agentId: 'agent-6', agentName: '百度搭子助手', backendType: 'dumate' },
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
  assert.match(html, /消息推送模式/);
  assert.match(html, /HTTP/);
  assert.match(html, /name="dataFileAccess"/);
  assert.match(html, /data-risk="medium"/);
  assert.match(html, /data-risk="high"/);
  assert.match(html, /高风险/);
  assert.doesNotMatch(html, /name="shell"/);
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
  assert.match(codexHtml, /宿主机广泛只读/);
  assert.match(codexHtml, /允许写工作区/);
  assert.doesNotMatch(codexHtml, /网络访问/);

  const goosePage = await fetch(`${origin}/agents/agent-3/security`, { headers: auth });
  const gooseHtml = await goosePage.text();
  assert.equal(goosePage.status, 200, gooseHtml);
  assert.match(gooseHtml, /尚未接入可验证的动态权限控制/);
  assert.doesNotMatch(gooseHtml, /工具权限/);

  const hermesPage = await fetch(`${origin}/agents/agent-4/security`, { headers: auth });
  const hermesHtml = await hermesPage.text();
  assert.equal(hermesPage.status, 200, hermesHtml);
  for (const control of ['toolProfile', 'safeMode', 'approvalMode', 'acceptHooks', 'additionalPrompt']) {
    assert.match(hermesHtml, new RegExp(`name="${control}"`));
  }
  assert.match(hermesHtml, /自动批准（YOLO）/);
  assert.match(hermesHtml, /自动批准未知 Hooks/);
  assert.match(hermesHtml, /id="provider-command-preview"/);
  assert.match(hermesHtml, /id="provider-prompt-editor"/);
  assert.equal((hermesHtml.match(/name="additionalPrompt"/g) || []).length, 1);
  assert.doesNotMatch(hermesHtml, /id="provider-prompt-preview"/);
  assert.match(hermesHtml, /这里编辑的内容会自动追加到每条访客消息，使得Agent意识到这是一个访客信息/);
  assert.match(hermesHtml, /权限与安全/);
  assert.match(hermesHtml, /安全参数/);
  assert.doesNotMatch(hermesHtml, /当前转发效果/);
  assert.doesNotMatch(hermesHtml, /转发命令/);
  assert.match(hermesHtml, /rows="5"/);
  assert.match(hermesHtml, />保存设置<\/button>/);
  assert.doesNotMatch(hermesHtml, />预检并保存<\/button>/);
  assert.ok(hermesHtml.indexOf('name="acceptHooks"') < hermesHtml.indexOf('>保存设置</button>'));
  assert.match(hermesHtml, /<label[^>]*font-size:18px[^>]*>安全提示语<\/label>/);
  assert.match(hermesHtml, /<h3[^>]*font-size:18px[^>]*>安全参数<\/h3>/);
  assert.match(hermesHtml, /彩色部分表示下方权限选项带来的参数或执行策略变化/);
  assert.match(hermesHtml, /#b42318/);
  assert.match(hermesHtml, /#a85b00/);
  assert.match(hermesHtml, /#1769aa/);
  assert.match(hermesHtml, /智能体名称输入错误，请输入页面顶部显示的完整名称/);
  assert.match(hermesHtml, /PROVIDER_SECURITY_CONFIRMATION_MISMATCH/);
  const hermesSecurityScript = [...hermesHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(match => match[1]).find(source => source.includes('provider-security-form'));
  assert.ok(hermesSecurityScript);
  assert.doesNotThrow(() => new Function(hermesSecurityScript));

  const qwenPage = await fetch(`${origin}/agents/agent-5/security`, { headers: auth });
  const qwenHtml = await qwenPage.text();
  assert.equal(qwenPage.status, 200, qwenHtml);
  for (const control of ['sessionPersistence', 'permissionMode', 'toolAccess', 'mcpProfile', 'additionalPrompt']) {
    assert.match(qwenHtml, new RegExp(`name="${control}"`));
  }
  assert.match(qwenHtml, /qoderclicn --print --permission-mode/);
  assert.match(qwenHtml, /--strict-mcp-config --mcp-config/);
  assert.equal((qwenHtml.match(/name="additionalPrompt"/g) || []).length, 1);

  const dumatePage = await fetch(`${origin}/agents/agent-6/security`, { headers: auth });
  const dumateHtml = await dumatePage.text();
  assert.equal(dumatePage.status, 200, dumateHtml);
  for (const control of ['sessionPersistence', 'additionalPrompt']) {
    assert.match(dumateHtml, new RegExp(`name="${control}"`));
  }
  assert.match(dumateHtml, /POST \/session\/<sessionId>\/prompt_async/);
  assert.equal((dumateHtml.match(/name="additionalPrompt"/g) || []).length, 1);

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
