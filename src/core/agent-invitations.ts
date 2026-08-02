const crypto = require('crypto');
const { getPrimaryOwnerEmail, getUserAccessToken } = require('./database');
import type { DatabaseLike } from '../types/database';

type JsonRecord = Record<string, any>;

interface AgentRow {
  agent_id: string;
  owner_email?: string | null;
  did?: string | null;
}

interface SyncEvent {
  eventId?: string;
  event_id?: string;
  operation?: string;
  listType?: string;
  list_type?: string;
  visitorId?: string;
  visitor_id?: string;
  reason?: string;
  sourceInvitationId?: string;
  source_invitation_id?: string;
}

const CURSOR_CONFIG_TYPE = 'agent_access_sync_cursors';
const SERVER_INVITATION_REASON = 'server_invitation';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeBaseUrl(value: unknown): string {
  return String(value || '').replace(/\/+$/, '');
}

function readJson(responseText: string): JsonRecord | null {
  try {
    const value = JSON.parse(responseText);
    return value && typeof value === 'object' ? value : null;
  } catch (_) {
    return null;
  }
}

function serverAgentIdFromDid(did: unknown): string | null {
  const tail = String(did || '').split(':').pop() || '';
  const hex = tail.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`.toLowerCase();
}

function getAgentToken(db: DatabaseLike, agentId: string): { token: string; email: string; serverAgentId: string } {
  const agent = db.prepare('SELECT agent_id, owner_email, did FROM agents WHERE agent_id=?')
    .get<AgentRow>(agentId);
  if (!agent) throw new Error('Agent 不存在');
  const email = String(agent.owner_email || getPrimaryOwnerEmail(db) || '').trim().toLowerCase();
  const token = email ? getUserAccessToken(db, email) : null;
  if (!token) throw new Error('未找到当前用户的 User Access Token，请重新登录');
  if (!String(token).startsWith('ut_')) throw new Error('当前凭证不是有效的 User Access Token，请重新登录');
  return { token, email, serverAgentId: serverAgentIdFromDid(agent.did) || agentId };
}

async function requestJson(
  apiBaseUrl: string,
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<{ status: number; payload: JsonRecord }> {
  const response = await fetch(normalizeBaseUrl(apiBaseUrl) + path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
    signal: init.signal || AbortSignal.timeout(15000),
  });
  const text = await response.text();
  const payload = readJson(text);
  if (!payload) throw new Error(`邀请服务返回了无效响应 (HTTP ${response.status})`);
  if (!response.ok || payload.success === false) {
    const error = new Error(String(payload.message || payload.error || `HTTP ${response.status}`)) as Error & {
      status?: number;
      code?: string;
    };
    error.status = response.status;
    error.code = String(payload.code || payload.errorCode || payload.error_code || '');
    throw error;
  }
  return { status: response.status, payload };
}

function resultData(payload: JsonRecord): JsonRecord {
  return payload.data && typeof payload.data === 'object' ? payload.data : payload;
}

async function createAgentInvitation({
  db,
  apiBaseUrl,
  agentId,
  email,
}: {
  db: DatabaseLike;
  apiBaseUrl: string;
  agentId: string;
  email: string;
}): Promise<JsonRecord> {
  if (!agentId) return { success: false, error: '缺少 agentId' };
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    return { success: false, error: '好友邮箱格式无效' };
  }
  try {
    const { token, email: ownerEmail } = getAgentToken(db, agentId);
    if (normalizedEmail === ownerEmail) return { success: false, error: '不能邀请自己的邮箱' };
    const { payload } = await requestJson(apiBaseUrl, '/api/external/v1/agent-invitations', token, {
      method: 'POST',
      body: JSON.stringify({ inviterAgentId: agentId, email: normalizedEmail }),
    });
    const data = resultData(payload);
    const result = String(data.result || payload.result || '');
    if (!['already_registered', 'invitation_created', 'invitation_resent', 'email_failed'].includes(result)) {
      return { success: false, error: '邀请服务返回了未知结果' };
    }
    return {
      success: true,
      result,
      email: normalizedEmail,
      invitationId: data.invitationId || data.id || null,
      emailSent: result !== 'email_failed',
      data,
    };
  } catch (error: unknown) {
    return { success: false, error: errorMessage(error) };
  }
}

function loadCursorMap(db: DatabaseLike): Record<string, string> {
  try {
    const row = db.prepare('SELECT data FROM config WHERE type=?').get<{ data?: string }>(CURSOR_CONFIG_TYPE);
    const parsed = row?.data ? JSON.parse(row.data) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function saveCursor(db: DatabaseLike, agentId: string, cursor: unknown): void {
  const map = loadCursorMap(db);
  if (cursor === null || cursor === undefined || cursor === '') delete map[agentId];
  else map[agentId] = String(cursor);
  db.prepare('INSERT OR REPLACE INTO config (type,data,updated_at) VALUES (?,?,?)')
    .run(CURSOR_CONFIG_TYPE, JSON.stringify(map), Date.now());
}

function normalizeRelation(item: JsonRecord): { listType: string; visitorId: string; reason: string } | null {
  const listType = String(item.listType || item.list_type || '');
  const visitorId = String(item.visitorId || item.visitor_id || '');
  if (!visitorId || !['whitelist', 'blacklist'].includes(listType)) return null;
  return {
    listType,
    visitorId,
    reason: String(item.reason || SERVER_INVITATION_REASON),
  };
}

function applyEvents(db: DatabaseLike, agentId: string, items: SyncEvent[]): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const item of items) {
      const relation = normalizeRelation(item as JsonRecord);
      if (!relation) throw new Error('访问同步事件字段不完整');
      const operation = String(item.operation || 'upsert');
      if (operation === 'delete') {
        db.prepare(`DELETE FROM agent_access_lists
          WHERE agent_id=? AND list_type=? AND visitor_id=?
            AND server_managed=1 AND manual_managed=0`)
          .run(agentId, relation.listType, relation.visitorId);
        db.prepare(`UPDATE agent_access_lists
          SET server_managed=0, server_source_invitation_id=NULL, updated_at=?
          WHERE agent_id=? AND list_type=? AND visitor_id=?
            AND server_managed=1 AND manual_managed=1`)
          .run(Date.now(), agentId, relation.listType, relation.visitorId);
        continue;
      }
      if (operation !== 'upsert') throw new Error(`未知访问同步操作: ${operation}`);
      const now = Date.now();
      db.prepare(`INSERT INTO agent_access_lists
        (id,agent_id,list_type,visitor_id,reason,manual_managed,server_managed,server_source_invitation_id,created_at,updated_at)
        VALUES (?,?,?,?,?,0,1,?,?,?)
        ON CONFLICT(agent_id,list_type,visitor_id)
        DO UPDATE SET
          server_managed=1,
          server_source_invitation_id=excluded.server_source_invitation_id,
          reason=CASE WHEN agent_access_lists.manual_managed=1 THEN agent_access_lists.reason ELSE excluded.reason END,
          updated_at=excluded.updated_at`)
        .run(
          crypto.randomUUID(),
          agentId,
          relation.listType,
          relation.visitorId,
          relation.reason,
          String(item.sourceInvitationId || item.source_invitation_id || '') || null,
          now,
          now,
        );
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw error;
  }
}

async function acknowledgeEvents(
  apiBaseUrl: string,
  token: string,
  agentId: string,
  eventIds: string[],
): Promise<void> {
  await requestJson(apiBaseUrl, '/api/external/v1/agent-access-sync/ack', token, {
    method: 'POST',
    body: JSON.stringify({ agentId, eventIds }),
  });
}

async function reconcileSnapshot(
  db: DatabaseLike,
  apiBaseUrl: string,
  token: string,
  localAgentId: string,
  serverAgentId = localAgentId,
): Promise<number> {
  const { payload } = await requestJson(
    apiBaseUrl,
    `/api/external/v1/agent-access-relations?agentId=${encodeURIComponent(serverAgentId)}`,
    token,
  );
  const data = resultData(payload);
  const rawItems = Array.isArray(payload.data)
    ? payload.data
    : (Array.isArray(data.items) ? data.items : (Array.isArray(data.relations) ? data.relations : []));
  const relations = rawItems.map(normalizeRelation).filter(Boolean) as Array<{
    listType: string;
    visitorId: string;
    reason: string;
  }>;
  const keep = new Set(relations.map((item) => `${item.listType}\u0000${item.visitorId}`));

  db.exec('BEGIN IMMEDIATE');
  try {
    const current = db.prepare(`SELECT list_type,visitor_id,manual_managed FROM agent_access_lists
      WHERE agent_id=? AND server_managed=1`).all<{
      list_type: string;
      visitor_id: string;
      manual_managed: number;
    }>(localAgentId);
    for (const row of current) {
      if (!keep.has(`${row.list_type}\u0000${row.visitor_id}`)) {
        if (row.manual_managed) {
          db.prepare(`UPDATE agent_access_lists
            SET server_managed=0, server_source_invitation_id=NULL, updated_at=?
            WHERE agent_id=? AND list_type=? AND visitor_id=?`)
            .run(Date.now(), localAgentId, row.list_type, row.visitor_id);
        } else {
          db.prepare(`DELETE FROM agent_access_lists
            WHERE agent_id=? AND list_type=? AND visitor_id=?`)
            .run(localAgentId, row.list_type, row.visitor_id);
        }
      }
    }
    for (const relation of relations) {
      const now = Date.now();
      db.prepare(`INSERT INTO agent_access_lists
        (id,agent_id,list_type,visitor_id,reason,manual_managed,server_managed,created_at,updated_at)
        VALUES (?,?,?,?,?,0,1,?,?)
        ON CONFLICT(agent_id,list_type,visitor_id)
        DO UPDATE SET
          server_managed=1,
          reason=CASE WHEN agent_access_lists.manual_managed=1 THEN agent_access_lists.reason ELSE excluded.reason END,
          updated_at=excluded.updated_at`)
        .run(crypto.randomUUID(), localAgentId, relation.listType, relation.visitorId, relation.reason, now, now);
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw error;
  }
  saveCursor(db, localAgentId, null);
  return relations.length;
}

function isCursorError(error: unknown): boolean {
  const candidate = error as { status?: number; code?: string };
  return candidate?.status === 409
    || candidate?.status === 410
    || /cursor.*(?:invalid|expired|lost)|(?:invalid|expired).*cursor/i.test(String(candidate?.code || errorMessage(error)));
}

async function syncAgentAccess({
  db,
  apiBaseUrl,
  agentId,
  limit = 100,
}: {
  db: DatabaseLike;
  apiBaseUrl: string;
  agentId: string;
  limit?: number;
}): Promise<{ success: boolean; applied?: number; snapshot?: boolean; skipped?: boolean; error?: string }> {
  let serverAgentId = agentId;
  try {
    const credentials = getAgentToken(db, agentId);
    const { token } = credentials;
    serverAgentId = credentials.serverAgentId;
    const cursorMap = loadCursorMap(db);
    const hasCursor = Object.prototype.hasOwnProperty.call(cursorMap, agentId);
    if (!hasCursor) await reconcileSnapshot(db, apiBaseUrl, token, agentId, serverAgentId);
    let cursor = hasCursor ? cursorMap[agentId] : '';
    let applied = 0;
    do {
      const query = new URLSearchParams({ agentId: serverAgentId, limit: String(limit) });
      if (cursor) query.set('cursor', cursor);
      let payload: JsonRecord;
      try {
        ({ payload } = await requestJson(
          apiBaseUrl,
          `/api/external/v1/agent-access-sync?${query.toString()}`,
          token,
        ));
      } catch (error: unknown) {
        if (!isCursorError(error)) throw error;
        const count = await reconcileSnapshot(db, apiBaseUrl, token, agentId, serverAgentId);
        return { success: true, applied: count, snapshot: true };
      }
      const data = resultData(payload);
      const items = Array.isArray(data.items) ? data.items as SyncEvent[] : [];
      const nextCursor = data.nextCursor ?? data.next_cursor ?? cursor;
      const eventIds = items
        .map((item) => String(item.eventId || item.event_id || ''))
        .filter(Boolean);
      if (eventIds.length !== items.length) throw new Error('访问同步事件缺少 eventId');
      if (items.length) {
        applyEvents(db, agentId, items);
        await acknowledgeEvents(apiBaseUrl, token, serverAgentId, eventIds);
        applied += items.length;
      }
      saveCursor(db, agentId, nextCursor);
      cursor = String(nextCursor || '');
      if (!data.hasMore && !data.has_more) break;
      if (!items.length) throw new Error('访问同步返回 hasMore 但没有事件');
    } while (true);
    return { success: true, applied };
  } catch (error: unknown) {
    if (/^agent not found$/i.test(errorMessage(error).trim())) {
      if (serverAgentId !== agentId) return { success: false, error: `服务端 Agent ${serverAgentId} 不存在` };
      return { success: true, applied: 0, skipped: true };
    }
    return { success: false, error: errorMessage(error) };
  }
}

function startAgentAccessSync({
  db,
  apiBaseUrl,
  intervalMs = 60000,
}: {
  db: DatabaseLike;
  apiBaseUrl: string;
  intervalMs?: number;
}): () => void {
  let stopped = false;
  let running = false;
  const lastErrors = new Map<string, string>();
  const unsupportedAgents = new Set<string>();
  const run = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const agents = db.prepare(`SELECT agent_id,owner_email FROM agents
        WHERE owner_email IS NOT NULL AND TRIM(owner_email)!=''`).all<AgentRow>();
      for (const agent of agents) {
        if (unsupportedAgents.has(agent.agent_id)) continue;
        if (!getUserAccessToken(db, agent.owner_email)) continue;
        const result = await syncAgentAccess({ db, apiBaseUrl, agentId: agent.agent_id });
        if (result.success) {
          lastErrors.delete(agent.agent_id);
          if (result.skipped) unsupportedAgents.add(agent.agent_id);
        } else {
          const error = result.error || '同步失败';
          if (lastErrors.get(agent.agent_id) === error) continue;
          lastErrors.set(agent.agent_id, error);
          console.warn(`[AccessSync] agent=${agent.agent_id} ${error}`);
        }
      }
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(() => { void run(); }, intervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

module.exports = {
  CURSOR_CONFIG_TYPE,
  serverAgentIdFromDid,
  SERVER_INVITATION_REASON,
  createAgentInvitation,
  syncAgentAccess,
  reconcileSnapshot,
  startAgentAccessSync,
};
