import crypto from 'node:crypto';
import type { DatabaseLike } from '../types/database';

const { fingerprintProviderSession, normalizeProviderFamily } = require('./provider-routing');

function clean(value: unknown, max = 512): string {
  return String(value ?? '').trim().slice(0, max);
}

export class AgentIdentityBindingStore {
  constructor(private readonly db: DatabaseLike) {}

  bind(input: { agentId: string; providerFamily: string; providerInstanceKey?: string | null;
    nativeSessionId: string; evidenceType: string; }): void {
    const now = Date.now();
    const family = normalizeProviderFamily(input.providerFamily);
    const instance = clean(input.providerInstanceKey, 192);
    const fingerprint = fingerprintProviderSession(this.db, family, input.nativeSessionId);
    this.db.prepare(`INSERT INTO provider_agent_identity_bindings
      (id,agent_id,provider_family,provider_instance_key,native_session_fingerprint,evidence_type,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'active',?,?)
      ON CONFLICT(agent_id,provider_family,provider_instance_key,native_session_fingerprint)
      DO UPDATE SET evidence_type=excluded.evidence_type,status='active',updated_at=excluded.updated_at`)
      .run(crypto.randomUUID(), clean(input.agentId, 128), family, instance, fingerprint,
        clean(input.evidenceType, 64), now, now);
  }

  resolve(providerFamily: string, providerInstanceKey: string | null | undefined, nativeSessionId: string): string[] {
    const family = normalizeProviderFamily(providerFamily);
    const fingerprint = fingerprintProviderSession(this.db, family, nativeSessionId);
    return (this.db.prepare(`SELECT agent_id FROM provider_agent_identity_bindings
      WHERE provider_family=? AND provider_instance_key=? AND native_session_fingerprint=? AND status='active'`)
      .all(family, clean(providerInstanceKey, 192), fingerprint) as Array<{ agent_id: string }>).map((row) => row.agent_id);
  }
}

export interface LegacyIdentityBackfillResult {
  status: 'completed' | 'skipped';
  reason?: string;
  candidates: number;
  inserted: number;
  ambiguous: number;
  incompatible: number;
}

/**
 * Populate identity bindings from the old conversation-binding store only when
 * one provider instance/session has exactly one compatible Agent owner.
 */
export function backfillLegacyAgentIdentityBindings(
  db: DatabaseLike,
  options: { force?: boolean } = {},
): LegacyIdentityBackfillResult {
  const empty = { status: 'completed' as const, candidates: 0, inserted: 0, ambiguous: 0, incompatible: 0 };
  const hasTable = (name: string) => !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
  ).get(name);
  if (!hasTable('provider_agent_identity_bindings')
    || !hasTable('provider_conversation_bindings') || !hasTable('agents') || !hasTable('config')) {
    return { ...empty, status: 'skipped', reason: 'schema_missing' };
  }

  const markerType = 'provider_identity_legacy_backfill_v1';
  if (!options.force && db.prepare('SELECT 1 FROM config WHERE type=? LIMIT 1').get(markerType)) {
    return { ...empty, status: 'skipped', reason: 'already_completed' };
  }

  type LegacyRow = {
    agent_id?: string; provider_type?: string; provider_instance_id?: string | null;
    native_session_id?: string; backend_type?: string;
  };
  const rows = db.prepare(`
    SELECT b.agent_id, b.provider_type, b.provider_instance_id, b.native_session_id, a.backend_type
    FROM provider_conversation_bindings b
    JOIN agents a ON a.agent_id=b.agent_id
    WHERE TRIM(COALESCE(b.provider_type,''))<>''
      AND TRIM(COALESCE(b.native_session_id,''))<>''
  `).all() as LegacyRow[];
  const groups = new Map<string, { family: string; instance: string; session: string; agents: Set<string>; compatible: Set<string> }>();
  for (const row of rows) {
    const family = normalizeProviderFamily(row.provider_type);
    const instance = clean(row.provider_instance_id, 192);
    const session = clean(row.native_session_id);
    const agentId = clean(row.agent_id, 128);
    if (!family || !session || !agentId) continue;
    const key = `${family}\0${instance}\0${session}`;
    const group = groups.get(key) || { family, instance, session, agents: new Set<string>(), compatible: new Set<string>() };
    group.agents.add(agentId);
    if (normalizeProviderFamily(row.backend_type) === family) group.compatible.add(agentId);
    groups.set(key, group);
  }

  const candidates = [...groups.values()];
  let ambiguous = 0;
  let incompatible = 0;
  const eligible = candidates.filter((group) => {
    if (group.agents.size !== 1) { ambiguous++; return false; }
    if (group.compatible.size !== 1) { incompatible++; return false; }
    return true;
  });
  let inserted = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    const insert = db.prepare(`INSERT OR IGNORE INTO provider_agent_identity_bindings
      (id,agent_id,provider_family,provider_instance_key,native_session_fingerprint,evidence_type,status,created_at,updated_at)
      VALUES (?,?,?,?,?,'legacy_binding_unique','active',?,?)`);
    const now = Date.now();
    for (const group of eligible) {
      const agentId = [...group.agents][0];
      const fingerprint = fingerprintProviderSession(db, group.family, group.session);
      const result = insert.run(crypto.randomUUID(), agentId, group.family, group.instance, fingerprint, now, now) as { changes?: number };
      if (Number(result?.changes) > 0) inserted++;
    }
    db.prepare(`INSERT OR REPLACE INTO config (type,data,updated_at) VALUES (?,?,?)`)
      .run(markerType, JSON.stringify({ completedAt: now, candidates: candidates.length, inserted, ambiguous, incompatible }), now);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw error;
  }
  return { ...empty, candidates: candidates.length, inserted, ambiguous, incompatible };
}

module.exports = { AgentIdentityBindingStore, backfillLegacyAgentIdentityBindings };
