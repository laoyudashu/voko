const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { initDatabase, createDatabaseAPI } = require('../build/core/database');
const { OwnerInterventionNotifier } = require('../build/server/owner-intervention-notifier');

const tempDirs = [];
const notifiers = [];
const databases = [];

function createFixture(send) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-intervention-reliability-'));
  tempDirs.push(dir);
  const db = initDatabase(path.join(dir, 'lite.db'), { silent: true });
  databases.push(db);
  const databaseAPI = createDatabaseAPI(db);
  const registry = {
    getHandler: () => ({ sendMessageToOwnerWithTracking: send }),
  };
  const createNotifier = () => {
    const notifier = new OwnerInterventionNotifier({
      databaseAPI,
      registry,
      db,
      getEnabledChannel: () => ({ name: 'voko-email' }),
    });
    notifiers.push(notifier);
    return notifier;
  };
  return { db, databaseAPI, createNotifier };
}

function record(id) {
  const now = Date.now();
  return {
    id,
    visitorId: 'visitor-1',
    agentId: 'agent-1',
    sessionKey: 'agent:agent-1:visitor-1',
    problem: 'need owner help',
    agentSuggestion: 'please reply',
    askTime: now,
    expireTime: now + 60000,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    skipReply: 0,
  };
}

afterEach(() => {
  for (const notifier of notifiers.splice(0)) notifier.stop();
  for (const db of databases.splice(0)) {
    try { if (db.open) db.close(); } catch {}
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Owner intervention delivery reliability', () => {
  it('defaults reply-required interventions to 24 hours and leaves notifications without expiry', () => {
    const fixture = createFixture(async () => ({ sentMessageId: 'unused' }));
    const replyRequired = record('expires-in-24h');
    delete replyRequired.expireTime;
    const notification = { ...record('notification'), expireTime: Date.now() + 1000, skipReply: 1 };
    fixture.databaseAPI.saveOwnerIntervention(replyRequired);
    fixture.databaseAPI.saveOwnerIntervention(notification);

    const replyRow = fixture.db.prepare('SELECT ask_time,expire_time FROM owner_interventions WHERE id=?')
      .get(replyRequired.id);
    const notificationRow = fixture.db.prepare('SELECT expire_time FROM owner_interventions WHERE id=?')
      .get(notification.id);
    assert.equal(replyRow.expire_time - replyRow.ask_time, 24 * 60 * 60 * 1000);
    assert.equal(notificationRow.expire_time, null);
    const rejected = fixture.databaseAPI.saveOwnerIntervention({
      ...record('reserved-visitor'), visitorId: 'system:forged',
    });
    assert.equal(rejected.code, 'VISITOR_ID_RESERVED');
    assert.equal(fixture.db.prepare("SELECT COUNT(*) count FROM owner_interventions WHERE id='reserved-visitor'").get().count, 0);
  });

  it('expired resolved and cancelled interventions cannot be reopened by reply or status updates', () => {
    const fixture = createFixture(async () => ({ sentMessageId: 'unused' }));
    for (const status of ['expired', 'resolved', 'cancelled']) {
      const value = { ...record(`terminal-${status}`), status };
      fixture.databaseAPI.saveOwnerIntervention(value);
      const reply = fixture.databaseAPI.updateOwnerInterventionReply(value.id, 'late', Date.now(), 'voko-email');
      const reopen = fixture.databaseAPI.updateOwnerInterventionStatus(value.id, 'replied', null);
      assert.equal(reply.code, 'INTERVENTION_TERMINAL');
      assert.equal(reopen.code, 'INTERVENTION_TERMINAL');
      assert.equal(fixture.db.prepare('SELECT status FROM owner_interventions WHERE id=?').get(value.id).status, status);
    }
  });

  it('email content states the exact deadline and that late replies are discarded', async () => {
    let emailBody = '';
    const fixture = createFixture(async (content) => {
      emailBody = content;
      return { sentMessageId: 'deadline-message' };
    });
    const value = record('deadline-copy');
    fixture.databaseAPI.saveOwnerIntervention(value);
    await fixture.createNotifier().enqueue(value);
    assert.match(emailBody, /回复截止时间|Reply deadline|返信期限/);
    assert.match(emailBody, /不会做任何响应|discarded|破棄/);
    assert.match(emailBody, /24/);
  });

  it('atomically claims a record so concurrent notifiers send only once', async () => {
    let sends = 0;
    const fixture = createFixture(async () => {
      sends++;
      await new Promise(resolve => setTimeout(resolve, 20));
      return { sentMessageId: 'owner-message-1' };
    });
    const value = record('concurrent-1');
    assert.equal(fixture.databaseAPI.saveOwnerIntervention(value).success, true);

    await Promise.all([
      fixture.createNotifier().enqueue(value),
      fixture.createNotifier().enqueue(value),
    ]);

    assert.equal(sends, 1);
    const row = fixture.db.prepare(
      'SELECT is_sent, parent_message_id FROM owner_interventions WHERE id = ?',
    ).get(value.id);
    assert.equal(row.is_sent, 1);
    assert.equal(row.parent_message_id, 'owner-message-1');
  });

  it('recovers an expired processing lease but not an active lease', async () => {
    const sent = [];
    const fixture = createFixture(async (_body, visitorId) => {
      sent.push(visitorId);
      return { sentMessageId: `owner-message-${sent.length}` };
    });
    const stale = record('stale-claim');
    const active = record('active-claim');
    fixture.databaseAPI.saveOwnerIntervention(stale);
    fixture.databaseAPI.saveOwnerIntervention(active);
    fixture.db.prepare('UPDATE owner_interventions SET is_sent=2, updated_at=? WHERE id=?')
      .run(Date.now() - 3 * 60 * 1000, stale.id);
    fixture.db.prepare('UPDATE owner_interventions SET is_sent=2, updated_at=? WHERE id=?')
      .run(Date.now(), active.id);

    const pending = fixture.databaseAPI.getPendingOwnerInterventions();
    assert.deepEqual(pending.map(item => item.id), [stale.id]);
    await fixture.createNotifier()._recoverPending();

    assert.equal(sent.length, 1);
    assert.equal(fixture.db.prepare('SELECT is_sent FROM owner_interventions WHERE id=?').get(stale.id).is_sent, 1);
    assert.equal(fixture.db.prepare('SELECT is_sent FROM owner_interventions WHERE id=?').get(active.id).is_sent, 2);
  });

  it('rejects malformed channel success results and returns the claim to pending', async () => {
    const fixture = createFixture(async () => ({ success: true }));
    const value = record('invalid-result');
    fixture.databaseAPI.saveOwnerIntervention(value);
    const notifier = fixture.createNotifier();

    await notifier.enqueue(value);

    const row = fixture.db.prepare(
      'SELECT is_sent, retry_count FROM owner_interventions WHERE id=?',
    ).get(value.id);
    assert.equal(row.is_sent, 0);
    assert.equal(row.retry_count, 1);
    assert.ok(notifier._retryQueue[value.id]);
  });
});
