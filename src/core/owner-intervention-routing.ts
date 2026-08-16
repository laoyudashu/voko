import type { DatabaseLike } from '../types/database';
import { fingerprintProviderSession, normalizeProviderFamily } from './provider-routing';

export interface InterventionCallerContext {
  providerType?: string | null;
  providerInstanceId?: string | null;
  instanceId?: string | null;
  nativeSessionId?: string | null;
  evidence?: string | null;
}

export type InterventionConversationResolution =
  | { status: 'resolved'; conversationId: string; method: 'current_turn' | 'source_message' | 'explicit' | 'unique' }
  | { status: 'selection_required'; candidateConversationIds: string[] }
  | { status: 'unavailable'; reason: 'conversation_not_found' | 'source_route_invalid' };

export function resolveOwnerInterventionConversation(db: DatabaseLike, input: {
  agentId: string;
  channelId: string;
  channelType?: number;
  caller?: InterventionCallerContext | null;
  sourceMessageId?: string | null;
  conversationId?: string | null;
}): InterventionConversationResolution {
  const agentId = String(input.agentId || '').trim();
  const channelId = String(input.channelId || '').trim();
  const channelType = Number(input.channelType) === 2 ? 2 : 1;
  const caller = input.caller;
  if (caller?.nativeSessionId && caller?.providerType && caller?.evidence) {
    try {
      const family = normalizeProviderFamily(caller.providerType);
      const fingerprint = fingerprintProviderSession(db, family, caller.nativeSessionId);
      let instance = String(caller.providerInstanceId || caller.instanceId || '').trim();
      if (!instance) {
        const agent = db.prepare('SELECT backend_instance_id FROM agents WHERE agent_id=? LIMIT 1')
          .get(agentId) as { backend_instance_id?: string | null } | undefined;
        instance = String(agent?.backend_instance_id || '').trim();
      }
      const row = db.prepare(`SELECT id FROM provider_routing_conversations
        WHERE agent_id=? AND channel_id=? AND channel_type=? AND provider_family=?
          AND provider_instance_key=? AND native_session_fingerprint=? AND status='active' LIMIT 1`)
        .get(agentId, channelId, channelType, family, instance, fingerprint) as { id?: string } | undefined;
      if (row?.id) return { status: 'resolved', conversationId: row.id, method: 'current_turn' };
    } catch (_) {}
  }
  if (input.sourceMessageId) {
    try {
      const route = db.prepare(`SELECT conversation_id FROM provider_message_routes
        WHERE message_id=? AND agent_id=? AND channel_id=? AND channel_type=? AND status='active'
        ORDER BY created_at DESC LIMIT 1`).get(String(input.sourceMessageId), agentId, channelId, channelType) as any;
      if (route?.conversation_id) return { status: 'resolved', conversationId: route.conversation_id, method: 'source_message' };
    } catch (_) {}
  }
  if (input.conversationId) {
    try {
      const row = db.prepare(`SELECT id FROM provider_routing_conversations
        WHERE id=? AND agent_id=? AND channel_id=? AND channel_type=? AND status IN ('pending','active') LIMIT 1`)
        .get(String(input.conversationId), agentId, channelId, channelType) as { id?: string } | undefined;
      return row?.id
        ? { status: 'resolved', conversationId: row.id, method: 'explicit' }
        : { status: 'unavailable', reason: 'conversation_not_found' };
    } catch (_) { return { status: 'unavailable', reason: 'conversation_not_found' }; }
  }
  let candidates: Array<{ id: string }> = [];
  try {
    candidates = db.prepare(`SELECT id FROM provider_routing_conversations
      WHERE agent_id=? AND channel_id=? AND channel_type=? AND status='active'
      ORDER BY last_used_at DESC,id ASC`).all(agentId, channelId, channelType) as Array<{ id: string }>;
  } catch (_) {}
  if (candidates.length === 1) return { status: 'resolved', conversationId: candidates[0].id, method: 'unique' };
  if (candidates.length > 1) return { status: 'selection_required', candidateConversationIds: candidates.map(row => row.id) };
  return { status: 'unavailable', reason: input.sourceMessageId ? 'source_route_invalid' : 'conversation_not_found' };
}
