import type { DatabaseLike } from '../types/database';

export type CheckpointKind = 'opaque' | 'sequence' | 'timestamp_id';

export interface SyncCheckpoint {
  namespace: string;
  scopeKey: string;
  cursorKind: CheckpointKind;
  committedValue: string | null;
  pendingValue: string | null;
  pendingMeta: string | null;
  revision: number;
  updatedAt: number;
}

interface CheckpointRow {
  namespace: string;
  scope_key: string;
  cursor_kind: CheckpointKind;
  committed_value: string | null;
  pending_value: string | null;
  pending_meta: string | null;
  revision: number;
  updated_at: number;
}

interface ConfigRow { type: string; data: string }

function rowToCheckpoint(row?: CheckpointRow): SyncCheckpoint | null {
  return row ? {
    namespace: row.namespace,
    scopeKey: row.scope_key,
    cursorKind: row.cursor_kind,
    committedValue: row.committed_value,
    pendingValue: row.pending_value,
    pendingMeta: row.pending_meta,
    revision: row.revision,
    updatedAt: row.updated_at,
  } : null;
}

export function checkpointScope(parts: unknown[]): string {
  return JSON.stringify(parts);
}

export function getCheckpoint(db: DatabaseLike, namespace: string, scopeKey: string): SyncCheckpoint | null {
  return rowToCheckpoint(db.prepare(`SELECT namespace,scope_key,cursor_kind,committed_value,
    pending_value,pending_meta,revision,updated_at FROM sync_checkpoints
    WHERE namespace=? AND scope_key=?`).get<CheckpointRow>(namespace, scopeKey));
}

export function setCheckpoint(
  db: DatabaseLike,
  namespace: string,
  scopeKey: string,
  cursorKind: CheckpointKind,
  value: unknown,
): void {
  const now = Date.now();
  db.prepare(`INSERT INTO sync_checkpoints
    (namespace,scope_key,cursor_kind,committed_value,pending_value,pending_meta,revision,created_at,updated_at)
    VALUES (?,?,?,?,NULL,NULL,1,?,?)
    ON CONFLICT(namespace,scope_key) DO UPDATE SET
      cursor_kind=excluded.cursor_kind,
      committed_value=excluded.committed_value,
      pending_value=NULL,
      pending_meta=NULL,
      revision=sync_checkpoints.revision+1,
      updated_at=excluded.updated_at`)
    .run(namespace, scopeKey, cursorKind, value === null || value === undefined ? null : String(value), now, now);
}

export function advanceCheckpoint(
  db: DatabaseLike,
  namespace: string,
  scopeKey: string,
  value: number,
): number {
  const next = Math.max(0, Number(value) || 0);
  const now = Date.now();
  db.prepare(`INSERT INTO sync_checkpoints
    (namespace,scope_key,cursor_kind,committed_value,pending_value,pending_meta,revision,created_at,updated_at)
    VALUES (?,?,'sequence',?,NULL,NULL,1,?,?)
    ON CONFLICT(namespace,scope_key) DO UPDATE SET
      cursor_kind='sequence',
      committed_value=CAST(MAX(CAST(COALESCE(sync_checkpoints.committed_value,'0') AS INTEGER),
        CAST(excluded.committed_value AS INTEGER)) AS TEXT),
      pending_value=NULL,
      pending_meta=NULL,
      revision=sync_checkpoints.revision+1,
      updated_at=excluded.updated_at`)
    .run(namespace, scopeKey, String(next), now, now);
  const stored = getCheckpoint(db, namespace, scopeKey)?.committedValue;
  return stored === null || stored === undefined ? next : Number(stored) || 0;
}

export function stageCheckpoint(
  db: DatabaseLike,
  namespace: string,
  scopeKey: string,
  cursorKind: CheckpointKind,
  value: unknown,
  metadata?: unknown,
): void {
  const now = Date.now();
  db.prepare(`INSERT INTO sync_checkpoints
    (namespace,scope_key,cursor_kind,committed_value,pending_value,pending_meta,revision,created_at,updated_at)
    VALUES (?,?,?,NULL,?,?,1,?,?)
    ON CONFLICT(namespace,scope_key) DO UPDATE SET
      cursor_kind=excluded.cursor_kind,
      pending_value=excluded.pending_value,
      pending_meta=excluded.pending_meta,
      revision=sync_checkpoints.revision+1,
      updated_at=excluded.updated_at`)
    .run(namespace, scopeKey, cursorKind, String(value ?? ''), metadata === undefined ? null : JSON.stringify(metadata), now, now);
}

export function commitCheckpoint(db: DatabaseLike, namespace: string, scopeKey: string): void {
  db.prepare(`UPDATE sync_checkpoints SET committed_value=pending_value,
    pending_value=NULL,pending_meta=NULL,revision=revision+1,updated_at=?
    WHERE namespace=? AND scope_key=? AND pending_value IS NOT NULL`)
    .run(Date.now(), namespace, scopeKey);
}

export function clearCheckpoint(db: DatabaseLike, namespace: string, scopeKey: string): void {
  db.prepare('DELETE FROM sync_checkpoints WHERE namespace=? AND scope_key=?').run(namespace, scopeKey);
}

function parseObject(data: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(data);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

export function migrateLegacyCheckpoints(db: DatabaseLike): { migrated: number; invalid: string[] } {
  let migrated = 0;
  const invalid: string[] = [];
  const insertIfMissing = (namespace: string, scopeKey: string, kind: CheckpointKind, value: unknown) => {
    if (getCheckpoint(db, namespace, scopeKey)) return;
    setCheckpoint(db, namespace, scopeKey, kind, value);
    migrated++;
  };
  const rows = db.prepare(`SELECT type,data FROM config
    WHERE type IN ('agent_access_sync_cursors','offline_sync_cursors') OR type LIKE 'cursor:%'`)
    .all<ConfigRow>();
  for (const row of rows) {
    if (row.type === 'agent_access_sync_cursors' || row.type === 'offline_sync_cursors') {
      const values = parseObject(row.data);
      if (!values) { invalid.push(row.type); continue; }
      for (const [scopeKey, value] of Object.entries(values)) {
        insertIfMissing(
          row.type === 'agent_access_sync_cursors' ? 'access_sync' : 'offline_messages',
          scopeKey,
          row.type === 'agent_access_sync_cursors' ? 'opaque' : 'sequence',
          value,
        );
      }
      continue;
    }
    try {
      const key = row.type.slice('cursor:'.length);
      const separator = key.indexOf(':');
      const name = separator < 0 ? key : key.slice(0, separator);
      const scopeKey = separator < 0 ? '' : key.slice(separator + 1);
      const value = Number(JSON.parse(row.data)) || 0;
      const isTimestampCursor = name === 'check_human_replies' || name === 'check_payments';
      insertIfMissing(
        `mcp.${name}`,
        scopeKey,
        isTimestampCursor ? 'timestamp_id' : 'sequence',
        isTimestampCursor ? JSON.stringify({ timestamp: value, id: '' }) : value,
      );
    } catch (_) {
      invalid.push(row.type);
    }
  }
  return { migrated, invalid };
}
