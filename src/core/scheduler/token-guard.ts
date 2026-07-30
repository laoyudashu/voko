/**
 * token-guard.js — 轻量会话级成本护栏
 *
 * 防单访客/单 agent 失控：单会话 token 上限、单 agent 速率限制。
 * 超限触发回调（创建恢复动作升级 owner），不自行阻断。
 *
 * 用法：
 *   const guard = createTokenGuard({ onLimit: (info) => ra.create({...}) });
 *   guard.record(agentId, visitorId, { inputTokens: 100, outputTokens: 50 });
 *   const check = guard.check(agentId, visitorId);
 */

interface Usage {
  inputTokens?: number;
  outputTokens?: number;
}

interface LimitInfo {
  type: 'session_token_limit' | 'agent_rate_limit';
  agentId: string;
  visitorId?: string;
  total?: number;
  count?: number;
  limit: number;
  reason: string;
}

interface SessionUsage {
  total: number;
  limitWarned: boolean;
  lastUpdated: number;
}

function createTokenGuard(opts: { onLimit?: (info: LimitInfo) => void } = {}) {
  // 滑动窗口配置
  const WINDOW_MS = 60000;     // 1 分钟窗口
  const MAX_TOKENS_PER_SESSION = 100000;   // 单会话总 token 上限
  const MAX_MSGS_PER_AGENT = 10;           // 每分钟最多消息数

  // 状态存储
  const _sessionTokens = new Map<string, SessionUsage>();
  const _agentMsgCount = new Map<string, number[]>();

  // 定期清理过期 session（30 分钟无活动的 session 释放）
  const SESSION_TTL_MS = 30 * 60 * 1000;
  let _lastCleanup = Date.now();

  /** 记录一次 token 消耗 */
  function record(agentId: string, visitorId: string, usage: Usage = {}) {
    const now = Date.now();
    const key = `${agentId}:${visitorId}`;
    const input = usage.inputTokens || 0;
    const output = usage.outputTokens || 0;

    // 会话级累积
    if (!_sessionTokens.has(key)) {
      _sessionTokens.set(key, { total: 0, limitWarned: false, lastUpdated: now });
    }
    const session = _sessionTokens.get(key)!;
    session.total += input + output;
    session.lastUpdated = now;

    // agent 速率计数
    if (!_agentMsgCount.has(agentId)) {
      _agentMsgCount.set(agentId, []);
    }
    _agentMsgCount.get(agentId)!.push(now);

    // 清理过期窗口
    _cleanWindow(agentId, now);
    _cleanSessions(now);

    return { sessionTotal: session.total, agentMsgCount: _agentMsgCount.get(agentId)!.length };
  }

  /**
   * 检查是否超限。
   * @returns {{ limited: boolean, reason: string|null }}
   */
  function check(agentId: string, visitorId: string) {
    const now = Date.now();
    const key = `${agentId}:${visitorId}`;

    // 会话 token 上限
    const session = _sessionTokens.get(key);
    if (session && session.total >= MAX_TOKENS_PER_SESSION && !session.limitWarned) {
      session.limitWarned = true;
      if (opts.onLimit) opts.onLimit({
        type: 'session_token_limit',
        agentId, visitorId,
        total: session.total,
        limit: MAX_TOKENS_PER_SESSION,
        reason: `会话 token 超限 (${session.total}/${MAX_TOKENS_PER_SESSION})`,
      });
      return { limited: true, reason: 'session_token_limit' };
    }

    // agent 速率限制
    _cleanWindow(agentId, now);
    const msgs = _agentMsgCount.get(agentId) || [];
    if (msgs.length > MAX_MSGS_PER_AGENT) {
      if (opts.onLimit) opts.onLimit({
        type: 'agent_rate_limit',
        agentId,
        count: msgs.length,
        limit: MAX_MSGS_PER_AGENT,
        reason: `agent 消息速率超限 (${msgs.length}/${MAX_MSGS_PER_AGENT}/min)`,
      });
      return { limited: true, reason: 'agent_rate_limit' };
    }

    return { limited: false, reason: null };
  }

  /** 重置（agent 重启时） */
  function reset(agentId: string, visitorId?: string): void {
    if (visitorId) {
      _sessionTokens.delete(`${agentId}:${visitorId}`);
    } else {
      _agentMsgCount.delete(agentId);
    }
  }

  function _cleanWindow(agentId: string, now: number): void {
    const msgs = _agentMsgCount.get(agentId);
    if (!msgs) return;
    const cutoff = now - WINDOW_MS;
    _agentMsgCount.set(agentId, msgs.filter(t => t > cutoff));
  }

  /** 清理长时间无活动的 session 记录（防内存泄漏） */
  function _cleanSessions(now: number): void {
    if (now - _lastCleanup < 60000) return; // 每分钟清理一次
    _lastCleanup = now;
    for (const [key, session] of _sessionTokens) {
      if (now - session.lastUpdated > SESSION_TTL_MS) {
        _sessionTokens.delete(key);
      }
    }
  }

  return { record, check, reset };
}

module.exports = { createTokenGuard };
