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
function startServer(handlers, db, options = {}) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use((req, _res, next) => {
    req.locale = options.locale || 'zh';
    req.t = makeT(req.locale);
    next();
  });
  app.use(createRegisterRouter(handlers, db, {
    readWorkBuddyAgentAvatar: options.readWorkBuddyAgentAvatar,
    readAgentIconCandidate: options.readAgentIconCandidate,
    uploadAgentIcon: options.uploadAgentIcon,
    fetchImpl: options.fetchImpl,
    registrationOrchestrator: {
      commandAvailable: () => false,
      installedApplications: () => [],
      gatewaySetup: { checkGateway: () => ({ ready: false }) },
      ...options.registrationOrchestrator,
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
  it('renders distinct optional-session and required-instance registration guidance', async (t) => {
    const db = createDb('web@test.com');
    const server = await setupServer(t, {}, db);
    const response = await fetch(server.baseUrl + '/agent/add');
    const html = await response.text();
    assert.strictEqual(response.status, 200);
    assert.match(html, /不绑定现有实例（收到消息时自动创建新会话）/);
    assert.match(html, /该类型必须先创建实例才能发送消息/);
    assert.match(html, /requiresInstance/);
    assert.match(html, /if\(p\.type==='dumate'\)return ''/);
    assert.doesNotMatch(html, /p\.blockingReason==='DUMATE_BACKEND_UNAVAILABLE'.*instance-panel error/);
    assert.doesNotMatch(html, /instances\.length\+' '\+term/);
    assert.match(html, /p\.requiresInstance&&!selectedInstance&&instances\.length\)selectedInstance=instances\[0\]\.id/);
  });

  it('login renders six code cells, accepts paste through one input, and auto-submits at six digits', async (t) => {
    const db = createDb(null);
    const server = await setupServer(t, {}, db);
    const response = await fetch(server.baseUrl + '/login?email=owner%40example.com');
    const html = await response.text();

    assert.strictEqual(response.status, 200);
    assert.strictEqual((html.match(/class="otp-cell(?: active)?"/g) || []).length, 6);
    assert.match(html, /id="code" class="otp-input"[^>]*maxlength="6"[^>]*inputmode="numeric"[^>]*autocomplete="one-time-code"/);
    assert.match(html, /name="action" value="verify"/);
    assert.match(html, /codeInput\.value\.replace\(\/\\D\/g,""\)\.slice\(0,6\)/);
    assert.match(html, /value\.length===6&&value!==lastSubmittedCode/);
    assert.match(html, /loginForm\.requestSubmit\(\)/);
    assert.match(html, /class="desc bug-report-subtle"/);
    assert.match(html, /class="send-code-btn" id="send-btn"/);
    assert.match(html, /id="send-feedback" class="alert send-code-feedback" aria-live="polite"/);
    assert.match(html, /b\.textContent=I18N_SENDING/);
    assert.match(html, /alert-success send-code-feedback active/);
    assert.match(html, /alert-error send-code-feedback active/);
    assert.match(html, /data-voko-language-switcher="1"/);
    assert.match(html, /data-voko-language-select="1"/);
    assert.doesNotMatch(html, /<button[^>]*type="submit"/);
  });

  it('OAuth login routes proxy the session contract without exposing the token in HTML', async (t) => {
    const db = createDb(null);
    const startedProviders = [];
    let exchangeMode = '';
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
      oauth_exchange_for_owner_switch: async () => {
        exchangeMode = 'pending';
        return { success: true, email: 'owner@example.com' };
      },
    };
    const server = await setupServer(t, handlers, db);
    const login = await fetch(server.baseUrl + '/login');
    const html = await login.text();
    assert.match(html, /data-oauth-provider="google"/);
    assert.match(html, /data-oauth-provider="github"/);
    assert.match(html, /class="oauth-icon"/);
    assert.match(html, /fill="#4285F4"/);
    assert.match(html, /fill="currentColor"/);
    assert.match(html, /class="oauth-buttons"/);
    assert.doesNotMatch(html, /class="oauth-buttons" hidden/);
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
    assert.match(switchHtml, /class="oauth-buttons"/);
    assert.doesNotMatch(switchHtml, /class="oauth-buttons" hidden/);
    assert.doesNotMatch(switchHtml, /class="oauth-divider"/);
    assert.ok(switchHtml.indexOf('</form>') < switchHtml.indexOf('class="oauth-buttons"'));
    assert.match(switchHtml, /grid-template-columns:1fr 1fr/);
    assert.match(switchHtml, /api\/login\/oauth\/providers/);
    // 切换用户页同样不渲染系统 footer
    assert.doesNotMatch(switchHtml, /data-voko-system-footer/);

    const oauthCompleteHtml = await (await fetch(server.baseUrl + '/login/oauth/complete')).text();
    assert.match(oauthCompleteHtml, /api\/web\/agents\/restart/);
    assert.match(oauthCompleteHtml, /x\.instanceId!==j\.previousInstanceId/);
    assert.match(oauthCompleteHtml, /Date\.now\(\)\+60000/);
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
    assert.strictEqual(exchangeMode, 'pending');
    assert.doesNotMatch(JSON.stringify(exchanged), /ut_/);
  });

  it('email verification stages an owner switch and renders the controlled restart page', async (t) => {
    const db = createDb('old@example.com');
    let verified;
    const handlers = {
      login_for_owner_switch: async (input) => {
        verified = input;
        return { success: true, email: 'new@example.com' };
      },
    };
    const server = await setupServer(t, handlers, db);
    const response = await fetch(server.baseUrl + '/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ action: 'verify', email: 'new@example.com', code: '123456' }),
    });
    const html = await response.text();

    assert.deepStrictEqual(verified, { email: 'new@example.com', code: '123456' });
    assert.strictEqual(response.status, 200);
    assert.match(html, /api\/web\/agents\/restart/);
    assert.match(html, /--no-open --no-interactive/);
    assert.match(html, /x\.instanceId!==j\.previousInstanceId/);
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
    assert.match(html, /for="wf-desc">描述（选填）<\/label>/);
    assert.match(html, /for="wf-tags">标签（选填）<\/label>/);
    assert.match(html, />图标（选填）<\/label>/);
    assert.match(html, /for="wf-phone">电话（选填）<\/label><input id="wf-phone" placeholder="例如：\+86 138 0000 0000">/);
    assert.match(html, /for="wf-address">地址（选填）<\/label><input id="wf-address" placeholder="例如：中国·上海">/);
    assert.match(html, /所有者邮箱/);
    assert.doesNotMatch(html, /<details id="wf-more-providers"/);
    assert.doesNotMatch(html, /\(env\.more\|\|\[\]\)\.forEach/);
    assert.doesNotMatch(html, /providerCard\(\{type:'others'/);
    assert.match(html, /provider\.none_detected|未检测到可用的本机 Agent/);
    assert.match(html, /data-wizard-step="2" role="button" tabindex="0"/);
    assert.match(html, /for="wf-category">[^<]+ \*<\/label><select id="wf-category" required>/);
    assert.match(html, /function inferredCategory\(name,description,suggested\)/);
    assert.doesNotMatch(html, /function providerGuidance\(p\)/);
    assert.doesNotMatch(html, /data-provider-setup/);
    assert.doesNotMatch(html, /data-provider-setup="login_workbuddy"/);
    assert.doesNotMatch(html, /data-provider-setup="login_qwen_office"/);
    assert.doesNotMatch(html, /data-provider-setup="open_dumate"/);
    assert.doesNotMatch(html, /blocked\?I\.configure/);
    assert.doesNotMatch(html, /selectedProvider==='workbuddy'&&m\.mode==='http'&&!usable/);
    assert.match(html, /I\.messageModes\[m\.mode\]\|\|m\.mode/);
    assert.match(html, /npm install -g @tencent-ai\/codebuddy-code/);
    assert.match(html, /workbuddyManualCommand/);
    assert.match(html, /usable\?escHtml\(m\.description\)/);
    assert.match(html, /data-voko-copy-value/);
    assert.match(html, /selectedProvider==='workbuddy'\?I\.recheck:I\.test/);
    const registerSource = fs.readFileSync(path.join(__dirname, '../src/web/register.js'), 'utf8');
    assert.match(registerSource, /http: t\('web\.home\.message_mode\.http'\)/);
    assert.match(registerSource, /cli: t\('web\.home\.message_mode\.cli'\)/);
    assert.match(html, /return available\.has\('general'\)\?'general'/);
    assert.match(html, /category:document\.getElementById\('wf-category'\)\.value\|\|'general'/);
    const categoryRulesSource = html.match(/var rules=(\[.*?\]);\s*var best='general'/s);
    assert.ok(categoryRulesSource, '应输出自动分类规则');
    const categoryRules = Function('return ' + categoryRulesSource[1])();
    const categoryCodes = categoryRules.map(([code]) => code);
    const categoryKeywords = categoryRules.flatMap(([, keywords]) => keywords);
    assert.strictEqual(new Set(categoryCodes).size, categoryCodes.length, '分类规则不能重复');
    assert.strictEqual(new Set(categoryKeywords).size, categoryKeywords.length, '关键词不能跨分类重复');
    assert.match(html, /if\(score>bestScore\)\{best=rules\[i\]\[0\];bestScore=score\}/);
    assert.match(html, /function setDetectionPending\(\)/);
    assert.match(html, /function openProviderStep\(/);
    assert.match(html, /s\.addEventListener\('click',activate\)/);
    assert.match(html, /next\.disabled=!\(state&&state\.environment&&\(state\.environment\.detected\|\|\[\]\)\.length\)/);
    assert.match(html, /id="wf-name" value=""/);
    assert.match(html, /class="basic-profile-grid"/);
    assert.match(html, /class="basic-icon-preview"/);
    assert.match(html, /id="wf-icon-button"/);
    assert.match(html, /DEFAULT_AGENT_ICON="data:image\/svg\+xml/);
    assert.match(html, /selectedIconObjectUrl\|\|suggestedIconPreview\|\|DEFAULT_AGENT_ICON/);
    assert.match(html, /type="file" id="wf-icon-file"/);
    assert.match(html, /useSuggestedIcon:!selectedIconFile/);
    assert.match(html, /function uploadSelectedIcon\(agentId\)/);
    assert.match(html, /\/api\/agents\/['"]\+encodeURIComponent\(agentId\)\+['"]\/icon/);
    assert.doesNotMatch(html, /id="wf-icon"(?:\s|>)/);
    assert.doesNotMatch(html, /basic-icon-help|basic-icon-url/);
    assert.doesNotMatch(html, /本机插件图标仅用于预览/);
    assert.match(html, /id="wf-reselect-dialog" class="voko-confirm-dialog"/);
    assert.match(html, /reselectDialog\.showModal\(\)/);
    assert.doesNotMatch(html, /window\.confirm\(/);
    assert.match(html, /id="wf-phone" placeholder="例如：\+86 138 0000 0000"/);
    assert.match(html, /id="wf-address" placeholder="例如：中国·上海"/);
    assert.match(html, /已检测到 \{providers\} 种可用的智能体类型/);
    assert.match(html, /nameCheckUnavailable/);
    assert.match(html, /nameBlocked=true;nameStatus\.className='name-status taken';nameStatus\.textContent=I\.nameCheckUnavailable/);
    assert.match(html, /normalizedSuggestionTags/);
    assert.match(html, /map\(localizedSuggestion\)\.filter\(Boolean\)/);
    assert.doesNotMatch(html, /\(s\.tags\|\|\[\]\)\.join/);
    assert.match(html, /@media\(max-width:600px\)[\s\S]*\.basic-profile-grid\{grid-template-columns:1fr\}/);
    assert.match(html, /\/api\/agent-registration/);
    assert.match(html, /discover_provider_instances/);
    assert.match(html, /instanceLoading/);
    assert.match(html, /loadWorkBuddy/);
    assert.match(html, /selectedProvider==='workbuddy'&&workbuddyLoad==='idle'/);
    assert.doesNotMatch(html, /class="loopback-feedback"/);
    assert.doesNotMatch(html, /class="result-loopback"/);
    assert.doesNotMatch(html, /data-provider-id/);
    assert.doesNotMatch(html, /deliveryReadiness/);
    assert.match(html, /\['ready','preflight_passed','loopback_verified'\]\.indexOf\(m\.status\)>=0/);
    assert.match(html, /usable\?I\.testOk:I\.testFailed/);
    assert.match(html, /class="voko-command-inline/);
    assert.match(html, /workBuddyCommand\(command,punctuation,longCommand\)/);
    assert.match(html, /data-voko-copy-value="'\+escHtml\(command\)\+'"/);
    assert.match(html, /selectedProvider==='qwen-office'/);
    assert.match(html, /m\.loginCommand/);
    assert.match(html, /qwenCliLoginRequired/);
    assert.match(html, /COPY_ICON/);
    assert.doesNotMatch(html, /workbuddy-command-list/);
    assert.match(html, /id="wf-loopback-dialog"/);
    assert.match(html, /data-action="detect"/);
    assert.match(html, /api\('status'\)\.then\(function\(d\)\{state=d;renderDeliveries\(d\)/);
    assert.match(html, /confirmLoopback\(function\(\)/);
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

  it('localizes every second-step profile label in zh, en and ja', () => {
    for (const locale of ['zh', 'en', 'ja']) {
      const t = makeT(locale);
      for (const key of ['section_profile', 'tags', 'tags_placeholder', 'icon', 'reselect_warning',
        'phone', 'phone_placeholder', 'address', 'address_placeholder']) {
        const value = t(`register.flow.basic.${key}`);
        assert.ok(value && value !== `register.flow.basic.${key}`, `${locale} missing ${key}`);
      }
    }
  });

  it('checks names locally and remotely, and fails closed when remote verification is unavailable', async () => {
    async function runCase({ localName, fetchImpl, expectedStatus, expectedBody }) {
      const db = createDb('web@test.com');
      if (localName) db.prepare('INSERT INTO agents (agent_name) VALUES (?)').run(localName);
      const server = await startServer({}, db, { fetchImpl });
      try {
        const response = await fetch(server.baseUrl + '/api/agent/check-name?name=' + encodeURIComponent('英语单词学习专家'));
        assert.strictEqual(response.status, expectedStatus);
        assert.deepStrictEqual(await response.json(), expectedBody);
      } finally {
        await server.close();
        cleanupDb(db);
      }
    }

    let localRemoteCalls = 0;
    await runCase({
      localName: '英语单词学习专家',
      fetchImpl: async () => { localRemoteCalls++; throw new Error('must not call remote'); },
      expectedStatus: 200,
      expectedBody: { available: false, source: 'local' },
    });
    assert.strictEqual(localRemoteCalls, 0);

    await runCase({
      fetchImpl: async () => new Response(JSON.stringify({ success: true, data: [{ name: '英语单词学习专家' }] }), { status: 200 }),
      expectedStatus: 200,
      expectedBody: { available: false, source: 'remote' },
    });
    await runCase({
      fetchImpl: async () => new Response(JSON.stringify({ success: true, data: [] }), { status: 200 }),
      expectedStatus: 200,
      expectedBody: { available: true, source: 'remote' },
    });
    await runCase({
      fetchImpl: async () => new Response(JSON.stringify({ success: false, error: 'unavailable' }), { status: 503 }),
      expectedStatus: 503,
      expectedBody: { available: false, error: 'NAME_CHECK_UNAVAILABLE' },
    });
  });

  it('serves WorkBuddy avatar previews through the server-side instance reader only', async (t) => {
    const db = createDb('web@test.com');
    const seen = [];
    const server = await startServer({}, db, {
      readWorkBuddyAgentAvatar(instanceId) {
        seen.push(instanceId);
        return instanceId === 'safe-agent'
          ? { data: Buffer.from('89504e470d0a1a0a00000000', 'hex'), mimeType: 'image/png' }
          : null;
      },
    });
    t.after(async () => { await server.close(); cleanupDb(db); });
    const valid = await fetch(server.baseUrl + '/api/agent-registration/workbuddy-avatar/safe-agent');
    assert.strictEqual(valid.status, 200);
    assert.strictEqual(valid.headers.get('content-type'), 'image/png');
    assert.match(valid.headers.get('cache-control'), /private/);
    const missing = await fetch(server.baseUrl + '/api/agent-registration/workbuddy-avatar/missing-agent');
    assert.strictEqual(missing.status, 404);
    assert.deepStrictEqual(seen, ['safe-agent', 'missing-agent']);
  });

  it('uploads any server-provided second-step icon candidate after creation and writes back iconUrl', async (t) => {
    const db = createDb('web@test.com');
    const iconBytes = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    const seen = { candidates: [], uploads: [], updates: [] };
    const handlers = {
      create_agent_by_token: async (params) => ({ success: true, agentId: 'created-with-icon', agentName: params.agentName }),
      update_agent_profile: async (params) => { seen.updates.push(params); return { success: true }; },
    };
    const server = await startServer(handlers, db, {
      registrationOrchestrator: {
        installedApplications: () => ['WorkBuddy'],
        workBuddyAgents: () => [{ id: 'icon-source', name: 'Icon source', avatar: 'avatar.png', available: true }],
      },
      readAgentIconCandidate(candidate) {
        seen.candidates.push(candidate);
        return { data: iconBytes, mimeType: 'image/png' };
      },
      uploadAgentIcon: async (data, objectName, mimeType, agentId) => {
        seen.uploads.push({ data, objectName, mimeType, agentId });
        return 'https://files.example/created-icon.png';
      },
    });
    t.after(async () => { await server.close(); cleanupDb(db); });
    async function action(input) {
      const response = await fetch(server.baseUrl + '/api/agent-registration', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
      });
      const data = await response.json();
      assert.strictEqual(response.status, 200, data.error);
      return data;
    }
    const started = await action({ action: 'start', email: 'web@test.com' });
    await action({ action: 'select_provider', registrationId: started.registrationId, providerType: 'workbuddy', instanceId: 'icon-source' });
    await action({ action: 'set_basic_info', registrationId: started.registrationId, agentName: 'Created with icon' });
    await action({ action: 'select_delivery', registrationId: started.registrationId, deliveryModes: [] });
    const completed = await action({ action: 'complete', registrationId: started.registrationId, accessMode: 'private' });

    assert.strictEqual(completed.result.iconUrl, 'https://files.example/created-icon.png');
    assert.strictEqual(completed.result.iconUploadError, null);
    assert.strictEqual(seen.candidates.length, 1);
    assert.strictEqual(seen.candidates[0].instanceId, 'icon-source');
    assert.strictEqual(seen.uploads.length, 1);
    assert.deepStrictEqual(seen.uploads[0].data, iconBytes);
    assert.match(seen.uploads[0].objectName, /^agent-icons\/[0-9a-f-]+\.png$/);
    assert.strictEqual(seen.uploads[0].mimeType, 'image/png');
    assert.strictEqual(seen.uploads[0].agentId, 'created-with-icon');
    assert.deepStrictEqual(seen.updates, [{ agentId: 'created-with-icon', iconUrl: 'https://files.example/created-icon.png' }]);
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'register.js'), 'utf8');
    assert.doesNotMatch(source, /backendType\s*===?\s*['"]workbuddy['"][\s\S]{0,200}uploadAgentIcon/);
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
    assert.strictEqual(started.status, 'provider_selection_required');
    const provider = await action({
      action: 'select_provider', registrationId: started.registrationId, providerType: 'others',
    });
    assert.strictEqual(provider.status, 'basic_info_required');
    assert.match(provider.suggestedBasicInfo.agentName, /^web的others-[A-Za-z0-9]{6}$/);
    const basic = await action({
      action: 'set_basic_info', registrationId: started.registrationId,
      agentName: '共享 Web Agent', description: '四步流程', category: 'general',
    });
    assert.strictEqual(basic.status, 'delivery_selection_required');
    assert.deepStrictEqual(provider.deliveryModes, []);
    assert.deepStrictEqual(basic.deliveryModes.map((mode) => mode.mode), ['pull']);
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
