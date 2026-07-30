/**
 * payment.js — 支付处理逻辑
 *
 * 包括支付订单处理、消息发送等核心逻辑。
 * 纯 Node.js，无 Electron 依赖。UI 通知通过 callback 注入。
 *
 * @module
 */

const { signDidRequest } = require('./did-auth');
import type { DatabaseLike } from '../types/database';

interface PaymentOrder {
  id: string;
  agent_id: string;
  visitor_id: string;
  from_uid?: string;
  amount: number;
  description?: string;
  order_no?: string;
  query_token?: string;
  updated_at?: number;
  created_at?: number;
  type?: string;
  status?: string;
  [key: string]: unknown;
}

interface PaymentUpdate {
  status: string;
  result?: string;
  order_no?: string;
  pay_url?: string;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, signal: init?.signal || AbortSignal.timeout(15000) });
  const body = await response.json().catch(() => null) as T | null;
  if (response.ok === false || body === null) {
    const detail = body && typeof body === 'object' && 'message' in body
      ? String((body as { message?: unknown }).message || '')
      : '';
    throw new Error(detail || `HTTP ${response.status}`);
  }
  return body;
}

interface DatabaseApiLike {
  getAgentDid(agentId: string): string | null | undefined;
  updatePaymentOrder(orderId: string, update: PaymentUpdate): unknown;
  getPaymentOrdersByStatus(status: string): PaymentOrder[];
  saveOwnerIntervention(data: Record<string, unknown>): unknown;
}

interface WorkerEntry {
  worker: { send(message: Record<string, unknown>): void };
}

interface PaymentDeps {
  db: DatabaseLike;
  databaseAPI: DatabaseApiLike;
  agentWorkers?: Map<string, WorkerEntry>;
  wukongimSender?: { send(...args: unknown[]): Promise<unknown> };
  deliver?: (...args: unknown[]) => Promise<unknown>;
  sendMessage?: (...args: unknown[]) => Promise<unknown>;
  endpoints: { payment: { baseUrl: string } };
  notifyUI?: (type: string, data: Record<string, unknown>) => void;
  payLog?: (data: Record<string, unknown>) => void;
  hermesHandler?: { connected?: boolean; steer(sessionKey: string, content: string): unknown };
  openclawHandler?: { connected?: boolean; sendToSession(sessionKey: string, content: string): unknown };
  sendSystemMessage?: (agentId: string, visitorId: string, key: string, params: Record<string, unknown>) => unknown;
  ownerInterventionNotifier?: { enqueue(data: Record<string, unknown>): unknown };
}

interface CreateOrderResult {
  success?: boolean;
  message?: string;
  data?: { payUrl?: string; orderNo?: string; queryToken?: string };
}

interface QueryOrderResult {
  success?: boolean;
  data?: Record<string, unknown> & {
    status?: number;
    transactionNo?: string;
    tradeNo?: string;
    thirdTradeNo?: string;
    transaction_no?: string;
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 处理支付订单
 *
 * @param {object} order - 订单对象 { id, agent_id, visitor_id, from_uid, amount, description }
 * @param {object} deps
 * @param {object} deps.db - better-sqlite3 实例
 * @param {object} deps.databaseAPI - 数据库 API
 * @param {object} deps.agentWorkers - Map<agentId, {worker}> IM worker 进程映射（CLI 模式为空）
 * @param {object} deps.wukongimSender - 可选，wukongIM 直连发送器（CLI fallback）
 * @param {object} deps.endpoints - { payment: { baseUrl } }
 * @param {Function} deps.notifyUI - (type, data) => {} 可选 UI 通知回调
 * @param {Function} deps.payLog - (data) => {} 可选支付日志回调
 */
async function processPendingPaymentOrder(order: PaymentOrder, deps: PaymentDeps): Promise<void> {
  const { db, databaseAPI, agentWorkers, wukongimSender, deliver, sendMessage, endpoints, notifyUI, payLog } = deps;
  const _log = payLog || (() => {});
  const _notify = notifyUI || (() => {});
  let serverOrderNo = null;
  let serverPayUrl = null;

  try {
    // 原子领取：只有当前仍是 pending 才能成功
    const claimed = db.prepare(`UPDATE payment_orders SET status = 'processing', updated_at = ? WHERE id = ? AND status = 'pending'`).run(Date.now(), order.id) as { changes: number };
    if (claimed.changes === 0) {
      console.log('[Payment] 跳过，订单已被处理, id:', order.id);
      return;
    }

    // 获取 Agent DID 和私钥
    const agentDid = databaseAPI.getAgentDid(order.agent_id);
    const agentKeyRow = db.prepare(`SELECT private_key FROM agents WHERE agent_id = ? AND private_key IS NOT NULL`).get<{ private_key: string }>(order.agent_id);
    if (!agentDid || !agentKeyRow) {
      databaseAPI.updatePaymentOrder(order.id, { status: 'failed', result: 'Agent 未注册 DID 或未配置私钥' });
      console.error('[Payment] Agent ' + order.agent_id + ' 未注册 DID 或未配置私钥');
      return;
    }

    const bizFields = {
      agentDid,
      amount: order.amount,
      description: order.description || '支付收款',
      imUid: order.visitor_id || undefined,
      clientOrderId: order.id
    };
    const authFields = await signDidRequest(agentDid, agentKeyRow.private_key, bizFields);
    const body = { ...authFields, ...bizFields };

    const initResult = await fetchJson<CreateOrderResult>(endpoints.payment.baseUrl + '/payment/create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!initResult.success) {
      databaseAPI.updatePaymentOrder(order.id, { status: 'failed', result: initResult.message || '创建支付失败' });
      return;
    }

    const payUrl = initResult.data?.payUrl;
    const orderNo = initResult.data?.orderNo;
    const queryToken = initResult.data?.queryToken || '';
    serverOrderNo = orderNo;
    serverPayUrl = payUrl;
    if (!payUrl) {
      databaseAPI.updatePaymentOrder(order.id, { status: 'failed', result: '未获取到支付链接' });
      return;
    }

    if (queryToken) {
      db.prepare(`UPDATE payment_orders SET query_token = ? WHERE id = ?`).run(queryToken, order.id);
    }
    // 服务端订单一旦创建成功，必须先持久化远端身份，再做任何消息投递。
    // 即使随后投递失败，也要继续轮询，避免已可支付的远端订单成为孤儿。
    databaseAPI.updatePaymentOrder(order.id, { status: 'created', order_no: orderNo, pay_url: payUrl });

    // 发送给访客（无二维码）
    let fromUid = order.from_uid || '';
    if (!fromUid) {
      try {
        const row = db.prepare(`SELECT imUid FROM agents WHERE agent_id = ?`).get<{ imUid?: string }>(order.agent_id);
        fromUid = row?.imUid || 'voko';
      } catch (_) { fromUid = 'voko'; }
    }

    const textMsg = `请支付 ¥${order.amount.toFixed(2)}，支付链接：${payUrl}`;
    const timestamp = Math.floor(Date.now() / 1000);

    if (sendMessage) {
      // 统一发送：落库 + 会话 + 投递 + UI 通知（sendMessage 内已 emit）
      await sendMessage(order.agent_id, order.visitor_id, textMsg, fromUid, 'text');
    } else {
      // 兜底（未注入 sendMessage）：保留原 落库 + 投递 逻辑
      const entry = agentWorkers?.get(order.agent_id);
      const textMsgId = `pay_msg_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
      db.prepare(`INSERT INTO messages (id, from_uid, to_uid, content, channel_id, channel_type, agent_id, timestamp, is_me, status, message_seq, client_msg_no, no_persist, red_dot, sync_once, content_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(textMsgId, fromUid, order.visitor_id, textMsg, order.visitor_id, 1, order.agent_id, timestamp, 1, 'sent', null, null, 0, 0, 0, 1);
      db.prepare(`INSERT OR IGNORE INTO conversations (user_uid, channel_id, channel_type, name, last_message, last_timestamp, unread_count, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(fromUid, order.visitor_id, 1, order.visitor_id, textMsg, timestamp, 0, order.agent_id);
      db.prepare(`UPDATE conversations SET last_message = ?, last_timestamp = ? WHERE user_uid = ? AND channel_id = ?`)
        .run(textMsg, timestamp, fromUid, order.visitor_id);
      if (entry) {
        entry.worker.send({ type: 'send', channelId: order.visitor_id, content: textMsg, messageType: 'text', localMsgId: textMsgId });
      } else if (wukongimSender) {
        try { await wukongimSender.send(order.agent_id, order.visitor_id, textMsg); } catch (err: unknown) { console.error('[Payment] wukongIM 直连发送失败:', errorMessage(err)); }
      }
    }

    if (!sendMessage) {
      try {
        _notify('agent-wukongim:message', {
          agentId: order.agent_id, fromUid, toUid: order.visitor_id,
          channelId: order.visitor_id, content: textMsg, timestamp
        });
      } catch (notifyErr: unknown) {
        console.warn('[Payment] UI notify 失败（订单已 created）:', errorMessage(notifyErr));
      }
    }

    _log({ event: 'order_created', orderId: order.id, orderNo });
    console.log('[Payment] 订单已创建并通知访客:', order.id, orderNo);
  } catch (e: unknown) {
    const message = errorMessage(e);
    _log({ event: 'pending_fail', orderId: order.id, error: message });
    console.error('[Payment] 处理 pending 订单失败:', order.id, message);
    if (serverOrderNo) {
      databaseAPI.updatePaymentOrder(order.id, {
        status: 'created', order_no: serverOrderNo, pay_url: serverPayUrl || '', result: message
      });
      console.warn('[Payment] 服务端订单已创建，本地保留 created 供轮询:', order.id, serverOrderNo);
    } else {
      databaseAPI.updatePaymentOrder(order.id, { status: 'failed', result: message });
    }
  }
}

/**
 * 启动支付轮询
 *
 * 每 5 秒检查 created 订单：超 30 分钟 → expired，成功支付 → paid 并通知各方。
 *
 * @param {object} deps
 * @param {object} deps.db
 * @param {object} deps.databaseAPI
 * @param {object} deps.agentWorkers - Map<agentId, {worker}>
 * @param {object} deps.endpoints - { payment: { baseUrl } }
 * @param {object} deps.hermesHandler
 * @param {object} deps.openclawHandler
 * @param {Function} deps.sendSystemMessage - (agentId, visitorId, content) => {}
 * @param {Function} deps.payLog - (data) => {}
 * @param {object} deps.ownerInterventionNotifier - 可选
 */
function startPaymentPolling(deps: PaymentDeps): () => void {
  const { db, databaseAPI, agentWorkers, endpoints, hermesHandler, openclawHandler, sendSystemMessage, payLog, ownerInterventionNotifier } = deps;
  const _log = payLog || (() => {});
  const _sendMsg = sendSystemMessage || (() => {});

  let pollInterval = 5000;
  let pollTimer: NodeJS.Timeout | null = null;
  let reconcileLegacyExpired = true;
  const reconciledLegacyOrderIds = new Set<string>();

  const scheduleNext = () => {
    pollTimer = setTimeout(doPoll, pollInterval);
  };

  const doPoll = async () => {
    try {
      const createdOrders = databaseAPI.getPaymentOrdersByStatus('created');
      // 历史 bug：服务端已 create-order 但本地误标 failed 且有 order_no 的，继续轮询补同步
      let failedWithOrderNo: PaymentOrder[] = [];
      try {
        failedWithOrderNo = db.prepare(
          `SELECT * FROM payment_orders WHERE status = 'failed' AND order_no IS NOT NULL AND order_no != '' AND query_token IS NOT NULL AND query_token != '' ORDER BY created_at ASC`
        ).all<PaymentOrder>();
      } catch (_) {}
      let legacyExpired: PaymentOrder[] = [];
      try {
        if (reconcileLegacyExpired) {
        const candidates = db.prepare(
          `SELECT * FROM payment_orders WHERE status = 'expired' AND order_no IS NOT NULL AND order_no != '' AND query_token IS NOT NULL AND query_token != '' ORDER BY created_at ASC`
        ).all<PaymentOrder>();
        legacyExpired = candidates.filter((order) => !reconciledLegacyOrderIds.has(order.id)).slice(0, 10);
        for (const order of legacyExpired) reconciledLegacyOrderIds.add(order.id);
        reconcileLegacyExpired = candidates.some((order) => !reconciledLegacyOrderIds.has(order.id));
        }
      } catch (_) {}
      const ordersToPoll = createdOrders.concat(failedWithOrderNo, legacyExpired);
      for (const order of ordersToPoll) {
        try {
          const qt = db.prepare(`SELECT query_token FROM payment_orders WHERE id = ?`).get<{ query_token?: string }>(order.id);
          const queryToken = qt?.query_token || '';
          if (!queryToken) {
            databaseAPI.updatePaymentOrder(order.id, {
              status: 'failed',
              result: 'Missing queryToken; secure order status lookup is unavailable',
            });
            _log({ event: 'query_skipped_missing_token', orderId: order.id });
            continue;
          }
          const queryResult = await fetchJson<QueryOrderResult>(
            endpoints.payment.baseUrl + '/payment/order/' + encodeURIComponent(order.order_no || '') + '?token=' + encodeURIComponent(queryToken),
            { method: 'GET' }
          );

          if (queryResult.success && queryResult.data?.status === 1) {
            const paidData = queryResult.data;
            paidData.transaction_no = paidData.transactionNo || paidData.tradeNo || paidData.thirdTradeNo || '';
            databaseAPI.updatePaymentOrder(order.id, { status: 'paid', result: JSON.stringify(paidData) });

            // 激活会话
            try {
              if (order.type === 'timed') {
                const pa = db.prepare('SELECT duration_minutes FROM agent_pricing WHERE agent_id = ? AND enabled = 1').get<{ duration_minutes?: number }>(order.agent_id);
                if (pa && pa.duration_minutes) {
                  const conv = db.prepare('SELECT session_status, session_expire_at FROM conversations WHERE user_uid = ? AND channel_id = ?').get<{ session_status?: string; session_expire_at?: number }>(order.from_uid, order.visitor_id);
                  const n2 = Date.now();
                  const dur = pa.duration_minutes * 60 * 1000;
                  const expireAt = (conv && conv.session_status === 'active' && typeof conv.session_expire_at === 'number' && conv.session_expire_at > n2)
                    ? conv.session_expire_at + dur
                    : n2 + dur;
                  if (conv) {
                    db.prepare('UPDATE conversations SET session_status=?, session_expire_at=? WHERE user_uid=? AND channel_id=?').run('active', expireAt, order.from_uid, order.visitor_id);
                  } else {
                    db.prepare(`INSERT INTO conversations (user_uid, channel_id, channel_type, name, last_message, last_timestamp, session_status, session_expire_at, agent_id) VALUES (?, ?, 1, ?, '', ?, 'active', ?, ?)`).run(order.from_uid, order.visitor_id, order.visitor_id, n2, expireAt, order.agent_id);
                  }
                }
              }
            } catch (e: unknown) { console.error('[计费] 激活会话失败:', errorMessage(e)); }

            // 通知访客（_sendMsg 自带 worker→wukongIM 兜底，agent 离线/CLI 模式也能送达）
            try {
              const isTimed = order.type === 'timed';
              if (isTimed) {
                _sendMsg(order.agent_id, order.visitor_id, 'payment_success_timed', {});
              } else {
                _sendMsg(order.agent_id, order.visitor_id, 'payment_success_detail', { amount: order.amount.toFixed(2), description: order.description || '无', orderNo: order.order_no || '-' });
              }
            } catch (e: unknown) { console.error('[Payment] 通知访客支付结果失败:', errorMessage(e)); }

            // 通知 agent
            try {
              const payAgent = db.prepare(`SELECT backend_type FROM agents WHERE agent_id = ?`).get<{ backend_type?: string }>(order.agent_id);
              const payBackend = payAgent?.backend_type || 'openclaw';
              const payMsg2 = `[Payment Notification]\n访客: ${order.visitor_id}\n金额: ¥${order.amount.toFixed(2)}\n描述: ${order.description || '无'}\n订单号: ${order.order_no || '-'}\n交易流水号: ${paidData.transactionNo || ''}`;
              if (payBackend === 'hermes' && hermesHandler?.connected) {
                hermesHandler.steer(`hermes:${order.agent_id}:${order.visitor_id}`, payMsg2);
              } else if (openclawHandler?.connected) {
                openclawHandler.sendToSession(`agent:${order.agent_id}:${order.visitor_id}`, payMsg2);
              }
            } catch (e: unknown) { console.error('[Payment] 通知 agent 失败:', errorMessage(e)); }

            // 通知主人
            try {
              const now2 = Date.now();
              const oiId = 'pay_' + now2 + '_' + Math.random().toString(36).substr(2, 6);
              const ownerMsg = '💰 支付成功通知\nAgent: ' + order.agent_id + '\n访客: ' + order.visitor_id + '\n金额: ¥' + order.amount.toFixed(2);
              const payPrefix = (db.prepare(`SELECT backend_type FROM agents WHERE agent_id = ?`).get<{ backend_type?: string }>(order.agent_id)?.backend_type) === 'hermes' ? 'hermes' : 'agent';
              databaseAPI.saveOwnerIntervention({
                id: oiId, visitorId: order.visitor_id, sessionKey: payPrefix + ':' + order.agent_id + ':' + order.visitor_id,
                problem: ownerMsg, agentSuggestion: '支付成功通知，无需回复', askTime: now2,
                status: 'pending', channelType: 'voko', createdAt: now2, updatedAt: now2, agentId: order.agent_id,
                skipReply: 1,
              });
              if (ownerInterventionNotifier) ownerInterventionNotifier.enqueue({ id: oiId, visitorId: order.visitor_id, agentId: order.agent_id, sessionKey: payPrefix + ':' + order.agent_id + ':' + order.visitor_id, problem: ownerMsg, agentSuggestion: '支付成功通知，无需回复', askTime: now2, skipReply: 1 });
            } catch (e: unknown) { console.error('[Payment] 通知主人失败:', errorMessage(e)); }
          } else if (queryResult.success && queryResult.data?.status === 2) {
            const wasExpired = order.status === 'expired';
            databaseAPI.updatePaymentOrder(order.id, { status: 'expired' });
            if (!wasExpired) {
              try {
                const isTimed = order.type === 'timed';
                if (isTimed) {
                  _sendMsg(order.agent_id, order.visitor_id, 'payment_expired_timed', {});
                } else {
                  _sendMsg(order.agent_id, order.visitor_id, 'payment_expired_detail', { orderNo: order.order_no || '-', description: order.description || '无', amount: order.amount.toFixed(2) });
                }
              } catch (e: unknown) { console.error('[Payment] 通知访客超时失败:', errorMessage(e)); }
            }
          } else if (queryResult.success && queryResult.data?.status === 0 && order.status !== 'created') {
            // 修复旧版本按本地时间提前过期造成的状态分叉。
            databaseAPI.updatePaymentOrder(order.id, { status: 'created' });
          }
        } catch (e: unknown) {
          const message = errorMessage(e);
          _log({ event: 'query_fail', orderId: order.id, error: message });
          console.error('[Payment] 查询订单状态失败:', order.id, message);
        }
      }
    } catch (err: unknown) {
      const message = errorMessage(err);
      _log({ event: 'poll_error', error: message });
      console.error('[Payment] 支付轮询错误:', message);
    }
    scheduleNext();
  };

  scheduleNext();
  console.log('[Payment] 启动支付轮询，初始间隔 5s');

  // 返回停止函数
  return () => { if (pollTimer) clearTimeout(pollTimer); };
}

module.exports = { processPendingPaymentOrder, startPaymentPolling };
