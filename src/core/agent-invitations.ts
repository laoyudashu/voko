const crypto = require('crypto');
const { getPrimaryOwnerEmail, getUserAccessToken } = require('./database');
const {
  clearCheckpoint,
  commitCheckpoint,
  getCheckpoint,
  setCheckpoint,
  stageCheckpoint,
} = require('./checkpoint-store');
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
const CHECKPOINT_NAMESPACE = 'access_sync';
const SERVER_INVITATION_REASON = 'server_invitation';
const MAX_BATCH_AGENTS = 50;
const MAX_BATCH_EVENT_IDS = 200;
const MAX_UNSIGNED_BIGINT = 18446744073709551615n;
const batchSupport = new Map<string, boolean>();

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

export { serverAgentIdFromDid };

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

function saveLegacyCursor(db: DatabaseLike, agentId: string, cursor: unknown): void {
  const map = loadCursorMap(db);
  if (cursor === null || cursor === undefined || cursor === '') delete map[agentId];
  else map[agentId] = String(cursor);
  db.prepare('INSERT OR REPLACE INTO config (type,data,updated_at) VALUES (?,?,?)')
    .run(CURSOR_CONFIG_TYPE, JSON.stringify(map), Date.now());
}

function saveCursor(db: DatabaseLike, agentId: string, cursor: unknown): void {
  if (cursor === null || cursor === undefined || cursor === '') {
    clearCheckpoint(db, CHECKPOINT_NAMESPACE, agentId);
  } else {
    setCheckpoint(db, CHECKPOINT_NAMESPACE, agentId, 'opaque', cursor);
  }
  saveLegacyCursor(db, agentId, cursor);
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

function applyEvents(
  db: DatabaseLike,
  agentId: string,
  items: SyncEvent[],
  nextCursor: unknown,
  eventIds: string[],
): void {
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
    stageCheckpoint(db, CHECKPOINT_NAMESPACE, agentId, 'opaque', nextCursor, { eventIds });
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

function applySnapshotRelations(
  db: DatabaseLike,
  localAgentId: string,
  rawItems: JsonRecord[],
): number {
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
  return applySnapshotRelations(db, localAgentId, rawItems as JsonRecord[]);
}

function isCursorError(error: unknown): boolean {
  const candidate = error as { status?: number; code?: string };
  const detail = String(candidate?.code || errorMessage(error));
  return candidate?.status === 409
    || candidate?.status === 410
    || (candidate?.status === 400 && /cursor/i.test(detail))
    || /cursor.*(?:invalid|expired|lost)|(?:invalid|expired).*cursor/i.test(detail);
}

function isBatchUnsupported(error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  return status === 404 || status === 405;
}

async function requestAccessSyncBatch(
  apiBaseUrl: string,
  token: string,
  agents: Array<{ agentId: string; cursor: string }>,
  limit: number,
): Promise<JsonRecord> {
  const { payload } = await requestJson(apiBaseUrl, '/api/external/v1/agent-access-sync/batch', token, {
    method: 'POST',
    body: JSON.stringify({ agents, limit }),
  });
  return resultData(payload);
}

async function acknowledgeEventsBatch(
  apiBaseUrl: string,
  token: string,
  agents: Array<{ agentId: string; eventIds: string[] }>,
): Promise<JsonRecord> {
  const { payload } = await requestJson(apiBaseUrl, '/api/external/v1/agent-access-sync/batch/ack', token, {
    method: 'POST',
    body: JSON.stringify({ agents }),
  });
  return resultData(payload);
}

/**
 * ACK entries are merged by remote Agent ID before being sent. The server
 * intentionally rejects more than 200 unique IDs per Agent, so a duplicate
 * remote ID is split across sequential requests instead of being put twice
 * in one request.
 */
async function acknowledgeBatchEntries(
  apiBaseUrl: string,
  token: string,
  entries: Array<{ context: { serverAgentId: string }; eventIds: string[] }>,
): Promise<Map<string, boolean>> {
  const groups = new Map<string, { agentId: string; eventIds: string[]; offset: number; success: boolean }>();
  for (const entry of entries) {
    const agentId = entry.context.serverAgentId;
    const group = groups.get(agentId) || { agentId, eventIds: [], offset: 0, success: true };
    const known = new Set(group.eventIds);
    for (const eventId of entry.eventIds) {
      if (!known.has(eventId)) {
        known.add(eventId);
        group.eventIds.push(eventId);
      }
    }
    groups.set(agentId, group);
  }
  const pending = [...groups.values()];
  while (pending.some((group) => group.success && group.offset < group.eventIds.length)) {
    const round = pending
      .filter((group) => group.success && group.offset < group.eventIds.length)
      .slice(0, MAX_BATCH_AGENTS);
    if (!round.length) break;
    const data = await acknowledgeEventsBatch(apiBaseUrl, token, round.map((group) => ({
      agentId: group.agentId,
      eventIds: group.eventIds.slice(group.offset, group.offset + MAX_BATCH_EVENT_IDS),
    })));
    const resultMap = agentResultMap(data);
    for (const group of round) {
      const result = resultMap.get(group.agentId);
      if (!result || result.success === false) {
        group.success = false;
        continue;
      }
      group.offset += Math.min(MAX_BATCH_EVENT_IDS, group.eventIds.length - group.offset);
    }
  }
  return new Map([...groups.values()].map((group) => [group.agentId, group.success]));
}

async function requestAccessRelationsBatch(
  apiBaseUrl: string,
  token: string,
  agentIds: string[],
): Promise<JsonRecord> {
  const { payload } = await requestJson(apiBaseUrl, '/api/external/v1/agent-access-relations/batch', token, {
    method: 'POST',
    body: JSON.stringify({ agentIds }),
  });
  return resultData(payload);
}

function getCheckpointState(db: DatabaseLike, agentId: string): JsonRecord | null {
  const cursorMap = loadCursorMap(db);
  let checkpoint = getCheckpoint(db, CHECKPOINT_NAMESPACE, agentId);
  if (!checkpoint && Object.prototype.hasOwnProperty.call(cursorMap, agentId)) {
    setCheckpoint(db, CHECKPOINT_NAMESPACE, agentId, 'opaque', cursorMap[agentId]);
    checkpoint = getCheckpoint(db, CHECKPOINT_NAMESPACE, agentId);
  }
  return checkpoint as JsonRecord | null;
}

function pendingEventIds(checkpoint: JsonRecord | null): string[] {
  if (!checkpoint || checkpoint.pendingValue === null || checkpoint.pendingValue === undefined) return [];
  let pendingMeta: { eventIds?: string[] } = {};
  try { pendingMeta = checkpoint.pendingMeta ? JSON.parse(checkpoint.pendingMeta) : {}; } catch (_) {}
  return Array.isArray(pendingMeta.eventIds) ? pendingMeta.eventIds.map(String).filter(Boolean) : [];
}

function agentResultMap(data: JsonRecord): Map<string, JsonRecord> {
  const items = Array.isArray(data.agents) ? data.agents : [];
  return new Map(items
    .filter((item) => item && typeof item === 'object')
    .map((item) => [String(item.agentId || ''), item]));
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function normalizeBatchLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 200) return 100;
  return parsed;
}

function normalizeBatchCursor(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return '0';
  const text = String(value).trim();
  if (!/^(0|[1-9]\d*)$/.test(text)) return null;
  try {
    const cursor = BigInt(text);
    return cursor <= MAX_UNSIGNED_BIGINT ? cursor.toString() : null;
  } catch (_) {
    return null;
  }
}

function maxBatchCursor(left: string, right: string): string {
  const leftValue = normalizeBatchCursor(left);
  const rightValue = normalizeBatchCursor(right);
  if (leftValue === null || rightValue === null) throw new Error('Invalid cursor');
  return BigInt(leftValue) >= BigInt(rightValue) ? leftValue : rightValue;
}

function isBatchSafeId(value: string): boolean {
  return value.length > 0 && value.length <= 64 && /^[A-Za-z0-9_-]+$/.test(value);
}

type BatchAgentResult = {
  agentId: string;
  success: boolean;
  applied?: number;
  skipped?: boolean;
  error?: string;
};

type BatchSyncResult = {
  success: boolean;
  applied: number;
  agents: BatchAgentResult[];
  fallback?: boolean;
  error?: string;
};

function setBatchAgentError(
  context: { agentId: string; serverAgentId: string },
  result: BatchAgentResult | undefined,
  error: unknown,
): void {
  if (!result) return;
  const message = String(error || 'Agent not found');
  if (context.agentId === context.serverAgentId && /^agent not found$/i.test(message.trim())) {
    result.success = true;
    result.skipped = true;
    result.error = undefined;
    return;
  }
  result.success = false;
  result.error = message;
}

async function syncAgentAccessBatch({
  db,
  apiBaseUrl,
  agentIds,
  limit = 100,
}: {
  db: DatabaseLike;
  apiBaseUrl: string;
  agentIds: string[];
  limit?: number;
}): Promise<BatchSyncResult> {
  const ids = [...new Set(agentIds.map(String).filter(Boolean))];
  if (!ids.length) return { success: true, applied: 0, agents: [] };
  const safeLimit = normalizeBatchLimit(limit);
  const token = getAgentToken(db, ids[0]).token;
  const contexts = ids.map((agentId) => {
    const credentials = getAgentToken(db, agentId);
    return {
      agentId,
      serverAgentId: credentials.serverAgentId,
      checkpoint: getCheckpointState(db, agentId),
      applied: 0,
    };
  });
  const results = new Map<string, BatchAgentResult>(contexts.map((context) => [
    context.agentId,
    { agentId: context.agentId, success: true, applied: 0 },
  ]));
  const baseKey = normalizeBaseUrl(apiBaseUrl);
  if (contexts.some((context) => !isBatchSafeId(context.serverAgentId))) {
    const fallbackResults: BatchAgentResult[] = [];
    for (const agentId of ids) {
      const result = await syncAgentAccess({ db, apiBaseUrl, agentId, limit: safeLimit });
      fallbackResults.push({ agentId, ...result });
    }
    return {
      success: fallbackResults.every((result) => result.success),
      applied: fallbackResults.reduce((sum, result) => sum + Number(result.applied || 0), 0),
      agents: fallbackResults,
      fallback: true,
    };
  }
  if (batchSupport.get(baseKey) === false) {
    const fallbackResults: BatchAgentResult[] = [];
    for (const agentId of ids) {
      const result = await syncAgentAccess({ db, apiBaseUrl, agentId, limit: safeLimit });
      fallbackResults.push({ agentId, ...result });
    }
    return {
      success: fallbackResults.every((result) => result.success),
      applied: fallbackResults.reduce((sum, result) => sum + Number(result.applied || 0), 0),
      agents: fallbackResults,
      fallback: true,
    };
  }

  try {
    const pending = contexts
      .map((context) => ({ context, eventIds: pendingEventIds(context.checkpoint) }))
      .filter((item) => item.eventIds.length);
    const commitPending = (context: typeof contexts[number]) => {
      const checkpoint = context.checkpoint;
      commitCheckpoint(db, CHECKPOINT_NAMESPACE, context.agentId);
      saveLegacyCursor(db, context.agentId, checkpoint?.pendingValue);
      context.checkpoint = getCheckpointState(db, context.agentId);
    };
    if (pending.length) {
      const legacyPending = pending.filter(({ eventIds }) => eventIds.some((eventId) => !isBatchSafeId(eventId)));
      for (const { context, eventIds } of legacyPending) {
        await acknowledgeEvents(apiBaseUrl, token, context.serverAgentId, eventIds);
        commitPending(context);
      }
      const batchPending = pending.filter(({ eventIds }) => eventIds.every(isBatchSafeId));
      if (batchPending.length) {
        const ackResults = await acknowledgeBatchEntries(
          apiBaseUrl,
          token,
          batchPending.map(({ context, eventIds }) => ({ context, eventIds })),
        );
        for (const { context } of batchPending) {
          if (!ackResults.get(context.serverAgentId)) {
            const result = results.get(context.agentId);
            if (result) {
              result.success = false;
              result.error = 'AccessSync pending ack failed';
            }
          } else {
            commitPending(context);
          }
        }
      }
    }

    const ready = contexts.filter((context) => results.get(context.agentId)?.success !== false);
    const snapshotDone = new Set<string>();
    const invalidCursor = ready.filter((context) => {
      const committed = context.checkpoint?.committedValue;
      return committed !== null && committed !== undefined && normalizeBatchCursor(committed) === null;
    });
    for (const context of invalidCursor) {
      try {
        await reconcileSnapshot(db, apiBaseUrl, token, context.agentId, context.serverAgentId);
        context.checkpoint = getCheckpointState(db, context.agentId);
        snapshotDone.add(context.agentId);
      } catch (error: unknown) {
        setBatchAgentError(context, results.get(context.agentId), errorMessage(error));
      }
    }
    const withoutCursor = ready.filter((context) => (
      !snapshotDone.has(context.agentId)
      && (context.checkpoint?.committedValue === null || context.checkpoint?.committedValue === undefined)
    ));
    if (withoutCursor.length) {
      for (const chunk of chunkArray(withoutCursor, MAX_BATCH_AGENTS)) {
        let snapshotData: JsonRecord;
        try {
          snapshotData = await requestAccessRelationsBatch(
            apiBaseUrl,
            token,
            chunk.map((context) => context.serverAgentId),
          );
        } catch (error: unknown) {
          if (isBatchUnsupported(error)) {
            batchSupport.set(baseKey, false);
            const fallbackResults: BatchAgentResult[] = [];
            for (const agentId of ids) {
              const result = await syncAgentAccess({ db, apiBaseUrl, agentId, limit: safeLimit });
              fallbackResults.push({ agentId, ...result });
            }
            return {
              success: fallbackResults.every((result) => result.success),
              applied: fallbackResults.reduce((sum, result) => sum + Number(result.applied || 0), 0),
              agents: fallbackResults,
              fallback: true,
            };
          }
          throw error;
        }
        const snapshots = agentResultMap(snapshotData);
        for (const context of chunk) {
          const snapshot = snapshots.get(context.serverAgentId);
          const result = results.get(context.agentId);
          if (!snapshot || snapshot.success === false) {
            setBatchAgentError(context, result, snapshot?.message || snapshot?.error || 'Agent not found');
            continue;
          }
          const count = applySnapshotRelations(
            db,
            context.agentId,
            (Array.isArray(snapshot.relations) ? snapshot.relations : []) as JsonRecord[],
          );
          context.checkpoint = getCheckpointState(db, context.agentId);
          if (result) result.applied = Number(result.applied || 0) + count;
        }
      }
    }

    let active = ready.filter((context) => results.get(context.agentId)?.success !== false);
    while (active.length) {
      const nextActive = [] as typeof contexts;
      for (const chunk of chunkArray(active, MAX_BATCH_AGENTS)) {
        const data = await requestAccessSyncBatch(
          apiBaseUrl,
          token,
          chunk.map((context) => ({
            agentId: context.serverAgentId,
            cursor: normalizeBatchCursor(context.checkpoint?.committedValue) || '0',
          })),
          safeLimit,
        );
        const responseMap = agentResultMap(data);
        const staged = [] as Array<{ context: typeof contexts[number]; eventIds: string[]; nextCursor: string }>;
        const chunkNextActive = [] as typeof contexts;
        for (const context of chunk) {
          const page = responseMap.get(context.serverAgentId);
          const result = results.get(context.agentId);
          if (!page || page.success === false) {
            setBatchAgentError(context, result, page?.message || page?.error || 'Agent not found');
            continue;
          }
          const items = Array.isArray(page.items) ? page.items as SyncEvent[] : [];
          const cursor = normalizeBatchCursor(context.checkpoint?.committedValue) || '0';
          const serverNextCursor = normalizeBatchCursor(page.nextCursor ?? page.next_cursor ?? cursor);
          if (serverNextCursor === null) throw new Error('Invalid cursor');
          const nextCursor = maxBatchCursor(cursor, serverNextCursor);
          const eventIds = items.map((item) => String(item.eventId || item.event_id || '')).filter(Boolean);
          if (eventIds.length !== items.length) throw new Error('璁块棶鍚屾浜嬩欢缂哄皯 eventId');
          if (items.length) {
            applyEvents(db, context.agentId, items, nextCursor, eventIds);
            staged.push({ context, eventIds, nextCursor });
            if (result) result.applied = Number(result.applied || 0) + items.length;
          } else {
            saveCursor(db, context.agentId, nextCursor);
            context.checkpoint = getCheckpointState(db, context.agentId);
          }
          if (page.hasMore || page.has_more) {
            if (!items.length) throw new Error('访问同步返回 hasMore 但没有事件');
            chunkNextActive.push(context);
          }
        }
        if (staged.length) {
          const batchAck = staged.filter(({ eventIds }) => eventIds.every(isBatchSafeId));
          const legacyAck = staged.filter(({ eventIds }) => eventIds.some((eventId) => !isBatchSafeId(eventId)));
          for (const { context, eventIds, nextCursor } of legacyAck) {
            await acknowledgeEvents(apiBaseUrl, token, context.serverAgentId, eventIds);
            commitCheckpoint(db, CHECKPOINT_NAMESPACE, context.agentId);
            saveLegacyCursor(db, context.agentId, nextCursor);
            context.checkpoint = getCheckpointState(db, context.agentId);
          }
          if (batchAck.length) {
            const ackResults = await acknowledgeBatchEntries(
              apiBaseUrl,
              token,
              batchAck.map(({ context, eventIds }) => ({ context, eventIds })),
            );
            for (const { context, nextCursor } of batchAck) {
              const result = results.get(context.agentId);
              if (!ackResults.get(context.serverAgentId)) {
                if (result) {
                  result.success = false;
                  result.error = 'AccessSync ack failed';
                }
                continue;
              }
              commitCheckpoint(db, CHECKPOINT_NAMESPACE, context.agentId);
              saveLegacyCursor(db, context.agentId, nextCursor);
              context.checkpoint = getCheckpointState(db, context.agentId);
            }
          }
        }
        nextActive.push(...chunkNextActive);
      }
      active = nextActive.filter((context) => results.get(context.agentId)?.success !== false);
    }
  } catch (error: unknown) {
    if (isBatchUnsupported(error)) {
      batchSupport.set(baseKey, false);
      const fallbackResults: BatchAgentResult[] = [];
      for (const agentId of ids) {
        const result = await syncAgentAccess({ db, apiBaseUrl, agentId, limit: safeLimit });
        fallbackResults.push({ agentId, ...result });
      }
      return {
        success: fallbackResults.every((result) => result.success),
        applied: fallbackResults.reduce((sum, result) => sum + Number(result.applied || 0), 0),
        agents: fallbackResults,
        fallback: true,
      };
    }
    if (isCursorError(error)) {
      for (const context of contexts) {
        const result = results.get(context.agentId);
        if (!result || !result.success) continue;
        try {
          const count = await reconcileSnapshot(db, apiBaseUrl, token, context.agentId, context.serverAgentId);
          result.applied = Number(result.applied || 0) + count;
          context.checkpoint = getCheckpointState(db, context.agentId);
        } catch (snapshotError: unknown) {
          setBatchAgentError(context, result, errorMessage(snapshotError));
        }
      }
      const recoveredResults = [...results.values()];
      return {
        success: recoveredResults.every((result) => result.success),
        applied: recoveredResults.reduce((sum, result) => sum + Number(result.applied || 0), 0),
        agents: recoveredResults,
      };
    }
    return { success: false, applied: 0, agents: ids.map((agentId) => ({ agentId, success: false, error: errorMessage(error) })), error: errorMessage(error) };
  }
  const agentResults = [...results.values()];
  return {
    success: agentResults.every((result) => result.success),
    applied: agentResults.reduce((sum, result) => sum + Number(result.applied || 0), 0),
    agents: agentResults,
  };
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
    let checkpoint = getCheckpoint(db, CHECKPOINT_NAMESPACE, agentId);
    if (!checkpoint && Object.prototype.hasOwnProperty.call(cursorMap, agentId)) {
      setCheckpoint(db, CHECKPOINT_NAMESPACE, agentId, 'opaque', cursorMap[agentId]);
      checkpoint = getCheckpoint(db, CHECKPOINT_NAMESPACE, agentId);
    }
    if (checkpoint?.pendingValue !== null && checkpoint?.pendingValue !== undefined) {
      let pendingMeta: { eventIds?: string[] } = {};
      try { pendingMeta = checkpoint.pendingMeta ? JSON.parse(checkpoint.pendingMeta) : {}; } catch (_) {}
      const pendingEventIds = Array.isArray(pendingMeta.eventIds) ? pendingMeta.eventIds.map(String).filter(Boolean) : [];
      if (!pendingEventIds.length) throw new Error('AccessSync pending checkpoint 缺少 eventIds');
      await acknowledgeEvents(apiBaseUrl, token, serverAgentId, pendingEventIds);
      commitCheckpoint(db, CHECKPOINT_NAMESPACE, agentId);
      saveLegacyCursor(db, agentId, checkpoint.pendingValue);
      checkpoint = getCheckpoint(db, CHECKPOINT_NAMESPACE, agentId);
    }
    const hasCursor = checkpoint?.committedValue !== null && checkpoint?.committedValue !== undefined;
    if (!hasCursor) await reconcileSnapshot(db, apiBaseUrl, token, agentId, serverAgentId);
    let cursor = hasCursor ? String(checkpoint?.committedValue || '') : '';
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
        applyEvents(db, agentId, items, nextCursor, eventIds);
        await acknowledgeEvents(apiBaseUrl, token, serverAgentId, eventIds);
        commitCheckpoint(db, CHECKPOINT_NAMESPACE, agentId);
        saveLegacyCursor(db, agentId, nextCursor);
        applied += items.length;
      } else {
        saveCursor(db, agentId, nextCursor);
      }
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
  initialDelayMs = 15000,
  wakeDelayMs = 15000,
  // A delayed interval callback is the portable sleep/resume signal. Keep a
  // little jitter tolerance so ordinary scheduler delays do not add a wake
  // pause, while a laptop resume does not immediately hit the API.
  sleepGapMs = Math.max(intervalMs + 30000, 90000),
  now = () => Date.now(),
}: {
  db: DatabaseLike;
  apiBaseUrl: string;
  intervalMs?: number;
  initialDelayMs?: number;
  wakeDelayMs?: number;
  sleepGapMs?: number;
  now?: () => number;
}): () => void {
  let stopped = false;
  let running = false;
  let wakeTimer: ReturnType<typeof setTimeout> | null = null;
  let lastTickAt = now();
  const lastErrors = new Map<string, string>();
  const unsupportedAgents = new Set<string>();
  const run = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const agents = db.prepare(`SELECT agent_id,owner_email FROM agents
        WHERE owner_email IS NOT NULL AND TRIM(owner_email)!=''`).all<AgentRow>();
      const grouped = new Map<string, string[]>();
      for (const agent of agents) {
        if (unsupportedAgents.has(agent.agent_id)) continue;
        if (!getUserAccessToken(db, agent.owner_email)) continue;
        let credentials: { email: string; token: string; serverAgentId: string };
        try {
          credentials = getAgentToken(db, agent.agent_id);
        } catch (error: unknown) {
          const message = errorMessage(error);
          if (lastErrors.get(agent.agent_id) !== message) {
            lastErrors.set(agent.agent_id, message);
            console.warn(`[AccessSync] agent=${agent.agent_id} ${message}`);
          }
          continue;
        }
        const key = `${credentials.email}\u0000${credentials.token}`;
        const group = grouped.get(key) || [];
        group.push(agent.agent_id);
        grouped.set(key, group);
      }
      for (const agentIds of grouped.values()) {
        const result = await syncAgentAccessBatch({ db, apiBaseUrl, agentIds });
        if (result.fallback) {
          const fallbackKey = agentIds.join(',');
          if (lastErrors.get(fallbackKey) !== 'legacy') {
            console.info(`[AccessSync] 批量接口不可用，已回退旧版逐 Agent 同步（${agentIds.length} 个）`);
            lastErrors.set(fallbackKey, 'legacy');
          }
        }
        const batchError = result.error && result.agents.length === agentIds.length
          && result.agents.every((agentResult) => agentResult.error === result.error)
          ? result.error
          : null;
        if (batchError) {
          const batchKey = `batch:${agentIds.join(',')}`;
          if (lastErrors.get(batchKey) !== batchError) {
            lastErrors.set(batchKey, batchError);
            console.warn(`[AccessSync] agents=${agentIds.length} 批量同步失败: ${batchError}`);
          }
          continue;
        }
        for (const agentResult of result.agents) {
          if (agentResult.success) {
            lastErrors.delete(agentResult.agentId);
            if (agentResult.skipped) unsupportedAgents.add(agentResult.agentId);
          } else {
            const error = agentResult.error || result.error || '同步失败';
            if (lastErrors.get(agentResult.agentId) === error) continue;
            lastErrors.set(agentResult.agentId, error);
            console.warn(`[AccessSync] agent=${agentResult.agentId} ${error}`);
          }
        }
      }
    } finally {
      running = false;
    }
  };
  const scheduleRun = (delayMs: number) => {
    if (stopped || running) return;
    if (wakeTimer) return;
    if (delayMs <= 0) {
      void run();
      return;
    }
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      void run();
    }, delayMs);
    wakeTimer.unref?.();
  };
  scheduleRun(initialDelayMs);
  const timer = setInterval(() => {
    const currentTime = now();
    const elapsed = currentTime - lastTickAt;
    lastTickAt = currentTime;
    if (elapsed >= sleepGapMs) {
      console.info(`[AccessSync] 检测到休眠/恢复，${wakeDelayMs}ms 后执行合并同步`);
      scheduleRun(wakeDelayMs);
      return;
    }
    scheduleRun(0);
  }, intervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
    if (wakeTimer) clearTimeout(wakeTimer);
    wakeTimer = null;
  };
}

module.exports = {
  CURSOR_CONFIG_TYPE,
  serverAgentIdFromDid,
  SERVER_INVITATION_REASON,
  createAgentInvitation,
  syncAgentAccess,
  syncAgentAccessBatch,
  reconcileSnapshot,
  startAgentAccessSync,
};
