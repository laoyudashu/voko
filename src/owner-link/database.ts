import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const OWNER_LINK_SCHEMA_VERSION = 3;

interface InitOwnerLinkDatabaseOptions { createParent?: boolean }

function initOwnerLinkDatabase(
  databasePath: string,
  options: InitOwnerLinkDatabaseOptions = {},
): DatabaseSync {
  const resolvedPath = path.resolve(databasePath);
  if (options.createParent !== false) fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  const db = new DatabaseSync(resolvedPath);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    const version = Number((db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)?.user_version || 0);
    if (version > OWNER_LINK_SCHEMA_VERSION) {
      throw new Error(`Owner Link database schema ${version} is newer than supported ${OWNER_LINK_SCHEMA_VERSION}`);
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS owner_link_meta (
          key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS owner_link_settings (
          key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS owner_link_identity_bindings (
          conversation_id TEXT PRIMARY KEY,
          owner_identity_id TEXT NOT NULL UNIQUE,
          agent_id TEXT NOT NULL,
          observed_im_uid TEXT NOT NULL,
          ownership_epoch INTEGER NOT NULL,
          conversation_epoch INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          CHECK (status IN ('active','revoked')),
          UNIQUE (agent_id, owner_identity_id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS owner_link_commands (
          message_id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES owner_link_identity_bindings(conversation_id),
          sequence INTEGER NOT NULL,
          agent_id TEXT NOT NULL,
          payload_digest TEXT NOT NULL,
          payload_json TEXT,
          state TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          lease_owner TEXT,
          lease_version INTEGER NOT NULL DEFAULT 0,
          lease_expires_at INTEGER,
          provider_accepted_at INTEGER,
          completed_at INTEGER,
          error_code TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE (conversation_id, sequence),
          CHECK (state IN ('RECEIVED','VERIFIED','PERSISTED','DISPATCH_RESERVED','PROVIDER_ACCEPTED','COMPLETED','REJECTED','EXPIRED','FAILED_NOT_DELIVERED','OUTCOME_UNKNOWN'))
        ) STRICT;
        CREATE INDEX IF NOT EXISTS idx_owner_link_commands_pending
          ON owner_link_commands(state, expires_at, lease_expires_at);
        CREATE TABLE IF NOT EXISTS owner_link_command_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id TEXT NOT NULL REFERENCES owner_link_commands(message_id) ON DELETE CASCADE,
          from_state TEXT,
          to_state TEXT NOT NULL,
          reason_code TEXT,
          created_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS owner_link_outbox (
          event_id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL REFERENCES owner_link_commands(message_id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          producer_sequence INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          next_attempt_at INTEGER NOT NULL,
          lease_owner TEXT,
          lease_expires_at INTEGER,
          last_error_code TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE (message_id, kind, producer_sequence),
          CHECK (status IN ('pending','leased','sent','acked','dead','outcome_unknown'))
        ) STRICT;
        CREATE TABLE IF NOT EXISTS owner_link_security_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          code TEXT NOT NULL,
          message_id TEXT,
          conversation_id TEXT,
          agent_id TEXT,
          details_digest TEXT,
          created_at INTEGER NOT NULL
        ) STRICT;
      `);
      if (version < 2) {
        const commandColumns = new Set((db.prepare('PRAGMA table_info(owner_link_commands)').all() as Array<{ name?: string }>)
          .map((column) => String(column.name || '')));
        const addCommandColumn = (name: string, declaration: string) => {
          if (!commandColumns.has(name)) db.exec(`ALTER TABLE owner_link_commands ADD COLUMN ${name} ${declaration}`);
        };
        addCommandColumn('operation', 'TEXT');
        addCommandColumn('owner_identity_id', 'TEXT');
        addCommandColumn('observed_im_uid', 'TEXT');
        addCommandColumn('ownership_epoch', 'INTEGER');
        addCommandColumn('conversation_epoch', 'INTEGER');
        db.exec(`
          CREATE TABLE IF NOT EXISTS owner_link_provider_bindings (
            owner_conversation_id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL,
            provider_type TEXT NOT NULL,
            provider_instance_id TEXT NOT NULL DEFAULT '',
            adapter_type TEXT NOT NULL,
            delivery_mode TEXT NOT NULL,
            native_session_id TEXT NOT NULL,
            binding_version INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            last_used_at INTEGER NOT NULL,
            CHECK (status IN ('active','stale','unavailable')),
            UNIQUE (provider_type, provider_instance_id, adapter_type, native_session_id)
          ) STRICT;
          CREATE INDEX idx_owner_link_provider_bindings_agent
            ON owner_link_provider_bindings(agent_id, status);
          CREATE TABLE IF NOT EXISTS owner_link_approvals (
            approval_id TEXT PRIMARY KEY,
            message_id TEXT NOT NULL REFERENCES owner_link_commands(message_id) ON DELETE CASCADE,
            action_digest TEXT NOT NULL,
            provider_type TEXT,
            provider_instance_id TEXT,
            adapter_type TEXT,
            delivery_mode TEXT,
            binding_version INTEGER,
            native_session_digest TEXT,
            enforcement TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            expires_at INTEGER NOT NULL,
            claimed_at INTEGER,
            consumed_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            CHECK (enforcement IN ('voko_enforced','provider_enforced','not_enforceable')),
            CHECK (status IN ('pending','claimed','consumed','expired','rejected'))
          ) STRICT;
        `);
      }
      if (version < 3) {
        const approvalColumns = new Set((db.prepare('PRAGMA table_info(owner_link_approvals)').all() as Array<{ name?: string }>)
          .map((column) => String(column.name || '')));
        if (!approvalColumns.has('native_session_digest')) {
          db.exec('ALTER TABLE owner_link_approvals ADD COLUMN native_session_digest TEXT');
        }
      }
      db.prepare(`INSERT INTO owner_link_meta(key,value,updated_at) VALUES('schema_version',?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
        .run(String(OWNER_LINK_SCHEMA_VERSION), Date.now());
      db.exec(`PRAGMA user_version=${OWNER_LINK_SCHEMA_VERSION}`);
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

export { OWNER_LINK_SCHEMA_VERSION, initOwnerLinkDatabase };
export type { InitOwnerLinkDatabaseOptions };
