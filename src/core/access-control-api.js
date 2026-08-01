/**
 * 访问控制（黑白名单）API 模块
 *
 * 纯函数，无 Electron / IPC 依赖。
 * 所有函数第一个参数为 db（better-sqlite3 实例），依赖显式传入。
 */

/**
 * 查询黑白名单列表
 */
function getList(db, { agentId, listType, limit, offset, keyword }) {
  try {
    let where = 'WHERE a.agent_id = ? AND a.list_type = ?';
    const params = [agentId, listType];
    if (keyword) {
      where += ' AND (a.visitor_id LIKE ? OR COALESCE(u.nickname, \'\') LIKE ? OR COALESCE(a.reason, \'\') LIKE ?)';
      const pattern = '%' + keyword + '%';
      params.push(pattern, pattern, pattern);
    }
    const from = 'FROM agent_access_lists a LEFT JOIN user_cache u ON u.uid = a.visitor_id';
    const countRow = db.prepare(`SELECT COUNT(*) as cnt ${from} ${where}`).get(...params);
    const total = countRow?.cnt || 0;
    let sql = `SELECT a.id, a.visitor_id, a.reason, a.created_at ${from} ${where} ORDER BY a.created_at DESC`;
    if (limit) { sql += ' LIMIT ?'; params.push(limit); }
    if (offset) { sql += ' OFFSET ?'; params.push(offset); }
    const rows = db.prepare(sql).all(...params);
    return { success: true, data: rows, total };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * 添加黑白名单条目
 * 如果 listType='whitelist' 且传了 onWhitelistAdded，添加成功后自动回调通知
 *
 * @param {Function} [onWhitelistAdded] - (agentId, visitorId) => void
 */
function addEntry(db, { agentId, listType, visitorId, reason }, { onWhitelistAdded } = {}) {
  try {
    const id = `acl-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    const now = Date.now();
    db.prepare(
      `INSERT INTO agent_access_lists
         (id, agent_id, list_type, visitor_id, reason, manual_managed, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(agent_id, list_type, visitor_id) DO UPDATE SET
         manual_managed = 1,
         reason = COALESCE(excluded.reason, agent_access_lists.reason),
         updated_at = excluded.updated_at`
    ).run(id, agentId, listType, visitorId, reason || null, now, now);
    // 白名单添加成功后自动通知访客
    if (listType === 'whitelist' && onWhitelistAdded) {
      try { onWhitelistAdded(agentId, visitorId); } catch (_) {}
    }
    return { success: true, id };
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) {
      return { success: false, error: '该访客已在此名单中' };
    }
    return { success: false, error: e.message };
  }
}

/**
 * 删除黑白名单条目（按条件）
 */
function removeEntryByVisitor(db, agentId, visitorId, listType) {
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`UPDATE agent_access_lists
        SET manual_managed=0, updated_at=?
        WHERE agent_id=? AND visitor_id=? AND list_type=? AND server_managed=1`)
        .run(Date.now(), agentId, visitorId, listType);
      db.prepare(`DELETE FROM agent_access_lists
        WHERE agent_id=? AND visitor_id=? AND list_type=? AND server_managed=0`)
        .run(agentId, visitorId, listType);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      throw error;
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * 删除黑白名单条目
 */
function removeEntry(db, id) {
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`UPDATE agent_access_lists SET manual_managed=0, updated_at=?
        WHERE id=? AND server_managed=1`).run(Date.now(), id);
      db.prepare(`DELETE FROM agent_access_lists WHERE id=? AND server_managed=0`).run(id);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      throw error;
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * 检查访客是否在黑名单中
 */
function isBlacklisted(db, agentId, visitorId) {
  return !!db.prepare(
    `SELECT 1 FROM agent_access_lists WHERE agent_id = ? AND list_type = 'blacklist' AND visitor_id = ?`
  ).get(agentId, visitorId);
}

/**
 * 检查访客是否在白名单中
 */
function isWhitelisted(db, agentId, visitorId) {
  return !!db.prepare(
    `SELECT 1 FROM agent_access_lists WHERE agent_id = ? AND list_type = 'whitelist' AND visitor_id = ?`
  ).get(agentId, visitorId);
}

/**
 * 检查主人回复是否是同意好友申请，是则自动加入白名单并通知访客
 * 干预记录 id 以 private_req_ 开头表示好友申请类型
 *
 * @param {Object} db - better-sqlite3 实例
 * @param {Function} sendSystemMessage - (agentId, visitorId, content, timestamp) => void
 * @param {Object} intervention - 干预记录
 * @param {string} ownerReply - 主人回复内容
 * @returns {boolean} 是否已处理
 */
function autoApproveIfFriendRequest(db, sendSystemMessage, intervention, ownerReply) {
  if (!intervention || !intervention.id || !intervention.id.startsWith('private_req_')) return false;
  if (!ownerReply || typeof ownerReply !== 'string') return false;
  const trimmed = ownerReply.trim();
  const isApproved = /同意|通过|好的|ok/i.test(trimmed);
  if (!isApproved) return false;

  const { agentId, visitorId } = intervention;
  if (!agentId || !visitorId) return false;

  // 检查是否已在白名单中
  if (isWhitelisted(db, agentId, visitorId)) {
    console.log(`[好友申请] 访客 ${visitorId} 已在白名单中，跳过`);
    return true;
  }

  const result = addEntry(db, { agentId, listType: 'whitelist', visitorId, reason: '好友申请已通过' }, {
    onWhitelistAdded: (aid, vid) => {
      sendSystemMessage(aid, vid, 'friend_request_approved', {}, Math.floor(Date.now() / 1000));
    }
  });
  if (result.success) {
    console.log(`[好友申请] 访客 ${visitorId} 已自动加入 Agent ${agentId} 的白名单`);
  } else {
    console.error('[好友申请] 自动加入白名单失败:', result.error);
  }
  return true;
}

/**
 * 通知服务端 Agent 状态变更（HTTP POST）
 */
function postAgentStatus(apiBase, agentId, data) {
  fetch(`${apiBase}/api/agent-status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId, ...data })
  }).catch(err => console.warn('[AgentStatus] 通知服务端失败:', err.message));
}

module.exports = {
  getList,
  addEntry,
  removeEntry,
  removeEntryByVisitor,
  isBlacklisted,
  isWhitelisted,
  autoApproveIfFriendRequest,
  postAgentStatus,
};
