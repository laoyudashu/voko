import type { DatabaseLike } from '../types/database';

export interface AgentRoutingSnapshot {
  backendType: string;
  backendInstanceId: string | null;
  deliveryModes: string[];
  imUid?: string;
  imToken?: string;
  imServerUrl?: string;
}

const MODE_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

export function parseDeliveryModes(value: unknown, fallback: string[] = ['pull']): string[] {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) return [...fallback];
    const modes = [...new Set(parsed.map(mode => String(mode || '').trim()).filter(Boolean))];
    if (!modes.includes('pull')) modes.push('pull');
    return modes;
  } catch {
    return [...fallback];
  }
}

export function normalizeDeliveryModes(value: unknown, ensurePull = true): string[] {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) throw new Error('delivery_modes must be an array');
  const modes = [...new Set(parsed.map(mode => String(mode || '').trim()).filter(Boolean))];
  for (const mode of modes) {
    if (!MODE_PATTERN.test(mode)) throw new Error(`invalid delivery mode: ${mode}`);
  }
  if (ensurePull && !modes.includes('pull')) modes.push('pull');
  return modes;
}

export class AgentDeliveryPolicyStore {
  constructor(private readonly db: Pick<DatabaseLike, 'prepare' | 'exec'>) {}

  get(agentId: string): AgentRoutingSnapshot | null {
    const row = this.db.prepare(`
      SELECT backend_type, backend_instance_id, delivery_modes, imUid, imToken, im_server_url
      FROM agents WHERE agent_id=? LIMIT 1
    `).get(agentId) as any;
    if (!row) return null;
    return {
      backendType: String(row.backend_type || 'others'),
      backendInstanceId: row.backend_instance_id == null ? null : String(row.backend_instance_id),
      deliveryModes: parseDeliveryModes(row.delivery_modes),
      imUid: row.imUid,
      imToken: row.imToken,
      imServerUrl: row.im_server_url,
    };
  }

  update(agentId: string, input: {
    backendType?: string;
    backendInstanceId?: string | null;
    deliveryModes?: unknown;
  }): { previous: AgentRoutingSnapshot; next: AgentRoutingSnapshot } {
    const previous = this.get(agentId);
    if (!previous) throw new Error('Agent not found');
    const sets: string[] = [];
    const values: unknown[] = [];
    if (input.backendType !== undefined) {
      sets.push('backend_type=?');
      values.push(String(input.backendType || 'others').trim() || 'others');
    }
    if (input.backendInstanceId !== undefined) {
      sets.push('backend_instance_id=?');
      values.push(String(input.backendInstanceId || '').trim() || null);
    }
    if (input.deliveryModes !== undefined) {
      sets.push('delivery_modes=?');
      values.push(JSON.stringify(normalizeDeliveryModes(input.deliveryModes)));
    }
    if (!sets.length) return { previous, next: previous };
    sets.push('updated_at=?');
    values.push(Date.now(), agentId);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE agent_id=?`).run(...values);
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch (_) {}
      throw error;
    }
    const next = this.get(agentId);
    if (!next) throw new Error('Agent disappeared after delivery policy update');
    return { previous, next };
  }

  forcePull(agentId: string): void {
    this.update(agentId, { deliveryModes: ['pull'] });
  }
}

module.exports = { AgentDeliveryPolicyStore, parseDeliveryModes, normalizeDeliveryModes };
