import type { DatabaseLike } from '../types/database';

const crypto = require('crypto');

export type BindingStatus = 'pending' | 'active' | 'stale' | 'unavailable';
export type SessionOrigin = 'caller' | 'voko_managed';

export interface ProviderCallerIdentity {
  providerType?: string | null;
  providerInstanceId?: string | null;
  nativeSessionId?: string | null;
  connectionId?: string | null;
  evidence?: string | null;
  source?: string | null;
}

export interface ProviderConversationBinding {
  id: string;
  agentId: string;
  channelId: string;
  channelType: number;
  providerType: string;
  providerInstanceId: string | null;
  deliveryMode: string;
  adapterType: string;
  nativeSessionId: string;
  sessionOrigin: SessionOrigin;
  status: BindingStatus;
  bindingVersion: number;
  pendingMessageId: string | null;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;
}

interface BindingRow {
  id: string;
  agent_id: string;
  channel_id: string;
  channel_type: number;
  provider_type: string;
  provider_instance_id: string | null;
  delivery_mode: string;
  adapter_type: string;
  native_session_id: string;
  session_origin: SessionOrigin;
  status: BindingStatus;
  binding_version: number;
  pending_message_id: string | null;
  created_at: number;
  updated_at: number;
  last_used_at: number;
}

function clean(value: unknown, max = 255): string {
  return String(value ?? '').trim().slice(0, max);
}

function cleanSessionId(value: unknown): string {
  const sessionId = clean(value, 512);
  return /^[A-Za-z0-9][A-Za-z0-9._:@/+\-=]{0,511}$/.test(sessionId) ? sessionId : '';
}

function normalizeChannelType(value: unknown): number {
  return Number(value) === 2 ? 2 : 1;
}

function fromRow(row?: BindingRow | null): ProviderConversationBinding | null {
  if (!row) return null;
  return {
    id: row.id,
    agentId: row.agent_id,
    channelId: row.channel_id,
    channelType: row.channel_type,
    providerType: row.provider_type,
    providerInstanceId: row.provider_instance_id,
    deliveryMode: row.delivery_mode,
    adapterType: row.adapter_type,
    nativeSessionId: row.native_session_id,
    sessionOrigin: row.session_origin,
    status: row.status,
    bindingVersion: row.binding_version,
    pendingMessageId: row.pending_message_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
  };
}

export class ProviderConversationBindingStore {
  private readonly available: boolean;

  constructor(private readonly db: Pick<DatabaseLike, 'prepare' | 'exec'>) {
    try {
      const row = this.db.prepare(`
        SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='provider_conversation_bindings'
      `).get() as { present?: number } | undefined;
      this.available = row?.present === 1;
    } catch (_) {
      this.available = false;
    }
  }

  getActive(agentId: string, channelId: string, channelType = 1): ProviderConversationBinding | null {
    if (!this.available) return null;
    const row = this.db.prepare(`
      SELECT * FROM provider_conversation_bindings
      WHERE agent_id=? AND channel_id=? AND channel_type=? AND status='active'
      ORDER BY binding_version DESC LIMIT 1
    `).get(agentId, channelId, normalizeChannelType(channelType)) as BindingRow | undefined;
    return fromRow(row);
  }

  getByAdapter(agentId: string, channelId: string, channelType: number, adapterType: string): ProviderConversationBinding | null {
    if (!this.available) return null;
    const row = this.db.prepare(`
      SELECT * FROM provider_conversation_bindings
      WHERE agent_id=? AND channel_id=? AND channel_type=? AND adapter_type=?
        AND status IN ('active','stale')
      ORDER BY binding_version DESC LIMIT 1
    `).get(agentId, channelId, normalizeChannelType(channelType), clean(adapterType, 64)) as BindingRow | undefined;
    return fromRow(row);
  }

  isActiveElsewhere(input: {
    agentId: string;
    channelId: string;
    channelType?: number;
    providerType: string;
    providerInstanceId?: string | null;
    nativeSessionId: string;
  }): boolean {
    if (!this.available) return false;
    return !!this.db.prepare(`
      SELECT 1 FROM provider_conversation_bindings
      WHERE provider_type=? AND COALESCE(provider_instance_id,'')=COALESCE(?, '')
        AND native_session_id=? AND status='active'
        AND NOT (agent_id=? AND channel_id=? AND channel_type=?)
      LIMIT 1
    `).get(clean(input.providerType, 64), clean(input.providerInstanceId, 192) || null,
      cleanSessionId(input.nativeSessionId), clean(input.agentId, 128), clean(input.channelId, 192),
      normalizeChannelType(input.channelType));
  }

  markConversationStale(agentId: string, channelId: string, channelType = 1): void {
    if (!this.available) return;
    this.db.prepare(`
      UPDATE provider_conversation_bindings SET status='stale', updated_at=?
      WHERE agent_id=? AND channel_id=? AND channel_type=? AND status='active'
    `).run(Date.now(), agentId, channelId, normalizeChannelType(channelType));
  }

  beginCallerBinding(input: {
    agentId: string;
    channelId: string;
    channelType?: number;
    providerType: string;
    providerInstanceId?: string | null;
    nativeSessionId: string;
    deliveryMode?: string;
    adapterType?: string;
    pendingMessageId: string;
  }): ProviderConversationBinding | null {
    if (!this.available) return null;
    const agentId = clean(input.agentId, 128);
    const channelId = clean(input.channelId, 192);
    const providerType = clean(input.providerType, 64);
    const nativeSessionId = cleanSessionId(input.nativeSessionId);
    const messageId = clean(input.pendingMessageId, 192);
    if (!agentId || !channelId || !providerType || !nativeSessionId || !messageId) return null;

    const channelType = normalizeChannelType(input.channelType);
    const providerInstanceId = clean(input.providerInstanceId, 192) || null;
    const deliveryMode = clean(input.deliveryMode || 'mcp', 64) || 'mcp';
    const adapterType = clean(input.adapterType || providerType, 64) || providerType;
    const existingElsewhere = this.db.prepare(`
      SELECT 1 FROM provider_conversation_bindings
      WHERE provider_type=? AND COALESCE(provider_instance_id,'')=COALESCE(?, '')
        AND native_session_id=? AND status='active'
        AND NOT (agent_id=? AND channel_id=? AND channel_type=?)
      LIMIT 1
    `).get(providerType, providerInstanceId, nativeSessionId, agentId, channelId, channelType);
    if (existingElsewhere) return null;

    const now = Date.now();
    const current = this.getActive(agentId, channelId, channelType);
    const version = (current?.bindingVersion || 0) + 1;
    const id = `pcb_${crypto.randomUUID()}`;
    this.db.prepare(`
      INSERT INTO provider_conversation_bindings
        (id, agent_id, channel_id, channel_type, provider_type, provider_instance_id,
         delivery_mode, adapter_type, native_session_id, session_origin, status,
         binding_version, pending_message_id, created_at, updated_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'caller', 'pending', ?, ?, ?, ?, ?)
    `).run(id, agentId, channelId, channelType, providerType, providerInstanceId,
      deliveryMode, adapterType, nativeSessionId, version, messageId, now, now, now);
    return this.getById(id);
  }

  activatePending(id: string): ProviderConversationBinding | null {
    if (!this.available) return null;
    const now = Date.now();
    let activatedId: string | null = null;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const candidate = this.getById(id);
      if (!candidate || candidate.status !== 'pending') {
        this.db.exec('COMMIT');
        return null;
      }
      const versionRow = this.db.prepare(`
        SELECT COALESCE(MAX(binding_version), 0) AS version
        FROM provider_conversation_bindings
        WHERE agent_id=? AND channel_id=? AND channel_type=? AND status<>'pending'
      `).get(candidate.agentId, candidate.channelId, candidate.channelType) as { version?: number } | undefined;
      const nextVersion = Number(versionRow?.version || 0) + 1;
      this.db.prepare(`
        UPDATE provider_conversation_bindings SET status='stale', updated_at=?
        WHERE agent_id=? AND channel_id=? AND channel_type=? AND status='active' AND id<>?
      `).run(now, candidate.agentId, candidate.channelId, candidate.channelType, candidate.id);
      this.db.prepare(`
        UPDATE provider_conversation_bindings
        SET status='active', binding_version=?, pending_message_id=NULL, updated_at=?, last_used_at=?
        WHERE id=? AND status='pending'
      `).run(nextVersion, now, now, candidate.id);
      activatedId = candidate.id;
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    return activatedId ? this.getById(activatedId) : null;
  }

  discardPending(id: string): void {
    if (!this.available) return;
    this.db.prepare(`DELETE FROM provider_conversation_bindings WHERE id=? AND status='pending'`).run(id);
  }

  saveManaged(input: {
    agentId: string;
    channelId: string;
    channelType?: number;
    providerType: string;
    providerInstanceId?: string | null;
    nativeSessionId: string;
    deliveryMode: string;
    adapterType: string;
    expectedVersion?: number | null;
  }): ProviderConversationBinding | null {
    if (!this.available) return null;
    const agentId = clean(input.agentId, 128);
    const channelId = clean(input.channelId, 192);
    const providerType = clean(input.providerType, 64);
    const nativeSessionId = cleanSessionId(input.nativeSessionId);
    if (!agentId || !channelId || !providerType || !nativeSessionId) return null;
    const channelType = normalizeChannelType(input.channelType);
    const now = Date.now();
    const id = `pcb_${crypto.randomUUID()}`;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.getActive(agentId, channelId, channelType);
      if (input.expectedVersion != null && current && current.bindingVersion !== input.expectedVersion) {
        this.db.exec('COMMIT');
        return current;
      }
      if (current?.nativeSessionId === nativeSessionId && current.providerType === providerType) {
        this.db.prepare(`UPDATE provider_conversation_bindings SET updated_at=?, last_used_at=? WHERE id=?`)
          .run(now, now, current.id);
        this.db.exec('COMMIT');
        return this.getById(current.id);
      }
      const versionRow = this.db.prepare(`
        SELECT COALESCE(MAX(binding_version), 0) AS version
        FROM provider_conversation_bindings
        WHERE agent_id=? AND channel_id=? AND channel_type=?
      `).get(agentId, channelId, channelType) as { version?: number } | undefined;
      const version = Number(versionRow?.version || 0) + 1;
      this.db.prepare(`
        UPDATE provider_conversation_bindings SET status='stale', updated_at=?
        WHERE agent_id=? AND channel_id=? AND channel_type=? AND status='active'
      `).run(now, agentId, channelId, channelType);
      this.db.prepare(`
        INSERT INTO provider_conversation_bindings
          (id, agent_id, channel_id, channel_type, provider_type, provider_instance_id,
           delivery_mode, adapter_type, native_session_id, session_origin, status,
           binding_version, pending_message_id, created_at, updated_at, last_used_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'voko_managed', 'active', ?, NULL, ?, ?, ?)
      `).run(id, agentId, channelId, channelType, providerType,
        clean(input.providerInstanceId, 192) || null, clean(input.deliveryMode, 64),
        clean(input.adapterType, 64), nativeSessionId, version, now, now, now);
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    return this.getById(id);
  }

  importLegacy(input: {
    agentId: string;
    channelId: string;
    channelType?: number;
    providerType: string;
    providerInstanceId?: string | null;
    deliveryMode: string;
    adapterType: string;
    legacyVisitorId?: string;
  }): ProviderConversationBinding | null {
    if (!this.available) return null;
    const current = this.getActive(input.agentId, input.channelId, input.channelType);
    if (current) return current;
    const row = this.db.prepare(`
      SELECT session_handle FROM agent_session_handles
      WHERE agent_id=? AND visitor_id=? AND adapter_type=?
    `).get(input.agentId, input.legacyVisitorId || input.channelId, input.adapterType) as { session_handle?: string } | undefined;
    if (!row?.session_handle) return null;
    return this.saveManaged({ ...input, nativeSessionId: row.session_handle, expectedVersion: 0 });
  }

  markStale(id: string): void {
    if (!this.available) return;
    this.db.prepare(`UPDATE provider_conversation_bindings SET status='stale', updated_at=? WHERE id=?`).run(Date.now(), id);
  }

  touch(id: string): void {
    if (!this.available) return;
    const now = Date.now();
    this.db.prepare(`UPDATE provider_conversation_bindings SET updated_at=?, last_used_at=? WHERE id=?`).run(now, now, id);
  }

  deleteForAgent(agentId: string): void {
    if (!this.available) return;
    this.db.prepare(`DELETE FROM provider_conversation_bindings WHERE agent_id=?`).run(agentId);
  }

  cleanupPending(maxAgeMs = 10 * 60 * 1000): number {
    if (!this.available) return 0;
    const result = this.db.prepare(`
      DELETE FROM provider_conversation_bindings WHERE status='pending' AND updated_at<?
    `).run(Date.now() - maxAgeMs) as { changes?: number } | undefined;
    return Number(result?.changes || 0);
  }

  recoverPending(maxAgeMs = 10 * 60 * 1000): { activated: number; discarded: number } {
    if (!this.available) return { activated: 0, discarded: 0 };
    const rows = this.db.prepare(`
      SELECT b.id, m.status AS message_status
      FROM provider_conversation_bindings b
      LEFT JOIN messages m ON m.id=b.pending_message_id
      WHERE b.status='pending'
    `).all() as Array<{ id: string; message_status?: string | null }>;
    let activated = 0;
    let discarded = 0;
    for (const row of rows) {
      if (row.message_status === 'sent') {
        if (this.activatePending(row.id)) activated += 1;
      } else if (row.message_status === 'failed') {
        this.discardPending(row.id);
        discarded += 1;
      }
    }
    discarded += this.cleanupPending(maxAgeMs);
    return { activated, discarded };
  }

  markUnavailable(id: string): void {
    if (!this.available) return;
    this.db.prepare(`UPDATE provider_conversation_bindings SET status='unavailable', updated_at=? WHERE id=?`)
      .run(Date.now(), id);
  }

  private getById(id: string): ProviderConversationBinding | null {
    if (!this.available) return null;
    return fromRow(this.db.prepare(`SELECT * FROM provider_conversation_bindings WHERE id=?`).get(id) as BindingRow | undefined);
  }
}

module.exports = { ProviderConversationBindingStore };
