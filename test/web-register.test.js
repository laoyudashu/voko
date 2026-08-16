const { describe, it } = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const os = require('os');
const fs = require('fs');
const express = require('express');
const { makeT } = require('../build/core/i18n');

/**
 * Web 端 Agent 注册测试（POST /agent/add）。
 *
 * 手法：内存 SQLite 写入登录态（user_access_token），mock handlers.create_agent_by_token
 *      为 spy，临时启动 Express server（随机端口），fetch POST 表单，断言 handler 收到的参数。
 *
 * 验证三端一致：Web 入口同样接收并传递 backendType/category/description，移除了二次 update_agent_profile 调用。
 */

const { createRegisterRouter } = require('../build/web/register');

// ── 内存 SQLite：建 config 表（getLoggedEmail 依赖）──
function createDb(loggedEmail) {
  const dbPath = path.join(os.tmpdir(), `voko-web-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  const db = new DatabaseSync(dbPath);
  db._tmpPath = dbPath;
  db.exec(`CREATE TABLE config (type TEXT PRIMARY KEY, data TEXT)`);
  db.exec(`CREATE TABLE agents (agent_name TEXT)`);
  if (loggedEmail) {
    db.prepare(`INSERT INTO config (type, data) VALUES ('user_access_token', ?)`).run(JSON.stringify({ [loggedEmail]: 'ut_test_token' }));
  }
  return db;
}
function cleanupDb(db) { try { db.close(); } catch (_) {} try { fs.unlinkSync(db._tmpPath); } catch (_) {} }

/** 启动临时 Express server（随机端口），返回 { baseUrl, close } */
function startServer(handlers, db) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use((req, _res, next) => {
    req.locale = 'zh';
    req.t = makeT(req.locale);
    next();
  });
  app.use(createRegisterRouter(handlers, db, {
    registrationOrchestrator: {
      commandAvailable: () => false,
      installedApplications: () => [],
      gatewaySetup: { checkGateway: () => ({ ready: false }) },
    },
  }));
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      server.off('error', reject);
      let closed = false;
      resolve({
        baseUrl: 'http://127.0.0.1:' + server.address().port,
        close: () => {
          if (closed) return Promise.resolve();
          closed = true;
          server.closeIdleConnections?.();
          return new Promise((r) => {
            const timer = setTimeout(() => {
              server.closeAllConnections?.();
              r();
            }, 1000);
            timer.unref?.();
            server.close(() => {
              clearTimeout(timer);
              r();
            });
          });
        },
      });
    });
    server.once('error', reject);
  });
}

async function setupServer(t, handlers, db) {
  try {
    const server = await startServer(handlers, db);
    t.after(async () => {
      await server.close();
      cleanupDb(db);
    });
    return server;
  } catch (error) {
    cleanupDb(db);
    throw error;
  }
}

describe('Web POST /agent/add 注册流程', () => {
  it('OAuth login routes proxy the session contract without exposing the token in HTML', async (t) => {
    const db = createDb(null);
    const startedProviders = [];
    const handlers = {
      oauth_providers: async () => ({ success: true, data: { providers: [
        { id: 'google', enabled: true },
        { id: 'github', enabled: true },
      ] } }),
      oauth_start: async ({ provider }) => {
        startedProviders.push(provider);
        return { success: true, data: {
        sessionId: 'los_web', authorizeUrl: `https://example.test/${provider}`, expiresAt: new Date(Date.now() + 60000).toISOString(),
        pollIntervalSeconds: 2,
      } };
      },
      oauth_status: async () => ({ success: true, data: { status: 'authorized', exchangeCode: 'loe_web' } }),
      oauth_exchange: async () => ({ success: true, email: 'owner@example.com' }),
    };
    const server = await setupServer(t, handlers, db);
    const login = await fetch(server.baseUrl + '/login');
    const html = await login.text();
    assert.match(html, /data-oauth-provider="google"/);
    assert.match(html, /data-oauth-provider="github"/);
    assert.match(html, /class="oauth-icon"/);
    assert.match(html, /fill="#4285F4"/);
    assert.match(html, /fill="currentColor"/);
    assert.match(html, /class="oauth-buttons" hidden/);
    assert.doesNotMatch(html, /class="oauth-divider"/);
    assert.ok(html.indexOf('</form>') < html.indexOf('class="oauth-buttons"'));
    assert.match(html, /grid-template-columns:1fr 1fr/);
    assert.match(html, /\.oauth-btn\{[^}]*font-size:13px;white-space:nowrap/);
    assert.match(html, /api\/login\/oauth\/providers/);
    assert.doesNotMatch(html, /ut_/);
    // 登录页不渲染系统 footer（“错误上报”/IM 状态等运行时信息不应在未登录页暴露）
    assert.doesNotMatch(html, /data-voko-system-footer/);

    const switchLogin = await fetch(server.baseUrl + '/login?mode=switch');
    const switchHtml = await switchLogin.text();
    assert.match(switchHtml, /data-oauth-provider="google"/);
    assert.match(switchHtml, /data-oauth-provider="github"/);
    assert.match(switchHtml, /class="oauth-icon"/);
    assert.match(switchHtml, /class="oauth-buttons" hidden/);
    assert.doesNotMatch(switchHtml, /class="oauth-divider"/);
    assert.ok(switchHtml.indexOf('</form>') < switchHtml.indexOf('class="oauth-buttons"'));
    assert.match(switchHtml, /grid-template-columns:1fr 1fr/);
    assert.match(switchHtml, /api\/login\/oauth\/providers/);
    // 切换用户页同样不渲染系统 footer
    assert.doesNotMatch(switchHtml, /data-voko-system-footer/);

    const oauthCompleteHtml = await (await fetch(server.baseUrl + '/login/oauth/complete')).text();
    assert.match(oauthCompleteHtml, /if\(!r\.ok\|\|!d\.success\)/);
    assert.match(oauthCompleteHtml, /switch-error/);

    const providers = await (await fetch(server.baseUrl + '/api/login/oauth/providers')).json();
    assert.deepStrictEqual(providers.providers, [
      { id: 'google', enabled: true },
      { id: 'github', enabled: true },
    ]);
    const started = await (await fetch(server.baseUrl + '/api/login/oauth/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"provider":"google"}',
    })).json();
    assert.strictEqual(started.sessionId, 'los_web');
    const githubStarted = await (await fetch(server.baseUrl + '/api/login/oauth/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"provider":"github"}',
    })).json();
    assert.strictEqual(githubStarted.authorizeUrl, 'https://example.test/github');
    assert.deepStrictEqual(startedProviders, ['google', 'github']);
    const status = await (await fetch(server.baseUrl + '/api/login/oauth/status/los_web')).json();
    assert.strictEqual(status.exchangeCode, 'loe_web');
    const exchanged = await (await fetch(server.baseUrl + '/api/login/oauth/exchange', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: '{"sessionId":"los_web","exchangeCode":"loe_web"}',
    })).json();
    assert.strictEqual(exchanged.success, true);
    assert.doesNotMatch(JSON.stringify(exchanged), /ut_/);
  });

  it('GET /agent/add renders the four-step shared-orchestrator wizard', async (t) => {
    const db = createDb('web@test.com');
    const handlers = {
      create_agent_by_token: async () => ({ success: true, agentId: 'unused' }),
    };
    const server = await setupServer(t, handlers, db);
    const res = await fetch(server.baseUrl + '/agent/add', { signal: AbortSignal.timeout(10000) });
    const html = await res.text();
    assert.strictEqual(res.status, 200);
    assert.match(html, /registration-wizard/);
    assert.match(html, /data-registration-tab="human"/);
    assert.match(html, /data-registration-tab="agent"/);
    assert.match(html, /voko_manage_agent_registration/);
    assert.match(html, /--registration-mode agent/);
    assert.match(html, /id="copy-agent-registration"/);
    assert.doesNotMatch(html, /ut_test_token/);
    assert.match(html, /消息接收方式/);
    assert.match(html, /访问与发现/);
    assert.match(html, /白名单审核/);
    assert.match(html, /所有者邮箱/);
    assert.match(html, /<details id="wf-more-providers"/);
    assert.doesNotMatch(html, /<details id="wf-more-providers" open/);
    assert.match(html, /data-wizard-step="2" role="button" tabindex="0"/);
    assert.match(html, /function setDetectionPending\(\)/);
    assert.match(html, /function openProviderStep\(/);
    assert.match(html, /s\.addEventListener\('click',activate\)/);
    assert.match(html, /beginDetection\(\)\.then\(function\(\)\{if\(step===2\)next\.disabled=false\}/);
    assert.match(html, /web的Agent-[0-9a-f]{4}/);
    assert.match(html, /\/api\/agent-registration/);
    assert.match(html, /class="loopback-feedback"/);
    assert.match(html, /data-provider-id/);
    assert.match(html, /supportsLoopback/);
    assert.match(html, /providerId:b\.dataset\.providerId/);
    assert.doesNotMatch(html, /id="wf-loopback-dialog"/);
    assert.doesNotMatch(html, /data-action="test"/);
    assert.match(html, /b\.classList\.add\('success'\)/);
    assert.doesNotMatch(html, /window\.confirm\(I\.loopbackConfirm\)/);
    assert.match(html, /addEventListener\('blur'/);
    assert.match(html, /voko\.agentRegistrationDraft/);
    assert.match(html, /voko\.agentRegistrationMode/);
    assert.match(html, /api\('status'\)/);
    assert.match(html, /if\(discardDraft\)return/);
    assert.match(html, /discardDraft=true;\s*try\{sessionStorage\.removeItem\(draftKey\)\}/);
    assert.match(html, /new URLSearchParams\(location\.search\)\.get\('new'\)==='1'/);
    assert.match(html, /history\.replaceState\(null,'',location\.pathname\)/);
    assert.doesNotMatch(html, /data-value="__custom__"/);
    const homeSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'index.js'), 'utf8');
    assert.match(homeSource, /href="\/agent\/add\?new=1"/);
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
    assert.ok(scripts.length >= 2);
    scripts.forEach((source) => assert.doesNotThrow(() => new Function(source)));
  });

  it('Web step API and legacy POST share the registration orchestrator', async (t) => {
    const db = createDb('web@test.com');
    let captured = null;
    const handlers = {
      create_agent_by_token: async (params) => {
        captured = params;
        return { success: true, agentId: 'shared-web', agentName: params.agentName };
      },
    };
    const server = await setupServer(t, handlers, db);
    async function action(input) {
      const response = await fetch(server.baseUrl + '/api/agent-registration', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(15000),
      });
      const data = await response.json();
      assert.strictEqual(response.status, 200, data.error);
      return data;
    }
    const started = await action({ action: 'start', email: 'web@test.com' });
    assert.strictEqual(started.status, 'basic_info_required');
    const basic = await action({
      action: 'set_basic_info', registrationId: started.registrationId,
      agentName: '共享 Web Agent', description: '四步流程', category: 'general',
    });
    assert.strictEqual(basic.status, 'provider_selection_required');
    const provider = await action({
      action: 'select_provider', registrationId: started.registrationId, providerType: 'others',
    });
    assert.deepStrictEqual(provider.deliveryModes.map((mode) => mode.mode), ['pull']);
    await action({
      action: 'select_delivery', registrationId: started.registrationId, deliveryModes: [],
    });
    const completed = await action({
      action: 'complete', registrationId: started.registrationId, accessMode: 'public',
    });
    assert.strictEqual(completed.status, 'created');
    assert.strictEqual(captured.backendType, 'others');
    assert.strictEqual(captured.agentName, '共享 Web Agent');
    assert.strictEqual(captured.accessMode, 'public');
    assert.strictEqual(completed.result.ownerEmail, 'web@test.com');
    assert.strictEqual(completed.result.accessMode, 'public');
  });

  it('完整字段：create_agent_by_token 收到 backendType/category/description', async (t) => {
    const db = createDb('web@test.com');
    let captured = null;
    const handlers = {
      create_agent_by_token: async (p) => { captured = p; return { success: true, agentId: 'web-1' }; },
    };
    const server = await setupServer(t, handlers, db);

    const body = new URLSearchParams({
      action: 'createAgent',
      email: 'web@test.com',
      agentName: 'Web助手',
      backendType: 'codex',
      category: 'technology',
      description: '通过 Web 创建',
    });
    const res = await fetch(server.baseUrl + '/agent/add', {
      method: 'POST',
      body,
      redirect: 'manual', // 不跟随 302，便于断言
      signal: AbortSignal.timeout(10000),
    });
    t.after(() => res.body?.cancel());

    assert.strictEqual(res.status, 302, '成功应重定向');
    assert.match(res.headers.get('location') || '', /done=/);
    assert.ok(captured, '应调用 create_agent_by_token');
    assert.strictEqual(captured.backendType, 'codex');
    assert.strictEqual(captured.category, 'technology');
    assert.strictEqual(captured.description, '通过 Web 创建');
    assert.strictEqual(captured.agentName, 'Web助手');

  });

  it('未登录（无 user_access_token）→ 重定向 /login', async (t) => {
    const db = createDb(null); // 未登录
    let called = false;
    const handlers = { create_agent_by_token: async () => { called = true; return { success: true }; } };
    const server = await setupServer(t, handlers, db);

    const body = new URLSearchParams({ action: 'createAgent', agentName: 'X', backendType: 'codex', category: 'technology' });
    const res = await fetch(server.baseUrl + '/agent/add', {
      method: 'POST',
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    });
    t.after(() => res.body?.cancel());

    assert.strictEqual(res.status, 302);
    assert.match(res.headers.get('location') || '', /\/login/);
    assert.strictEqual(called, false, '未登录不应创建 agent');

  });

  it('后端创建失败（如名称占用）→ 返回错误页（非重定向）', async (t) => {
    const db = createDb('web@test.com');
    const handlers = {
      create_agent_by_token: async () => ({ success: false, error: '该名称已被占用' }),
    };
    const server = await setupServer(t, handlers, db);

    const body = new URLSearchParams({ action: 'createAgent', email: 'web@test.com', agentName: '重复名', backendType: 'codex', category: 'technology' });
    const res = await fetch(server.baseUrl + '/agent/add', {
      method: 'POST',
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    });

    assert.notStrictEqual(res.status, 302, '失败不应重定向到 done');
    const html = await res.text();
    assert.match(html, /创建失败|已被占用/);
  });
});
