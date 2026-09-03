const assert = require('node:assert/strict');
const test = require('node:test');
const EventEmitter = require('node:events');

const { initDatabase, createDatabaseAPI } = require('../build/core/database');
const { createDispatcher } = require('../build/core/dispatcher');
const { MessageHandler } = require('../build/core/messenger');
const { OwnerInterventionNotifier } = require('../build/server/owner-intervention-notifier');
const { createResumeOwnerIntervention } = require('../build');

class MockProvider extends EventEmitter {
  constructor() {
    super();
    this.priority = 1;
    this.pushes = [];
  }
  match() { return true; }
  isAvailable() { return true; }
  push(payload) { this.pushes.push(payload); }
}

function setupAgents() {
  const db = initDatabase(':memory:', { silent: true });
  const now = Date.now();
  const insert = db.prepare(`INSERT INTO agents
    (id,agent_id,imUid,imToken,im_server_url,publish_status,access_mode,backend_type,agent_name,created_at,updated_at)
    VALUES (?,?,?,?,?,'published','public','mock',?,?,?)`);
  insert.run('a', 'agentA', 'uidA', 'tokA', 'ws://fake', 'Agent A', now, now);
  insert.run('b', 'agentB', 'uidB', 'tokB', 'ws://fake', 'Agent B', now, now);
  return db;
}

function groupPayload(content) {
  return {
    agentId: 'agentB',
    fromUid: 'uidA',
    senderUid: 'uidA',
    content,
    channelId: 'group_test',
    sessionTarget: 'group:group_test',
    channelType: 2,
    mention: { all: false, uids: ['uidB'] },
    messageId: `group-${Math.random()}`,
    timestamp: Math.floor(Date.now() / 1000),
  };
}

test('主人定向恢复会清除旧收敛闸门，但后续仍走正常 A2A 治理', () => {
  const db = setupAgents();
  try {
    const provider = new MockProvider();
    const dispatcher = createDispatcher({ db, providers: { 'mock-echo': provider } });
    dispatcher.markConverged('uidA', 'uidB', 'group:group_test');
    dispatcher.resetA2AForAgent('agentB', 'uidA', 'group:group_test');
    dispatcher.dispatch('agentB', groupPayload('主人要求继续回复'));

    assert.equal(provider.pushes.length, 1);
    assert.match(provider.pushes[0].content, /\[STATE\]/);
    assert.match(provider.pushes[0].content, /round 1\/10/);
  } finally {
    db.close();
  }
});

test('群主人介入恢复不带 a2aManaged，并在 steer 前重置旧收敛状态', async () => {
  const calls = [];
  const dispatcher = {
    isAgentImUid: uid => uid === 'uidA',
    resetA2AForAgent: (...args) => calls.push(['reset', ...args]),
    steer: async (...args) => {
      calls.push(['steer', ...args]);
      return true;
    },
  };
  const resume = createResumeOwnerIntervention(dispatcher);
  const result = await resume({
    id: 'oi_group',
    agentId: 'agentB',
    visitorId: 'uidA',
    sourceSenderUid: 'uidA',
    targetChannelId: 'group_test',
    targetChannelType: 2,
  }, '主人指令');

  assert.equal(result.success, true);
  assert.deepEqual(calls[0], ['reset', 'agentB', 'uidA', 'group:group_test']);
  assert.equal(calls[1][0], 'steer');
  assert.equal(calls[1][2], 'group:group_test');
  assert.equal(calls[1][4].interventionResume, true);
  assert.equal(calls[1][4].a2aManaged, undefined);
});

test('主人恢复后的群回复定向 mention 原发送者，并清理内部过程话术和正文 @', () => {
  const db = setupAgents();
  try {
    const delivered = [];
    const converged = [];
    const handler = new MessageHandler(db, {
      dispatcher: {
        isAgentImUid: uid => uid === 'uidA' || uid === 'uidB',
        markConverged: (...args) => converged.push(args),
      },
      deliver: async (...args) => {
        delivered.push(args);
        return { success: true };
      },
    });

    handler.handleAgentReply({
      agentId: 'agentB',
      visitorId: 'group:group_test',
      channelId: 'group_test',
      channelType: 2,
      senderUid: 'uidA',
      interventionResume: true,
      content: '好的，主人回复了！让我关闭介入请求，然后回复群聊。\n\n@AgentA 29日10点可以到店。',
      done: true,
    });

    assert.equal(delivered.length, 1);
    assert.equal(delivered[0][2], '29日10点可以到店。');
    assert.deepEqual(delivered[0][5], { all: false, uids: ['uidA'] });
    assert.equal(converged.length, 0);
  } finally {
    db.close();
  }
});

test('已入库但未通知 Agent 的邮件回复会重试并最终收敛状态', async () => {
  const row = {
    id: 'oi_retry',
    email_message_id: 'email_1',
    agent_id: 'agentB',
    visitor_id: 'uidA',
    session_key: 'agent:agentB:group:group_test',
    problem: '确认时间',
    source_sender_uid: 'uidA',
    target_channel_id: 'group_test',
    target_channel_type: 2,
    source_message_id: 'msg_1',
    status: 'replied',
    owner_reply: '29日10点',
    reply_time: Date.now(),
    agent_notified: 0,
  };
  let resumeAttempts = 0;
  let remoteQueries = 0;
  const db = {
    prepare(sql) {
      return {
        run() { return { changes: 1 }; },
        all() {
          if (sql.includes('FROM owner_interventions oi')) {
            return row.agent_notified ? [] : [row];
          }
          return [];
        },
        get() { return undefined; },
      };
    },
  };
  const databaseAPI = {
    updateOwnerInterventionReply() {
      throw new Error('已入库回复不应重复写入');
    },
    markAgentNotified() {
      row.agent_notified = 1;
    },
    updateOwnerInterventionStatus(_id, status) {
      row.status = status;
    },
  };
  const notifier = new OwnerInterventionNotifier({
    db,
    databaseAPI,
    registry: {},
    agentEmailApi: {
      async pollReplies() {
        remoteQueries++;
        return { events: [], next_cursor: '0', has_more: false };
      },
    },
    buildOwnerReplyPrompt: (_intervention, reply) => `owner:${reply}`,
    resumeOwnerIntervention: async (_intervention, prompt) => {
      resumeAttempts++;
      assert.equal(prompt, 'owner:29日10点');
      return resumeAttempts === 1
        ? { success: false, deliveryOutcome: 'not_delivered' }
        : { success: true, deliveryOutcome: 'delivered' };
    },
  });

  await notifier._pollEmailReplies();
  assert.equal(row.status, 'replied');
  assert.equal(row.agent_notified, 0);

  await notifier._pollEmailReplies();
  assert.equal(resumeAttempts, 2);
  assert.equal(remoteQueries, 2);
  assert.equal(row.status, 'resolved');
  assert.equal(row.agent_notified, 1);
});

test('多个 Agent 共用一次邮箱事件轮询并按 message_id 分别恢复', async () => {
  const db = setupAgents();
  const now = Date.now();
  const insert = db.prepare(`INSERT INTO owner_interventions
    (id,visitor_id,agent_id,session_key,problem,ask_time,status,email_message_id,
     agent_notified,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'pending',?,0,?,?)`);
  insert.run('oi_a', 'owner', 'agentA', 'agent:agentA:owner', '确认 A', now, 'mail_a', now, now);
  insert.run('oi_b', 'owner', 'agentB', 'agent:agentB:owner', '确认 B', now, 'mail_b', now, now);
  let pollCount = 0;
  const resumed = [];
  const databaseAPI = {
    markAgentNotified(id) {
      db.prepare('UPDATE owner_interventions SET agent_notified=1 WHERE id=?').run(id);
    },
    updateOwnerInterventionStatus(id, status) {
      db.prepare('UPDATE owner_interventions SET status=? WHERE id=?').run(status, id);
    },
  };
  const notifier = new OwnerInterventionNotifier({
    db, databaseAPI, registry: {},
    agentEmailApi: { async pollReplies({ cursor }) {
      pollCount += 1;
      if (cursor === '0') return { events: [
        { event_id: '11', message_id: 'mail_a', raw_text: 'A 同意', replied_at: new Date().toISOString() },
      ], next_cursor: '11', has_more: true };
      assert.equal(cursor, '11');
      return { events: [
        { event_id: '12', message_id: 'mail_b', raw_text: 'B 同意', replied_at: new Date().toISOString() },
      ], next_cursor: '12', has_more: false };
    } },
    buildOwnerReplyPrompt: (_intervention, reply) => reply,
    resumeOwnerIntervention: async (intervention, prompt) => {
      resumed.push([intervention.agentId, prompt]);
      return { success: true, deliveryOutcome: 'delivered' };
    },
  });
  try {
    await notifier._pollEmailReplies();
    assert.equal(pollCount, 1);
    assert.deepEqual(resumed, [['agentA', 'A 同意']]);
    await notifier._pollEmailReplies();
    assert.equal(pollCount, 2);
    assert.deepEqual(resumed, [['agentA', 'A 同意'], ['agentB', 'B 同意']]);
    const checkpoint = db.prepare(`SELECT committed_value FROM sync_checkpoints
      WHERE namespace='owner_email_replies' AND scope_key='primary_owner'`).get();
    assert.equal(checkpoint.committed_value, '12');
  } finally {
    db.close();
  }
});

test('批量邮件回复轮询不可用时按待处理 message_id 查询并恢复', async () => {
  const db = setupAgents();
  const now = Date.now();
  db.prepare(`INSERT INTO owner_interventions
    (id,visitor_id,agent_id,session_key,problem,ask_time,expire_time,status,email_message_id,
     routing_conversation_id,agent_notified,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,'pending',?,?,0,?,?)`).run(
      'oi_query_fallback', 'owner', 'agentB', 'agent:agentB:owner', '确认继续', now,
      now + 60_000, 'mail_query_fallback', 'conversation_exact', now, now
    );
  const queried = [];
  const resumed = [];
  const databaseAPI = {
    markAgentNotified(id) {
      db.prepare('UPDATE owner_interventions SET agent_notified=1 WHERE id=?').run(id);
    },
    updateOwnerInterventionStatus(id, status) {
      db.prepare('UPDATE owner_interventions SET status=? WHERE id=?').run(status, id);
    },
  };
  const notifier = new OwnerInterventionNotifier({
    db, databaseAPI, registry: {},
    agentEmailApi: {
      async pollReplies() { return null; },
      async queryReply({ message_id }) {
        queried.push(message_id);
        return { has_reply: true, raw_text: 'OWNER_DSH_ROUTE_OK', replied_at: new Date().toISOString() };
      },
    },
    buildOwnerReplyPrompt: (_intervention, reply) => `owner:${reply}`,
    resumeOwnerIntervention: async (intervention, prompt) => {
      resumed.push([intervention.routingConversationId, prompt]);
      return { success: true, deliveryOutcome: 'delivered' };
    },
  });
  try {
    await notifier._pollEmailReplies();
    assert.deepEqual(queried, ['mail_query_fallback']);
    assert.deepEqual(resumed, [['conversation_exact', 'owner:OWNER_DSH_ROUTE_OK']]);
    const row = db.prepare(`SELECT status,owner_reply,agent_notified,channel_type
      FROM owner_interventions WHERE id='oi_query_fallback'`).get();
    assert.deepEqual({ ...row }, {
      status: 'resolved', owner_reply: 'OWNER_DSH_ROUTE_OK', agent_notified: 1,
      channel_type: 'voko-email',
    });
  } finally {
    db.close();
  }
});

test('到期介入无需邮件 ID 也会收敛，迟到邮件只推进游标', async () => {
  const db = setupAgents();
  const now = Date.now();
  db.prepare(`INSERT INTO owner_interventions
    (id,visitor_id,agent_id,session_key,problem,ask_time,expire_time,status,email_message_id,
     agent_notified,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,0,?,?)`).run(
      'oi_expired', 'owner', 'agentA', 'agent:agentA:owner', '过期确认', now - 1000,
      now - 1, 'pending', 'mail_expired', now, now
    );
  db.prepare(`INSERT INTO owner_interventions
    (id,visitor_id,agent_id,session_key,problem,ask_time,expire_time,status,
     agent_notified,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,0,?,?)`).run(
      'oi_unsent_expired', 'owner', 'agentB', 'agent:agentB:owner', '未发出确认', now - 1000,
      now - 1, 'pending', now, now
    );
  db.prepare(`INSERT INTO owner_interventions
    (id,visitor_id,agent_id,session_key,problem,ask_time,expire_time,status,
     agent_notified,created_at,updated_at)
    VALUES (?,?,?,?,?,?,NULL,?,0,?,?)`).run(
      'oi_legacy_expired', 'owner', 'agentB', 'agent:agentB:owner', '历史确认',
      now - 25 * 60 * 60 * 1000, 'pending', now, now
    );
  let resumes = 0;
  const notifier = new OwnerInterventionNotifier({
    db, databaseAPI: {}, registry: {},
    agentEmailApi: { async pollReplies() { return { events: [{
      event_id: '21', message_id: 'mail_expired', status: 'replied', raw_text: '迟到回复',
      replied_at: new Date().toISOString(),
    }], next_cursor: '21', has_more: false }; } },
    resumeOwnerIntervention: async () => { resumes += 1; return { success: true }; },
  });
  try {
    notifier.startEmailReplyPolling();
    notifier.stopEmailReplyPolling();
    await notifier._pollEmailReplies();
    const rows = db.prepare(`SELECT id,status,owner_reply FROM owner_interventions
      WHERE id IN ('oi_expired','oi_legacy_expired','oi_unsent_expired') ORDER BY id`).all()
      .map(row => ({ id: row.id, status: row.status, owner_reply: row.owner_reply }));
    assert.deepEqual(rows, [
      { id: 'oi_expired', status: 'expired', owner_reply: null },
      { id: 'oi_legacy_expired', status: 'expired', owner_reply: null },
      { id: 'oi_unsent_expired', status: 'expired', owner_reply: null },
    ]);
    assert.equal(resumes, 0);
    assert.deepEqual(createDatabaseAPI(db).getPendingOwnerInterventions(), []);
    const checkpoint = db.prepare(`SELECT committed_value FROM sync_checkpoints
      WHERE namespace='owner_email_replies' AND scope_key='primary_owner'`).get();
    assert.equal(checkpoint.committed_value, '21');
  } finally {
    db.close();
  }
});

test('自动转发结果未知时只收敛一次并保留 Pull 状态', async () => {
  const row = {
    id: 'oi_unknown',
    email_message_id: 'email_unknown',
    agent_id: 'agentB',
    visitor_id: 'uidA',
    session_key: 'agent:agentB:uidA',
    problem: '需要确认',
    status: 'replied',
    owner_reply: '继续',
    reply_time: Date.now(),
    agent_notified: 0,
  };
  let attempts = 0;
  const db = {
    prepare(sql) {
      return {
        run() { return { changes: 1 }; },
        all() {
          if (sql.includes('FROM owner_interventions oi')) {
            return row.agent_notified ? [] : [row];
          }
          return [];
        },
        get() { return undefined; },
      };
    },
  };
  const databaseAPI = {
    updateOwnerInterventionReply() { throw new Error('should not rewrite stored reply'); },
    markAgentNotified() { row.agent_notified = 1; },
    updateOwnerInterventionStatus(_id, status) { row.status = status; },
  };
  const notifier = new OwnerInterventionNotifier({
    db,
    databaseAPI,
    registry: {},
    agentEmailApi: { async pollReplies() { return { events: [], next_cursor: '0', has_more: false }; } },
    buildOwnerReplyPrompt: (_intervention, reply) => `owner:${reply}`,
    resumeOwnerIntervention: async () => {
      attempts += 1;
      return { success: false, deliveryOutcome: 'outcome_unknown' };
    },
  });

  await Promise.all([notifier._pollEmailReplies(), notifier._pollEmailReplies()]);
  await notifier._pollEmailReplies();
  assert.equal(attempts, 1);
  assert.equal(row.status, 'unknown');
  assert.equal(row.agent_notified, 1);
});

test('Pull-only Agent 的主人回复只入库并等待主动获取', async () => {
  const row = {
    id: 'oi_pull_only',
    email_message_id: 'email_pull_only',
    agent_id: 'agentB',
    visitor_id: 'uidA',
    session_key: 'agent:agentB:uidA',
    problem: '需要确认',
    status: 'replied',
    owner_reply: '同意',
    reply_time: Date.now(),
    agent_notified: 0,
  };
  let resumeAttempts = 0;
  const db = {
    prepare(sql) {
      return {
        run() { return { changes: 1 }; },
        all() {
          if (sql.includes('FROM owner_interventions oi')) return row.agent_notified ? [] : [row];
          return [];
        },
        get() { return undefined; },
      };
    },
  };
  const notifier = new OwnerInterventionNotifier({
    db,
    databaseAPI: {
      markAgentNotified() { row.agent_notified = 1; },
      updateOwnerInterventionStatus(_id, status) { row.status = status; },
    },
    registry: {},
    agentEmailApi: { async pollReplies() { return { events: [], next_cursor: '0', has_more: false }; } },
    buildOwnerReplyPrompt: (_intervention, reply) => `owner:${reply}`,
    getAgentDeliveryStatus: () => ({ pullOnly: true }),
    resumeOwnerIntervention: async () => { resumeAttempts += 1; },
  });

  await notifier._pollEmailReplies();
  await notifier._pollEmailReplies();
  assert.equal(resumeAttempts, 0);
  assert.equal(row.status, 'replied');
  assert.equal(row.agent_notified, 1);
  assert.equal(row.owner_reply, '同意');
});

test('Lite 常驻扫描能接住启动后由独立 CLI 新写入的介入请求', async () => {
  let scans = 0;
  let sends = 0;
  const pending = {
    id: 'oi_cli',
    visitorId: 'uidA',
    agentId: 'agentB',
    sessionKey: 'agent:agentB:group:group_test',
    problem: '需要主人确认',
    askTime: Date.now(),
    skipReply: 0,
  };
  const notifier = new OwnerInterventionNotifier({
    db: {
      prepare() {
        return {
          run() { return { changes: 1 }; },
          get() { return undefined; },
          all() { return []; },
        };
      },
    },
    databaseAPI: {
      getPendingOwnerInterventions() {
        scans++;
        return scans === 2 ? [pending] : [];
      },
      updateOwnerInterventionSent() {},
    },
    registry: {
      getHandler() {
        return {
          async sendMessageToOwnerWithTracking() {
            sends++;
            return { sentMessageId: 'mail_cli', messageId: 'mail_cli' };
          },
        };
      },
    },
    getEnabledChannel: () => ({ name: 'voko-email' }),
  });

  notifier.startScan();
  try {
    await new Promise(resolve => setTimeout(resolve, 6300));
  } finally {
    notifier.stop();
  }

  assert.ok(scans >= 2);
  assert.equal(sends, 1);
});
