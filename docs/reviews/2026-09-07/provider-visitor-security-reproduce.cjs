'use strict';

// Read-only audit of production logic using only an in-memory database and
// synthetic messages. No Provider process, network delivery or live DB access.
// Run from the repository: node docs/reviews/2026-09-07/provider-visitor-security-reproduce.cjs
const { initDatabase } = require('../../../build/core/database');
const { MessageHandler } = require('../../../build/core/messenger');
const { buildConversationRecoveryPrompt } = require('../../../build/core/dispatcher/conversation-context');
const { createToolHandlers } = require('../../../build/mcp/tools');

async function probe(kind) {
  const db = initDatabase(':memory:', { silent: true });
  const marker = `AUDIT_${kind.toUpperCase()}_CANARY`;
  try {
    db.prepare(`INSERT INTO agents
      (id,agent_id,imUid,imToken,im_server_url,publish_status,access_mode,backend_type,agent_name,created_at,updated_at)
      VALUES('audit-agent','audit-agent','audit-uid','synthetic','','published','public','mock','Audit',1,1)`).run();
    if (kind === 'whitelist') db.prepare("UPDATE agents SET access_mode='private'").run();
    if (kind === 'unpublished' || kind === 'group_unpublished') {
      db.prepare("UPDATE agents SET publish_status='unpublished'").run();
    }
    let dispatched = 0;
    let blacklisted = kind.includes('blacklist') && kind !== 'queued_blacklist';
    const handler = new MessageHandler(db, {
      dispatcher: { dispatch() { dispatched++; } },
      ac: { isBlacklisted: () => blacklisted, isWhitelisted: () => false,
        addEntry: () => ({ success: true }) },
      checkAuditRules: () => ({ action: kind === 'audit' ? 'hard_deny' : 'allow',
        matchedKeyword: 'synthetic', matchedRule: {} }),
      notifyUI() {}, sendSystemMessage() {},
    });
    const group = kind.startsWith('group_');
    const channelId = group ? 'group_audit' : 'audit-visitor';
    const message = { fromUid: 'audit-visitor', toUid: 'audit-uid', channelId,
      channelType: group ? 2 : 1, contentType: 1, content: marker,
      messageId: 'audit-message', messageSeq: 1, timestamp: 1700000000,
      ...(group ? { mention: { uids: ['audit-uid'] } } : {}) };
    const forward = handler.handleAgentMessage('audit-agent', message, kind !== 'queued_blacklist');
    if (kind === 'queued_blacklist') {
      blacklisted = true;
      await handler.flushInboundTurns();
    }
    const recovery = buildConversationRecoveryPrompt(db, {
      agentId: 'audit-agent', fromUid: 'audit-visitor', channelType: 1,
      messageId: 'next-message', content: 'ordinary subsequent message',
    });
    const handlers = createToolHandlers({ db,
      query: (sql, params = []) => db.prepare(sql).all(...params),
      exec: (sql, params = []) => db.prepare(sql).run(...params),
    });
    const pull = await handlers.fetch_new_messages({ agentId: 'audit-agent', channelId,
      channelType: group ? 2 : 1, cursor: 0, onlyNew: false });
    return { scenario: kind, intercepted: message._vokoInboundIntercepted || null,
      forwardPayloadReturned: Boolean(forward), dispatched,
      recoveryContainsDeniedText: group ? null : recovery.includes(marker),
      pullSuccess: pull.success, pullContainsDeniedText: JSON.stringify(pull.messages).includes(marker) };
  } finally { db.close(); }
}

(async () => {
  const results = [];
  for (const kind of ['blacklist', 'whitelist', 'unpublished', 'audit', 'group_blacklist', 'group_unpublished', 'queued_blacklist']) {
    results.push(await probe(kind));
  }
  console.log(JSON.stringify({ evidence: 'local synthetic audit; not live Provider execution', results }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
