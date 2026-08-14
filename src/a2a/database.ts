import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const A2A_SCHEMA_VERSION = 4;

interface InitA2ADatabaseOptions {
  createParent?: boolean;
}

function initA2ADatabase(
  databasePath: string,
  options: InitA2ADatabaseOptions = {},
): DatabaseSync {
  const resolvedPath = path.resolve(databasePath);
  if (options.createParent !== false) {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  }

  const db = new DatabaseSync(resolvedPath);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');

    const currentVersion = Number(
      (db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)?.user_version || 0,
    );
    if (currentVersion > A2A_SCHEMA_VERSION) {
      throw new Error(
        `A2A database schema ${currentVersion} is newer than supported ${A2A_SCHEMA_VERSION}`,
      );
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS a2a_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS a2a_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS a2a_agent_publication (
          agent_id TEXT PRIMARY KEY,
          public_enabled INTEGER NOT NULL DEFAULT 1 CHECK (public_enabled IN (0,1)),
          updated_at INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS a2a_local_tasks (
          gateway_task_id TEXT PRIMARY KEY, context_id TEXT NOT NULL, execution_id TEXT NOT NULL,
          agent_id TEXT NOT NULL, gateway_uid TEXT NOT NULL, standard_state TEXT NOT NULL,
          delivery_state TEXT NOT NULL, last_command_sequence INTEGER NOT NULL DEFAULT 0,
          last_producer_sequence INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
          binding_generation INTEGER NOT NULL DEFAULT 1, owner_epoch INTEGER NOT NULL DEFAULT 1,
          policy_revision INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL,
          CHECK (standard_state IN ('SUBMITTED','WORKING','INPUT_REQUIRED','AUTH_REQUIRED','COMPLETED','FAILED','CANCELED','REJECTED')),
          CHECK (delivery_state IN ('QUEUED_OFFLINE','SENDING','IM_ACCEPTED','DELIVERED','EXECUTING','DELIVERY_UNKNOWN','DEAD_LETTER'))
        ) STRICT;
        CREATE TABLE IF NOT EXISTS a2a_local_contexts (
          agent_id TEXT NOT NULL, context_id TEXT NOT NULL, provider_family TEXT,
          provider_instance_id TEXT, delivery_mode TEXT, adapter_type TEXT, native_session_id TEXT,
          status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          PRIMARY KEY (agent_id, context_id), CHECK (status IN ('active','stale','unavailable'))
        ) STRICT;
        CREATE TABLE IF NOT EXISTS a2a_local_inbox (
          event_id TEXT PRIMARY KEY, gateway_task_id TEXT NOT NULL REFERENCES a2a_local_tasks(gateway_task_id) ON DELETE CASCADE,
          command_sequence INTEGER NOT NULL, operation TEXT NOT NULL, status TEXT NOT NULL,
          envelope_json TEXT, received_at INTEGER NOT NULL, processed_at INTEGER, error_code TEXT,
          UNIQUE (gateway_task_id, command_sequence)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS a2a_local_outbox (
          event_id TEXT PRIMARY KEY, gateway_task_id TEXT NOT NULL REFERENCES a2a_local_tasks(gateway_task_id) ON DELETE CASCADE,
          producer_sequence INTEGER NOT NULL, operation TEXT NOT NULL, envelope_json TEXT NOT NULL,
          status TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
          lease_owner TEXT, lease_expires_at INTEGER, last_error_code TEXT, created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL, UNIQUE (gateway_task_id, producer_sequence),
          CHECK (status IN ('pending','leased','sent','acked','dead','outcome_unknown'))
        ) STRICT;
        CREATE INDEX IF NOT EXISTS idx_a2a_local_outbox_ready
          ON a2a_local_outbox(status, next_attempt_at, lease_expires_at);
        CREATE TABLE IF NOT EXISTS a2a_remote_task_results (
          gateway_task_id TEXT PRIMARY KEY, result_sequence INTEGER NOT NULL,
          standard_state TEXT NOT NULL, delivery_state TEXT NOT NULL, response_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
      `);
      if (currentVersion < 4) {
        const columns = (table: string) => new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name));
        const taskColumns = columns('a2a_local_tasks');
        if (!taskColumns.has('binding_generation')) db.exec('ALTER TABLE a2a_local_tasks ADD COLUMN binding_generation INTEGER NOT NULL DEFAULT 1');
        if (!taskColumns.has('owner_epoch')) db.exec('ALTER TABLE a2a_local_tasks ADD COLUMN owner_epoch INTEGER NOT NULL DEFAULT 1');
        if (!taskColumns.has('policy_revision')) db.exec('ALTER TABLE a2a_local_tasks ADD COLUMN policy_revision INTEGER NOT NULL DEFAULT 1');
        if (!columns('a2a_local_inbox').has('envelope_json')) db.exec('ALTER TABLE a2a_local_inbox ADD COLUMN envelope_json TEXT');
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_a2a_local_tasks_agent_updated ON a2a_local_tasks(agent_id, updated_at);
        CREATE INDEX IF NOT EXISTS idx_a2a_local_tasks_agent_state_updated ON a2a_local_tasks(agent_id, standard_state, updated_at);
        CREATE INDEX IF NOT EXISTS idx_a2a_local_tasks_context_updated ON a2a_local_tasks(context_id, updated_at);
      `);
      db.prepare(`
        INSERT INTO a2a_meta (key, value, updated_at)
        VALUES ('schema_version', ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value=excluded.value,
          updated_at=excluded.updated_at
      `).run(String(A2A_SCHEMA_VERSION), Date.now());
      db.exec(`PRAGMA user_version = ${A2A_SCHEMA_VERSION}`);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      throw error;
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export { A2A_SCHEMA_VERSION, initA2ADatabase };
export type { InitA2ADatabaseOptions };
