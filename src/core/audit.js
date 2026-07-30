/**
 * audit.js — 消息审核规则引擎
 *
 * 从数据库加载 audit_rules，对消息进行正则/子串匹配，
 * 按优先级（hard_deny > soft_deny > allow）返回审核结果。
 * 纯 Node.js，无 Electron 依赖。
 *
 * @module
 */

/**
 * 检查消息是否命中审核规则
 *
 * @param {string} message - 消息内容
 * @param {string} direction - 'inbound' 或 'outbound'
 * @param {object} db - better-sqlite3 实例
 * @returns {{ action: string|null, matchedRule: object|null, matchedKeyword: string|null }}
 */
function checkAuditRules(message, direction, db) {
  if (!message || typeof message !== 'string' || !message.trim()) return { action: null, matchedRule: null, matchedKeyword: null };

  const rules = db.prepare(`SELECT * FROM audit_rules WHERE direction = ?`).all(direction);
  if (!rules.length) return { action: null, matchedRule: null, matchedKeyword: null };

  // 优先级：hard_deny > soft_deny > allow
  const priority = { hard_deny: 3, soft_deny: 2, allow: 1 };
  let bestAction = null;
  let bestRule = null;

  for (const rule of rules) {
    let matched = false;
    // 约定：keyword 以 / 开头和结尾的视为正则表达式
    if (rule.keyword.startsWith('/') && rule.keyword.endsWith('/') && rule.keyword.length > 2) {
      try {
        const pattern = rule.keyword.slice(1, -1);
        const re = new RegExp(pattern);
        matched = re.test(message);
      } catch (e) {
        matched = message.includes(rule.keyword);
      }
    } else {
      matched = message.includes(rule.keyword);
    }

    if (matched) {
      const p = priority[rule.action] || 0;
      const bestP = priority[bestAction] || 0;
      if (p > bestP) {
        bestAction = rule.action;
        bestRule = rule;
      }
    }
  }

  return {
    action: bestAction,
    matchedRule: bestRule,
    matchedKeyword: bestRule ? bestRule.keyword : null
  };
}

/**
 * 替换提示语中的变量
 *
 * @param {string} prompt - 含变量的提示语
 * @param {object} vars - { keyword, visitorId, agentId }
 * @param {object} db - better-sqlite3 实例
 * @returns {string}
 */
function substitutePromptVariables(prompt, vars, db) {
  if (!prompt) return prompt;
  let result = prompt;

  let ownerEmail = '';
  if (vars.agentId) {
    const row = db.prepare(`SELECT owner_email FROM agents WHERE agent_id = ?`).get(vars.agentId);
    if (row?.owner_email) ownerEmail = row.owner_email;
  }

  result = result.replace(/\{keyword\}/g, vars.keyword || '');
  result = result.replace(/\{visitor_id\}/g, vars.visitorId || '');
  result = result.replace(/\{owner_Email\}/g, ownerEmail);
  result = result.replace(/\{agent_name\}/g, vars.agentId || '');

  return result;
}

/**
 * 手动发送审核介入 — 创建出站审核的干预记录并通知主人
 *
 * @param {object} data - { agentId, channelId, content }
 * @param {object} auditResult - { action, matchedKeyword }
 * @param {object} db - better-sqlite3 实例
 * @param {object} databaseAPI - 数据库 API
 * @param {Function} [enqueueIntervention] - (record) => {} 可选，入队主人通知
 */
function triggerManualSendAuditIntervention(data, auditResult, db, databaseAPI, enqueueIntervention) {
  try {
    const now = Date.now();
    const backendRow = db.prepare(`SELECT backend_type FROM agents WHERE agent_id = ?`).get(data.agentId);
    const prefix = backendRow?.backend_type === 'hermes' ? 'hermes' : 'agent';
    const oiId = `audit_send_${now}_${Math.random().toString(36).substr(2, 6)}`;
    const isHardDeny = auditResult.action === 'hard_deny';
    const problem = isHardDeny
      ? `手动发送被拦截: "${data.content}"\n命中敏感词: "${auditResult.matchedKeyword}"\n系统已拦截，未发送给访客。`
      : `手动发送命中软规则: "${data.content}"\n命中敏感词: "${auditResult.matchedKeyword}"\n已放行发送，请关注。`;

    databaseAPI.saveOwnerIntervention({
      id: oiId, visitorId: data.channelId,
      sessionKey: `${prefix}:${data.agentId}:${data.channelId}`,
      problem,
      agentSuggestion: '出站关键词拦截提醒，无需回复',
      askTime: now, expireTime: null, status: 'pending',
      ownerReply: null, replyTime: null, parentMessageId: null,
      channelType: 'voko', resolvedAt: null, createdAt: now, updatedAt: now,
      agentId: data.agentId
    });
    db.prepare('UPDATE owner_interventions SET skip_reply = 1 WHERE id = ?').run(oiId);
    if (enqueueIntervention) {
      enqueueIntervention({
        id: oiId, visitorId: data.channelId, agentId: data.agentId,
        sessionKey: `${prefix}:${data.agentId}:${data.channelId}`,
        problem,
        agentSuggestion: '出站关键词拦截提醒，无需回复',
        askTime: now, skipReply: 1,
      });
    }
  } catch (e) {
    console.error('[审核-出站] 触发人工介入失败:', e.message);
  }
}

module.exports = { checkAuditRules, substitutePromptVariables, triggerManualSendAuditIntervention };
