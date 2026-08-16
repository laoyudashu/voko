import type { DatabaseSync } from 'node:sqlite';

function addColumn(db: DatabaseSync, table: string, column: string, declaration: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  if (!columns.some(item => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
}

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
    CREATE TABLE IF NOT EXISTS owner_chat_control_events (
      message_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, owner_im_uid TEXT NOT NULL,
      local_agent_id TEXT NOT NULL, sequence INTEGER NOT NULL, operation TEXT NOT NULL,
      payload_json TEXT NOT NULL, payload_digest TEXT NOT NULL, created_at INTEGER NOT NULL,
      UNIQUE(conversation_id,sequence)
    );
    CREATE TABLE IF NOT EXISTS owner_chat_execution_events (
      event_id TEXT PRIMARY KEY, message_id TEXT NOT NULL, from_state TEXT, to_state TEXT NOT NULL,
      reason_code TEXT, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_owner_chat_execution_events ON owner_chat_execution_events(message_id,created_at);
    CREATE TABLE IF NOT EXISTS owner_chat_io_events (
      event_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL,
      local_sequence INTEGER NOT NULL, provider_sequence INTEGER NOT NULL, event_type TEXT NOT NULL,
      provider_id TEXT NOT NULL, native_session_id TEXT, turn_id TEXT, payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL, UNIQUE(conversation_id,local_sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_owner_chat_io_events ON owner_chat_io_events(conversation_id,local_sequence);
    CREATE TABLE IF NOT EXISTS owner_chat_policy (
      id INTEGER PRIMARY KEY CHECK(id=1), owner_chat_enabled INTEGER NOT NULL DEFAULT 1,
      remote_execution_enabled INTEGER NOT NULL DEFAULT 0, host_full_access_enabled INTEGER NOT NULL DEFAULT 0,
      policy_epoch INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO owner_chat_policy(id,owner_chat_enabled,remote_execution_enabled,host_full_access_enabled,policy_epoch,updated_at)
      VALUES(1,1,0,0,1,0);
  `);
  addColumn(db, 'owner_chat_messages', 'execution_state', "TEXT NOT NULL DEFAULT 'PERSISTED'");
  addColumn(db, 'owner_chat_messages', 'execution_context_json', 'TEXT');
  addColumn(db, 'owner_chat_messages', 'policy_epoch', 'INTEGER NOT NULL DEFAULT 1');
  addColumn(db, 'owner_chat_bindings', 'authority_scope', "TEXT NOT NULL DEFAULT 'verified_owner_conversation'");
  addColumn(db, 'owner_chat_bindings', 'policy_digest', "TEXT NOT NULL DEFAULT ''");
  db.exec(`UPDATE owner_chat_messages SET execution_state=CASE LOWER(state)
    WHEN 'persisted' THEN 'PERSISTED' WHEN 'leased' THEN 'DISPATCH_RESERVED'
    WHEN 'replied' THEN 'COMPLETED' WHEN 'failed_not_delivered' THEN 'FAILED_NOT_DELIVERED'
    WHEN 'outcome_unknown' THEN 'OUTCOME_UNKNOWN' ELSE execution_state END`);
}

function appendOwnerChatIoEvent(db: DatabaseSync, event: Record<string, any>): number {
  const conversationId = String(event.conversationId || ''); const messageId = String(event.messageId || '');
  if (!conversationId || !messageId || !String(event.eventId || '')) throw new Error('OWNER_IO_EVENT_INVALID');
  const insert = db.prepare(`INSERT OR IGNORE INTO owner_chat_io_events
    (event_id,conversation_id,message_id,local_sequence,provider_sequence,event_type,provider_id,native_session_id,turn_id,payload_json,created_at)
    SELECT ?,?,?,COALESCE(MAX(local_sequence),0)+1,?,?,?,?,?,?,? FROM owner_chat_io_events WHERE conversation_id=?`);
  const result = insert.run(String(event.eventId),conversationId,messageId,Number(event.sequence || 0),String(event.type || 'status'),
    String(event.providerId || ''),event.nativeSessionId ? String(event.nativeSessionId) : null,
    event.turnId ? String(event.turnId) : null,JSON.stringify(event.payload ?? null),Number(event.occurredAt || Date.now()),conversationId);
  if (!Number(result.changes || 0)) {
    const row = db.prepare('SELECT local_sequence FROM owner_chat_io_events WHERE event_id=?').get(String(event.eventId)) as any;
    return Number(row?.local_sequence || 0);
  }
  const row = db.prepare('SELECT local_sequence FROM owner_chat_io_events WHERE event_id=?').get(String(event.eventId)) as any;
  return Number(row?.local_sequence || 0);
}

export { initOwnerChatSchema, appendOwnerChatIoEvent };
