'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDatabaseAPI, initDatabase } = require('../build/core/database');
const { MessageRouteStore, RoutingConversationStore } = require('../build/core/provider-routing');
const { AgentWorkerManager } = require('../build/core/worker-manager');
const { createToolHandlers } = require('../build/mcp/tools');

test('payment orders persist their routing conversation column', () => {
  const db = initDatabase(':memory:', { silent: true });
  try {
    const columns = db.prepare('PRAGMA table_info(payment_orders)').all().map(row => row.name);
    assert.ok(columns.includes('routing_conversation_id'));
    const api = createDatabaseAPI(db);
    assert.equal(api.savePaymentOrder({
      id: 'payment-route-1', agent_id: 'agent-pay', visitor_id: 'visitor-pay',
      from_uid: 'im-pay', amount: 0.1, description: 'test', type: 'service',
      status: 'pending', created_at: Date.now(), updated_at: Date.now(),
      routing_conversation_id: 'conversation-pay',
    }).success, true);
    assert.equal(db.prepare('SELECT routing_conversation_id FROM payment_orders WHERE id=?')
      .get('payment-route-1').routing_conversation_id, 'conversation-pay');
  } finally { db.close(); }
});

test('existing schema 8 databases receive the payment routing column on startup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-payment-schema8-'));
  const dbPath = path.join(dir, 'voko.db');
  try {
    let db = initDatabase(dbPath, { silent: true });
    db.exec('ALTER TABLE payment_orders DROP COLUMN routing_conversation_id');
    db.close();
    db = initDatabase(dbPath, { silent: true });
    assert.ok(db.prepare('PRAGMA table_info(payment_orders)').all()
      .some(row => row.name === 'routing_conversation_id'));
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('payment system notifications create an active route in the selected conversation', async () => {
  const db = initDatabase(':memory:', { silent: true });
  try {
    const now = Date.now();
    db.prepare(`INSERT INTO agents
      (id,agent_id,imUid,imToken,im_server_url,publish_status,created_at,updated_at,backend_type)
      VALUES (?,?,?,?,?,'published',?,?,?)`)
      .run('row-pay', 'agent-pay', 'im-pay', 'token', 'https://im.test', now, now, 'openclaw');
    const conversation = new RoutingConversationStore(db).createPending({
      agentId: 'agent-pay', channelId: 'visitor-pay', channelType: 1,
    });
    const routes = new MessageRouteStore(db);
    const inboundRouteId = routes.createPending({
      messageId: 'visitor-message-1', conversationId: conversation.id,
      agentId: 'agent-pay', peerUid: 'visitor-pay', channelId: 'visitor-pay',
      channelType: 1, direction: 'inbound',
    });
    routes.setStatus(inboundRouteId, 'active');
    const manager = new AgentWorkerManager(db);
    manager.workers.set('agent-pay', { worker: { send() {} }, config: { uid: 'im-pay', token: 'token', serverUrl: 'https://im.test' } });
    let deliveredMetadata = null;
    manager.setDeliver(async (...args) => {
      deliveredMetadata = args[7];
      return { success: true, messageSeq: 1, clientMsgNo: 'client-pay' };
    });

    const result = await manager.sendSystemMessage(
      'agent-pay', 'visitor-pay', 'payment_success_detail',
      { amount: '0.10', description: 'test', orderNo: 'ORDER-1' }, undefined,
      { conversationId: conversation.id },
    );

    assert.equal(result.notificationStatus, 'sent');
    const route = db.prepare(`SELECT conversation_id,status,direction FROM provider_message_routes
      WHERE agent_id='agent-pay' ORDER BY created_at DESC LIMIT 1`).get();
    assert.equal(route.conversation_id, conversation.id);
    assert.equal(route.status, 'active');
    assert.equal(route.direction, 'outbound');
    assert.equal(deliveredMetadata._voko.conversationKey, conversation.wireConversationKey);
    assert.ok(deliveredMetadata._voko.routeId);
    assert.equal(deliveredMetadata._voko.replyToRouteId, inboundRouteId);
  } finally { db.close(); }
});

test('create_payment returns the visitor delivery result and keeps the selected conversation', async () => {
  const db = initDatabase(':memory:', { silent: true });
  try {
    const now = Date.now();
    db.prepare(`INSERT INTO payment_auth
      (id,owner_email,receiver_apply_status,created_at,updated_at) VALUES (?,?,?,?,?)`)
      .run('auth-pay', 'owner@example.com', 'COMPLETED', now, now);
    db.prepare(`INSERT INTO agents
      (id,agent_id,imUid,imToken,im_server_url,publish_status,created_at,updated_at,backend_type,did,private_key,payment_auth_id)
      VALUES (?,?,?,?,?,'published',?,?,?,?,?,?)`)
      .run('row-pay', 'agent-pay', 'im-pay', 'token', 'https://im.test', now, now,
        'openclaw', 'did:test:agent-pay', 'private-key', 'auth-pay');
    const conversation = new RoutingConversationStore(db).createPending({
      agentId: 'agent-pay', channelId: 'visitor-pay', channelType: 1,
    });
    const databaseAPI = createDatabaseAPI(db);
    let processedOrder = null;
    const handlers = createToolHandlers({
      db,
      query: (sql, params = []) => db.prepare(sql).all(...params),
      exec: (sql, params = []) => db.prepare(sql).run(...params),
      getPaymentAuth: () => ({ id: 'auth-pay' }),
      getAgentImUid: () => 'im-pay',
      savePaymentOrder: (order) => databaseAPI.savePaymentOrder(order),
      processPaymentOrder: async (order) => {
        processedOrder = order;
        db.prepare(`UPDATE payment_orders SET status='created',order_no=?,pay_url=?,updated_at=? WHERE id=?`)
          .run('ORDER-1', 'https://pay.test/ORDER-1', Date.now(), order.id);
        return { orderCreated: true, sentToVisitor: false, deliveryStatus: 'failed',
          orderId: order.id, visitorId: order.visitor_id, messageId: 'pay-message-1', error: 'SENDACK rejected' };
      },
    });

    const result = await handlers.create_payment({
      agentId: 'agent-pay', visitorId: 'visitor-pay', amount: 0.1,
      description: 'test', conversationId: conversation.id,
    });

    assert.equal(processedOrder.routing_conversation_id, conversation.id);
    assert.equal(result.success, true);
    assert.equal(result.orderCreated, true);
    assert.equal(result.sentToVisitor, false);
    assert.equal(result.deliveryStatus, 'failed');
    assert.equal(result.deliveryError, 'SENDACK rejected');
    assert.equal(result.messageId, 'pay-message-1');
    assert.equal(result.visitorId, 'visitor-pay');
  } finally { db.close(); }
});
