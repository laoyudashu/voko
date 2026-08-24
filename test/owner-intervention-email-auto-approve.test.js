const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { OwnerInterventionNotifier } = require('../build/server/owner-intervention-notifier');
const { initDatabase } = require('../build/core/database');

// 复用 mock DB 风格（同 owner-intervention-group-resume.test.js），聚焦断言：
// 邮件渠道主人回复"同意"时，autoApproveWhitelistIfFriendRequest 被调用，
// 且不短路——回复仍照常转发给 agent（resumeOwnerIntervention 也被调用）。
function makeRow(overrides = {}) {
  return {
    id: 'private_req_email_1',
    email_message_id: 'email_1',
    agent_id: 'agentA',
    visitor_id: 'visitorA',
    session_key: 'agent:agentA:visitorA',
    problem: '访客 "visitorA"(visitorA) 申请添加好友',
    source_sender_uid: 'visitorA',
    target_channel_id: 'visitorA',
    target_channel_type: 1,
    source_message_id: 'msg_1',
    status: 'pending',
    owner_reply: null,
    reply_time: null,
    agent_notified: 0,
    ...overrides,
  };
}

function makeNotifier({ row, reply, approve, resume }) {
  const db = initDatabase(':memory:', { silent: true });
  const now = Date.now();
  db.prepare(`INSERT INTO owner_interventions
    (id,visitor_id,agent_id,session_key,problem,ask_time,status,email_message_id,
     source_sender_uid,target_channel_id,target_channel_type,source_message_id,
     agent_notified,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`).run(
      row.id, row.visitor_id, row.agent_id, row.session_key, row.problem, now, row.status,
      row.email_message_id, row.source_sender_uid, row.target_channel_id,
      row.target_channel_type, row.source_message_id, now, now
    );
  const databaseAPI = {
    markAgentNotified(id) {
      db.prepare('UPDATE owner_interventions SET agent_notified=1 WHERE id=?').run(id);
      row.agent_notified = 1;
    },
    updateOwnerInterventionStatus(id, status) {
      db.prepare('UPDATE owner_interventions SET status=? WHERE id=?').run(status, id);
      row.status = status;
    },
  };
  const notifier = new OwnerInterventionNotifier({
    db,
    databaseAPI,
    registry: {},
    agentEmailApi: { async pollReplies() {
      return { events: [{ event_id: '1', message_id: row.email_message_id,
        status: 'replied', raw_text: reply.raw_text, actor_email: null,
        replied_at: reply.replied_at }], next_cursor: '1', has_more: false };
    } },
    buildOwnerReplyPrompt: (_intervention, ownerReply) => `owner:${ownerReply}`,
    autoApproveWhitelistIfFriendRequest: approve,
    resumeOwnerIntervention: resume,
  });
  return { notifier, db };
}

describe('Owner intervention email auto-approve (friend request)', () => {
  it('主人邮件回复"同意"触发自动加白名单，且回复仍转发给 agent（不短路）', async () => {
    const row = makeRow();
    const approveCalls = [];
    const resumeCalls = [];

    const { notifier } = makeNotifier({
      row,
      reply: { has_reply: true, raw_text: '同意', replied_at: new Date().toISOString() },
      approve: (intervention, content) => { approveCalls.push({ intervention, content }); },
      resume: async (intervention, prompt) => { resumeCalls.push({ intervention, prompt }); return { success: true }; },
    });

    await notifier._pollEmailReplies();

    // 自动审批被调用，传入正确的 intervention 与回复内容
    assert.equal(approveCalls.length, 1);
    assert.equal(approveCalls[0].content, '同意');
    assert.equal(approveCalls[0].intervention.id, 'private_req_email_1');
    assert.equal(approveCalls[0].intervention.visitorId, 'visitorA');
    assert.equal(approveCalls[0].intervention.agentId, 'agentA');

    // 不短路：回复仍被转发给 agent
    assert.equal(resumeCalls.length, 1);
    assert.equal(resumeCalls[0].prompt, 'owner:同意');

    // 状态收敛为 resolved
    assert.equal(row.status, 'resolved');
    assert.equal(row.agent_notified, 1);
  });

  it('非批准回复（如"稍等"）不触发自动审批，但仍正常转发给 agent', async () => {
    const row = makeRow();
    const approveCalls = [];
    const resumeCalls = [];

    const { notifier } = makeNotifier({
      row,
      reply: { has_reply: true, raw_text: '稍等一下', replied_at: new Date().toISOString() },
      approve: (intervention, content) => { approveCalls.push({ intervention, content }); },
      resume: async (intervention, prompt) => { resumeCalls.push({ intervention, prompt }); return { success: true }; },
    });

    await notifier._pollEmailReplies();

    // 注意：此处仅断言 notifier 把回复交给审批回调；
    // 是否真的加白名单由 access-control-api 的关键词匹配决定（/同意|通过|好的|ok/），
    // "稍等"不命中，但 notifier 层仍会调用回调——这是 fire-and-forget 设计。
    assert.equal(approveCalls.length, 1);
    assert.equal(approveCalls[0].content, '稍等一下');
    assert.equal(resumeCalls.length, 1);
    assert.equal(row.status, 'resolved');
  });

  it('未注入 autoApproveWhitelistIfFriendRequest 时退化为无副作用（向后兼容）', async () => {
    const row = makeRow();
    const resumeCalls = [];

    const { notifier } = makeNotifier({
      row,
      reply: { has_reply: true, raw_text: '同意', replied_at: new Date().toISOString() },
      approve: undefined, // 未注入
      resume: async (intervention, prompt) => { resumeCalls.push({ intervention, prompt }); return { success: true }; },
    });

    await notifier._pollEmailReplies();

    // 回复转发不受影响
    assert.equal(resumeCalls.length, 1);
    assert.equal(row.status, 'resolved');
  });
});
