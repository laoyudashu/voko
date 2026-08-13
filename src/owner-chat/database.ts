import type { DatabaseSync } from 'node:sqlite';

function initOwnerChatSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS owner_chat_messages (
      message_id TEXT PRIMARY KEY, client_message_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
      owner_identity_id TEXT NOT NULL, owner_im_uid TEXT NOT NULL, agent_id TEXT NOT NULL, local_agent_id TEXT NOT NULL,
      ownership_epoch INTEGER NOT NULL, conversation_epoch INTEGER NOT NULL, sequence INTEGER NOT NULL,
      content_type INTEGER NOT NULL, payload_json TEXT NOT NULL, payload_digest TEXT NOT NULL,
      state TEXT NOT NULL, lease_owner TEXT, lease_expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(conversation_id,sequence), UNIQUE(conversation_id,client_message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_owner_chat_pending ON owner_chat_messages(state,lease_expires_at);
    CREATE TABLE IF NOT EXISTS owner_chat_bindings (
      conversation_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, provider_type TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL DEFAULT '', adapter_type TEXT NOT NULL, delivery_mode TEXT NOT NULL,
      native_session_id TEXT NOT NULL, binding_version INTEGER NOT NULL, status TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(agent_id,native_session_id)
    );
    CREATE TABLE IF NOT EXISTS owner_chat_outbox (
      event_id TEXT PRIMARY KEY, message_id TEXT NOT NULL, conversation_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      local_agent_id TEXT NOT NULL, owner_im_uid TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL,
      lease_owner TEXT, lease_expires_at INTEGER, attempt_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_owner_chat_outbox ON owner_chat_outbox(status,lease_expires_at);
    CREATE TABLE IF NOT EXISTS owner_chat_security_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL, message_id TEXT, conversation_id TEXT,
      agent_id TEXT, created_at INTEGER NOT NULL
    );
  `);
}

export { initOwnerChatSchema };
