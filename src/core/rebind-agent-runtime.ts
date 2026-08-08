/**
 * Agent 运行时重绑定（rebindAgentRuntime）。
 *
 * 背景：修改 Agent 的 backend_type / backend_instance_id / IM 凭证后，
 * 需要统一完成「加载目标 Provider → 失效旧会话绑定 → 清缓存 → 必要时重启 IM Worker」，
 * 否则会出现「数据库已改、消息仍走旧 Provider/旧实例」的不一致。
 *
 * 设计要点：
 * - 纯函数 + 依赖注入（与 publishAgent / setAgentStatus 同风格，便于测试）；
 * - 调用方负责在调用前完成 DB 更新；本函数只读配置 + 失效运行时态（失败时写 delivery_modes 降级）；
 * - 任一步失败都被 catch 成 RebindResult，绝不外抛——保证 HTTP/MCP 返回结构稳定；
 * - 不影响其他 Agent：ensureBackend 按 type 共享加载（不卸载），restartAgentWorker 按 agent。
 */

const { parseDeliveryModes } = require('./agent-delivery-policy');

const errorMessage = (e: unknown): string => {
  if (e instanceof Error) return e.message;
  try { return JSON.stringify(e); } catch (_) { return String(e); }
};

export interface RebindAgentSnapshot {
  backendType: string;
  backendInstanceId: string | null;
  deliveryModes?: string[] | string | null;
  imUid?: string;
  imToken?: string;
  imServerUrl?: string;
}

export interface RebindInput {
  db: any;
  agentId: string;
  /** 变更前快照（调用方在 DB 更新前读取） */
  previous: RebindAgentSnapshot;
  /** 变更后目标（调用方在 DB 更新后读取，或传入意图） */
  next: RebindAgentSnapshot;
}

export interface RebindDeps {
  ensureBackend: (type: string) => Promise<void>;
  invalidateMeta: (agentId?: string) => void;
  invalidateBindingsForConfigChange: (input: {
    agentId: string;
    prevProviderType: string;
    prevInstanceId: string | null;
    nextProviderType: string;
    nextInstanceId: string | null;
  }) => number;
  getAgentDeliveryStatus: (agentId: string) => any;
  restartAgentWorker?: (agentId: string) => Promise<unknown>;
  /** 失败降级：把 agent 的 delivery_modes 强制为 ['pull']。 */
  forceDeliveryModesPull?: (db: any, agentId: string) => void;
}

export interface RebindResult {
  success: boolean;
  agentId: string;
  rebindStatus: 'unchanged' | 'rebound' | 'failed';
  provider: { action: 'unchanged' | 'loaded' | 'failed'; type: string; instance: string | null };
  bindings: { invalidated: number };
  imWorker: { action: 'unchanged' | 'restarted' | 'failed'; status?: string };
  deliveryReadiness?: any;
  fallback?: 'voko_fetch_new_messages';
  error?: string;
}

function normalize(s: any): string {
  return String(s ?? '').trim();
}

/**
 * 创建 rebind 编排函数。
 * 返回的函数接受 RebindInput，返回 RebindResult（永不 reject）。
 */
export function createRebindAgentRuntime(deps: RebindDeps) {
  return async function rebindAgentRuntime(input: RebindInput): Promise<RebindResult> {
    const { db, agentId, previous, next } = input;
    const prevType = normalize(previous.backendType);
    const nextType = normalize(next.backendType);
    const prevInstance = previous.backendInstanceId == null ? '' : normalize(previous.backendInstanceId);
    const nextInstance = next.backendInstanceId == null ? '' : normalize(next.backendInstanceId);
    const typeChanged = prevType !== nextType;
    const instanceChanged = prevInstance !== nextInstance;
    const prevModes = parseDeliveryModes(previous.deliveryModes);
    const nextModes = parseDeliveryModes(next.deliveryModes);
    const deliveryModesChanged = JSON.stringify(prevModes) !== JSON.stringify(nextModes);
    const imChanged = !!(
      normalize(previous.imUid) !== normalize(next.imUid) ||
      normalize(previous.imToken) !== normalize(next.imToken) ||
      normalize(previous.imServerUrl) !== normalize(next.imServerUrl)
    );

    const base: RebindResult = {
      success: true,
      agentId,
      rebindStatus: 'unchanged',
      provider: { action: 'unchanged', type: nextType, instance: next.backendInstanceId ?? null },
      bindings: { invalidated: 0 },
      imWorker: { action: 'unchanged' },
    };

    // 1. 三者都没变：透传当前 deliveryStatus，不做任何运行时变更。
    if (!typeChanged && !instanceChanged && !deliveryModesChanged && !imChanged) {
      base.deliveryReadiness = safeDeliveryStatus(deps, agentId);
      maybeSetFallback(base);
      return base;
    }

    // 2. 加载目标 Provider（类型变了，或当前 type 的 provider 尚未加载）。
    //    失败 → 降级 Pull，记 failed，但不外抛。
    if (typeChanged) {
      try {
        await deps.ensureBackend(nextType);
        base.provider.action = 'loaded';
      } catch (e: any) {
        base.provider.action = 'failed';
        base.rebindStatus = 'failed';
        base.success = false;
        base.error = `ensureBackend 失败: ${errorMessage(e)}`;
        try { deps.forceDeliveryModesPull?.(db, agentId); } catch (_) {}
        try { deps.invalidateMeta(agentId); } catch (_) {}
        base.deliveryReadiness = safeDeliveryStatus(deps, agentId);
        maybeSetFallback(base);
        return base;
      }
    }

    // 3. 失效旧会话绑定（type 变 → 全 agent；仅 instance 变 → 仅旧实例；纯 IM 变 → 不动）。
    try {
      if (typeChanged || instanceChanged) base.bindings.invalidated = deps.invalidateBindingsForConfigChange({
        agentId,
        prevProviderType: prevType,
        prevInstanceId: previous.backendInstanceId ?? null,
        nextProviderType: nextType,
        nextInstanceId: next.backendInstanceId ?? null,
      });
    } catch (e: any) {
      // 绑定失效失败不致命（绑定有 TTL/覆盖语义兜底），记录但继续。
      console.error('[rebind] invalidateBindingsForConfigChange 失败:', errorMessage(e));
    }

    // 4. 清 dispatcher 的 meta + route 缓存。
    try { deps.invalidateMeta(agentId); } catch (e: any) {
      console.error('[rebind] invalidateMeta 失败:', errorMessage(e));
    }

    // 5. IM 凭证变更 → 重启当前 agent 的 worker（失败不阻塞 provider 重绑定，Pull 兜底）。
    if (imChanged && typeof deps.restartAgentWorker === 'function') {
      try {
        await deps.restartAgentWorker(agentId);
        base.imWorker.action = 'restarted';
      } catch (e: any) {
        base.imWorker.action = 'failed';
        base.imWorker.status = errorMessage(e);
        console.error('[rebind] restartAgentWorker 失败:', errorMessage(e));
      }
    }

    // 6. 读取最新投递状态，决定 fallback。
    base.deliveryReadiness = safeDeliveryStatus(deps, agentId);
    maybeSetFallback(base);
    base.rebindStatus = 'rebound';
    return base;
  };
}

function safeDeliveryStatus(deps: RebindDeps, agentId: string): any {
  try { return deps.getAgentDeliveryStatus(agentId); } catch (_) { return undefined; }
}

/** 当没有任何可用的自动通道时，标注 Pull 兜底。 */
function maybeSetFallback(base: RebindResult): void {
  const dr = base.deliveryReadiness;
  if (!dr) return;
  const auto = Array.isArray(dr.automaticReadyModes) ? dr.automaticReadyModes : [];
  if (auto.length === 0) base.fallback = 'voko_fetch_new_messages';
}

module.exports = { createRebindAgentRuntime };
