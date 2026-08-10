import type { DatabaseLike } from '../types/database';
import type { RoutingConversation } from './provider-routing';

type GroupMember = { uid?: string; role?: string };
type GroupSnapshot = {
  status?: string;
  dissolved_at?: string | null;
  dissolvedAt?: string | null;
  members?: GroupMember[];
};

export type GroupRouteResolution =
  | { state: 'absent' }
  | { state: 'ambiguous'; candidateCount: number }
  | { state: 'invalid'; reason: string }
  | { state: 'valid'; conversation: RoutingConversation; source: 'reply' | 'unique' };

type SnapshotLoader = (agentId: string, channelId: string) => Promise<GroupSnapshot>;

export class GroupMembershipSnapshotCache {
  private readonly values = new Map<string, { expiresAt: number; value: GroupSnapshot }>();
  private readonly pending = new Map<string, Promise<GroupSnapshot>>();

  constructor(private readonly load: SnapshotLoader, private readonly ttlMs = 10_000) {}

  async get(agentId: string, channelId: string): Promise<GroupSnapshot> {
    const key = String(channelId);
    const cached = this.values.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const active = this.pending.get(key);
    if (active) return active;
    const request = this.load(agentId, channelId).then((value) => {
      this.values.set(key, { value, expiresAt: Date.now() + this.ttlMs });
      return value;
    }).finally(() => {
      if (this.pending.get(key) === request) this.pending.delete(key);
    });
    this.pending.set(key, request);
    return request;
  }

  invalidate(channelId: string): void { this.values.delete(String(channelId)); }
}

export class GroupReplyRouteResolver {
  constructor(
    private readonly db: DatabaseLike,
    private readonly routes: { inspectGroupReply(input: {
      replyToRouteId: string; agentId: string; channelId: string;
    }): any },
    private readonly memberships: GroupMembershipSnapshotCache | null,
  ) {}

  async resolve(input: {
    replyToRouteId?: string | null;
    agentId: string;
    channelId: string;
    fromUid: string;
    mentionAll?: boolean;
  }): Promise<GroupRouteResolution> {
    let conversation: RoutingConversation | null = null;
    let source: 'reply' | 'unique' = 'reply';
    if (!input.replyToRouteId) {
      const rows = this.db.prepare(`SELECT * FROM provider_routing_conversations
        WHERE agent_id=? AND channel_type=2 AND channel_id=? AND status='active'
        ORDER BY last_used_at DESC, id ASC`).all(input.agentId, input.channelId) as any[];
      if (rows.length === 0) return { state: 'absent' };
      if (rows.length > 1) return { state: 'ambiguous', candidateCount: rows.length };
      const row = rows[0];
      conversation = {
        id: row.id, agentId: row.agent_id, providerFamily: row.provider_family,
        providerInstanceKey: row.provider_instance_key, nativeSessionId: row.native_session_id,
        nativeSessionFingerprint: row.native_session_fingerprint, wireConversationKey: row.wire_conversation_key,
        parentConversationId: row.parent_conversation_id, mergeStatus: row.merge_status || 'none', channelId: row.channel_id,
        channelType: row.channel_type, origin: row.origin, status: row.status,
        createdAt: row.created_at, updatedAt: row.updated_at, lastUsedAt: row.last_used_at,
      };
      source = 'unique';
    }
    if (input.replyToRouteId) {
      const inspected = this.routes.inspectGroupReply({
        replyToRouteId: input.replyToRouteId,
        agentId: input.agentId,
        channelId: input.channelId,
      });
      if (inspected.state === 'other_agent') {
        return input.mentionAll ? { state: 'absent' } : { state: 'invalid', reason: 'route_wrong_agent' };
      }
      if (inspected.state !== 'valid') return inspected;
      conversation = inspected.conversation;
    }
    if (!this.memberships) return { state: 'invalid', reason: 'membership_unavailable' };

    let snapshot: GroupSnapshot;
    try { snapshot = await this.memberships.get(input.agentId, input.channelId); }
    catch (_) { return { state: 'invalid', reason: 'membership_unavailable' }; }
    if (!snapshot || snapshot.status === 'dissolved' || snapshot.dissolved_at || snapshot.dissolvedAt) {
      return { state: 'invalid', reason: 'group_inactive' };
    }
    const members = Array.isArray(snapshot.members) ? snapshot.members : [];
    const sender = members.find((member) => String(member.uid || '') === input.fromUid);
    if (!sender) return { state: 'invalid', reason: 'sender_not_member' };
    const agent = this.db.prepare('SELECT imUid FROM agents WHERE agent_id=? LIMIT 1')
      .get(input.agentId) as { imUid?: string } | undefined;
    if (!agent?.imUid || !members.some((member) => String(member.uid || '') === agent.imUid)) {
      return { state: 'invalid', reason: 'agent_not_member' };
    }
    if (input.mentionAll && !['owner', 'admin'].includes(String(sender.role || '').toLowerCase())) {
      return { state: 'invalid', reason: 'mention_all_forbidden' };
    }
    return { state: 'valid', conversation: conversation!, source };
  }
}

module.exports = { GroupMembershipSnapshotCache, GroupReplyRouteResolver };
