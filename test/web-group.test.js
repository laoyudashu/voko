const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const ts = require('typescript');
const { makeT } = require('../build/core/i18n');
const { createGroupRouter } = require('../build/web/group');
const { createWebRouter } = require('../build/web');

function createDb(imUid) {
  return {
    prepare(sql) {
      return {
        get() {
          if (sql.includes('SELECT imUid FROM agents')) return { imUid };
          return undefined;
        },
        all() {
          return [];
        },
        run() {},
      };
    },
  };
}

function startServer(role, messages = []) {
  const imUid = 'agent-im-uid';
  const handlers = {
    list_agents: async () => ({
      agents: [{ agentId: 'agent-1', agentName: 'Agent One' }],
    }),
    get_group_context: async () => ({
      success: true,
      groupName: 'Test Group',
      status: 'active',
      members: [
        { uid: imUid, nickname: 'Agent One', role },
        { uid: 'visitor-1', nickname: 'Visitor', role: 'member' },
      ],
      messages,
      hasMore: false,
    }),
    list_group_applies: async () => ({ success: true, applies: [] }),
  };
  const app = express();
  app.use((req, _res, next) => {
    req.locale = 'zh';
    req.t = makeT('zh');
    next();
  });
  app.use(createGroupRouter(handlers, createDb(imUid)));

  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        async close() {
          server.closeIdleConnections?.();
          await new Promise((done) => server.close(done));
        },
      });
    });
    server.once('error', reject);
  });
}

async function renderGroup(t, role, messages) {
  const server = await startServer(role, messages);
  t.after(() => server.close());
  const response = await fetch(`${server.url}/agents/agent-1/g/group-1`, {
    signal: AbortSignal.timeout(3000),
  });
  const html = await response.text();
  assert.equal(response.status, 200);
  return html;
}

describe('Web group detail rendering', () => {
  it('injects manager capability for an owner', async (t) => {
    const html = await renderGroup(t, 'owner');
    assert.match(html, /window\.__IS_MANAGER__=true;/);
  });

  it('injects no manager capability for an ordinary member', async (t) => {
    const html = await renderGroup(t, 'member');
    assert.match(html, /window\.__IS_MANAGER__=false;/);
  });

  it('renders the current-user label without duplicate parentheses', async (t) => {
    const html = await renderGroup(t, 'member');
    assert.match(html, /Agent One <span[^>]*>\uFF08\u4F60\uFF09<\/span>/);
    assert.doesNotMatch(html, /Agent One <span[^>]*>\(\uFF08\u4F60\uFF09\)<\/span>/);
  });

  it('does not show self-chat or self-mention actions', async (t) => {
    const html = await renderGroup(t, 'member');
    const selfRow = html.match(/<tr data-search="Agent One agent-im-uid">([\s\S]*?)<\/tr>/)?.[1];
    const visitorRow = html.match(/<tr data-search="Visitor visitor-1">([\s\S]*?)<\/tr>/)?.[1];
    assert.ok(selfRow);
    assert.ok(visitorRow);
    assert.doesNotMatch(selfRow, /私聊|@TA/);
    assert.match(visitorRow, /私聊/);
    assert.match(visitorRow, /@TA/);
  });

  it('collapses long group messages while keeping the full content available', async (t) => {
    const longText = '群聊完整内容 '.repeat(80);
    const html = await renderGroup(t, 'member', [{
      senderName: 'Visitor',
      fromUid: 'visitor-1',
      contentType: 1,
      content: longText,
      timestamp: 1,
    }]);
    assert.match(html, /data-voko-expandable/);
    assert.match(html, /data-voko-message-preview/);
    assert.match(html, /data-voko-message-full hidden/);
    assert.match(html, /展开全文/);
  });
});

it('redirects a newly created group to the group list and preserves its id for pinning', async (t) => {
  const handlers = {
    list_agents: async () => ({ agents: [{ agentId: 'agent-1', agentName: 'Agent One', ownerEmail: 'owner@example.com' }] }),
    list_access_lists: async () => ({ success: true, data: [], total: 0 }),
    create_group: async () => ({ success: true, channelId: 'group-new' }),
    invite_to_group: async () => ({ success: true }),
  };
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req, _res, next) => {
    req.locale = 'zh';
    req.t = makeT('zh');
    next();
  });
  app.use(createGroupRouter(handlers, createDb('agent-im-uid')));
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/agents/agent-1/create-group`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ name: 'Newest Group' }),
    redirect: 'manual',
  });

  assert.equal(response.status, 302);
  const location = response.headers.get('location');
  assert.match(location, /^\/agents\/agent-1\?tab=group&created=group-new&ok=/);
});

it('returns JSON for member actions requested by the partial-refresh UI', async (t) => {
  const handlers = {
    kick_from_group: async ({ agentId, channelId, targetUid }) => ({ success: agentId === 'agent-1' && channelId === 'group-1' && targetUid === 'visitor-1' }),
    mute_member: async () => ({ success: true }),
    approve_group_apply: async () => ({ success: true }),
  };
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req, _res, next) => { req.locale = 'zh'; req.t = makeT('zh'); next(); });
  app.use(createGroupRouter(handlers, createDb('agent-im-uid')));
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/agents/agent-1/g/group-1/kick`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ targetUid: 'visitor-1' }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true });
});

it('pins the newly created group first and paginates group lists at ten rows', async (t) => {
  const groups = [
    { channel_id: 'group-hot', name: 'Hot Group', joined_at: '2026-08-01T01:00:00Z', status: 'active' },
    { channel_id: 'group-new', name: 'Newest Group', joined_at: '2026-08-01T00:00:00Z', status: 'active' },
    ...Array.from({ length: 9 }, (_, index) => ({
      channel_id: `group-${index}`,
      name: `Group ${index}`,
      joined_at: `2026-07-${String(20 - index).padStart(2, '0')}T00:00:00Z`,
      status: 'active',
      ...(index === 0 ? { created_at: 400 } : {}),
      ...(index === 1 ? { notice_updated_at: 500 } : {}),
    })),
  ];
  const handlers = {
    list_agents: async () => ({ agents: [{ agentId: 'agent-1', agentName: 'Agent One', ownerEmail: 'owner@example.com', backendType: 'others' }] }),
    get_status: async () => ({ agent: { imConnected: true }, warnings: [] }),
    list_conversations: async () => ({ conversations: [], total: 0 }),
    list_groups: async () => ({ success: true, groups, total: groups.length }),
  };
  const db = {
    prepare(sql) {
      return {
        get() {
          if (sql.includes('SELECT owner_email FROM agents')) return { owner_email: 'owner@example.com' };
          if (sql.includes("type='user_access_token'")) return { data: JSON.stringify({ 'owner@example.com': { user_access_token: 'ut_test' } }) };
          if (sql.includes('SELECT imUid FROM agents')) return { imUid: 'agent-im-uid' };
          if (sql.includes('SELECT unread_count FROM conversations')) return { unread_count: 0 };
          return undefined;
        },
        all() {
          if (sql.includes('SELECT channel_id,last_timestamp FROM conversations')) {
            return [{ channel_id: 'group-hot', last_timestamp: 100 }];
          }
          if (sql.includes('last_message_timestamp') && sql.includes('last_system_timestamp')) {
            return [
              { channel_id: 'group-2', last_message_timestamp: 650, last_system_timestamp: 0 },
              { channel_id: 'group-3', last_message_timestamp: 200, last_system_timestamp: 700 },
            ];
          }
          return [];
        },
        run() {},
      };
    },
  };
  const app = express();
  app.use(createWebRouter(handlers, db, { refreshUserProfiles: async () => {} }));
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/agents/agent-1?tab=group&created=group-new`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.ok(html.indexOf('/g/group-new') < html.indexOf('/g/group-hot'));
  assert.match(html, /\?tab=group&amp;gpage=2|\?tab=group&gpage=2/);
  assert.doesNotMatch(html, /\/g\/group-8/);

  const normalResponse = await fetch(`http://127.0.0.1:${server.address().port}/agents/agent-1?tab=group`);
  const normalHtml = await normalResponse.text();
  const orderedIds = ['group-3', 'group-2', 'group-1', 'group-0', 'group-hot'];
  for (let index = 1; index < orderedIds.length; index += 1) {
    assert.ok(normalHtml.indexOf(`/g/${orderedIds[index - 1]}`) < normalHtml.indexOf(`/g/${orderedIds[index]}`));
  }
});

it('searches invite candidates and returns whitelist pages as a partial response', async (t) => {
  const accessCalls = [];
  const handlers = {
    list_agents: async () => ({ agents: [
      { agentId: 'agent-1', agentName: 'Host', ownerEmail: 'owner@example.com' },
      { agentId: 'agent-2', agentName: 'Searchable Agent', ownerEmail: 'owner@example.com' },
    ] }),
    get_group_context: async () => ({ success: true, groupName: 'Test Group', status: 'active', members: [] }),
    list_access_lists: async (params) => {
      accessCalls.push(params);
      return { success: true, data: [{ visitor_id: 'visitor-search' }], total: 11 };
    },
  };
  const db = {
    prepare(sql) {
      return {
        get() { return undefined; },
        all() {
          if (sql.includes('SELECT agent_id, imUid FROM agents')) return [{ agent_id: 'agent-2', imUid: 'agent-2-im' }];
          return [];
        },
      };
    },
  };
  const app = express();
  app.use((req, _res, next) => { req.locale = 'zh'; req.t = makeT('zh'); next(); });
  app.use(createGroupRouter(handlers, db));
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/agents/agent-1/g/group-1/invite`;

  const page = await fetch(base);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /id="invite-search"/);
  assert.match(html, /_loadInviteCandidates/);
  assert.match(html, /data-invite-page="2"/);

  const partial = await fetch(`${base}?partial=1&wlPage=2&keyword=search`);
  assert.equal(partial.status, 200);
  const payload = await partial.json();
  assert.equal(payload.success, true);
  assert.match(payload.html, /visitor-search/);
  assert.deepEqual(accessCalls.at(-1), {
    agentId: 'agent-1', listType: 'whitelist', limit: 10, offset: 10, keyword: 'search',
  });
});

it('Lite Web JS has no unresolved server-side identifiers', () => {
  const liteDir = path.resolve(__dirname, '..');
  const configPath = path.join(liteDir, 'tsconfig.json');
  const rawConfig = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(rawConfig.error, undefined);
  const config = ts.parseJsonConfigFileContent(
    rawConfig.config,
    ts.sys,
    liteDir,
    { checkJs: true, noEmit: true },
    configPath,
  );
  const program = ts.createProgram(config.fileNames, config.options);
  const relevantCodes = new Set([2304, 2448, 2454, 2552, 2554]);
  const webDir = path.join('src', 'web');
  const diagnostics = ts.getPreEmitDiagnostics(program).filter((diagnostic) => (
    diagnostic.file
    && diagnostic.file.fileName.includes(webDir)
    && relevantCodes.has(diagnostic.code)
  ));
  const messages = diagnostics.map((diagnostic) => {
    const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start || 0);
    return `${path.relative(liteDir, diagnostic.file.fileName)}:${position.line + 1}:${position.character + 1}`
      + ` TS${diagnostic.code} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`;
  });
  assert.deepEqual(messages, []);
});

it('keeps every server-paginated Web view on the current document', () => {
  const indexWeb = require('node:fs').readFileSync(path.join(__dirname, '..', 'src', 'web', 'index.js'), 'utf8');
  const groupWeb = require('node:fs').readFileSync(path.join(__dirname, '..', 'src', 'web', 'group.js'), 'utf8');
  for (const source of [indexWeb, groupWeb]) {
    assert.match(source, /data-voko-page-region/);
    assert.match(source, /closest\("a\[href\*=/);
    assert.match(source, /fetch\(link\.href/);
    assert.match(source, /history\.pushState/);
  }
  assert.match(indexWeb, /document\.addEventListener\("click",function\(e\)\{var b=e\.target\.closest\("button\[data-tab\]"\)/);
  assert.match(groupWeb, /document\.addEventListener\("click",function\(e\)\{var b=e\.target\.closest\("button\[data-gtab\]"\)/);
  assert.match(groupWeb, /form\[data-group-ajax\]/);
  assert.match(indexWeb, /form\[data-voko-access-list\]/);
});

it('uses styled dialogs instead of native browser confirm prompts', () => {
  const indexWeb = require('node:fs').readFileSync(path.join(__dirname, '..', 'src', 'web', 'index.js'), 'utf8');
  const groupWeb = require('node:fs').readFileSync(path.join(__dirname, '..', 'src', 'web', 'group.js'), 'utf8');
  assert.doesNotMatch(indexWeb, /\b(?:window\.)?confirm\s*\(/);
  assert.doesNotMatch(groupWeb, /\b(?:window\.)?confirm\s*\(/);
  assert.match(indexWeb, /function showVokoConfirm\(/);
  assert.match(groupWeb, /id="quit-dlg"/);
});

it('places capability declaration on the Agent detail page before discovery', () => {
  const source = require('node:fs').readFileSync(path.join(__dirname, '..', 'src', 'web', 'index.js'), 'utf8');
  const detailStart = source.indexOf("const aclOps=");
  const caps = source.indexOf("/caps", detailStart);
  const discover = source.indexOf("/capabilities?agentId=", detailStart);
  assert.ok(caps > detailStart && caps < discover);
  const homeActionStart = source.indexOf("var actionHtml=");
  const homeActionEnd = source.indexOf("rows.push", homeActionStart);
  assert.doesNotMatch(source.slice(homeActionStart, homeActionEnd), /\/caps/);
});
