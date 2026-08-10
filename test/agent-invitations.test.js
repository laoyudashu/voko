const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  initDatabase,
  saveUserAccessToken,
} = require('../build/core/database');
const {
  CURSOR_CONFIG_TYPE,
  createAgentInvitation,
  serverAgentIdFromDid,
  syncAgentAccess,
  syncAgentAccessBatch,
  startAgentAccessSync,
} = require('../build/core/agent-invitations');
const { t } = require('../build/core/i18n');
const { getCheckpoint, setCheckpoint } = require('../build/core/checkpoint-store');
const accessControl = require('../src/core/access-control-api');

const API = 'https://api.example.test';
const originalFetch = global.fetch;

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(body); },
  };
}

function fixture() {
  const db = initDatabase(':memory:', { silent: true });
  const now = Date.now();
  db.prepare(`INSERT INTO agents
    (id,agent_id,agent_name,owner_email,imUid,imToken,im_server_url,publish_status,access_mode,backend_type,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,'published','private','others',?,?)`)
    .run('row-1', 'agent-a', 'Agent A', 'owner@example.com', 'agent_uid_a', 'token', 'wss://im.example.test', now, now);
  saveUserAccessToken(db, 'owner@example.com', 'ut_test_agent_manage');
  return db;
}

function cursor(db) {
  const row = db.prepare('SELECT data FROM config WHERE type=?').get(CURSOR_CONFIG_TYPE);
  return row ? JSON.parse(row.data)['agent-a'] : undefined;
}

function cursorFor(db, agentId) {
  const row = db.prepare('SELECT data FROM config WHERE type=?').get(CURSOR_CONFIG_TYPE);
  return row ? JSON.parse(row.data)[agentId] : undefined;
}

describe('Agent invitation and access sync', () => {
  beforeEach(() => { global.fetch = originalFetch; });
  afterEach(() => { global.fetch = originalFetch; });

  it('removes the obsolete local friend_invitations table during migration', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-invite-migration-'));
    const dbPath = path.join(dir, 'voko.db');
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`CREATE TABLE friend_invitations (
      code TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      friend_email TEXT NOT NULL,
      whitelisted INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`);
    legacy.close();
    const db = initDatabase(dbPath, { silent: true });
    try {
      assert.equal(db.prepare(`SELECT 1 FROM sqlite_master
        WHERE type='table' AND name='friend_invitations'`).get(), undefined);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates invitations with a Bearer User Access Token and preserves server results', async () => {
    const db = fixture();
    const calls = [];
    global.fetch = async (url, init) => {
      calls.push({ url, init });
      return response(200, {
        success: true,
        data: { result: 'already_registered' },
      });
    };
    try {
      const result = await createAgentInvitation({
        db,
        apiBaseUrl: API,
        agentId: 'agent-a',
        email: ' Friend@Example.com ',
      });
      assert.equal(result.result, 'already_registered');
      assert.equal(result.email, 'friend@example.com');
      assert.equal(calls[0].url, API + '/api/external/v1/agent-invitations');
      assert.equal(calls[0].init.headers.Authorization, 'Bearer ut_test_agent_manage');
      assert.deepEqual(JSON.parse(calls[0].init.body), {
        inviterAgentId: 'agent-a',
        email: 'friend@example.com',
      });
    } finally {
      db.close();
    }
  });

  it('keeps email_failed distinct from successful email delivery', async () => {
    const db = fixture();
    global.fetch = async () => response(200, {
      success: true,
      data: { result: 'email_failed', invitationId: 'inv-1' },
    });
    try {
      const result = await createAgentInvitation({
        db,
        apiBaseUrl: API,
        agentId: 'agent-a',
        email: 'friend@example.com',
      });
      assert.equal(result.success, true);
      assert.equal(result.result, 'email_failed');
      assert.equal(result.emailSent, false);
      assert.match(t('web.invite.result.already_registered', {}, 'zh'), /已在使用 VOKO/);
      assert.match(t('web.invite.result.email_failed', {}, 'zh'), /记录已创建.*邮件未成功发送/);
    } finally {
      db.close();
    }
  });

  it('replays duplicate events idempotently and advances the cursor only after ack', async () => {
    const db = fixture();
    let round = 0;
    global.fetch = async (url, init = {}) => {
      if (url.includes('/agent-access-relations')) {
        return response(200, { success: true, data: [] });
      }
      if (url.includes('/agent-access-sync/ack')) {
        assert.deepEqual(JSON.parse(init.body), { agentId: 'agent-a', eventIds: ['event-1'] });
        return response(200, { success: true });
      }
      round += 1;
      return response(200, {
        success: true,
        data: {
          items: [{
            eventId: 'event-1',
            operation: 'upsert',
            listType: 'whitelist',
            visitorId: 'agent_uid_b',
            reason: 'server_invitation',
          }],
          nextCursor: 'cursor-' + round,
          hasMore: false,
        },
      });
    };
    try {
      assert.equal((await syncAgentAccess({ db, apiBaseUrl: API, agentId: 'agent-a' })).success, true);
      assert.equal((await syncAgentAccess({ db, apiBaseUrl: API, agentId: 'agent-a' })).success, true);
      assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM agent_access_lists
        WHERE agent_id='agent-a' AND visitor_id='agent_uid_b'`).get().count, 1);
      assert.equal(cursor(db), 'cursor-2');
    } finally {
      db.close();
    }
  });

  it('does not ack or advance the cursor when the local transaction fails', async () => {
    const realDb = fixture();
    let acked = false;
    const db = {
      exec(sql) { return realDb.exec(sql); },
      prepare(sql) {
        if (/INSERT INTO agent_access_lists/.test(sql)) {
          return { run() { throw new Error('disk full'); }, get() {}, all() { return []; } };
        }
        return realDb.prepare(sql);
      },
    };
    global.fetch = async (url) => {
      if (url.includes('/agent-access-relations')) {
        return response(200, { success: true, data: [] });
      }
      if (url.includes('/agent-access-sync/ack')) {
        acked = true;
        return response(200, { success: true });
      }
      return response(200, {
        success: true,
        data: {
          items: [{
            eventId: 'event-1',
            operation: 'upsert',
            listType: 'whitelist',
            visitorId: 'agent_uid_b',
            reason: 'server_invitation',
          }],
          nextCursor: 'cursor-1',
          hasMore: false,
        },
      });
    };
    try {
      const result = await syncAgentAccess({ db, apiBaseUrl: API, agentId: 'agent-a' });
      assert.equal(result.success, false);
      assert.equal(acked, false);
      assert.equal(cursor(realDb), undefined);
    } finally {
      realDb.close();
    }
  });

  it('retries ack safely without advancing the cursor after the first failure', async () => {
    const db = fixture();
    let ackAttempts = 0;
    global.fetch = async (url) => {
      if (url.includes('/agent-access-relations')) {
        return response(200, { success: true, data: [] });
      }
      if (url.includes('/agent-access-sync/ack')) {
        ackAttempts += 1;
        if (ackAttempts === 1) return response(503, { success: false, message: 'retry' });
        return response(200, { success: true });
      }
      return response(200, {
        success: true,
        data: {
          items: [{
            eventId: 'event-1',
            operation: 'upsert',
            listType: 'whitelist',
            visitorId: 'agent_uid_b',
            reason: 'server_invitation',
          }],
          nextCursor: 'cursor-1',
          hasMore: false,
        },
      });
    };
    try {
      assert.equal((await syncAgentAccess({ db, apiBaseUrl: API, agentId: 'agent-a' })).success, false);
      assert.equal(cursor(db), undefined);
      assert.equal(getCheckpoint(db, 'access_sync', 'agent-a').pendingValue, 'cursor-1');
      assert.equal((await syncAgentAccess({ db, apiBaseUrl: API, agentId: 'agent-a' })).success, true);
      assert.equal(cursor(db), 'cursor-1');
      assert.equal(getCheckpoint(db, 'access_sync', 'agent-a').pendingValue, null);
      assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM agent_access_lists
        WHERE agent_id='agent-a' AND visitor_id='agent_uid_b'`).get().count, 1);
    } finally {
      db.close();
    }
  });

  it('treats a missing remote legacy Agent as unsupported without changing local data', async () => {
    for (const status of [200, 404]) {
      const db = fixture();
      global.fetch = async () => response(status, {
        success: false,
        message: 'Agent not found',
      });
      try {
        const result = await syncAgentAccess({ db, apiBaseUrl: API, agentId: 'agent-a' });
        assert.deepEqual(result, { success: true, applied: 0, skipped: true });
        assert.equal(db.prepare("SELECT COUNT(*) AS count FROM agents WHERE agent_id='agent-a'").get().count, 1);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM agent_access_lists').get().count, 0);
        assert.equal(cursor(db), undefined);
      } finally {
        db.close();
      }
    }
  });

  it('uses the server UUID from DID for AccessSync while keeping the local Agent ID in SQLite', async () => {
    const db = fixture();
    const serverAgentId = '2b4a3c62-efba-4c97-add9-6f09ee092462';
    db.prepare('UPDATE agents SET did=? WHERE agent_id=?')
      .run('did:wba:8.153.167.187:2b4a3c62efba4c97add96f09ee092462', 'agent-a');
    const calls = [];
    global.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('/agent-access-relations')) {
        return response(200, { success: true, data: [{ listType: 'whitelist', visitorId: 'visitor-1' }] });
      }
      return response(200, { success: true, data: { items: [], nextCursor: 'cursor-1', hasMore: false } });
    };
    try {
      assert.equal(serverAgentIdFromDid('did:wba:host:2b4a3c62efba4c97add96f09ee092462'), serverAgentId);
      assert.equal((await syncAgentAccess({ db, apiBaseUrl: API, agentId: 'agent-a' })).success, true);
      assert.match(calls[0].url, new RegExp(`agentId=${serverAgentId}`));
      assert.match(calls[1].url, new RegExp(`agentId=${serverAgentId}`));
      assert.equal(db.prepare(`SELECT agent_id FROM agent_access_lists WHERE visitor_id='visitor-1'`).get().agent_id, 'agent-a');
      assert.equal(cursor(db), 'cursor-1');
    } finally {
      db.close();
    }
  });

  it('uses an authoritative snapshot when the local cursor is missing without deleting manual entries', async () => {
    const db = fixture();
    const now = Date.now();
    db.prepare(`INSERT INTO agent_access_lists
      (id,agent_id,list_type,visitor_id,reason,manual_managed,server_managed,created_at,updated_at)
      VALUES (?,?,?,?,?,1,1,?,?)`)
      .run('manual', 'agent-a', 'whitelist', 'manual_uid', 'manual', now, now);
    db.prepare(`INSERT INTO agent_access_lists
      (id,agent_id,list_type,visitor_id,reason,manual_managed,server_managed,created_at,updated_at)
      VALUES (?,?,?,?,?,0,1,?,?)`)
      .run('old-server', 'agent-a', 'whitelist', 'old_uid', 'server_invitation', now, now);
    global.fetch = async (url) => {
      if (url.includes('/agent-access-relations')) {
        return response(200, {
          success: true,
          data: [{
              listType: 'whitelist',
              visitorId: 'new_uid',
              reason: 'server_invitation',
          }],
        });
      }
      return response(200, {
        success: true,
        data: { items: [], nextCursor: '0', hasMore: false },
      });
    };
    try {
      const result = await syncAgentAccess({ db, apiBaseUrl: API, agentId: 'agent-a' });
      assert.equal(result.success, true);
      const rows = db.prepare(`SELECT visitor_id,reason,manual_managed,server_managed FROM agent_access_lists
        WHERE agent_id='agent-a' ORDER BY visitor_id`).all();
      assert.deepEqual(rows.map((row) => ({ ...row })), [
        { visitor_id: 'manual_uid', reason: 'manual', manual_managed: 1, server_managed: 0 },
        { visitor_id: 'new_uid', reason: 'server_invitation', manual_managed: 0, server_managed: 1 },
      ]);
      assert.equal(cursor(db), '0');
    } finally {
      db.close();
    }
  });

  it('syncs multiple Agents through one batch pull and one batch acknowledgement', async () => {
    const db = fixture();
    const now = Date.now();
    db.prepare(`INSERT INTO agents
      (id,agent_id,agent_name,owner_email,imUid,imToken,im_server_url,publish_status,access_mode,backend_type,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,'published','private','others',?,?)`)
      .run('row-2', 'agent-b', 'Agent B', 'owner@example.com', 'agent_uid_b', 'token', 'wss://im.example.test', now, now);
    const calls = [];
    global.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('/agent-access-relations/batch')) {
        return response(200, {
          success: true,
          data: { agents: [
            { agentId: 'agent-a', success: true, relations: [] },
            { agentId: 'agent-b', success: true, relations: [] },
          ] },
        });
      }
      if (String(url).includes('/agent-access-sync/batch/ack')) {
        const body = JSON.parse(init.body);
        assert.equal(body.agents.length, 2);
        return response(200, {
          success: true,
          data: { agents: body.agents.map((agent) => ({ agentId: agent.agentId, success: true, acknowledged: agent.eventIds.length })) },
        });
      }
      assert.match(String(url), /\/agent-access-sync\/batch$/);
      return response(200, {
        success: true,
        data: { agents: [
          { agentId: 'agent-a', success: true, items: [{ eventId: 'event-a', operation: 'upsert', listType: 'whitelist', visitorId: 'visitor-a' }], nextCursor: '1', hasMore: false },
          { agentId: 'agent-b', success: true, items: [{ eventId: 'event-b', operation: 'upsert', listType: 'whitelist', visitorId: 'visitor-b' }], nextCursor: '2', hasMore: false },
        ] },
      });
    };
    try {
      const result = await syncAgentAccessBatch({ db, apiBaseUrl: API, agentIds: ['agent-a', 'agent-b'] });
      assert.equal(result.success, true);
      assert.equal(result.applied, 2);
      assert.equal(calls.filter((call) => call.url.includes('/agent-access-relations/batch')).length, 1);
      assert.equal(calls.filter((call) => call.url.includes('/agent-access-sync/batch') && !call.url.includes('/ack')).length, 1);
      assert.equal(calls.filter((call) => call.url.includes('/agent-access-sync/batch/ack')).length, 1);
      assert.equal(cursorFor(db, 'agent-a'), '1');
      assert.equal(cursorFor(db, 'agent-b'), '2');
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM agent_access_lists WHERE visitor_id IN ('visitor-a','visitor-b')").get().count, 2);
    } finally {
      db.close();
    }
  });

  it('chunks batch requests at the server limit and preserves BIGINT cursors', async () => {
    const db = fixture();
    const now = Date.now();
    const agentIds = ['agent-a'];
    for (let index = 1; index <= 50; index += 1) {
      const agentId = `agent-${index}`;
      agentIds.push(agentId);
      db.prepare(`INSERT INTO agents
        (id,agent_id,agent_name,owner_email,imUid,imToken,im_server_url,publish_status,access_mode,backend_type,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,'published','private','others',?,?)`)
        .run(`row-${index + 1}`, agentId, agentId, 'owner@example.com', `uid-${index}`, 'token', 'wss://im.example.test', now, now);
    }
    setCheckpoint(db, 'access_sync', 'agent-a', 'opaque', '9007199254740993');
    const calls = [];
    global.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ url: String(url), body });
      if (String(url).includes('/agent-access-relations/batch')) {
        return response(200, { success: true, data: { agents: body.agentIds.map((agentId) => ({ agentId, success: true, relations: [] })) } });
      }
      assert.match(String(url), /\/agent-access-sync\/batch$/);
      return response(200, {
        success: true,
        data: { agents: body.agents.map((agent) => ({
          agentId: agent.agentId,
          success: true,
          items: [],
          nextCursor: agent.agentId === 'agent-a' ? '9007199254740994' : agent.cursor,
          hasMore: false,
        })) },
      });
    };
    try {
      const result = await syncAgentAccessBatch({
        db,
        apiBaseUrl: 'https://chunk.example.test',
        agentIds,
      });
      assert.equal(result.success, true);
      const relationCalls = calls.filter((call) => call.url.includes('/agent-access-relations/batch'));
      const pullCalls = calls.filter((call) => call.url.includes('/agent-access-sync/batch'));
      assert.deepEqual(relationCalls.map((call) => call.body.agentIds.length), [50]);
      assert.deepEqual(pullCalls.map((call) => call.body.agents.length), [50, 1]);
      assert.equal(cursorFor(db, 'agent-a'), '9007199254740994');
    } finally {
      db.close();
    }
  });

  it('reconciles a legacy non-numeric cursor before using the strict batch API', async () => {
    const db = fixture();
    db.prepare('INSERT OR REPLACE INTO config (type,data,updated_at) VALUES (?,?,?)')
      .run(CURSOR_CONFIG_TYPE, JSON.stringify({ 'agent-a': 'cursor-legacy' }), Date.now());
    const urls = [];
    global.fetch = async (url) => {
      urls.push(String(url));
      if (String(url).includes('/agent-access-relations?')) return response(200, { success: true, data: [] });
      if (String(url).includes('/agent-access-relations/batch')) return response(200, { success: true, data: { agents: [] } });
      return response(200, { success: true, data: { agents: [{ agentId: 'agent-a', success: true, items: [], nextCursor: '0', hasMore: false }] } });
    };
    try {
      const result = await syncAgentAccessBatch({ db, apiBaseUrl: 'https://legacy-cursor.example.test', agentIds: ['agent-a'] });
      assert.equal(result.success, true);
      assert.ok(urls.some((url) => url.includes('/agent-access-relations?')));
      assert.ok(urls.some((url) => url.includes('/agent-access-sync/batch')));
      assert.equal(cursorFor(db, 'agent-a'), '0');
    } finally {
      db.close();
    }
  });

  it('merges duplicate remote Agent IDs before batch acknowledgement', async () => {
    const db = fixture();
    const now = Date.now();
    const did = 'did:wba:host:11111111111111111111111111111111';
    db.prepare('UPDATE agents SET did=? WHERE agent_id=?').run(did, 'agent-a');
    db.prepare(`INSERT INTO agents
      (id,agent_id,agent_name,owner_email,imUid,imToken,im_server_url,publish_status,access_mode,backend_type,did,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,'published','private','others',?,?,?)`)
      .run('row-2', 'agent-b', 'Agent B', 'owner@example.com', 'agent_uid_b', 'token', 'wss://im.example.test', did, now, now);
    const calls = [];
    global.fetch = async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ url: String(url), body });
      if (String(url).includes('/agent-access-relations/batch')) {
        return response(200, { success: true, data: { agents: [{ agentId: '11111111-1111-1111-1111-111111111111', success: true, relations: [] }] } });
      }
      if (String(url).includes('/agent-access-sync/batch/ack')) {
        assert.equal(body.agents.length, 1);
        return response(200, { success: true, data: { agents: [{ agentId: body.agents[0].agentId, success: true, acknowledged: 1 }] } });
      }
      return response(200, {
        success: true,
        data: { agents: [{
          agentId: '11111111-1111-1111-1111-111111111111',
          success: true,
          items: [{ eventId: 'event-duplicate', operation: 'upsert', listType: 'whitelist', visitorId: 'visitor-1' }],
          nextCursor: '1',
          hasMore: false,
        }] },
      });
    };
    try {
      const result = await syncAgentAccessBatch({
        db,
        apiBaseUrl: 'https://duplicate.example.test',
        agentIds: ['agent-a', 'agent-b'],
      });
      assert.equal(result.success, true);
      assert.equal(cursorFor(db, 'agent-a'), '1');
      assert.equal(cursorFor(db, 'agent-b'), '1');
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM agent_access_lists WHERE visitor_id='visitor-1'").get().count, 2);
    } finally {
      db.close();
    }
  });

  it('falls back to the legacy per-Agent protocol when the server has no batch endpoint', async () => {
    const db = fixture();
    const legacyApi = 'https://legacy.example.test';
    const calls = [];
    global.fetch = async (url) => {
      calls.push(String(url));
      if (String(url).includes('/agent-access-relations/batch')) {
        return response(404, { success: false, message: 'Not found' });
      }
      if (String(url).includes('/agent-access-relations?')) {
        return response(200, { success: true, data: [] });
      }
      return response(200, { success: true, data: { items: [], nextCursor: '0', hasMore: false } });
    };
    try {
      const result = await syncAgentAccessBatch({ db, apiBaseUrl: legacyApi, agentIds: ['agent-a'] });
      assert.equal(result.success, true);
      assert.equal(result.fallback, true);
      assert.ok(calls.some((url) => url.includes('/agent-access-relations/batch')));
      assert.ok(calls.some((url) => url.includes('/agent-access-relations?')));
      assert.ok(calls.some((url) => url.includes('/agent-access-sync?')));
    } finally {
      db.close();
    }
  });

  it('delays the initial AccessSync run after startup', async () => {
    const db = fixture();
    let calls = 0;
    global.fetch = async (url) => {
      calls += 1;
      if (String(url).includes('/agent-access-relations/batch')) {
        return response(200, { success: true, data: { agents: [{ agentId: 'agent-a', success: true, relations: [] }] } });
      }
      if (String(url).includes('/agent-access-sync/batch/ack')) {
        return response(200, { success: true, data: { agents: [{ agentId: 'agent-a', success: true, acknowledged: 0 }] } });
      }
      return response(200, { success: true, data: { agents: [{ agentId: 'agent-a', success: true, items: [], nextCursor: '0', hasMore: false }] } });
    };
    const stop = startAgentAccessSync({
      db,
      apiBaseUrl: API,
      initialDelayMs: 60,
      intervalMs: 1000,
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 15));
      assert.equal(calls, 0);
      await new Promise((resolve) => setTimeout(resolve, 90));
      assert.ok(calls > 0);
    } finally {
      stop();
      db.close();
    }
  });

  it('waits after a detected sleep/resume gap before running AccessSync', async () => {
    const db = fixture();
    let calls = 0;
    let clock = 1000;
    global.fetch = async (url) => {
      calls += 1;
      if (String(url).includes('/agent-access-relations/batch')) {
        return response(200, { success: true, data: { agents: [{ agentId: 'agent-a', success: true, relations: [] }] } });
      }
      return response(200, { success: true, data: { agents: [{ agentId: 'agent-a', success: true, items: [], nextCursor: '0', hasMore: false }] } });
    };
    const stop = startAgentAccessSync({
      db,
      apiBaseUrl: API,
      initialDelayMs: 0,
      intervalMs: 20,
      wakeDelayMs: 50,
      sleepGapMs: 30,
      now: () => clock,
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const beforeWake = calls;
      clock += 1000;
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(calls, beforeWake);
      await new Promise((resolve) => setTimeout(resolve, 45));
      assert.ok(calls > beforeWake);
    } finally {
      stop();
      db.close();
    }
  });

  it('keeps a server invitation relation when its manual whitelist source is removed', () => {
    const db = fixture();
    const now = Date.now();
    db.prepare(`INSERT INTO agent_access_lists
      (id,agent_id,list_type,visitor_id,reason,manual_managed,server_managed,created_at,updated_at)
      VALUES (?,?,?,?,?,0,1,?,?)`)
      .run('server', 'agent-a', 'whitelist', 'shared_uid', 'server_invitation', now, now);
    try {
      assert.equal(accessControl.addEntry(db, {
        agentId: 'agent-a',
        listType: 'whitelist',
        visitorId: 'shared_uid',
        reason: 'manual',
      }).success, true);
      assert.deepEqual({ ...db.prepare(`SELECT manual_managed,server_managed FROM agent_access_lists
        WHERE agent_id='agent-a' AND visitor_id='shared_uid'`).get() }, {
        manual_managed: 1,
        server_managed: 1,
      });
      assert.equal(accessControl.removeEntryByVisitor(
        db, 'agent-a', 'shared_uid', 'whitelist',
      ).success, true);
      assert.deepEqual({ ...db.prepare(`SELECT manual_managed,server_managed FROM agent_access_lists
        WHERE agent_id='agent-a' AND visitor_id='shared_uid'`).get() }, {
        manual_managed: 0,
        server_managed: 1,
      });
    } finally {
      db.close();
    }
  });

  it('searches access lists by locally cached nickname as well as visitor ID and reason', () => {
    const db = fixture();
    const now = Date.now();
    db.prepare(`INSERT INTO agent_access_lists
      (id,agent_id,list_type,visitor_id,reason,manual_managed,server_managed,created_at,updated_at)
      VALUES (?,?,?,?,?,1,0,?,?)`)
      .run('dashuu-entry', 'agent-a', 'whitelist', 'actor_123', 'trusted friend', now, now);
    db.prepare('INSERT INTO user_cache (uid,nickname,updated_at) VALUES (?,?,?)')
      .run('actor_123', 'dashuu', now);
    try {
      const byNickname = accessControl.getList(db, {
        agentId: 'agent-a', listType: 'whitelist', keyword: 'dashuu', limit: 10, offset: 0,
      });
      assert.equal(byNickname.total, 1);
      assert.equal(byNickname.data[0].visitor_id, 'actor_123');
      const byReason = accessControl.getList(db, {
        agentId: 'agent-a', listType: 'whitelist', keyword: 'trusted', limit: 10, offset: 0,
      });
      assert.equal(byReason.total, 1);
    } finally {
      db.close();
    }
  });
});
