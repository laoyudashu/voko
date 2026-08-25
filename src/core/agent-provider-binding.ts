import type { DatabaseLike } from '../types/database';
const { normalizeBackendType } = require('./agent-backend-types');
const { resolveWorkBuddyAgent } = require('./dispatcher/workbuddy-agents');

type Db = Pick<DatabaseLike, 'prepare' | 'exec'>;

export type ProviderSelection = {
  backendType: string;
  backendInstanceId: string | null;
};

function bindingError(code: string, message: string): Error {
  const error: any = new Error(message);
  error.code = code;
  return error;
}

export function validateProviderSelection(input: {
  backendType: unknown;
  backendInstanceId?: unknown;
  availableInstances?: Array<{ id: unknown }>;
}): ProviderSelection {
  const backendType = normalizeBackendType(input.backendType || 'others');
  const backendInstanceId = String(input.backendInstanceId || '').trim() || null;
  if (backendType === 'workbuddy' && backendInstanceId && !resolveWorkBuddyAgent(backendInstanceId)) {
    throw bindingError('BACKEND_INSTANCE_UNAVAILABLE', '所选 WorkBuddy Agent 不存在或不可用');
  }
  if (backendInstanceId && input.availableInstances
    && !input.availableInstances.some(item => String(item.id) === backendInstanceId)) {
    throw bindingError('BACKEND_INSTANCE_UNAVAILABLE', '所选 Agent 实例不存在或不可用');
  }
  return { backendType, backendInstanceId };
}

export class AgentProviderBindingService {
  constructor(private readonly db: Db) {}

  get(agentId: string): ProviderSelection | null {
    const row = this.db.prepare(
      'SELECT backend_type, backend_instance_id FROM agents WHERE agent_id=? LIMIT 1',
    ).get(agentId) as any;
    return row ? {
      backendType: normalizeBackendType(row.backend_type || 'others'),
      backendInstanceId: String(row.backend_instance_id || '').trim() || null,
    } : null;
  }

  assertLockedUpdate(agentId: string, input: {
    backendType?: unknown;
    backendInstanceId?: unknown;
  }): ProviderSelection {
    const current = this.get(agentId);
    if (!current) throw bindingError('AGENT_NOT_FOUND', 'Agent 不存在');
    if (input.backendType !== undefined
      && normalizeBackendType(input.backendType || 'others') !== current.backendType) {
      throw bindingError('BACKEND_TYPE_LOCKED', 'Agent 注册完成后不能更改类型');
    }
    if (input.backendInstanceId !== undefined) {
      const requested = String(input.backendInstanceId || '').trim() || null;
      if (requested !== current.backendInstanceId) {
        throw bindingError(
          current.backendInstanceId ? 'BACKEND_INSTANCE_LOCKED' : 'BACKEND_INSTANCE_BIND_ONCE_REQUIRED',
          current.backendInstanceId
            ? 'Agent 已绑定的实例不能更改'
            : '未绑定 Agent 只能通过 bind_agent_instance_once 补绑实例',
        );
      }
    }
    return current;
  }

  async bindInstanceOnce(agentId: string, input: {
    backendInstanceId: unknown;
    availableInstances?: Array<{ id: unknown }>;
    rebind?: (change: { agentId: string; previous: ProviderSelection; next: ProviderSelection }) => Promise<unknown>;
  }): Promise<{ previous: ProviderSelection; next: ProviderSelection; runtimeRebind?: unknown }> {
    const previous = this.get(agentId);
    if (!previous) throw bindingError('AGENT_NOT_FOUND', 'Agent 不存在');
    if (previous.backendInstanceId) throw bindingError('BACKEND_INSTANCE_LOCKED', 'Agent 已绑定实例，不能再次绑定');
    const next = validateProviderSelection({
      backendType: previous.backendType,
      backendInstanceId: input.backendInstanceId,
      availableInstances: input.availableInstances,
    });
    if (!next.backendInstanceId) throw bindingError('BACKEND_INSTANCE_REQUIRED', 'backendInstanceId 为必填字段');

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result: any = this.db.prepare(
        'UPDATE agents SET backend_instance_id=?, updated_at=? WHERE agent_id=? AND backend_instance_id IS NULL',
      ).run(next.backendInstanceId, Date.now(), agentId);
      if (Number(result?.changes || 0) !== 1) {
        throw bindingError('BACKEND_INSTANCE_ALREADY_BOUND', '该 Agent 已被其他操作绑定实例');
      }
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch (_) {}
      throw error;
    }
    const runtimeRebind = input.rebind ? await input.rebind({ agentId, previous, next }) : undefined;
    return { previous, next, ...(runtimeRebind === undefined ? {} : { runtimeRebind }) };
  }
}

module.exports = { AgentProviderBindingService, validateProviderSelection };
