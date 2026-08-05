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
    this._agentAvailability = new Map();
    this._fault = null;
    this._testStats = { pushCalls: 0, faultedPushes: 0, replies: 0 };
  }

  get priority() { return 99; }
  get capabilities() { return ['streaming']; }

  match(_agentId: string, meta?: AgentMeta | null): boolean {
    return meta?.backend_type === 'mock';
  }

  isAvailable(agentId?: string) {
    if (agentId && this._agentAvailability.has(agentId)) return this._agentAvailability.get(agentId);
    return this._available;
  }

  setAvailable(available: boolean) {
    this._available = !!available;
  }

  setAgentAvailable(agentId: string, available: boolean) {
    if (!agentId) return;
    this._agentAvailability.set(String(agentId), !!available);
  }

  clearAgentAvailability(agentId?: string) {
    if (agentId) this._agentAvailability.delete(String(agentId));
    else this._agentAvailability.clear();
  }

  setFault(mode: string, count = 1, disable = false) {
    const normalized = String(mode || '').trim();
    if (!['not_delivered', 'outcome_unknown'].includes(normalized)) {
      throw new Error(`Unsupported mock provider fault: ${normalized}`);
    }
    this._fault = {
      mode: normalized,
      remaining: Math.max(1, Number(count) || 1),
      disable: !!disable,
    };
  }

  clearFault() {
    this._fault = null;
  }

  getTestState() {
    return {
      available: this._available,
      agentAvailability: Object.fromEntries(this._agentAvailability.entries()),
      fault: this._fault ? { ...this._fault } : null,
      stats: { ...this._testStats },
    };
  }

  async push(payload: PushPayload): Promise<void> {
    this._testStats.pushCalls += 1;
    if (this._fault && this._fault.remaining > 0) {
      const fault = this._fault;
      fault.remaining -= 1;
      this._testStats.faultedPushes += 1;
      if (fault.remaining <= 0) this._fault = null;
      if (fault.disable) this._available = false;
      const error: any = new Error(`Mock provider ${fault.mode}`);
      error.deliveryOutcome = fault.mode;
      throw error;
    }
    const { agentId, fromUid, content } = payload;
    const turnId = String(payload.turnId || payload.messageId || `mock-${Date.now()}`);
    const reply = `[echo] ${content}`;
    setTimeout(() => {
      this._testStats.replies += 1;
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
