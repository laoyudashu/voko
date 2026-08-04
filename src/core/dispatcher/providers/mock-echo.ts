/**
 * mock-echo.js — 测试用 Mock Echo Provider
 *
 * 仅在 VOKO_SMOKE_TEST=1 时由 index.js 注册。不依赖任何外部 CLI/gateway，
 * push 时 emit 固定回复，覆盖 dispatch→provider→reply→persist 全链路。
 *
 * backend_type: 'mock'，priority 99（最高，确保选中）
 */

const { PushProvider } = require('../base-provider');
import type { AgentMeta, PushPayload } from '../types';

class MockEchoProvider extends PushProvider {
  constructor() {
    super();
    this._delay = parseInt(process.env.VOKO_SMOKE_ECHO_DELAY || '50', 10);
    this._available = true;
  }

  get priority() { return 99; }
  get capabilities() { return ['streaming']; }

  match(_agentId: string, meta?: AgentMeta | null): boolean {
    return meta?.backend_type === 'mock';
  }

  isAvailable() {
    return this._available;
  }

  setAvailable(available: boolean) {
    this._available = !!available;
  }

  async push(payload: PushPayload): Promise<void> {
    const { agentId, fromUid, content } = payload;
    const turnId = String(payload.turnId || payload.messageId || `mock-${Date.now()}`);
    const reply = `[echo] ${content}`;
    setTimeout(() => {
      this.emit('agent.reply', {
        agentId,
        visitorId: fromUid,
        content: reply,
        done: true,
        sessionKey: `mock:${agentId}:${fromUid}`,
        turnId,
        replyId: turnId,
      });
    }, this._delay);
  }

  async steer(agentId: string, visitorId: string, content: string, metadata?: { turnId?: string }): Promise<void> {
    const turnId = String(metadata?.turnId || `mock-steer-${Date.now()}`);
    this.emit('agent.reply', {
      agentId, visitorId,
      content: `[steer] ${content}`,
      done: true,
      sessionKey: `mock:${agentId}:${visitorId}`,
      turnId,
      replyId: turnId,
    });
  }

  start() {}
  stop() {}
  healthCheck() { return { ok: true }; }
}

module.exports = { MockEchoProvider };
