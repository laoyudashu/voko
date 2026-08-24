const assert = require('node:assert/strict');
const test = require('node:test');

const { initDatabase } = require('../build/core/database');
const { MessageHandler } = require('../build/core/messenger');
const { reservedVisitorPrefix, isExternalVisitorIdAllowed } = require('../build/core/visitor-id-policy');

test('reserved visitor namespaces are case-insensitive and prefix-bounded', () => {
  for (const prefix of ['cron:', 'system:', 'internal:', 'scheduler:']) {
    assert.equal(reservedVisitorPrefix(`${prefix}job-1`), prefix);
    assert.equal(reservedVisitorPrefix(`  ${prefix.toUpperCase()}job-1`), prefix);
  }
  assert.equal(isExternalVisitorIdAllowed('visitor-cron:1'), true);
  assert.equal(isExternalVisitorIdAllowed('cron-user'), true);
  assert.equal(isExternalVisitorIdAllowed('visitor-1'), true);
});

test('Messenger rejects reserved external visitor IDs before persistence or dispatch', () => {
  const db = initDatabase(':memory:', { silent: true });
  const now = Date.now();
  db.prepare(`INSERT INTO agents
    (id,agent_id,imUid,imToken,im_server_url,publish_status,access_mode,backend_type,agent_name,created_at,updated_at)
    VALUES (?, ?, ?, ?, ?, 'published', 'public', 'mock', ?, ?, ?)`).run(
      'row-1', 'agent-1', 'agent-uid', 'token', 'ws://fake', 'Agent', now, now
    );
  let dispatches = 0;
  const handler = new MessageHandler(db, {
    dispatcher: { dispatch() { dispatches += 1; } },
    deliver: async () => ({ success: true }),
  });
  try {
    for (const [index, fromUid] of ['cron:run-1', 'SYSTEM:notice', ' internal:job', 'scheduler:tick'].entries()) {
      handler.handleAgentMessage('agent-1', {
        fromUid, toUid: 'agent-uid', channelId: fromUid.trim(), channelType: index === 3 ? 2 : 1,
        content: 'untrusted', contentType: 1, messageId: `reserved-${index}`,
        messageSeq: index + 1, timestamp: 1700000000 + index,
      });
    }
    assert.equal(db.prepare('SELECT COUNT(*) count FROM messages').get().count, 0);
    assert.equal(dispatches, 0);
  } finally {
    db.close();
  }
});
