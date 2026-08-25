export {};

/**
 * Owner Intervention Notifier — 事件驱动的通知模块
 *
 * 替代原有的轮询机制 (startOwnerInterventionPolling)：
 * - saveOwnerIntervention 完成后立即通知，无需等待轮询周期
 * - 内置重试队列（指数退避）替代轮询重试
 * - 启动时扫描 is_sent=0 的记录作为崩溃恢复兜底
 * - 纯 Node.js，UI 通知通过 lite-bus 事件转发
 *
 * 使用方式：
 *   const notifier = new OwnerInterventionNotifier({ databaseAPI, registry, db });
 *   notifier.enqueue(record);
 */

const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 5000;
const MAX_RETRY_DELAY = 80000; // 80s cap
const STARTUP_SCAN_INTERVAL = 3000;
const PENDING_SCAN_INTERVAL = 3000;
const CLAIM_LEASE_MS = 2 * 60 * 1000;
const SEND_TIMEOUT_MS = 60 * 1000;
const bus = require('../core/lite-bus');
const { logEvent } = require('../core/event-log');
const { t, getLocale } = require('../core/i18n');
const { settleOwnerForward } = require('../core/owner-intervention-forward');
const { getCheckpoint, setCheckpoint } = require('../core/checkpoint-store');
const { OWNER_INTERVENTION_TTL_MS, ownerInterventionExpireTime } = require('../core/owner-intervention-expiry');

const EMAIL_REPLY_CHECKPOINT_NAMESPACE = 'owner_email_replies';
const EMAIL_REPLY_CHECKPOINT_SCOPE = 'primary_owner';

class OwnerInterventionNotifier {
  [key: string]: any;
  constructor({ databaseAPI, registry, db, getEnabledChannel, agentEmailApi, buildOwnerReplyPrompt, sendSystemMessage, resumeOwnerIntervention, autoApproveWhitelistIfFriendRequest }: any) {
    this.databaseAPI = databaseAPI;
    this.registry = registry;
    this.db = db;
    this.getEnabledChannel = getEnabledChannel;
    this.agentEmailApi = agentEmailApi;
    this.buildOwnerReplyPrompt = buildOwnerReplyPrompt || (() => '');
    this.sendSystemMessage = sendSystemMessage || (() => {});
    this.resumeOwnerIntervention = resumeOwnerIntervention || null;
    this.autoApproveWhitelistIfFriendRequest = autoApproveWhitelistIfFriendRequest || null;

    /** 重试队列: { [id]: { record, retryCount, timer } } */
    this._retryQueue = {};
    this._processing = false;
    this._recoveringPending = false;
    this._pollingEmailReplies = false;
    this._stopped = false;
  }

  _runBackground(task?: Promise<unknown>, label?: string) {
    void task?.catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[OwnerInterventionNotifier] ${label || '后台任务'}失败:`, message);
    });
  }

  /**
   * 启动时扫描 is_sent=0 的记录，补充处理（进程崩溃恢复）
   */
  startScan() {
    this._stopped = false;
    console.log('[OwnerInterventionNotifier] 启动恢复扫描...');
    if (this._pendingScanTimer) clearInterval(this._pendingScanTimer);
    // 独立 CLI 进程只负责落库；Lite 常驻进程持续捞取，原子 is_sent 更新负责防重。
    this._pendingScanTimer = setTimeout(() => {
      this._runBackground(this._recoverPending(), '恢复扫描');
      this._pendingScanTimer = setInterval(
        () => this._runBackground(this._recoverPending(), '恢复扫描'),
        PENDING_SCAN_INTERVAL,
      );
    }, STARTUP_SCAN_INTERVAL);
    // 启动邮件回复轮询
    this.startEmailReplyPolling();
  }

  /**
   * 停止所有重试定时器
   */
  stop() {
    this._stopped = true;
    if (this._pendingScanTimer) {
      clearTimeout(this._pendingScanTimer);
      clearInterval(this._pendingScanTimer);
      this._pendingScanTimer = null;
    }
    for (const id of Object.keys(this._retryQueue)) {
      clearTimeout(this._retryQueue[id].timer);
      delete this._retryQueue[id];
    }
    this.stopEmailReplyPolling();
    console.log('[OwnerInterventionNotifier] 已停止');
  }

  // ============ 公开方法 ============

  /**
   * 入队一条干预记录并立即发送。
   * 可在 saveOwnerIntervention 后直接调用。
   */
  enqueue(record?: any): Promise<void> {
    if (!record || !record.id) {
      console.warn('[OwnerInterventionNotifier] enqueue 跳过：无效记录');
      return Promise.resolve();
    }
    console.log('[OwnerInterventionNotifier] 入队通知, id:', record.id, 'visitor:', record.visitorId);
    logEvent('owner_intervention.enqueued', { id: record.id, agentId: record.agentId, visitorId: record.visitorId, messageId: record.parentMessageId, data: { skipReply: record.skipReply, problem: record.problem } });
    return this._processRecord(record);
  }

  // ============ 私有方法 ============

  /**
   * 处理单条记录：标记 is_sent=1 → 发送 → 更新 DB → 通知 UI
   */
  async _processRecord(record?: any) {
    const persisted = this.db.prepare(
      'SELECT status,expire_time FROM owner_interventions WHERE id=? LIMIT 1'
    ).get(record.id);
    const now = Date.now();
    if (persisted && !['pending', 'awaiting'].includes(String(persisted.status))) return;
    const expireTime = persisted?.expire_time ?? record.expireTime
      ?? (record.skipReply ? null : ownerInterventionExpireTime(record.askTime));
    if (expireTime != null && Number(expireTime) <= now) {
      this.db.prepare(`UPDATE owner_interventions
        SET status='expired',resolved_at=?,updated_at=?
        WHERE id=? AND status IN ('pending','awaiting')`).run(now, now, record.id);
      return;
    }
    // 内存传入 skipReply 时立即落库，避免重试/重载后丢失导致轮询与 UI 误判
    if (record.skipReply) {
      try {
        this.db.prepare('UPDATE owner_interventions SET skip_reply = 1 WHERE id = ?').run(record.id);
      } catch (_: any) {}
    }

    const channel = this.getEnabledChannel();
    if (!channel) {
      console.warn('[OwnerInterventionNotifier] 无可用渠道，标记失败, id:', record.id);
      this.db.prepare(`UPDATE owner_interventions SET is_sent=1, status='failed', updated_at=? WHERE id=? AND is_sent IN (0,2)`)
        .run(Date.now(), record.id);
      return;
    }

    const channelType = channel.name;
    const handler = this.registry.getHandler(channelType);
    if (!handler || typeof handler.sendMessageToOwnerWithTracking !== 'function') {
      console.warn('[OwnerInterventionNotifier] 渠道处理器不可用, id:', record.id, 'channelType:', channelType);
      this.db.prepare(`UPDATE owner_interventions SET is_sent=1, status='failed', updated_at=? WHERE id=? AND is_sent IN (0,2)`)
        .run(Date.now(), record.id);
      return;
    }

    try {
      // is_sent=2 表示带租约的处理中状态；成功后才转为 1。
      // 崩溃遗留的 2 会在租约过期后由恢复扫描重新领取。
      const now = Date.now();
      const updateResult = this.db.prepare(
        `UPDATE owner_interventions SET is_sent=2, updated_at=?
         WHERE id=? AND (is_sent=0 OR (is_sent=2 AND updated_at<=?))`
      ).run(now, record.id, now - CLAIM_LEASE_MS);
      if (updateResult.changes === 0) {
        console.log('[OwnerInterventionNotifier] 跳过，已被处理, id:', record.id);
        return;
      }

      // 构造通知消息
      const locale = getLocale();
      const deadlineText = !record.skipReply && expireTime != null
        ? `\n${t('errors.intervention.deadline', {
          deadline: new Date(Number(expireTime)).toLocaleString(locale === 'en' ? 'en-US' : locale === 'ja' ? 'ja-JP' : 'zh-CN'),
        }, locale)}`
        : '';
      const msgBody = `${t('errors.intervention.visitor', {}, locale)}${record.visitorId}
${t('errors.intervention.problem', {}, locale)}${record.problem}
${t('errors.intervention.suggestion', {}, locale)}${record.agentSuggestion || ""}
${t('errors.intervention.time', {}, locale)}${new Date(record.askTime).toLocaleString(locale === 'en' ? 'en-US' : locale === 'ja' ? 'ja-JP' : 'zh-CN')}${deadlineText}`;

      console.log('[OwnerInterventionNotifier] 发送通知, id:', record.id, 'channelType:', channelType);
      logEvent('owner_intervention.send_attempt', { id: record.id, agentId: record.agentId, visitorId: record.visitorId, messageId: record.parentMessageId, data: { attempt: (record.retry_count ?? record.retryCount ?? 0) + 1, channel: channelType } });
      let timeout: NodeJS.Timeout | null = null;
      const result = await Promise.race([
        handler.sendMessageToOwnerWithTracking(
          msgBody,
          record.visitorId,
          record.sessionKey,
          record.agentId
        ),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('OWNER_INTERVENTION_SEND_TIMEOUT')), SEND_TIMEOUT_MS);
        }),
      ]).finally(() => {
        if (timeout) clearTimeout(timeout);
      });

      const sentMessageId = typeof result?.sentMessageId === 'string' && result.sentMessageId
        ? result.sentMessageId
        : typeof result?.messageId === 'string' && result.messageId
          ? result.messageId
          : null;
      if (!sentMessageId) throw new Error('OWNER_INTERVENTION_INVALID_SEND_RESULT');
      console.log('[OwnerInterventionNotifier] 发送成功, id:', record.id, 'sentMessageId:', sentMessageId);
      logEvent('owner_intervention.sent', { id: record.id, agentId: record.agentId, visitorId: record.visitorId, messageId: record.parentMessageId, data: { channel: channelType, messageId: sentMessageId } });

      // 更新 DB
      const persisted = this.databaseAPI.updateOwnerInterventionSent(record.id, sentMessageId, channelType);
      if (persisted?.success === false) {
        throw new Error(persisted.error || 'OWNER_INTERVENTION_SENT_STATE_NOT_PERSISTED');
      }

      // 仅通知、无需邮件回复（审核拦截/支付成功等）→ 发完即 resolved，避免 reply/query 空转
      if (record.skipReply) {
        const resolvedAt = Date.now();
        this.databaseAPI.updateOwnerInterventionStatus(record.id, 'resolved', resolvedAt);
        record.status = 'resolved';
      }

      // 通知 UI
      this._notifyUI(record, sentMessageId, channelType);
    } catch (err: any) {
      console.error('[OwnerInterventionNotifier] 发送失败, id:', record.id, err.message);
      logEvent('owner_intervention.send_failed', { level: 'error', id: record.id, agentId: record.agentId, visitorId: record.visitorId, messageId: record.parentMessageId, data: { attempt: (record.retry_count ?? record.retryCount ?? 0) + 1, reason: err.message } });

      // 会话过期 / 邮件未配置 不重试
      if (err.message?.startsWith('SESSION_EXPIRED') || err.message?.includes('AgentEmailApi 未配置')) {
        this.db.prepare(
          `UPDATE owner_interventions SET is_sent=1, status='failed', updated_at=? WHERE id=?`
        ).run(Date.now(), record.id);
        console.log('[OwnerInterventionNotifier] 会话过期，标记失败, id:', record.id);
        return;
      }

      // 回滚 is_sent=0，加入重试队列
      try {
        this.db.prepare(
          `UPDATE owner_interventions SET is_sent=0, updated_at=? WHERE id=? AND is_sent=2`
        ).run(Date.now(), record.id);
      } catch (e2: any) {
        console.error('[OwnerInterventionNotifier] 回滚失败:', e2.message);
      }
      this._scheduleRetry(record, record.retry_count ?? record.retryCount ?? 0);
    }
  }

  /**
   * 调度重试
   */
  _scheduleRetry(record?: any, currentRetryCount?: any) {
    if (this._stopped) return;
    const nextRetry = currentRetryCount + 1;
    if (nextRetry > MAX_RETRIES) {
      console.log('[OwnerInterventionNotifier] 超过最大重试次数，放弃, id:', record.id);
      logEvent('owner_intervention.send_failed', { level: 'error', id: record.id, messageId: record.parentMessageId, data: { reason: `超过最大重试次数 (${MAX_RETRIES})` } });
      this.db.prepare(
        `UPDATE owner_interventions SET is_sent=1, status='failed', updated_at=? WHERE id=?`
      ).run(Date.now(), record.id);
      return;
    }

    const delay = Math.min(BASE_BACKOFF_MS * Math.pow(2, nextRetry - 1), MAX_RETRY_DELAY);
    console.log(`[OwnerInterventionNotifier] 计划重试, id: ${record.id}, 第${nextRetry}次, ${delay}ms后`);

    // 持久化 retry_count：进程重启后恢复扫描会读取该计数，避免每次重启都重置导致无限重试、记录永久 pending
    try {
      this.db.prepare('UPDATE owner_interventions SET retry_count = ?, last_retry_at = ?, updated_at = ? WHERE id = ?')
        .run(nextRetry, Date.now(), Date.now(), record.id);
    } catch (e: any) {
      console.warn('[OwnerInterventionNotifier] 持久化 retry_count 失败:', e.message);
    }

    if (this._retryQueue[record.id]) {
      clearTimeout(this._retryQueue[record.id].timer);
    }

    this._retryQueue[record.id] = {
      record: { ...record, retry_count: nextRetry },
      timer: setTimeout(() => {
        const savedMsgId = this._retryQueue[record.id]?.record?.parentMessageId;
        delete this._retryQueue[record.id];
        // 重新从 DB 读取最新状态
        const fresh = this.db.prepare('SELECT * FROM owner_interventions WHERE id = ?').get(record.id);
        if (!fresh || fresh.is_sent === 1) {
          console.log('[OwnerInterventionNotifier] 重试跳过，记录已被处理或不存在, id:', record.id);
          return;
        }
        this._runBackground(this._processRecord({
          id: fresh.id,
          visitorId: fresh.visitor_id,
          agentId: fresh.agent_id,
          sessionKey: fresh.session_key,
          problem: fresh.problem,
          agentSuggestion: fresh.agent_suggestion,
          askTime: fresh.ask_time,
          skipReply: fresh.skip_reply,
          retry_count: nextRetry,
          parentMessageId: savedMsgId,
          sourceSenderUid: fresh.source_sender_uid || fresh.visitor_id,
          targetChannelId: fresh.target_channel_id || fresh.visitor_id,
          targetChannelType: fresh.target_channel_type || 1,
          sourceMessageId: fresh.source_message_id || null,
        }), '重试发送');
      }, delay),
    };
  }

  /**
   * 通知 UI（通过 lite-bus 事件）
   */
  _notifyUI(record?: any, sentMessageId?: any, channelType?: any) {
    bus.emit('owner-intervention:updated', {
      id: record.id,
      visitorId: record.visitorId,
      agentId: record.agentId || 'voko',
      sessionKey: record.sessionKey,
      problem: record.problem,
      agentSuggestion: record.agentSuggestion,
      sentMessageId,
      channelType,
      skipReply: record.skipReply || 0,
      status: record.status || (record.skipReply ? 'resolved' : 'pending'),
      askTime: record.askTime,
      sourceSenderUid: record.sourceSenderUid || record.visitorId,
      targetChannelId: record.targetChannelId || record.visitorId,
      targetChannelType: record.targetChannelType || 1,
      sourceMessageId: record.sourceMessageId || null,
    });
  }

  /**
   * 启动恢复：扫描所有 is_sent=0 的记录重新入队
   */
  async _recoverPending() {
    if (this._recoveringPending) return;
    this._recoveringPending = true;
    try {
      const pending = this.databaseAPI.getPendingOwnerInterventions();
      if (!pending || pending.length === 0) {
        return;
      }
      console.log(`[OwnerInterventionNotifier] 恢复扫描发现 ${pending.length} 条待发送记录`);
      for (const item of pending) {
        await this._processRecord(item);
      }
    } catch (err: any) {
      console.error('[OwnerInterventionNotifier] 恢复扫描失败:', err.message);
    } finally {
      this._recoveringPending = false;
    }
  }

  // ============ 邮件回复轮询（每 5 秒） ============

  startEmailReplyPolling() {
    this.stopEmailReplyPolling();
    // 旧版本创建的待回复记录没有截止时间，按原请求时间补齐 24 小时期限。
    try {
      this.db.prepare(`UPDATE owner_interventions
        SET expire_time=ask_time+?,updated_at=?
        WHERE status IN ('pending','awaiting')
        AND COALESCE(skip_reply,0)=0
        AND expire_time IS NULL`).run(OWNER_INTERVENTION_TTL_MS, Date.now());
    } catch (_: any) {}
    // 清理历史脏数据：仅通知类（skip_reply / 支付成功）且已发邮件的不应再轮询
    try {
      const now = Date.now();
      this.db.prepare(
        `UPDATE owner_interventions SET skip_reply=1, status='resolved', resolved_at=?, updated_at=?
         WHERE email_message_id IS NOT NULL
         AND status IN ('pending','awaiting')
         AND (
           COALESCE(skip_reply,0)=1
           OR id LIKE 'pay_%'
           OR problem LIKE '%支付成功通知%'
         )`
      ).run(now, now);
    } catch (_: any) {}
    this._emailReplyPollTimer = setInterval(() => this._pollEmailReplies(), 5000);
    console.log('[OwnerInterventionNotifier] 邮件回复轮询已启动');
  }

  stopEmailReplyPolling() {
    if (this._emailReplyPollTimer) {
      clearInterval(this._emailReplyPollTimer);
      this._emailReplyPollTimer = null;
    }
  }

  async _pollEmailReplies() {
    if (!this.agentEmailApi || this._pollingEmailReplies) return;
    this._pollingEmailReplies = true;
    try {
      const now = Date.now();
      this.db.prepare(
        `UPDATE owner_interventions
         SET status='expired', resolved_at=?, updated_at=?
         WHERE status IN ('pending','awaiting')
         AND COALESCE(skip_reply, 0) = 0
         AND expire_time IS NOT NULL
         AND expire_time <= ?`
      ).run(now, now, now);

      const storedReplies = this.db.prepare(
        `SELECT oi.id, oi.email_message_id, oi.agent_id, oi.visitor_id, oi.session_key, oi.problem,
                oi.source_sender_uid, oi.target_channel_id, oi.target_channel_type, oi.source_message_id,
                oi.routing_conversation_id, oi.route_security_mode, oi.e2ee_protocol_conversation_id,
                oi.e2ee_session_scope_id, oi.status, oi.owner_reply, oi.reply_time,
                COALESCE(oi.agent_notified, 0) AS agent_notified
         FROM owner_interventions oi
         WHERE oi.email_message_id IS NOT NULL
         AND COALESCE(oi.skip_reply, 0) = 0
         AND oi.status='replied'
         AND COALESCE(oi.agent_notified, 0)=0
         AND oi.owner_reply IS NOT NULL`
      ).all();
      for (const row of storedReplies) {
        await this._forwardEmailReply(row, row.owner_reply, false);
      }

      const checkpoint = getCheckpoint(
        this.db, EMAIL_REPLY_CHECKPOINT_NAMESPACE, EMAIL_REPLY_CHECKPOINT_SCOPE
      );
      const cursor = checkpoint?.committedValue || '0';
      const page = await this.agentEmailApi.pollReplies({ cursor, limit: 100 });
      if (!page) {
        await this._queryPendingEmailReplies();
        return;
      }
      let processedCursor = cursor;
      for (const event of page.events) {
        const processed = this._storeEmailReplyEvent(event, processedCursor);
        processedCursor = event.event_id;
        if (processed) {
          await this._forwardEmailReply(processed.row, processed.replyText, processed.contentChanged);
        }
      }
    } catch (e: any) {
      console.warn('[OwnerInterventionNotifier] 邮件回复轮询错误:', e.message);
    } finally {
      this._pollingEmailReplies = false;
    }
  }

  async _queryPendingEmailReplies() {
    if (typeof this.agentEmailApi.queryReply !== 'function') return;
    const rows = this.db.prepare(
      `SELECT oi.id, oi.email_message_id, oi.agent_id, oi.visitor_id, oi.session_key, oi.problem,
              oi.source_sender_uid, oi.target_channel_id, oi.target_channel_type, oi.source_message_id,
               oi.routing_conversation_id, oi.route_security_mode, oi.e2ee_protocol_conversation_id,
               oi.e2ee_session_scope_id, oi.status, oi.owner_reply, oi.reply_time,
              COALESCE(oi.agent_notified, 0) AS agent_notified
       FROM owner_interventions oi
       WHERE oi.email_message_id IS NOT NULL
       AND COALESCE(oi.skip_reply, 0) = 0
       AND oi.status IN ('pending','awaiting')
       AND (oi.expire_time IS NULL OR oi.expire_time > ?)
       ORDER BY oi.ask_time ASC
       LIMIT 20`
    ).all(Date.now());
    for (const row of rows) {
      const reply = await this.agentEmailApi.queryReply({ message_id: row.email_message_id });
      const replyText = String(reply?.raw_text || '').trim();
      if (!reply?.has_reply || !replyText) continue;
      const stored = this._storeQueriedEmailReply(row.id, replyText, reply.replied_at);
      if (stored) await this._forwardEmailReply(stored, replyText, true);
    }
  }

  _storeQueriedEmailReply(id: string, replyText: string, repliedAt?: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(
        `SELECT oi.id, oi.email_message_id, oi.agent_id, oi.visitor_id, oi.session_key, oi.problem,
                oi.source_sender_uid, oi.target_channel_id, oi.target_channel_type, oi.source_message_id,
                 oi.routing_conversation_id, oi.route_security_mode, oi.e2ee_protocol_conversation_id,
                 oi.e2ee_session_scope_id, oi.status, oi.owner_reply, oi.reply_time,
                COALESCE(oi.agent_notified, 0) AS agent_notified
         FROM owner_interventions oi WHERE oi.id=? LIMIT 1`
      ).get(id);
      if (!row || !['pending', 'awaiting'].includes(String(row.status))) {
        this.db.exec('COMMIT');
        return null;
      }
      const replyTime = Date.parse(repliedAt || '') || Date.now();
      this.db.prepare(`UPDATE owner_interventions
        SET owner_reply=?,reply_time=?,status='replied',updated_at=?,agent_notified=0,channel_type='voko-email'
        WHERE id=? AND status IN ('pending','awaiting')`)
        .run(replyText, replyTime, Date.now(), id);
      this.db.exec('COMMIT');
      return { ...row, status: 'replied', owner_reply: replyText,
        reply_time: replyTime, agent_notified: 0 };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch (_) {}
      throw error;
    }
  }

  _storeEmailReplyEvent(event?: any, currentCursor: string = '0') {
    const eventId = String(event?.event_id || '');
    if (!/^(0|[1-9]\d*)$/.test(eventId) || BigInt(eventId) <= BigInt(currentCursor)) {
      throw new Error(`Invalid email reply event cursor: ${eventId}`);
    }
    const replyText = String(event?.raw_text || '').trim();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(
        `SELECT oi.id, oi.email_message_id, oi.agent_id, oi.visitor_id, oi.session_key, oi.problem,
                oi.source_sender_uid, oi.target_channel_id, oi.target_channel_type, oi.source_message_id,
                 oi.routing_conversation_id, oi.route_security_mode, oi.e2ee_protocol_conversation_id,
                 oi.e2ee_session_scope_id, oi.status, oi.owner_reply, oi.reply_time,
                COALESCE(oi.agent_notified, 0) AS agent_notified
         FROM owner_interventions oi WHERE oi.email_message_id=? LIMIT 1`
      ).get(event.message_id);
      let contentChanged = false;
      let storedRow = row;
      const terminalLateReply = row && replyText
        && ['expired', 'resolved', 'cancelled'].includes(String(row.status));
      if (row && replyText && ['pending', 'awaiting', 'replied'].includes(String(row.status))) {
        contentChanged = row.status !== 'replied';
        if (contentChanged) {
          const replyTime = Date.parse(event.replied_at) || Date.now();
          this.db.prepare(`UPDATE owner_interventions
            SET owner_reply=?,reply_time=?,status='replied',updated_at=?,agent_notified=0,channel_type='voko-email'
            WHERE id=? AND status IN ('pending','awaiting','replied')`)
            .run(replyText, replyTime, Date.now(), row.id);
          storedRow = { ...row, status: 'replied', owner_reply: replyText,
            reply_time: replyTime, agent_notified: 0 };
        }
      }
      setCheckpoint(this.db, EMAIL_REPLY_CHECKPOINT_NAMESPACE, EMAIL_REPLY_CHECKPOINT_SCOPE, 'sequence', eventId);
      this.db.exec('COMMIT');
      if (!row) {
        logEvent('owner_intervention.email_reply_unmatched', {
          level: 'warn', id: eventId, data: { messageId: event.message_id },
        });
        return null;
      }
      if (terminalLateReply) {
        logEvent('owner_intervention.email_reply_after_terminal', {
          level: 'warn', id: row.id, data: { messageId: event.message_id, eventId,
            terminalStatus: storedRow.status, action: 'discarded' },
        });
        return null;
      }
      const storedReplyText = String(storedRow?.owner_reply || '').trim();
      if (!storedReplyText || storedRow.status !== 'replied' || Number(storedRow.agent_notified) === 1) return null;
      return { row: storedRow, replyText: storedReplyText, contentChanged };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch (_) {}
      throw error;
    }
  }

  async _forwardEmailReply(row?: any, replyText?: string, contentChanged: boolean = false) {
    if (!row?.session_key || !row?.agent_id || !replyText || Number(row.agent_notified) === 1) return;
    if (contentChanged && this.autoApproveWhitelistIfFriendRequest) {
      this.autoApproveWhitelistIfFriendRequest({
        id: row.id, visitorId: row.visitor_id, agentId: row.agent_id,
        sessionKey: row.session_key, problem: row.problem,
      }, replyText);
    }
    const forwardMsg = this.buildOwnerReplyPrompt(
      { id: row.id, visitorId: row.visitor_id, problem: row.problem, agentId: row.agent_id }, replyText
    );
    let forwardOutcome: string | null = null;
    let requestedStatus: string | null = null;
    const settle = (result: unknown) => {
      requestedStatus = String((result as any)?.interventionStatus || '') || null;
      forwardOutcome = settleOwnerForward(this.databaseAPI, row.id, result);
      return forwardOutcome;
    };
    const intervention = {
      id: row.id, visitorId: row.visitor_id, agentId: row.agent_id,
      sessionKey: row.session_key, problem: row.problem,
      sourceSenderUid: row.source_sender_uid || row.visitor_id,
      targetChannelId: row.target_channel_id || row.visitor_id,
      targetChannelType: row.target_channel_type || 1,
      sourceMessageId: row.source_message_id || null,
      routingConversationId: row.routing_conversation_id || null,
      routeSecurityMode: row.route_security_mode || 'standard',
      e2eeProtocolConversationId: row.e2ee_protocol_conversation_id || null,
      e2eeSessionScopeId: row.e2ee_session_scope_id || null,
    };
    if (this.resumeOwnerIntervention) {
      try {
        settle(await this.resumeOwnerIntervention(intervention, forwardMsg));
      } catch (err: any) {
        settle(err);
        console.error('[OwnerInterventionNotifier] resume owner intervention failed:', err.message);
      }
    } else {
      settle({ success: false, deliveryOutcome: 'not_delivered', error: 'exact resume handler unavailable' });
    }
    const forwardStatus = requestedStatus || (forwardOutcome === 'delivered'
      ? 'resolved' : (forwardOutcome === 'outcome_unknown' || forwardOutcome === 'rejected' ? 'unknown' : 'replied'));
    bus.emit('owner-intervention:email-reply', {
      id: row.id, ownerReply: replyText, replyTime: row.reply_time, status: forwardStatus,
    });
    if (forwardOutcome === 'delivered') {
      console.log(row.route_security_mode === 'e2ee_v2'
        ? '[OwnerInterventionNotifier] 主人回复已入库，Agent 答复已通过 E2EE 送达访客, id:'
        : '[OwnerInterventionNotifier] 主人回复已入库并已交给 Agent, id:', row.id);
    } else if (requestedStatus === 'delivering') {
      console.log('[OwnerInterventionNotifier] 主人回复已入库，Agent 答复已进入 E2EE 可靠投递队列, id:', row.id);
    } else if (forwardOutcome === 'outcome_unknown' || forwardOutcome === 'rejected') {
      console.warn('[OwnerInterventionNotifier] 主人回复已入库，自动转发结果未知，保留 Pull, id:', row.id);
    } else {
      console.log('[OwnerInterventionNotifier] 主人回复已入库，通道确认未投递，等待重试, id:', row.id);
    }
  }
}

module.exports = { OwnerInterventionNotifier };
