const { test, expect } = require('./fixtures');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { createLocalWebSessionStore } = require('../build/core/local-web-session');

function manifest() { return JSON.parse(fs.readFileSync(process.env.VOKO_E2E_SERVICES_FILE, 'utf8')); }

async function openStreams(page) {
  await page.evaluate(() => {
    window.streamState = {};
    for (const path of ['/ws', '/voko/events/ws']) {
      const state = window.streamState[path] = { messages: [], closed: null };
      const ws = state.socket = new WebSocket(`ws://${location.host}${path}`);
      ws.onmessage = event => state.messages.push(JSON.parse(event.data));
      ws.onclose = event => { state.closed = event.code; };
    }
  });
}

test('anonymous browser retains health access but cannot subscribe to either sensitive stream', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ extraHTTPHeaders: {} });
  try {
    const page = await context.newPage();
    const response = await page.goto(`${baseURL}/health`);
    expect(response.status()).toBe(200);
    await openStreams(page);
    for (const path of ['/ws', '/voko/events/ws']) {
      await expect.poll(() => page.evaluate(path => window.streamState[path].closed, path)).toBe(4001);
      expect(await page.evaluate(path => window.streamState[path].messages.length, path)).toBe(0);
    }
  } finally { await context.close(); }
});

test('real browser cookie streams receive events and close after session revocation', async ({ browser, baseURL, request }) => {
  const info = manifest();
  const db = new DatabaseSync(info.dbPath);
  const sessions = createLocalWebSessionStore(db);
  const session = sessions.create('e2e-owner@example.test');
  const context = await browser.newContext({ extraHTTPHeaders: {} });
  try {
    await context.addCookies([{ name: 'voko_session', value: session.token, url: baseURL, httpOnly: true, sameSite: 'Strict' }]);
    const page = await context.newPage(); await page.goto(`${baseURL}/health`);
    await openStreams(page);
    await expect.poll(() => page.evaluate(() => window.streamState['/voko/events/ws'].messages.some(x => x.type === 'snapshot'))).toBe(true);
    const inject = content => request.post(`${info.services.api}/__test__/im/message`, { data: {
      toUid: 'e2e-im-uid', fromUid: 'e2e-cookie-visitor', channelId: 'e2e-cookie-visitor', channelType: 1,
      messageId: content === 'before' ? '73101' : '73102', messageSeq: content === 'before' ? 73101 : 73102, content: `cookie stream ${content}`,
    } });
    expect((await inject('before')).ok()).toBeTruthy();
    await expect.poll(() => page.evaluate(() => window.streamState['/ws'].messages.some(x => x.event === 'agent-wukongim:message'))).toBe(true);
    sessions.destroyRequest({ headers: { cookie: `voko_session=${session.token}` } });
    expect((await inject('after')).ok()).toBeTruthy();
    // Ordinary broadcasts revalidate immediately; exercise console's inbound heartbeat too.
    await page.evaluate(() => window.streamState['/voko/events/ws'].socket.send(JSON.stringify({ type: 'ping' })));
    for (const path of ['/ws', '/voko/events/ws']) {
      await expect.poll(() => page.evaluate(path => window.streamState[path].closed, path)).toBe(4001);
    }
    const renewed = sessions.create('e2e-owner@example.test');
    await context.addCookies([{ name: 'voko_session', value: renewed.token, url: baseURL, httpOnly: true, sameSite: 'Strict' }]);
    await openStreams(page);
    await expect.poll(() => page.evaluate(() => window.streamState['/voko/events/ws'].messages.some(x => x.type === 'snapshot'))).toBe(true);
    sessions.destroyRequest({ headers: { cookie: `voko_session=${renewed.token}` } });
  } finally { sessions.destroyRequest({ headers: { cookie: `voko_session=${session.token}` } }); db.close(); await context.close(); }
});
