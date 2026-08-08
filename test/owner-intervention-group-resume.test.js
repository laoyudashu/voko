const assert = require('node:assert/strict');
const test = require('node:test');
const EventEmitter = require('node:events');

const { initDatabase } = require('../build/core/database');
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
      async queryReply() {
        remoteQueries++;
        return null;
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
  assert.equal(remoteQueries, 0);
  assert.equal(row.status, 'resolved');
  assert.equal(row.agent_notified, 1);
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
    agentEmailApi: { async queryReply() { return null; } },
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
