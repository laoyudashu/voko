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
} = require('../build/core/agent-invitations');
const { t } = require('../build/core/i18n');
const { getCheckpoint } = require('../build/core/checkpoint-store');
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
