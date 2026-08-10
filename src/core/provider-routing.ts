import crypto from 'node:crypto';
import type { DatabaseLike } from '../types/database';

const HMAC_NAMESPACE = 'voko/provider-session/v1';
const HMAC_CONFIG_KEY = 'provider_session_hmac_key_v1';

export type ConversationOrigin = 'caller' | 'voko_managed' | 'web_system';
export type ConversationStatus = 'active' | 'stale' | 'unavailable';
export type RouteStatus = 'pending' | 'active' | 'failed' | 'expired' | 'invalid';
export const PRECISE_ROUTING_GREY_PROVIDERS = Object.freeze(['codex', 'claude-code', 'opencode', 'kiro']);

export interface RoutingFeaturePolicy {
  enabled: boolean;
  providerFamilies: string[];
  channelTypes: number[];
  contentTypes: number[];
}

function clean(value: unknown, max = 512): string {
  return String(value ?? '').trim().slice(0, max);
}

function cleanRouteId(value: unknown, required = false): string | null {
  const routeId = clean(value, 128);
  if (!routeId) {
    if (required) throw new Error('Route id is required');
    return null;
  }
  if (routeId.length < 24 || !/^[A-Za-z0-9_-]+$/.test(routeId)) throw new Error('Route id is invalid');
  return routeId;
}

export function normalizeProviderFamily(value: unknown): string {
  const family = clean(value, 64).toLowerCase();
  const aliases: Record<string, string> = {
    'claude': 'claude-code', 'goose-ai': 'goose', 'goose-acp': 'goose',
    'acp-goose': 'goose', 'opencode-acp': 'opencode', 'opencode-attach': 'opencode',
  };
  return aliases[family] || family.replace(/^acp-/, '').replace(/-(?:acp|cli|http|ws|mcp)$/, '');
}

export function isRoutingFeatureEnabled(db: DatabaseLike, name: string, defaultValue = false): boolean {
  const envValue = process.env[`VOKO_${String(name).toUpperCase()}`];
  if (envValue != null) return /^(1|true|yes|on)$/i.test(envValue);
  try {
    const row = db.prepare('SELECT data FROM config WHERE type=? LIMIT 1').get(`feature:${name}`) as { data?: string } | undefined;
    if (!row?.data) return defaultValue;
    const parsed = JSON.parse(row.data);
    return parsed === true || parsed?.enabled === true;
  } catch (_) { return defaultValue; }
}

export function getRoutingFeaturePolicy(
  db: DatabaseLike,
  name: string,
  defaults: Partial<RoutingFeaturePolicy> = {},
): RoutingFeaturePolicy {
  const fallback: RoutingFeaturePolicy = {
    enabled: defaults.enabled ?? false,
    providerFamilies: (defaults.providerFamilies || []).map(normalizeProviderFamily).filter(Boolean),
    channelTypes: (defaults.channelTypes || [1]).map(Number).filter(Number.isFinite),
    contentTypes: (defaults.contentTypes || [1]).map(Number).filter(Number.isFinite),
  };
  const envValue = process.env[`VOKO_${String(name).toUpperCase()}`];
  if (envValue != null) {
    if (/^(0|false|no|off)$/i.test(envValue)) return { ...fallback, enabled: false };
    if (/^(1|true|yes|on)$/i.test(envValue)) return { ...fallback, enabled: true };
    return { ...fallback, enabled: true,
      providerFamilies: envValue.split(',').map(normalizeProviderFamily).filter(Boolean) };
  }
  try {
    const row = db.prepare('SELECT data FROM config WHERE type=? LIMIT 1').get(`feature:${name}`) as { data?: string } | undefined;
    if (!row?.data) return fallback;
    const parsed = JSON.parse(row.data);
    if (typeof parsed === 'boolean') return { ...fallback, enabled: parsed };
    if (!parsed || typeof parsed !== 'object') return fallback;
    return {
      enabled: parsed.enabled === true,
      providerFamilies: Array.isArray(parsed.providerFamilies)
        ? parsed.providerFamilies.map(normalizeProviderFamily).filter(Boolean) : fallback.providerFamilies,
      channelTypes: Array.isArray(parsed.channelTypes)
        ? parsed.channelTypes.map(Number).filter(Number.isFinite) : fallback.channelTypes,
      contentTypes: Array.isArray(parsed.contentTypes)
        ? parsed.contentTypes.map(Number).filter(Number.isFinite) : fallback.contentTypes,
    };
  } catch (_) { return fallback; }
}

export function isRoutingPolicyEligible(
  db: DatabaseLike,
  name: string,
  input: { providerFamily: string; channelType?: number; contentType?: number },
): boolean {
  const policy = getRoutingFeaturePolicy(db, name, {
    providerFamilies: [...PRECISE_ROUTING_GREY_PROVIDERS], channelTypes: [1], contentTypes: [1],
  });
  if (!policy.enabled || !policy.providerFamilies.includes(normalizeProviderFamily(input.providerFamily))) return false;
  if (input.channelType != null && !policy.channelTypes.includes(Number(input.channelType))) return false;
  if (input.contentType != null && !policy.contentTypes.includes(Number(input.contentType))) return false;
  return true;
}

export function getProviderSessionHmacKey(db: DatabaseLike): Buffer {
  const row = db.prepare("SELECT data FROM config WHERE type=?").get(HMAC_CONFIG_KEY) as { data?: string } | undefined;
  if (!row?.data) throw new Error('Provider session HMAC key is not initialized');
  let encoded = row.data;
  try { encoded = JSON.parse(row.data); } catch (_) {}
  const key = Buffer.from(String(encoded), 'base64');
  if (key.length !== 32) throw new Error('Provider session HMAC key is invalid');
  return key;
}

export function fingerprintProviderSession(db: DatabaseLike, providerFamily: string, nativeSessionId: string): string {
  const family = normalizeProviderFamily(providerFamily);
  const session = clean(nativeSessionId);
  if (!family || !session) throw new Error('Provider family and native session are required');
  return crypto.createHmac('sha256', getProviderSessionHmacKey(db))
    .update(`${HMAC_NAMESPACE}\0${family}\0${session}`, 'utf8').digest('hex');
}

export interface RoutingConversation {
  id: string; agentId: string; providerFamily: string; providerInstanceKey: string;
  nativeSessionId: string; nativeSessionFingerprint: string; channelId: string;
  channelType: number; origin: ConversationOrigin; status: ConversationStatus;
  createdAt: number; updatedAt: number; lastUsedAt: number;
}

export type GroupRouteLookup =
  | { state: 'valid'; route: Record<string, unknown>; conversation: RoutingConversation }
  | { state: 'invalid'; reason: string }
  | { state: 'other_agent' };

function conversationFromRow(row: any): RoutingConversation | null {
  return row ? {
    id: row.id, agentId: row.agent_id, providerFamily: row.provider_family,
    providerInstanceKey: row.provider_instance_key, nativeSessionId: row.native_session_id,
    nativeSessionFingerprint: row.native_session_fingerprint, channelId: row.channel_id,
    channelType: row.channel_type, origin: row.origin, status: row.status,
    createdAt: row.created_at, updatedAt: row.updated_at, lastUsedAt: row.last_used_at,
  } : null;
}

export class RoutingConversationStore {
  constructor(private readonly db: DatabaseLike) {}

  resolveOrCreate(input: {
    agentId: string; providerFamily: string; providerInstanceKey?: string | null;
    nativeSessionId: string; channelId: string; channelType?: number; origin?: ConversationOrigin;
  }): RoutingConversation {
    const now = Date.now();
    const value = {
      agentId: clean(input.agentId, 128), providerFamily: normalizeProviderFamily(input.providerFamily),
      providerInstanceKey: clean(input.providerInstanceKey, 192), nativeSessionId: clean(input.nativeSessionId),
      channelId: clean(input.channelId, 192), channelType: Number(input.channelType) === 2 ? 2 : 1,
      origin: input.origin || 'caller',
    };
    if (!value.agentId || !value.providerFamily || !value.nativeSessionId || !value.channelId) {
      throw new Error('Incomplete routing conversation identity');
    }
    const fingerprint = fingerprintProviderSession(this.db, value.providerFamily, value.nativeSessionId);
    const find = () => conversationFromRow(this.db.prepare(`SELECT * FROM provider_routing_conversations
      WHERE agent_id=? AND provider_family=? AND provider_instance_key=?
        AND native_session_fingerprint=? AND channel_type=? AND channel_id=? AND status='active'
      LIMIT 1`).get(value.agentId, value.providerFamily, value.providerInstanceKey, fingerprint,
        value.channelType, value.channelId));
    const existing = find();
    if (existing) {
      this.db.prepare('UPDATE provider_routing_conversations SET last_used_at=?, updated_at=? WHERE id=?')
        .run(now, now, existing.id);
      return { ...existing, lastUsedAt: now, updatedAt: now };
    }
    try {
      this.db.prepare(`INSERT INTO provider_routing_conversations
        (id,agent_id,provider_family,provider_instance_key,native_session_id,native_session_fingerprint,
         channel_id,channel_type,origin,status,created_at,updated_at,last_used_at)
        VALUES (?,?,?,?,?,?,?,?,?,'active',?,?,?)`)
        .run(crypto.randomUUID(), value.agentId, value.providerFamily, value.providerInstanceKey,
          value.nativeSessionId, fingerprint, value.channelId, value.channelType, value.origin, now, now, now);
    } catch (error) {
      const raced = find();
      if (raced) return raced;
      throw error;
    }
    const created = find();
    if (!created) throw new Error('Failed to create routing conversation');
    return created;
  }

  getForScope(id: string, agentId: string, channelId: string, channelType = 1): RoutingConversation | null {
    return conversationFromRow(this.db.prepare(`SELECT * FROM provider_routing_conversations
      WHERE id=? AND agent_id=? AND channel_id=? AND channel_type=? AND status='active' LIMIT 1`)
      .get(clean(id, 128), clean(agentId, 128), clean(channelId, 192), Number(channelType) === 2 ? 2 : 1));
  }

}

export class MessageRouteStore {
  constructor(private readonly db: DatabaseLike) {}

  createPending(input: { messageId: string; conversationId: string; replyToRouteId?: string | null;
    agentId: string; peerUid: string; channelId: string; channelType?: number; direction: 'inbound' | 'outbound';
    ttlMs?: number; }): string {
    const now = Date.now();
    const routeId = crypto.randomBytes(32).toString('base64url');
    this.db.prepare(`INSERT INTO provider_message_routes
      (route_id,message_id,conversation_id,reply_to_route_id,agent_id,peer_uid,channel_id,channel_type,
       direction,status,expires_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?,?)`).run(routeId, clean(input.messageId, 256),
        clean(input.conversationId, 128), cleanRouteId(input.replyToRouteId), clean(input.agentId, 128),
        clean(input.peerUid, 192), clean(input.channelId, 192), Number(input.channelType) === 2 ? 2 : 1,
        input.direction, now + Math.max(60_000, input.ttlMs || 30 * 24 * 60 * 60 * 1000), now, now);
    return routeId;
  }

  setStatus(routeId: string, status: RouteStatus): void {
    this.db.prepare('UPDATE provider_message_routes SET status=?, updated_at=? WHERE route_id=?')
      .run(status, Date.now(), clean(routeId, 128));
  }

  recordInbound(input: { messageId: string; remoteRouteId: string; conversationId?: string | null;
    agentId: string; peerUid: string; channelId: string; channelType?: number; ttlMs?: number; }): string {
    const now = Date.now();
    const routeId = crypto.randomBytes(32).toString('base64url');
    const messageId = clean(input.messageId, 256);
    const agentId = clean(input.agentId, 128);
    const peerUid = clean(input.peerUid, 192);
    const channelId = clean(input.channelId, 192);
    const channelType = Number(input.channelType) === 2 ? 2 : 1;
    const remoteRouteId = cleanRouteId(input.remoteRouteId, true)!;
    const existing = this.db.prepare(`SELECT agent_id,peer_uid,channel_id,channel_type
      FROM provider_message_routes WHERE message_id=? AND direction='inbound' AND agent_id=? LIMIT 1`).get(messageId, agentId) as any;
    if (existing && (existing.agent_id !== agentId || existing.peer_uid !== peerUid
      || existing.channel_id !== channelId || Number(existing.channel_type) !== channelType)) {
      throw new Error('Inbound route scope conflict');
    }
    this.db.prepare(`INSERT INTO provider_message_routes
      (route_id,message_id,conversation_id,reply_to_route_id,agent_id,peer_uid,channel_id,channel_type,
       direction,status,expires_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,'active',?,?,?)
      ON CONFLICT(message_id,direction,agent_id) DO UPDATE SET
        conversation_id=COALESCE(excluded.conversation_id,provider_message_routes.conversation_id),
        reply_to_route_id=excluded.reply_to_route_id,status='active',updated_at=excluded.updated_at`)
      .run(routeId, messageId, clean(input.conversationId, 128) || null,
        remoteRouteId, agentId, peerUid, channelId, channelType, 'inbound',
        now + Math.max(60_000, input.ttlMs || 30 * 24 * 60 * 60 * 1000), now, now);
    return (this.getByMessage(messageId, agentId)?.route_id as string) || routeId;
  }

  recordInvalidInbound(input: { messageId: string; remoteRouteId?: string | null; agentId: string;
    peerUid: string; channelId: string; channelType?: number; }): string {
    const now = Date.now();
    const routeId = crypto.randomBytes(32).toString('base64url');
    let remoteRouteId: string | null = null;
    try { remoteRouteId = cleanRouteId(input.remoteRouteId); } catch (_) {}
    this.db.prepare(`INSERT INTO provider_message_routes
      (route_id,message_id,conversation_id,reply_to_route_id,agent_id,peer_uid,channel_id,channel_type,
       direction,status,expires_at,created_at,updated_at)
      VALUES (?,?,NULL,?,?,?,?,?,'inbound','invalid',?,?,?)
      ON CONFLICT(message_id,direction,agent_id) DO UPDATE SET
        conversation_id=NULL,reply_to_route_id=excluded.reply_to_route_id,status='invalid',updated_at=excluded.updated_at`)
      .run(routeId, clean(input.messageId, 256), remoteRouteId, clean(input.agentId, 128),
        clean(input.peerUid, 192), clean(input.channelId, 192), Number(input.channelType) === 2 ? 2 : 1,
        now + 30 * 24 * 60 * 60 * 1000, now, now);
    return (this.getByMessage(input.messageId, input.agentId)?.route_id as string) || routeId;
  }

  claimInbound(input: { messageId: string; conversationId: string; agentId: string; peerUid: string;
    channelId: string; channelType?: number; ttlMs?: number; }): boolean {
    const now = Date.now();
    const routeId = crypto.randomBytes(32).toString('base64url');
    const messageId = clean(input.messageId, 256);
    const conversationId = clean(input.conversationId, 128);
    const agentId = clean(input.agentId, 128);
    const peerUid = clean(input.peerUid, 192);
    const channelId = clean(input.channelId, 192);
    const channelType = Number(input.channelType) === 2 ? 2 : 1;
    const conversation = this.db.prepare(`SELECT 1 FROM provider_routing_conversations
      WHERE id=? AND agent_id=? AND channel_id=? AND channel_type=? AND status='active' LIMIT 1`)
      .get(conversationId, agentId, channelId, channelType);
    if (!conversation) return false;
    this.db.prepare(`UPDATE provider_message_routes SET conversation_id=?,status='active',updated_at=?
      WHERE message_id=? AND direction='inbound' AND agent_id=? AND conversation_id IS NULL
        AND peer_uid=? AND channel_id=? AND channel_type=? AND status='active'`)
      .run(conversationId, now, messageId, agentId, peerUid, channelId, channelType);
    this.db.prepare(`INSERT INTO provider_message_routes
      (route_id,message_id,conversation_id,reply_to_route_id,agent_id,peer_uid,channel_id,channel_type,
       direction,status,expires_at,created_at,updated_at)
      VALUES (?,?,?,NULL,?,?,?,?,'inbound','active',?,?,?)
      ON CONFLICT(message_id,direction,agent_id) DO NOTHING`)
      .run(routeId, messageId, conversationId, agentId, peerUid, channelId, channelType,
        now + Math.max(60_000, input.ttlMs || 30 * 24 * 60 * 60 * 1000), now, now);
    const claimed = this.db.prepare(`SELECT conversation_id,status FROM provider_message_routes
      WHERE message_id=? AND direction='inbound' AND agent_id=? LIMIT 1`).get(messageId, agentId) as any;
    return claimed?.status === 'active' && claimed?.conversation_id === conversationId;
  }

  getByMessage(messageId: string, agentId?: string): any | null {
    return this.db.prepare(`SELECT * FROM provider_message_routes WHERE message_id=?
      ${agentId ? 'AND agent_id=?' : ''} ORDER BY created_at DESC LIMIT 1`)
      .get(...(agentId ? [clean(messageId, 256), clean(agentId, 128)] : [clean(messageId, 256)])) || null;
  }

  resolvePrivateReply(input: { replyToRouteId: string; agentId: string; peerUid: string; channelId: string;
    channelType?: number; }): { route: any; conversation: RoutingConversation } | null {
    const row = this.db.prepare(`SELECT
      r.route_id AS route_id, r.message_id AS route_message_id, r.agent_id AS route_agent_id,
      r.peer_uid AS route_peer_uid, r.channel_id AS route_channel_id, r.channel_type AS route_channel_type,
      r.direction AS route_direction, r.status AS route_status, r.expires_at AS route_expires_at,
      c.id AS conversation_id, c.agent_id AS conversation_agent_id,
      c.provider_family AS conversation_provider_family,
      c.provider_instance_key AS conversation_provider_instance_key,
      c.native_session_id AS conversation_native_session_id,
      c.native_session_fingerprint AS conversation_native_session_fingerprint,
      c.channel_id AS conversation_channel_id, c.channel_type AS conversation_channel_type,
      c.origin AS conversation_origin, c.status AS conversation_status,
      c.created_at AS conversation_created_at, c.updated_at AS conversation_updated_at,
      c.last_used_at AS conversation_last_used_at
      FROM provider_message_routes r JOIN provider_routing_conversations c ON c.id=r.conversation_id
      WHERE r.route_id=? AND r.agent_id=? AND r.peer_uid=? AND r.channel_id=? AND r.channel_type=?
        AND r.direction='outbound' AND r.status='active' AND r.expires_at>? AND c.status='active' LIMIT 1`)
      .get(cleanRouteId(input.replyToRouteId, true), clean(input.agentId, 128), clean(input.peerUid, 192),
        clean(input.channelId, 192), Number(input.channelType) === 2 ? 2 : 1, Date.now()) as any;
    if (!row) return null;
    return { route: row, conversation: conversationFromAliasedRow(row) };
  }

  /** Backwards-compatible private resolver. Group callers must use inspectGroupReply(). */
  resolveReply(input: { replyToRouteId: string; agentId: string; peerUid: string; channelId: string;
    channelType?: number; }): { route: any; conversation: RoutingConversation } | null {
    if (Number(input.channelType) === 2) return null;
    return this.resolvePrivateReply(input);
  }

  inspectGroupReply(input: { replyToRouteId: string; agentId: string; channelId: string }): GroupRouteLookup {
    let routeId: string;
    try { routeId = cleanRouteId(input.replyToRouteId, true)!; }
    catch (_) { return { state: 'invalid', reason: 'malformed_route' }; }
    const row = this.db.prepare(`SELECT
      r.route_id AS route_id, r.message_id AS route_message_id, r.agent_id AS route_agent_id,
      r.peer_uid AS route_peer_uid, r.channel_id AS route_channel_id, r.channel_type AS route_channel_type,
      r.direction AS route_direction, r.status AS route_status, r.expires_at AS route_expires_at,
      c.id AS conversation_id, c.agent_id AS conversation_agent_id,
      c.provider_family AS conversation_provider_family,
      c.provider_instance_key AS conversation_provider_instance_key,
      c.native_session_id AS conversation_native_session_id,
      c.native_session_fingerprint AS conversation_native_session_fingerprint,
      c.channel_id AS conversation_channel_id, c.channel_type AS conversation_channel_type,
      c.origin AS conversation_origin, c.status AS conversation_status,
      c.created_at AS conversation_created_at, c.updated_at AS conversation_updated_at,
      c.last_used_at AS conversation_last_used_at
      FROM provider_message_routes r
      LEFT JOIN provider_routing_conversations c ON c.id=r.conversation_id
      WHERE r.route_id=? LIMIT 1`).get(routeId) as any;
    if (!row) return { state: 'invalid', reason: 'route_not_found' };
    if (String(row.route_agent_id) !== clean(input.agentId, 128)) return { state: 'other_agent' };
    const channelId = clean(input.channelId, 192);
    if (Number(row.route_channel_type) !== 2 || String(row.route_channel_id) !== channelId) {
      return { state: 'invalid', reason: 'route_scope_mismatch' };
    }
    if (row.route_direction !== 'outbound' || row.route_status !== 'active'
      || Number(row.route_expires_at) <= Date.now()) {
      return { state: 'invalid', reason: 'route_inactive' };
    }
    if (!row.conversation_id || String(row.conversation_agent_id) !== clean(input.agentId, 128)
      || Number(row.conversation_channel_type) !== 2 || String(row.conversation_channel_id) !== channelId
      || row.conversation_status !== 'active') {
      return { state: 'invalid', reason: 'conversation_scope_mismatch' };
    }
    return { state: 'valid', route: row, conversation: conversationFromAliasedRow(row) };
  }
}

function conversationFromAliasedRow(row: any): RoutingConversation {
  return {
    id: row.conversation_id, agentId: row.conversation_agent_id,
    providerFamily: row.conversation_provider_family,
    providerInstanceKey: row.conversation_provider_instance_key,
    nativeSessionId: row.conversation_native_session_id,
    nativeSessionFingerprint: row.conversation_native_session_fingerprint,
    channelId: row.conversation_channel_id, channelType: row.conversation_channel_type,
    origin: row.conversation_origin, status: row.conversation_status,
    createdAt: row.conversation_created_at, updatedAt: row.conversation_updated_at,
    lastUsedAt: row.conversation_last_used_at,
  };
}

module.exports = { MessageRouteStore, RoutingConversationStore,
  fingerprintProviderSession, getProviderSessionHmacKey, getRoutingFeaturePolicy, isRoutingFeatureEnabled,
  isRoutingPolicyEligible, normalizeProviderFamily, PRECISE_ROUTING_GREY_PROVIDERS };
