/**
 * runtime-state.js — 运行时状态聚合
 *
 * 聚合 worker-manager / 调度层 / adapter healthCheck / 会话状态
 * 成统一可订阅视图，供控制台消费。
 */

export {};

type AgentState = Record<string, unknown> & {
  status?: string;
  connected?: boolean;
  _updatedAt?: number;
};

type AgentSnapshot = AgentState & { agentId: string };
type StateListener = (state: AgentSnapshot[]) => void;

class RuntimeState {
  private _agents: Map<string, AgentState>;
  private _listeners: Set<StateListener>;

  constructor() {
    this._agents = new Map();       // agentId → { ... }
    this._listeners = new Set();    // (state) => void
  }

  /** 注册或更新 agent 状态 */
  updateAgent(agentId: string, data: AgentState): void {
    const existing = this._agents.get(agentId) || {};
    const updated = { ...existing, ...data, _updatedAt: Date.now() };
    this._agents.set(agentId, updated);
    this._notify();
  }

  /** 删除 agent */
  removeAgent(agentId: string): void {
    this._agents.delete(agentId);
    this._notify();
  }

  /** 获取全部 agent 状态快照 */
  getAll(): AgentSnapshot[] {
    return Array.from(this._agents.entries()).map(([agentId, data]) => ({
      agentId,
      ...data,
    }));
  }

  /** 获取单 agent 状态 */
  get(agentId: string): AgentState | null {
    return this._agents.get(agentId) || null;
  }

  /** 订阅状态变更 */
  subscribe(fn: StateListener): () => boolean {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  /** 生成摘要 */
  summary(): {
    total: number;
    connected: number;
    disconnected: number;
    online: number;
    uptime: number;
    memory: number;
  } {
    const agents = this.getAll();
    return {
      total: agents.length,
      connected: agents.filter(a => a.status === 'connected').length,
      disconnected: agents.filter(a => a.status === 'disconnected' || a.status === 'kicked').length,
      online: agents.filter(a => a.connected).length,
      uptime: process.uptime(),
      memory: process.memoryUsage ? Math.round(process.memoryUsage().rss / 1024 / 1024) : 0,
    };
  }

  private _notify(): void {
    const state = this.getAll();
    for (const fn of this._listeners) {
      try { fn(state); } catch {}
    }
  }
}

module.exports = { RuntimeState };
