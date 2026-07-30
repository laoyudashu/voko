/**
 * watchdog.js — 分层 watchdog
 *
 * 补强 worker-manager 的进程级检测，提供会话级和 agent 静默级监控。
 *
 * 分层：
 *   1. 会话级 — 访客最后一条消息后超时无响应 → 触发恢复动作
 *   2. agent 静默级 — 进程活着但超时无输出 → 判定卡死 → 中断 + 恢复
 *   3. 上下文恢复 — 活性路径丢失 → 恢复到明确等待状态
 *
 * 用法：
 *   const wd = createWatchdog({ db, onSessionTimeout, onAgentSilence });
 *   wd.start(); // 每 30s 扫描一次
 *   wd.feed(agentId, visitorId); // 有活动时喂狗
 */

interface TimeoutInfo {
  agentId: string;
  visitorId: string;
  elapsed: number;
  timeout: number;
}

interface SilenceInfo {
  agentId: string;
  elapsed: number;
  timeout: number;
}

interface WatchdogOptions {
  db?: unknown;
  onSessionTimeout?: (info: TimeoutInfo) => void;
  onAgentSilence?: (info: SilenceInfo) => void;
}

function createWatchdog({ onSessionTimeout, onAgentSilence }: WatchdogOptions = {}) {
  let _timer: NodeJS.Timeout | null = null;
  let _interval = 30000; // 扫描间隔 ms
  const _lastActivity = new Map<string, number>();
  const _lastOutput = new Map<string, number>();

  /** 记录活动（访客发消息 / agent 回复） */
  function feed(agentId: string, visitorId: string): void {
    const now = Date.now();
    _lastActivity.set(`${agentId}:${visitorId}`, now);
  }

  /** 记录 agent 有输出 */
  function feedOutput(agentId: string): void {
    _lastOutput.set(agentId, Date.now());
  }

  /** 移除一个 session 的监控（不影响同 agent 的其他 session） */
  function removeSession(agentId: string, visitorId: string): void {
    _lastActivity.delete(`${agentId}:${visitorId}`);
  }

  /** 移除整个 agent 的所有监控 */
  function removeAgent(agentId: string): void {
    for (const key of _lastActivity.keys()) {
      if (key.startsWith(`${agentId}:`)) _lastActivity.delete(key);
    }
    _lastOutput.delete(agentId);
  }

  /** 开始定时扫描 */
  function start(intervalMs?: number): void {
    if (_timer) return;
    if (intervalMs) _interval = intervalMs;
    _timer = setInterval(_scan, _interval);
    _timer.unref();
  }

  /** 停止扫描 */
  function stop(): void {
    if (_timer) { clearInterval(_timer); _timer = null; }
  }

  /** 单次扫描 — 超时后移除记录防止重复触发 */
  function _scan() {
    const now = Date.now();
    const sessionTimeout = 300000;  // 5 分钟访客无响应
    const silenceTimeout = 120000; // 2 分钟 agent 无输出
    const expiredSessions: string[] = [];
    const expiredAgents: string[] = [];

    // 会话级检查
    for (const [key, lastActive] of _lastActivity) {
      const elapsed = now - lastActive;
      if (elapsed > sessionTimeout) {
        const [agentId, ...rest] = key.split(':');
        const visitorId = rest.join(':');
        expiredSessions.push(key);
        if (typeof onSessionTimeout === 'function') {
          onSessionTimeout({ agentId, visitorId, elapsed, timeout: sessionTimeout });
        }
      }
    }

    // agent 静默级检查
    for (const [agentId, lastOut] of _lastOutput) {
      const elapsed = now - lastOut;
      if (elapsed > silenceTimeout) {
        expiredAgents.push(agentId);
        if (typeof onAgentSilence === 'function') {
          onAgentSilence({ agentId, elapsed, timeout: silenceTimeout });
        }
      }
    }

    // 移除超时条目防止重复触发
    for (const key of expiredSessions) _lastActivity.delete(key);
    for (const id of expiredAgents) _lastOutput.delete(id);
  }

  /** 获取当前监控状态 */
  function getStatus() {
    return {
      sessions: Array.from(_lastActivity.entries()).map(([k, v]) => {
        const [agentId, visitorId] = k.split(':');
        return { agentId, visitorId, lastActivity: v, idle: Date.now() - v };
      }),
      agents: Array.from(_lastOutput.entries()).map(([k, v]) => ({
        agentId: k, lastOutput: v, idle: Date.now() - v,
      })),
    };
  }

  return { feed, feedOutput, removeSession, removeAgent, start, stop, getStatus };
}

module.exports = { createWatchdog };
