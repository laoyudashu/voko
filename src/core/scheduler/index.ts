/**
 * scheduler/index.js — 调度层统一入口
 *
 * 组装 wakeup + watchdog + recovery-actions + token-guard。
 * 提供 createScheduler() 工厂，一次初始化获得全部能力。
 */

const { createWakeupQueue } = require('./wakeup');
const { createWatchdog } = require('./watchdog');
const { createRecoveryActions } = require('./recovery-actions');
const { createTokenGuard } = require('./token-guard');
import type { DatabaseLike } from '../../types/database';

/**
 * 创建完整调度器实例。
 *
 * @param {object} db - better-sqlite3
 * @returns {{ wakeup, watchdog, recovery, tokenGuard }}
 */
function createScheduler(db: DatabaseLike) {
  const recovery = createRecoveryActions(db);
  const watchdog = createWatchdog({
    db,
    onSessionTimeout: ({ agentId, visitorId, elapsed }: { agentId: string; visitorId: string; elapsed: number }) => {
      recovery.create({
        type: 'escalate',
        actor: 'system',
        agentId,
        visitorId,
        reason: `会话超时无响应 (${Math.round(elapsed / 1000)}s)`,
        evidence: `lastActivity: ${elapsed}ms ago`,
      });
    },
    onAgentSilence: ({ agentId, elapsed }: { agentId: string; elapsed: number }) => {
      recovery.create({
        type: 'escalate',
        actor: 'system',
        agentId,
        reason: `agent 静默超时 (${Math.round(elapsed / 1000)}s 无输出)`,
        evidence: `silence: ${elapsed}ms`,
      });
    },
  });

  const tokenGuard = createTokenGuard({
    onLimit: (info: { agentId: string; visitorId?: string; reason: string }) => {
      recovery.create({
        type: 'escalate',
        actor: 'system',
        agentId: info.agentId,
        visitorId: info.visitorId,
        reason: info.reason,
        evidence: JSON.stringify(info),
      });
    },
  });

  const wakeup = createWakeupQueue(db);

  return { wakeup, watchdog, recovery, tokenGuard };
}

module.exports = {
  createScheduler,
  createWakeupQueue,
  createWatchdog,
  createRecoveryActions,
  createTokenGuard,
};
