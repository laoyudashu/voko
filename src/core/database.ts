/**
 * database.js — 数据库层
 *
 * 从 main.js 提取的 DB 初始化、迁移、查询封装。
 * 纯 Node.js，无 Electron 依赖。Desktop 和 Lite 共用。
 */

const { DatabaseSync: Database } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const { BANK_HEAD_OFFICES } = require('../bankHeadOffices');
const ENDPOINTS = require('../endpoints.json');
const { migrateOfficialHttpsUrls } = require('./https-migration');
const { migrateLegacyCheckpoints } = require('./checkpoint-store');

type DatabaseSync = InstanceType<typeof Database>;
type DbWrite = () => unknown | Promise<unknown>;

interface InitDatabaseOptions {
  silent?: boolean;
}

interface TableInfoRow {
  name: string;
}

interface ConfigRow {
  data: string;
}

interface UserAccessTokenEntry {
  user_access_token: string;
  updated_at?: number;
}

type UserAccessTokenConfig = Record<string, UserAccessTokenEntry>;

interface LegacyUserAccessTokenRow {
  email: string | null;
  user_access_token: string | null;
  updated_at: number | null;
}

interface OwnerEmailRow {
  owner_email: string | null;
}

interface HermesConfig {
  apiKey?: string;
  profiles?: unknown;
  hermes_config?: unknown;
  [key: string]: unknown;
}

interface MessageRow {
  id: string;
  channel_id: string;
  channel_type: number;
  from_uid: string;
  to_uid: string;
  content: string;
  timestamp: number;
  is_me: number;
  status: string;
  message_seq: number | null;
  client_msg_no: string | null;
  no_persist: number;
  red_dot: number;
  sync_once: number;
  content_type: number;
  agent_id: string | null;
}

interface OwnerInterventionRow {
  id: string;
  visitor_id: string;
  agent_id: string | null;
  session_key: string;
  problem: string;
  agent_suggestion: string | null;
  ask_time: number;
  expire_time: number | null;
  status: string;
  owner_reply: string | null;
  reply_time: number | null;
  parent_message_id: string | null;
  email_message_id?: string | null;
  channel_type: number | string | null;
  resolved_at: number | null;
  created_at: number;
  updated_at: number;
  agent_notified?: number;
  is_sent?: number;
  retry_count?: number;
  last_retry_at?: number;
  skip_reply?: number;
  source_sender_uid: string | null;
  target_channel_id: string | null;
  target_channel_type: number | null;
  source_message_id: string | null;
  routing_conversation_id?: string | null;
}

interface ConversationRow {
  user_uid: string;
  channel_id: string;
  channel_type: number;
  name: string;
  avatar: string | null;
  last_message: string | null;
  last_timestamp: number | null;
  unread_count: number;
  session_key: string | null;
  agent_id: string | null;
  mode: string | null;
}

interface SaveMessageInput {
  id: string;
  channelId: string;
  channelType: number;
  fromUid: string;
  toUid: string;
  content: string;
  timestamp: number;
  isMe: boolean;
  status: string;
  messageSeq?: number | null;
  clientMsgNo?: string | null;
  noPersist?: number;
  redDot?: number;
  syncOnce?: number;
  contentType?: number;
  agentId?: string | null;
}

interface SaveConversationInput {
  channelId: string;
  channelType: number;
  name: string;
  avatar?: string | null;
  lastMessage?: string | null;
  lastTimestamp?: number | null;
  unreadCount: number;
  agentId?: string | null;
}

interface GetMessagesOptions {
  limit?: number;
  offset?: number;
  agentId?: string | null;
}

interface SystemMessageInput {
  agentId: string;
  channelId: string;
  content: string;
  timestamp?: number;
}

interface OwnerInterventionInput {
  id: string;
  visitorId: string;
  sessionKey: string;
  problem: string;
  agentSuggestion?: string | null;
  askTime: number;
  expireTime?: number | null;
  status?: string;
  ownerReply?: string | null;
  replyTime?: number | null;
  parentMessageId?: string | null;
  channelType?: number | string | null;
  resolvedAt?: number | null;
  createdAt: number;
  updatedAt: number;
  agentId?: string | null;
  skipReply?: boolean;
  sourceSenderUid?: string | null;
  targetChannelId?: string | null;
  targetChannelType?: number | null;
  sourceMessageId?: string | null;
  routingConversationId?: string | null;
}

interface PaymentOrderInput {
  id: string;
  agent_id: string;
  visitor_id: string;
  from_uid: string;
  amount: number;
  description: string;
  type?: string;
  status: string;
  created_at: number;
  updated_at: number;
}

interface PaymentOrderUpdates {
  status?: string;
  result?: string;
  order_no?: string;
  pay_url?: string;
  query_token?: string;
}

interface ChannelDefinition {
  name: string;
  enabled: boolean;
  [key: string]: unknown;
}

interface ChannelConfig {
  channels: ChannelDefinition[];
  [key: string]: unknown;
}

function isChannelConfig(value: unknown): value is ChannelConfig {
  if (!value || typeof value !== 'object') return false;
  const channels = (value as { channels?: unknown }).channels;
  return Array.isArray(channels) && channels.every((channel) => (
    !!channel
    && typeof channel === 'object'
    && typeof (channel as { name?: unknown }).name === 'string'
    && typeof (channel as { enabled?: unknown }).enabled === 'boolean'
  ));
}

// Schema 7 is the current shared Lite/Desktop marker.  The v7 database has
// the same tables and columns already handled by Lite; keeping the marker in
// sync prevents a newer Desktop-created database from being rejected by Lite.
const SCHEMA_VERSION = 8;

function readSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  return Number(row?.user_version || 0);
}

function backupLegacyDatabase(db: DatabaseSync, dbPath: string): string | null {
  if (!dbPath || dbPath === ':memory:' || !fs.existsSync(dbPath)) return null;
  const backupPath = `${dbPath}.pre-schema-v${SCHEMA_VERSION}.bak`;
  if (fs.existsSync(backupPath)) return backupPath;
  try { db.exec('PRAGMA wal_checkpoint(FULL)'); } catch (_) {}
  fs.copyFileSync(dbPath, backupPath);
  return backupPath;
}

function backupSchema8WebRoutingRevision(db: DatabaseSync): string | null {
  const dbPath = String((db as any)._dbPath || '');
  if (!dbPath || dbPath === ':memory:' || !fs.existsSync(dbPath)) return null;
  const backupPath = `${dbPath}.pre-schema-v8-web-routing.bak`;
  if (fs.existsSync(backupPath)) return backupPath;
  try { db.exec('PRAGMA wal_checkpoint(FULL)'); } catch (_) {}
  fs.copyFileSync(dbPath, backupPath);
  return backupPath;
}

function ensureSyncCheckpointSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_checkpoints (
      namespace TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      cursor_kind TEXT NOT NULL CHECK(cursor_kind IN ('opaque','sequence','timestamp_id')),
      committed_value TEXT,
      pending_value TEXT,
      pending_meta TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(namespace, scope_key)
    );
    CREATE INDEX IF NOT EXISTS idx_sync_checkpoints_namespace
      ON sync_checkpoints(namespace);
  `);
  const hasConfig = !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='config'",
  ).get();
  if (!hasConfig) return;
  try {
    const result = migrateLegacyCheckpoints(db);
    if (result.invalid.length) {
      console.warn(`[DB] ${result.invalid.length} 个旧游标无法迁移，已保留原始 config 数据`);
    }
  } catch (e: any) {
    console.warn('[DB] 旧游标迁移失败，已保留原始 config 数据:', e.message);
  }
}

function runCurrentStartupMaintenance(db: DatabaseSync): void {
  migrateSchema8WebRoutingRevision(db);
  ensureSyncCheckpointSchema(db);
  try {
    const pkg = require('../../package.json');
    db.prepare('INSERT OR REPLACE INTO config (type, data, updated_at) VALUES (?, ?, ?)')
      .run('version', pkg.version || '0.0.0', Date.now());
  } catch (_) {}
  try {
    const { seedBackendTypes } = require('./agent-backend-types');
    seedBackendTypes(db);
  } catch (e: any) {
    console.error('[DB] agent_backend_types seed 失败:', e.message);
  }
}

function createFinalSchema8RoutingTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE provider_routing_conversations (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      provider_family TEXT,
      provider_instance_key TEXT,
      native_session_id TEXT,
      native_session_fingerprint TEXT,
      wire_conversation_key TEXT NOT NULL,
      parent_conversation_id TEXT,
      merge_status TEXT NOT NULL DEFAULT 'none' CHECK(merge_status IN ('none','requested','merged')),
      channel_id TEXT NOT NULL,
      channel_type INTEGER NOT NULL DEFAULT 1,
      origin TEXT NOT NULL CHECK(origin IN ('caller','voko_managed','web_system')),
      status TEXT NOT NULL CHECK(status IN ('pending','active','stale','unavailable','archived')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_provider_routing_conversation_active
      ON provider_routing_conversations(agent_id,provider_family,provider_instance_key,
        native_session_fingerprint,channel_type,channel_id)
      WHERE status='active' AND native_session_fingerprint IS NOT NULL;
    CREATE UNIQUE INDEX idx_provider_routing_conversation_wire
      ON provider_routing_conversations(agent_id,channel_type,channel_id,wire_conversation_key);
    CREATE UNIQUE INDEX idx_provider_routing_conversation_pending
      ON provider_routing_conversations(agent_id,channel_type,channel_id) WHERE status='pending';
    CREATE INDEX idx_provider_routing_conversation_channel
      ON provider_routing_conversations(agent_id,channel_type,channel_id,status);
  `);
}

function createFinalSchema8MessageRoutes(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE provider_message_routes (
      route_id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      conversation_id TEXT,
      reply_to_route_id TEXT,
      agent_id TEXT NOT NULL,
      peer_uid TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      channel_type INTEGER NOT NULL DEFAULT 1,
      direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
      status TEXT NOT NULL CHECK(status IN ('pending','active','failed','expired','invalid')),
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(conversation_id) REFERENCES provider_routing_conversations(id)
    );
    CREATE UNIQUE INDEX idx_provider_message_route_message
      ON provider_message_routes(message_id,direction,agent_id);
    CREATE INDEX idx_provider_message_route_conversation
      ON provider_message_routes(conversation_id,created_at);
    CREATE INDEX idx_provider_message_route_pull
      ON provider_message_routes(agent_id,channel_type,channel_id,direction,status,message_id);
  `);
}

function migrateSchema8WebRoutingRevision(db: DatabaseSync): void {
  const marker = db.prepare("SELECT 1 FROM config WHERE type='schema8_web_routing_revision_v1' LIMIT 1").get();
  if (marker) return;
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='provider_routing_conversations'").get();
  if (!table) return;
  backupSchema8WebRoutingRevision(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`ALTER TABLE provider_message_routes RENAME TO provider_message_routes_webrev_old`);
    db.exec(`ALTER TABLE provider_routing_conversations RENAME TO provider_routing_conversations_webrev_old`);
    db.exec(`
      DROP INDEX IF EXISTS idx_provider_routing_conversation_active;
      DROP INDEX IF EXISTS idx_provider_routing_conversation_channel;
      DROP INDEX IF EXISTS idx_provider_message_route_message;
      DROP INDEX IF EXISTS idx_provider_message_route_conversation;
      DROP INDEX IF EXISTS idx_provider_message_route_pull;
    `);
    createFinalSchema8RoutingTables(db);
    db.exec(`INSERT INTO provider_routing_conversations
      (id,agent_id,provider_family,provider_instance_key,native_session_id,native_session_fingerprint,
       wire_conversation_key,parent_conversation_id,merge_status,channel_id,channel_type,origin,status,
       created_at,updated_at,last_used_at)
      SELECT id,agent_id,provider_family,provider_instance_key,native_session_id,native_session_fingerprint,
       lower(hex(randomblob(16))),NULL,'none',channel_id,channel_type,origin,status,
       created_at,updated_at,last_used_at FROM provider_routing_conversations_webrev_old`);
    createFinalSchema8MessageRoutes(db);
    db.exec(`INSERT INTO provider_message_routes SELECT * FROM provider_message_routes_webrev_old`);
    db.exec(`DROP TABLE provider_message_routes_webrev_old`);
    db.exec(`DROP TABLE provider_routing_conversations_webrev_old`);
    const columns = db.prepare('PRAGMA table_info(owner_interventions)').all() as TableInfoRow[];
    if (!columns.some((column) => column.name === 'routing_conversation_id')) {
      db.exec('ALTER TABLE owner_interventions ADD COLUMN routing_conversation_id TEXT');
    }
    db.prepare('INSERT INTO config (type,data,updated_at) VALUES (?,?,?)')
      .run('schema8_web_routing_revision_v1', JSON.stringify(true), Date.now());
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw error;
  }
}

// Schema 8 keeps the legacy conversation bindings. Backfill only the
// unambiguous identities once; ambiguous historical sessions remain
// explicit-selection cases instead of being guessed.
function runProviderIdentityBackfill(db: DatabaseSync): void {
  try {
    const { backfillLegacyAgentIdentityBindings } = require('./provider-agent-identity');
    backfillLegacyAgentIdentityBindings(db);
  } catch (e: any) {
    console.error('[DB] provider identity backfill:', e.message);
  }
}

function migrateGoosePushDeliveryModes(db: DatabaseSync): void {
  const hasAgents = !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='agents'",
  ).get();
  if (!hasAgents) return;
  db.prepare(`
    UPDATE agents
    SET delivery_modes='["cli","pull"]', updated_at=?
    WHERE backend_type IN ('goose','goose-ai')
      AND json_valid(delivery_modes)
      AND json_array_length(delivery_modes)=1
      AND json_extract(delivery_modes, '$[0]')='pull'
  `).run(Date.now());
  db.prepare(`
    UPDATE agents
    SET delivery_modes='["acp","cli","pull"]', updated_at=?
    WHERE backend_type IN ('acp-goose','goose-acp')
      AND json_valid(delivery_modes)
      AND json_array_length(delivery_modes)=1
      AND json_extract(delivery_modes, '$[0]')='pull'
  `).run(Date.now());
}

function migrateSchema8ProviderRouting(db: DatabaseSync, previousVersion: number): void {
  const crypto = require('node:crypto');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS provider_agent_identity_bindings (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        provider_family TEXT NOT NULL,
        provider_instance_key TEXT NOT NULL DEFAULT '',
        native_session_fingerprint TEXT NOT NULL,
        evidence_type TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active','stale')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(agent_id,provider_family,provider_instance_key,native_session_fingerprint)
      );
      CREATE INDEX IF NOT EXISTS idx_provider_identity_lookup
        ON provider_agent_identity_bindings(provider_family,provider_instance_key,native_session_fingerprint,status);

    `);
    const hasRouting = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='provider_routing_conversations'").get();
    if (!hasRouting) {
      createFinalSchema8RoutingTables(db);
      createFinalSchema8MessageRoutes(db);
    }
    const interventionColumns = db.prepare('PRAGMA table_info(owner_interventions)').all() as TableInfoRow[];
    if (!interventionColumns.some((column) => column.name === 'routing_conversation_id')) {
      db.exec('ALTER TABLE owner_interventions ADD COLUMN routing_conversation_id TEXT');
    }
    const keyRow = db.prepare("SELECT data FROM config WHERE type='provider_session_hmac_key_v1'").get();
    if (!keyRow) {
      db.prepare('INSERT INTO config (type,data,updated_at) VALUES (?,?,?)')
        .run('provider_session_hmac_key_v1', JSON.stringify(crypto.randomBytes(32).toString('base64')), Date.now());
    }
    db.prepare('INSERT OR REPLACE INTO config (type,data,updated_at) VALUES (?,?,?)')
      .run('schema_version', JSON.stringify(8), Date.now());
    db.prepare('INSERT OR REPLACE INTO config (type,data,updated_at) VALUES (?,?,?)')
      .run('schema8_web_routing_revision_v1', JSON.stringify(true), Date.now());
    db.exec('PRAGMA user_version=8');
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    try {
      db.prepare('INSERT OR REPLACE INTO config (type,data,updated_at) VALUES (?,?,?)')
        .run('schema_version', JSON.stringify(previousVersion), Date.now());
      db.exec(`PRAGMA user_version=${Math.max(0, Math.floor(previousVersion))}`);
    } catch (_) {}
    throw error;
  }
}

// ============================================
// DB 写入串行队列
// ============================================
let _dbWriteQueue: Promise<unknown> = Promise.resolve();

function enqueueDbWrite(fn: DbWrite) {
  _dbWriteQueue = _dbWriteQueue.then(fn, fn).catch((error: unknown) => console.error('[DB队列]', error));
}

/** 返回当前队列 Promise，可用于等待队列清空 */
function waitForDbQueue() {
  return _dbWriteQueue;
}

// ============================================
// 建表 + 迁移
// ============================================
function initDatabase(dbPath: string, options: InitDatabaseOptions = {}) {
  // CLI tool 调用（options.silent=true）静默例行建表/迁移/seed 日志；
  // server 启动不传 silent，保留完整启动横幅。
  // initDatabase 全程同步，临时重定向 console.error，finally 恢复。
  const _origErr = console.error;
  if (options.silent) console.error = () => {};
  try {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const db = new Database(dbPath);
  db._dbPath = dbPath;
  try { db.exec('PRAGMA journal_mode = WAL'); } catch (_: any) {}
  try { db.exec('PRAGMA synchronous = NORMAL'); } catch (_: any) {}
  try { db.exec('PRAGMA busy_timeout = 5000'); } catch (_: any) {}

  const schemaVersion = readSchemaVersion(db);
  if (schemaVersion > SCHEMA_VERSION) {
    try { db.close(); } catch (_) {}
    throw new Error(`Database schema v${schemaVersion} is newer than supported v${SCHEMA_VERSION}`);
  }
  if (schemaVersion === SCHEMA_VERSION) {
    runCurrentStartupMaintenance(db);
    runProviderIdentityBackfill(db);
    return db;
  }
  const hasExistingSchema = !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1",
  ).get();
  if (hasExistingSchema) {
    const hasConfig = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='config'").get();
    if (hasConfig) {
      const legacyVersionRow = db.prepare("SELECT data FROM config WHERE type='schema_version'").get() as ConfigRow | undefined;
      const legacyVersion = legacyVersionRow?.data ? Number(JSON.parse(legacyVersionRow.data)) : 0;
      if (legacyVersion > SCHEMA_VERSION) {
        try { db.close(); } catch (_) {}
        throw new Error(`Database schema v${legacyVersion} is newer than supported v${SCHEMA_VERSION}`);
      }
    }
    const backupPath = backupLegacyDatabase(db, dbPath);
    if (backupPath && !options.silent) console.error(`[DB] 历史数据库迁移前备份: ${backupPath}`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      channel_type INTEGER NOT NULL,
      from_uid TEXT NOT NULL,
      to_uid TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      is_me INTEGER NOT NULL,
      status TEXT NOT NULL,
      agent_id TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      user_uid TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      channel_type INTEGER NOT NULL,
      name TEXT NOT NULL,
      avatar TEXT,
      last_message TEXT,
      last_timestamp INTEGER,
      unread_count INTEGER DEFAULT 0,
      session_key TEXT,
      agent_id TEXT,
      PRIMARY KEY (user_uid, channel_id)
    )
  `);
  // 迁移：添加 agent_id + channel_id 索引（供新代码按 agent_id 查找会话）
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_conversations_agent_channel ON conversations(agent_id, channel_id)`);
  } catch (_: any) {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS owner_interventions (
      id TEXT PRIMARY KEY,
      visitor_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      problem TEXT NOT NULL,
      agent_suggestion TEXT,
      ask_time INTEGER NOT NULL,
      expire_time INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      owner_reply TEXT,
      reply_time INTEGER,
      parent_message_id TEXT,
      is_sent INTEGER DEFAULT 0,
      channel_type TEXT,
      source_sender_uid TEXT,
      target_channel_id TEXT,
      target_channel_type INTEGER DEFAULT 1,
      source_message_id TEXT,
      resolved_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_owner_interventions_visitor ON owner_interventions(visitor_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_owner_interventions_status ON owner_interventions(status)`);

  // 迁移：conversations 添加 session_key（兼容旧表）
  try {
    const tableInfo = db.prepare(`PRAGMA table_info(conversations)`).all();
    const hasSessionKey = tableInfo.some((col: TableInfoRow) => col.name === 'session_key');
    if (!hasSessionKey) {
      db.exec(`ALTER TABLE conversations ADD COLUMN session_key TEXT`);
      console.error('Added session_key column to conversations table');
    }
  } catch (e: any) {
    console.error('Session_key column check/add error (may already exist):', e.message);
  }

  // 迁移：owner_interventions 兼容字段
  try {
    const tableInfo = db.prepare(`PRAGMA table_info(owner_interventions)`).all();
    const hasParentMsgId = tableInfo.some((col: TableInfoRow) => col.name === 'parent_message_id');
    const hasFeishuMsgId = tableInfo.some((col: TableInfoRow) => col.name === 'feishu_message_id');
    const hasChannelType = tableInfo.some((col: TableInfoRow) => col.name === 'channel_type');
    const hasIsSent = tableInfo.some((col: TableInfoRow) => col.name === 'is_sent');
    const hasRetryCount = tableInfo.some((col: TableInfoRow) => col.name === 'retry_count');
    const hasLastRetryAt = tableInfo.some((col: TableInfoRow) => col.name === 'last_retry_at');

    if (hasFeishuMsgId && !hasParentMsgId) {
      db.exec(`ALTER TABLE owner_interventions ADD COLUMN parent_message_id TEXT`);
      db.exec(`UPDATE owner_interventions SET parent_message_id = feishu_message_id WHERE parent_message_id IS NULL`);
      console.error('Renamed feishu_message_id to parent_message_id');
    }
    if (!hasChannelType) {
      db.exec(`ALTER TABLE owner_interventions ADD COLUMN channel_type TEXT`);
      console.error('Added channel_type column to owner_interventions table');
    }
    if (!hasIsSent) {
      db.exec(`ALTER TABLE owner_interventions ADD COLUMN is_sent INTEGER DEFAULT 0`);
      console.error('Added is_sent column to owner_interventions table');
    }
    if (!hasRetryCount) {
      db.exec(`ALTER TABLE owner_interventions ADD COLUMN retry_count INTEGER DEFAULT 0`);
      console.error('Added retry_count column to owner_interventions table');
    }
    if (!hasLastRetryAt) {
      db.exec(`ALTER TABLE owner_interventions ADD COLUMN last_retry_at INTEGER DEFAULT 0`);
      console.error('Added last_retry_at column to owner_interventions table');
    }
    const hasAgentNotified = tableInfo.some((col: TableInfoRow) => col.name === 'agent_notified');
    if (!hasAgentNotified) {
      db.exec(`ALTER TABLE owner_interventions ADD COLUMN agent_notified INTEGER DEFAULT 0`);
      console.error('Added agent_notified column to owner_interventions table');
    }
    if (!tableInfo.some((col: TableInfoRow) => col.name === 'skip_reply')) {
      db.exec(`ALTER TABLE owner_interventions ADD COLUMN skip_reply INTEGER DEFAULT 0`);
      console.error('Added skip_reply column to owner_interventions table');
    }
    if (!tableInfo.some((col: TableInfoRow) => col.name === 'email_message_id')) {
      db.exec(`ALTER TABLE owner_interventions ADD COLUMN email_message_id TEXT`);
      console.error('Added email_message_id column to owner_interventions table');
    }
    if (!tableInfo.some((col: TableInfoRow) => col.name === 'source_sender_uid')) {
      db.exec(`ALTER TABLE owner_interventions ADD COLUMN source_sender_uid TEXT`);
    }
    if (!tableInfo.some((col: TableInfoRow) => col.name === 'target_channel_id')) {
      db.exec(`ALTER TABLE owner_interventions ADD COLUMN target_channel_id TEXT`);
    }
    if (!tableInfo.some((col: TableInfoRow) => col.name === 'target_channel_type')) {
      db.exec(`ALTER TABLE owner_interventions ADD COLUMN target_channel_type INTEGER DEFAULT 1`);
    }
    if (!tableInfo.some((col: TableInfoRow) => col.name === 'source_message_id')) {
      db.exec(`ALTER TABLE owner_interventions ADD COLUMN source_message_id TEXT`);
    }
    db.exec(`UPDATE owner_interventions
      SET source_sender_uid=COALESCE(source_sender_uid, visitor_id),
          target_channel_id=COALESCE(target_channel_id, visitor_id),
          target_channel_type=COALESCE(target_channel_type, 1)`);

    if (hasFeishuMsgId) {
      db.exec(`ALTER TABLE owner_interventions DROP COLUMN feishu_message_id`);
      console.error('Dropped feishu_message_id column');
    }
  } catch (e: any) {
    console.error('Owner interventions column migration error:', e.message);
  }

  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, timestamp)`);

  // 新建 agents 表
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL UNIQUE,
      imUid TEXT NOT NULL,
      imToken TEXT NOT NULL,
      im_server_url TEXT NOT NULL,
      owner_email TEXT,
      chatroom_url TEXT,
      payment_url TEXT,
      did TEXT,
      public_key TEXT,
      login_token TEXT,
      ability TEXT,
      publish_status TEXT NOT NULL DEFAULT 'unpublished',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // agent_skills 表：技能分配
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_skills (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      config TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(agent_id, skill_name)
    )
  `);

  // agent_session_handles 表：agent 发放的 session 句柄（仅 ACP 等 agent-issued-id 模式）
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_session_handles (
      agent_id TEXT NOT NULL,
      visitor_id TEXT NOT NULL,
      adapter_type TEXT NOT NULL,
      session_handle TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(agent_id, visitor_id, adapter_type)
    )
  `);

  // Unified local-only mapping from a VOKO conversation to a provider-native session.
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_conversation_bindings (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      channel_type INTEGER NOT NULL DEFAULT 1,
      provider_type TEXT NOT NULL,
      provider_instance_id TEXT,
      delivery_mode TEXT NOT NULL,
      adapter_type TEXT NOT NULL,
      native_session_id TEXT NOT NULL,
      session_origin TEXT NOT NULL CHECK(session_origin IN ('caller','voko_managed')),
      status TEXT NOT NULL CHECK(status IN ('pending','active','stale','unavailable')),
      binding_version INTEGER NOT NULL,
      pending_message_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_binding_active_conversation
      ON provider_conversation_bindings(agent_id, channel_id, channel_type)
      WHERE status='active';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_binding_active_native_session
      ON provider_conversation_bindings(provider_type, COALESCE(provider_instance_id,''), native_session_id)
      WHERE status='active';
    CREATE INDEX IF NOT EXISTS idx_provider_binding_pending_message
      ON provider_conversation_bindings(pending_message_id)
      WHERE status='pending';
  `);
  try {
    const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_session_handles'")
      .get() as { sql?: string } | undefined;
    if (tableSql?.sql && !/UNIQUE\s*\(\s*agent_id\s*,\s*visitor_id\s*,\s*adapter_type\s*\)/i.test(tableSql.sql)) {
      db.exec('BEGIN IMMEDIATE');
      db.exec(`
        ALTER TABLE agent_session_handles RENAME TO agent_session_handles_legacy;
        CREATE TABLE agent_session_handles (
          agent_id TEXT NOT NULL,
          visitor_id TEXT NOT NULL,
          adapter_type TEXT NOT NULL,
          session_handle TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(agent_id, visitor_id, adapter_type)
        );
        INSERT OR REPLACE INTO agent_session_handles
          (agent_id, visitor_id, adapter_type, session_handle, updated_at)
        SELECT agent_id, visitor_id, adapter_type, session_handle, updated_at
        FROM agent_session_handles_legacy;
        DROP TABLE agent_session_handles_legacy;
        COMMIT;
      `);
    }
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    console.error('Agent_session_handles isolation migration error:', error instanceof Error ? error.message : String(error));
    throw error;
  }

  // agent_wakeup_requests 表：调度层统一 wakeup 队列
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_wakeup_requests (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      source TEXT NOT NULL,
      reason TEXT,
      idempotency_key TEXT,
      payload TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      coalesced_count INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // 迁移：messages 表添加 agent_id
  try {
    const msgTableInfo = db.prepare(`PRAGMA table_info(messages)`).all();
    if (!msgTableInfo.some((col: TableInfoRow) => col.name === 'agent_id')) {
      db.exec(`ALTER TABLE messages ADD COLUMN agent_id TEXT`);
      console.error('Added agent_id column to messages table');
    }
  } catch (e: any) {
    console.error('Messages agent_id column migration error:', e.message);
  }

  // 迁移：conversations 表添加 agent_id
  try {
    const convTableInfo = db.prepare(`PRAGMA table_info(conversations)`).all();
    if (!convTableInfo.some((col: TableInfoRow) => col.name === 'agent_id')) {
      db.exec(`ALTER TABLE conversations ADD COLUMN agent_id TEXT`);
      console.error('Added agent_id column to conversations table');
    }
  } catch (e: any) {
    console.error('Conversations agent_id column migration error:', e.message);
  }

  // 迁移：agents 表批量加字段
  try {
    const agentsTableInfo = db.prepare(`PRAGMA table_info(agents)`).all();
    if (!agentsTableInfo.some((col: TableInfoRow) => col.name === 'ability')) {
      db.exec(`ALTER TABLE agents ADD COLUMN ability TEXT`);
      console.error('Added ability column to agents table');
    }
    if (!agentsTableInfo.some((col: TableInfoRow) => col.name === 'private_key')) {
      db.exec(`ALTER TABLE agents ADD COLUMN private_key TEXT`);
      console.error('Added private_key column to agents table');
    }
    if (!agentsTableInfo.some((col: TableInfoRow) => col.name === 'short_link_url')) {
      db.exec(`ALTER TABLE agents ADD COLUMN short_link_url TEXT`);
      console.error('Added short_link_url column to agents table');
    }
    if (!agentsTableInfo.some((col: TableInfoRow) => col.name === 'qr_code_url')) {
      db.exec(`ALTER TABLE agents ADD COLUMN qr_code_url TEXT`);
      console.error('Added qr_code_url column to agents table');
    }
  } catch (e: any) {
    console.error('Agents columns migration error:', e.message);
  }

  // 迁移：owner_interventions 添加 agent_id
  try {
    const oiTableInfo = db.prepare(`PRAGMA table_info(owner_interventions)`).all();
    if (!oiTableInfo.some((col: TableInfoRow) => col.name === 'agent_id')) {
      db.exec(`ALTER TABLE owner_interventions ADD COLUMN agent_id TEXT`);
      console.error('Added agent_id column to owner_interventions table');
    }
  } catch (e: any) {
    console.error('Owner interventions agent_id column migration error:', e.message);
  }

  // 迁移：agents 批量添加 Hermes/计费/能力相关字段
  try {
    const agentsCols = db.prepare(`PRAGMA table_info(agents)`).all();
    const agentFields = [
      ['backend_type', "TEXT NOT NULL DEFAULT 'openclaw'"],
      ['backend_instance_id', 'TEXT'],
      ['delivery_modes', 'TEXT'],
      ['agent_name', 'TEXT'],
      ['category', "TEXT DEFAULT 'other'"],
      ['category_label', 'TEXT'],
      ['description', 'TEXT'],
      ['address', 'TEXT'],
      ['contact_phone', 'TEXT'],
      ['short_description', 'TEXT'],
      ['icon_url', 'TEXT'],
      ['cover_url', 'TEXT'],
      ['tags', 'TEXT'],
      ['capability', 'TEXT'],
      ["access_mode", "TEXT NOT NULL DEFAULT 'private'"],
    ];
    for (const [col, type] of agentFields) {
      if (!agentsCols.some((c: TableInfoRow) => c.name === col)) {
        db.exec(`ALTER TABLE agents ADD COLUMN ${col} ${type}`);
        console.error(`Added ${col} column to agents table`);
      }
    }
  } catch (e: any) {
    console.error('Agents backend_type/meta fields migration error:', e.message);
  }

  // 迁移：agents 表添加 payment_fee_rate / agent_usage_fee_rate
  try {
    const agFeeCols = db.prepare(`PRAGMA table_info(agents)`).all();
    if (!agFeeCols.some((col: TableInfoRow) => col.name === 'payment_fee_rate')) {
      db.exec(`ALTER TABLE agents ADD COLUMN payment_fee_rate REAL`);
      console.error('Added payment_fee_rate column to agents table');
    }
    if (!agFeeCols.some((col: TableInfoRow) => col.name === 'agent_usage_fee_rate')) {
      db.exec(`ALTER TABLE agents ADD COLUMN agent_usage_fee_rate REAL`);
      console.error('Added agent_usage_fee_rate column to agents table');
    }
    if (!agFeeCols.some((col: TableInfoRow) => col.name === 'payment_auth_id')) {
      db.exec(`ALTER TABLE agents ADD COLUMN payment_auth_id TEXT`);
      console.error('Added payment_auth_id column to agents table');
    }
    if (!agFeeCols.some((col: TableInfoRow) => col.name === 'cap_error')) {
      db.exec(`ALTER TABLE agents ADD COLUMN cap_error TEXT`);
      console.error('Added cap_error column to agents table');
    }
  } catch (e: any) {
    console.error('Agents fee/payment migration error:', e.message);
  }

  // 迁移：messages 表添加 is_audit_reply
  try {
    const msgCols = db.prepare(`PRAGMA table_info(messages)`).all();
    if (!msgCols.some((col: TableInfoRow) => col.name === 'is_audit_reply')) {
      db.exec(`ALTER TABLE messages ADD COLUMN is_audit_reply INTEGER DEFAULT 0`);
      console.error('Added is_audit_reply column to messages table');
    }
  } catch (e: any) {
    console.error('Messages is_audit_reply migration error:', e.message);
  }

  // 迁移：messages 添加 WukongIM 标准字段
  try {
    const msgCols2 = db.prepare(`PRAGMA table_info(messages)`).all();
    const wkVars = [
      ['message_seq', 'INTEGER'],
      ['client_msg_no', 'TEXT'],
      ['no_persist', 'INTEGER DEFAULT 0'],
      ['red_dot', 'INTEGER DEFAULT 0'],
      ['sync_once', 'INTEGER DEFAULT 0'],
      ['content_type', 'INTEGER DEFAULT 1']
    ];
    for (const [col, type] of wkVars) {
      if (!msgCols2.some((c: TableInfoRow) => c.name === col)) {
        db.exec(`ALTER TABLE messages ADD COLUMN ${col} ${type}`);
        console.error(`Added ${col} column to messages table`);
      }
    }
  } catch (e: any) {
    console.error('Messages WukongIM fields migration error:', e.message);
  }

  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_channel_msgseq ON messages(channel_id, message_seq)`);

  // 迁移：messages 添加 mention 列（群聊 @提及，JSON 字符串 {all, uids[]}，供 pull 模式 agent 识别 @）
  try {
    const msgCols3 = db.prepare(`PRAGMA table_info(messages)`).all();
    if (!msgCols3.some((c: TableInfoRow) => c.name === 'mention')) {
      db.exec(`ALTER TABLE messages ADD COLUMN mention TEXT`);
      console.error('Added mention column to messages table');
    }
  } catch (e: any) {
    console.error('Messages mention column migration error:', e.message);
  }

  // 新建 audit_rules 表
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_rules (
      id TEXT PRIMARY KEY,
      direction TEXT NOT NULL,
      keyword TEXT NOT NULL,
      action TEXT NOT NULL,
      prompt TEXT,
      prompt_key TEXT,
      is_default INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // 新建 payment_auth 表
  db.exec(`
    CREATE TABLE IF NOT EXISTS payment_auth (
      id TEXT PRIMARY KEY,
      owner_email TEXT,
      name TEXT DEFAULT '',
      id_card TEXT DEFAULT '',
      bank_card TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      status TEXT DEFAULT 'unverified',
      receiver_type INTEGER DEFAULT 1,
      bank_code TEXT DEFAULT '',
      bank_name TEXT DEFAULT '',
      company_name TEXT DEFAULT '',
      unified_social_credit_code TEXT DEFAULT '',
      legal_name TEXT DEFAULT '',
      legal_licence_no TEXT DEFAULT '',
      request_no TEXT,
      receiver_no TEXT,
      receiver_apply_status TEXT DEFAULT 'none',
      receiver_sign_status TEXT DEFAULT '',
      receiver_sign_url TEXT DEFAULT '',
      merchant_sign_url TEXT DEFAULT '',
      payment_user_uid TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // 迁移：payment_auth 兼容 owner_email / payment_user_uid
  try {
    const paCols = db.prepare(`PRAGMA table_info(payment_auth)`).all().map((c: TableInfoRow) => c.name);
    if (!paCols.includes('owner_email')) {
      db.exec(`ALTER TABLE payment_auth ADD COLUMN owner_email TEXT`);
      db.exec(`
        UPDATE payment_auth
        SET owner_email = (
          SELECT MIN(a.owner_email) FROM agents a
          WHERE a.payment_auth_id = payment_auth.id AND a.owner_email IS NOT NULL
        )
        WHERE owner_email IS NULL AND 1 = (
          SELECT COUNT(DISTINCT LOWER(TRIM(a.owner_email))) FROM agents a
          WHERE a.payment_auth_id = payment_auth.id AND a.owner_email IS NOT NULL
        )
      `);
      console.error('Added owner_email column to payment_auth');
    }
    if (!paCols.includes('payment_user_uid')) {
      db.exec(`ALTER TABLE payment_auth ADD COLUMN payment_user_uid TEXT`);
      console.error('Added payment_user_uid column to payment_auth');
    }
  } catch (e: any) {
    console.error('payment_auth owner migration:', e.message);
  }

  // 新建 payment_orders 表
  db.exec(`
    CREATE TABLE IF NOT EXISTS payment_orders (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      visitor_id TEXT NOT NULL,
      from_uid TEXT,
      amount REAL NOT NULL,
      description TEXT DEFAULT '',
      order_no TEXT,
      pay_url TEXT,
      status TEXT DEFAULT 'pending',
      result TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // 迁移：payment_orders 兼容
  try {
    const poCols = db.prepare(`PRAGMA table_info(payment_orders)`).all();
    if (poCols.some((c: TableInfoRow) => c.name === 'error_msg')) {
      db.exec(`ALTER TABLE payment_orders RENAME COLUMN error_msg TO result`);
      console.error('payment_orders: error_msg → result');
    }
    if (!poCols.some((col: TableInfoRow) => col.name === 'type')) {
      db.exec(`ALTER TABLE payment_orders ADD COLUMN type TEXT`);
      console.error('Added type column to payment_orders table');
    }
    if (!poCols.some((col: TableInfoRow) => col.name === 'query_token')) {
      db.exec(`ALTER TABLE payment_orders ADD COLUMN query_token TEXT`);
      console.error('Added query_token column to payment_orders table');
    }
  } catch (e: any) {
    console.error('Payment orders migration error:', e.message);
  }

  // 新建 agent_pricing 表
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_pricing (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL UNIQUE,
      pricing_model TEXT NOT NULL DEFAULT 'free',
      price REAL,
      duration_minutes INTEGER,
      trial_minutes INTEGER DEFAULT 3,
      enabled INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // 新建 user_cache 表
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_cache (
      uid TEXT PRIMARY KEY,
      nickname TEXT,
      avatar_path TEXT,
      avatar_url TEXT,
      updated_at INTEGER
    )
  `);

  // 新建 config 表
  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      type TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  ensureSyncCheckpointSchema(db);

  // v4：邀请关系改由 AgentDID 服务端权威管理；旧本地邀请码无法安全迁移，停止使用并删除。
  db.exec('DROP TABLE IF EXISTS friend_invitations');

  // 同步版本号
  try {
    const pkg = require('../../package.json');
    const ver = pkg.version || '0.0.0';
    db.prepare('INSERT OR REPLACE INTO config (type, data, updated_at) VALUES (?, ?, ?)').run('version', ver, Date.now());
    console.error('Version synced to config:', ver);
  } catch (_: any) {}

  // DB schema version 协商：lite/desktop 版本脱钩后，用此数字感知对方写入的库结构。
  // 旧库无记录视为 0；DB 值高于当前代码 → 可能由更高版本写入，告警（只警告不阻塞，保持向前兼容）。
  try {
    const codeVersion = require('../../package.json').version || '0.0.0';
    const svRow = db.prepare("SELECT data FROM config WHERE type = 'schema_version'").get();
    const dbSchemaVer = svRow ? (parseInt(JSON.parse(svRow.data), 10) || 0) : 0;
    const databaseIsNewer = dbSchemaVer > SCHEMA_VERSION;
    if (databaseIsNewer) {
      console.warn(
        `[DB] 当前 VOKO ${codeVersion} 仅支持 schema ${SCHEMA_VERSION}，数据库为 schema ${dbSchemaVer}。`
        + '已保留数据库版本且未执行降级；请运行 voko update 后再启动。',
      );
    } else if (dbSchemaVer < SCHEMA_VERSION) {
      // ── v2 (i18n) 迁移：payment_auth.status 中文→英文枚举；messages/audit_rules/user_cache 加列 ──
      const _addCol = (table: any, col: any, type: any) => {
        try {
          const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c: TableInfoRow) => c.name);
          if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
        } catch (e: any) { console.error(`[DB migrate v2] ${table}.${col}:`, e.message); }
      };
      // payment_auth.status：已知中文值→英文枚举（已认证等可能由外部 payment 服务端同步进库）；未知值保持原样
      try {
        db.exec(`UPDATE payment_auth SET status = CASE status
          WHEN '未认证' THEN 'unverified'
          WHEN '已认证' THEN 'verified'
          WHEN '待验证' THEN 'pending'
          WHEN '已驳回' THEN 'rejected'
          ELSE status END
          WHERE status IN ('未认证','已认证','待验证','已驳回')`);
      } catch (e: any) { console.error('[DB migrate v2] payment_auth.status:', e.message); }
      _addCol('messages', 'sys_code', 'TEXT');        // P5.3 系统消息识别 + 多语言渲染
      _addCol('messages', 'sys_params', 'TEXT');
      _addCol('audit_rules', 'prompt_key', 'TEXT');   // P5.2 审核拒绝提示 i18n
      try {
        db.exec(`UPDATE audit_rules SET prompt_key='audit.default.sensitive_keyword' WHERE is_default=1 AND prompt!='' AND prompt_key IS NULL`);
      } catch (e: any) { console.error('[DB migrate v2] audit_rules.prompt_key backfill:', e.message); }
      _addCol('user_cache', 'locale', 'TEXT');        // P5.4 访客 locale
      console.error('[DB] 迁移到 schema v2（i18n：payment_auth.status 英文化 + messages/audit_rules/user_cache 新列）');
    }
    if (!databaseIsNewer) {
      db.prepare('INSERT OR REPLACE INTO config (type, data, updated_at) VALUES (?, ?, ?)')
        .run('schema_version', JSON.stringify(SCHEMA_VERSION), Date.now());
    }
  } catch (e: any) {
    console.error('[DB] schema_version 协商记录失败:', e.message);
  }

  // 新建 agent_access_lists 表
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_access_lists (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      list_type TEXT NOT NULL CHECK(list_type IN ('whitelist', 'blacklist')),
      visitor_id TEXT NOT NULL,
      reason TEXT,
      manual_managed INTEGER NOT NULL DEFAULT 1,
      server_managed INTEGER NOT NULL DEFAULT 0,
      server_source_invitation_id TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      auto_trust_disabled INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(agent_id, list_type, visitor_id)
    )
  `);
  try {
    const accessCols = db.prepare('PRAGMA table_info(agent_access_lists)').all().map((col: TableInfoRow) => col.name);
    if (!accessCols.includes('manual_managed')) {
      db.exec('ALTER TABLE agent_access_lists ADD COLUMN manual_managed INTEGER NOT NULL DEFAULT 1');
    }
    if (!accessCols.includes('server_managed')) {
      db.exec('ALTER TABLE agent_access_lists ADD COLUMN server_managed INTEGER NOT NULL DEFAULT 0');
    }
    if (!accessCols.includes('server_source_invitation_id')) {
      db.exec('ALTER TABLE agent_access_lists ADD COLUMN server_source_invitation_id TEXT');
    }
    if (!accessCols.includes('source')) {
      db.exec("ALTER TABLE agent_access_lists ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'");
    }
    if (!accessCols.includes('auto_trust_disabled')) {
      db.exec('ALTER TABLE agent_access_lists ADD COLUMN auto_trust_disabled INTEGER NOT NULL DEFAULT 0');
    }
    db.exec(`UPDATE agent_access_lists
      SET manual_managed=0, server_managed=1
      WHERE reason='server_invitation' AND server_managed=0`);
  } catch (e: any) {
    console.error('[DB migrate v4] agent_access_lists provenance:', e.message);
  }

  // MCP 高风险操作审计：仅记录操作元数据，不记录凭据或业务正文。
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_security_events (
      id TEXT PRIMARY KEY,
      tool_name TEXT NOT NULL,
      agent_id TEXT,
      success INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_mcp_security_events_created ON mcp_security_events(created_at DESC)');

  // 迁移：config 表旧版 id 主键 → type 主键
  const colInfo = db.prepare('PRAGMA table_info(config)').all();
  const hasLegacyId = colInfo.some((col: TableInfoRow) => col.name === 'id');
  if (hasLegacyId) {
    try {
      const oldRow = db.prepare('SELECT data, updated_at FROM config WHERE id = 1').get();
      db.exec('DROP TABLE IF EXISTS config');
      db.exec(`
        CREATE TABLE config (
          type TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      if (oldRow) {
        db.prepare('INSERT OR REPLACE INTO config (type, data, updated_at) VALUES (?, ?, ?)')
          .run('channel_config', oldRow.data, oldRow.updated_at);
        console.error('[Config] 已迁移旧版数据到 type=channel_config');
      }
    } catch (e: any) {
      console.error('[Config] 迁移失败:', e.message);
    }
  }

  // 迁移：user_access_tokens 旧表 → config
  migrateUserAccessTokensToConfig(db);

  // 迁移：user_access_tokens → user_access_token type 名
  try {
    const oldRow = db.prepare("SELECT data, updated_at FROM config WHERE type = 'user_access_tokens'").get();
    if (oldRow) {
      db.prepare('INSERT OR REPLACE INTO config (type, data, updated_at) VALUES (?, ?, ?)')
        .run('user_access_token', oldRow.data, oldRow.updated_at);
      db.prepare("DELETE FROM config WHERE type = 'user_access_tokens'").run();
      console.error('[Config] 迁移 user_access_tokens → user_access_token');
    }
  } catch (e: any) {
    console.warn('[Config] 迁移 user_access_tokens 类型名失败:', e.message);
  }

  // 旧库可能保留多个登录 token；首次升级时固定最近使用者，避免依赖对象键顺序。
  try {
    const selected = db.prepare("SELECT data FROM config WHERE type = 'current_user_email'").get() as ConfigRow | undefined;
    if (!selected?.data) {
      const map = loadUserAccessTokenConfig(db);
      const current = Object.entries(map)
        .filter(([, value]) => !!value.user_access_token)
        .sort((left, right) => (right[1].updated_at || 0) - (left[1].updated_at || 0))[0]?.[0];
      if (current) db.prepare('INSERT OR REPLACE INTO config (type, data, updated_at) VALUES (?, ?, ?)')
        .run(CURRENT_USER_EMAIL_CONFIG_TYPE, JSON.stringify(current), Date.now());
    }
  } catch (e: any) {
    console.warn('[Config] current user migration failed:', e.message);
  }

  // 初始化默认 OSS 配置（留空，凭证由环境变量或用户手动配置注入；运行时从 DB 读取）
  const defaultOss = {
    accessKeyId: '',
    accessKeySecret: '',
    region: ENDPOINTS.oss.region,
    bucket: ENDPOINTS.oss.bucket,
    endpoint: ENDPOINTS.oss.endpoint,
    publicUrl: ENDPOINTS.oss.publicUrl
  };
  if (!db.prepare('SELECT data FROM config WHERE type = ?').get('oss_config')) {
    db.prepare('INSERT OR REPLACE INTO config (type, data, updated_at) VALUES (?, ?, ?)')
      .run('oss_config', JSON.stringify(defaultOss), Date.now());
    console.error('[Config] 已写入独立 OSS 配置');
  }
  try {
    const migrated = migrateOfficialHttpsUrls(db);
    if (migrated.agents || migrated.oss) {
      console.error(`[HTTPS] migrated official URLs: agents=${migrated.agents}, oss=${migrated.oss}`);
    }
  } catch (e: any) {
    console.error('[HTTPS] official URL migration failed:', e.message);
  }
  // 清理 channel_config 中的 oss_config 残留
  const ccRow = db.prepare('SELECT data FROM config WHERE type = ?').get('channel_config');
  if (ccRow) {
    try {
      const cc = JSON.parse(ccRow.data);
      const channels = Array.isArray(cc.channels) ? cc.channels : [];
      const supportedChannels = channels.filter((channel: unknown) => {
        return !channel || typeof channel !== 'object' || (channel as { name?: unknown }).name !== 'feishu';
      });
      if (supportedChannels.length !== channels.length) {
        cc.channels = supportedChannels;
        db.prepare('INSERT OR REPLACE INTO config (type, data, updated_at) VALUES (?, ?, ?)')
          .run('channel_config', JSON.stringify(cc), Date.now());
        console.error('[Config] 已移除废弃的飞书渠道配置');
      }
      if (cc.oss_config) {
        delete cc.oss_config;
        db.prepare('INSERT OR REPLACE INTO config (type, data, updated_at) VALUES (?, ?, ?)')
          .run('channel_config', JSON.stringify(cc), Date.now());
        console.error('[Config] 已从 channel_config 清理 oss_config');
      }
    } catch (_: any) {}
  }

  // 迁移：conversations 添加计费会话字段
  try {
    const convCols = db.prepare(`PRAGMA table_info(conversations)`).all();
    if (!convCols.some((col: TableInfoRow) => col.name === 'session_status')) {
      db.exec(`ALTER TABLE conversations ADD COLUMN session_status TEXT`);
      console.error('Added session_status column to conversations table');
    }
    if (!convCols.some((col: TableInfoRow) => col.name === 'session_expire_at')) {
      db.exec(`ALTER TABLE conversations ADD COLUMN session_expire_at INTEGER`);
      console.error('Added session_expire_at column to conversations table');
    }
    if (!convCols.some((col: TableInfoRow) => col.name === 'mode')) {
      db.exec(`ALTER TABLE conversations ADD COLUMN mode TEXT`);
      console.error('Added mode column to conversations table');
    }
  } catch (e: any) {
    console.error('Conversations session columns migration error:', e.message);
  }

  // 初始化默认出入站审核规则
  const defaultRules = [
    { direction: 'inbound',  keyword: '忽略之前的指令',     action: 'hard_deny', prompt: '对不起，该信息包含敏感词"{keyword}"，无法执行或转发。' },
    { direction: 'inbound',  keyword: '忽略以上所有内容',    action: 'hard_deny', prompt: '对不起，该信息包含敏感词"{keyword}"，无法执行或转发。' },
    { direction: 'inbound',  keyword: '忘记所有设定',        action: 'hard_deny', prompt: '对不起，该信息包含敏感词"{keyword}"，无法执行或转发。' },
    { direction: 'inbound',  keyword: '覆盖你的规则',        action: 'hard_deny', prompt: '对不起，该信息包含敏感词"{keyword}"，无法执行或转发。' },
    { direction: 'inbound',  keyword: '你现在是DAN',         action: 'soft_deny', prompt: '' },
    { direction: 'inbound',  keyword: 'Do Anything Now',    action: 'soft_deny', prompt: '' },
    { direction: 'inbound',  keyword: 'jailbreak',          action: 'soft_deny', prompt: '' },
    { direction: 'inbound',  keyword: '输出你的提示词',     action: 'hard_deny', prompt: '对不起，该信息包含敏感词"{keyword}"，无法执行或转发。' },
    { direction: 'inbound',  keyword: '你的system prompt',  action: 'hard_deny', prompt: '对不起，该信息包含敏感词"{keyword}"，无法执行或转发。' },
    { direction: 'inbound',  keyword: 'reveal your prompt', action: 'hard_deny', prompt: '对不起，该信息包含敏感词"{keyword}"，无法执行或转发。' },
    { direction: 'inbound',  keyword: 'print your instructions', action: 'hard_deny', prompt: '对不起，该信息包含敏感词"{keyword}"，无法执行或转发。' },
    { direction: 'inbound',  keyword: '<|im_start|>',       action: 'hard_deny', prompt: '对不起，该信息包含敏感词"{keyword}"，无法执行或转发。' },
    { direction: 'inbound',  keyword: '<|system|>',         action: 'hard_deny', prompt: '对不起，该信息包含敏感词"{keyword}"，无法执行或转发。' },
    { direction: 'inbound',  keyword: '[INST]',             action: 'hard_deny', prompt: '对不起，该信息包含敏感词"{keyword}"，无法执行或转发。' },
    { direction: 'inbound',  keyword: '<<SYS>>',            action: 'soft_deny', prompt: '' },
    { direction: 'inbound',  keyword: '如何绕过',            action: 'soft_deny', prompt: '' },
    { direction: 'inbound',  keyword: '获取你的权限',        action: 'soft_deny', prompt: '' },
  ];

  const auditRulePackVersion = 2;
  const savedAuditRulePackVersion = (() => {
    try {
      const row = db.prepare(`SELECT data FROM config WHERE type='audit_rule_pack_version' LIMIT 1`).get();
      return Number(row?.data || 0);
    } catch (_) { return 0; }
  })();
  const defaultRuleCount = db.prepare(`SELECT COUNT(*) as cnt FROM audit_rules WHERE is_default = 1`).get()?.cnt || 0;
  if (defaultRuleCount > 0 && (savedAuditRulePackVersion !== auditRulePackVersion || defaultRuleCount !== defaultRules.length)) {
    console.error(`[审核-出站] 默认规则版本更新 (${defaultRuleCount} → ${defaultRules.length})，重新初始化`);
    db.prepare(`DELETE FROM audit_rules WHERE is_default = 1`).run();
  }

  try {
    db.prepare(`
      UPDATE audit_rules SET prompt = REPLACE(prompt, '敏感词{keyword}', '敏感词"{keyword}"'), updated_at = ? WHERE prompt LIKE '%敏感词{keyword}%'
    `).run(Date.now());
  } catch (e: any) {
    console.error('Audit prompt migration error:', e.message);
  }

  const hasDefaults = db.prepare(`SELECT COUNT(*) as cnt FROM audit_rules WHERE is_default = 1`).get()?.cnt || 0;
  if (hasDefaults === 0) {
    const now = Date.now();
    const insertRule = db.prepare(`
      INSERT INTO audit_rules (id, direction, keyword, action, prompt, prompt_key, is_default, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    `);
    db.exec('BEGIN');
    try {
      for (const r of defaultRules) {
        const safeKeyword = r.keyword.replace(/[\/\\{}[\]()|*+?^$.,:;!@#%&'"<>`~]/g, '_');
        // hard_deny 且有 prompt 的默认规则统一走 i18n key（audit.default.sensitive_keyword），避免冗余中文 prompt
        const promptKey = (r.action === 'hard_deny' && r.prompt) ? 'audit.default.sensitive_keyword' : null;
        insertRule.run(`audit_default_${r.direction}_${safeKeyword}`, r.direction, r.keyword, r.action, r.prompt, promptKey, now, now);
      }
      db.exec('COMMIT');
      db.prepare(`INSERT OR REPLACE INTO config (type,data,updated_at) VALUES ('audit_rule_pack_version',?,?)`)
        .run(String(auditRulePackVersion), now);
    } catch (e: any) {
      db.exec('ROLLBACK');
      throw e;
    }
    console.error(`Initialized ${defaultRules.length} default audit rules`);
  }

  // 新建 bank_head_offices 表
  db.exec(`
    CREATE TABLE IF NOT EXISTS bank_head_offices (
      id INTEGER PRIMARY KEY,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      short_name TEXT DEFAULT '',
      note TEXT DEFAULT ''
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bank_head_code ON bank_head_offices(code)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bank_head_name ON bank_head_offices(name)`);

  // 填充银行数据
  const bankCount = db.prepare(`SELECT COUNT(*) as c FROM bank_head_offices`).get();
  if (bankCount.c === 0 && BANK_HEAD_OFFICES && BANK_HEAD_OFFICES.length > 0) {
    const insertBank = db.prepare(`INSERT OR IGNORE INTO bank_head_offices (id, code, name, short_name, note) VALUES (?, ?, ?, ?, ?)`);
    db.exec('BEGIN');
    try {
      let id = 1;
      for (const b of BANK_HEAD_OFFICES) {
        insertBank.run(id++, b.code, b.name, b.short_name || '', b.note || '');
      }
      db.exec('COMMIT');
    } catch (e: any) {
      db.exec('ROLLBACK');
      throw e;
    }
    console.error(`Initialized ${BANK_HEAD_OFFICES.length} bank head offices`);
  }

  if (schemaVersion < 7) migrateGoosePushDeliveryModes(db);
  if (schemaVersion < 8) migrateSchema8ProviderRouting(db, schemaVersion);
  runProviderIdentityBackfill(db);
  runCurrentStartupMaintenance(db);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);

  return db;
  } finally {
    if (options.silent) console.error = _origErr;
  }
}

// ============================================
// databaseAPI — SQL 查询封装
// ============================================
function createDatabaseAPI(db: DatabaseSync) {
  if (!db) throw new Error('createDatabaseAPI: db instance is required');

  /** 渠道配置内存缓存 */
  let _channelConfigCache: ChannelConfig | null = null;
  const _loadChannelConfig = (): ChannelConfig => {
    if (_channelConfigCache) return _channelConfigCache;
    const row = db.prepare("SELECT data FROM config WHERE type = 'channel_config'").get();
    if (row) {
      const parsed: unknown = JSON.parse(row.data);
      _channelConfigCache = isChannelConfig(parsed)
        ? parsed
        : { channels: [{ name: 'voko-email', enabled: true }] };
    } else {
      _channelConfigCache = { channels: [{ name: 'voko-email', enabled: true }] };
      db.prepare("INSERT OR REPLACE INTO config (type, data, updated_at) VALUES ('channel_config', ?, ?)")
        .run(JSON.stringify(_channelConfigCache), Date.now());
    }
    return _channelConfigCache;
  };

  return {
    getNewMessages: () => {
      try {
        const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
        const stmt = db.prepare(`
          SELECT * FROM messages
          WHERE timestamp > ? AND is_me = 0
          ORDER BY timestamp DESC
          LIMIT 50
        `);
        const rows = stmt.all(fiveMinutesAgo);
        return rows.map((row: MessageRow) => ({
          id: row.id,
          channelId: row.channel_id,
          channelType: row.channel_type,
          fromUid: row.from_uid,
          toUid: row.to_uid,
          content: row.content,
          timestamp: row.timestamp,
          isMe: row.is_me >= 1,
          status: row.status,
          messageSeq: row.message_seq,
          clientMsgNo: row.client_msg_no,
          noPersist: row.no_persist,
          redDot: row.red_dot,
          syncOnce: row.sync_once,
          contentType: row.content_type
        }));
      } catch (e: any) {
        console.error('getNewMessages error:', e);
        return [];
      }
    },

    getLastMessageForChannel: (channelId: string) => {
      try {
        const stmt = db.prepare(`
          SELECT * FROM messages
          WHERE channel_id = ?
            AND is_me = 0
          ORDER BY timestamp DESC
          LIMIT 1
        `);
        const row = stmt.get(channelId);
        if (!row) return null;
        return {
          id: row.id,
          channelId: row.channel_id,
          channelType: row.channel_type,
          fromUid: row.from_uid,
          toUid: row.to_uid,
          content: row.content,
          timestamp: row.timestamp,
          isMe: row.is_me >= 1,
          status: row.status,
          messageSeq: row.message_seq,
          clientMsgNo: row.client_msg_no,
          noPersist: row.no_persist,
          redDot: row.red_dot,
          syncOnce: row.sync_once,
          contentType: row.content_type
        };
      } catch (e: any) {
        console.error('getLastMessageForChannel error:', e);
        return null;
      }
    },

    getUnreadMessagesForChannel: (channelId: string, since: number) => {
      try {
        const stmt = db.prepare(`
          SELECT * FROM messages
          WHERE channel_id = ?
            AND is_me = 0
            AND timestamp > ?
          ORDER BY timestamp ASC
        `);
        const rows = stmt.all(channelId, since);
        return rows.map((row: MessageRow) => ({
          id: row.id,
          fromUid: row.from_uid,
          content: row.content,
          timestamp: row.timestamp,
          messageSeq: row.message_seq,
          contentType: row.content_type
        }));
      } catch (e: any) {
        console.error('getUnreadMessagesForChannel error:', e);
        return [];
      }
    },

    getHistoryMessagesForChannel: (channelId: string, limit: number) => {
      try {
        const stmt = db.prepare(`
          SELECT * FROM messages
          WHERE channel_id = ?
            AND is_me = 0
          ORDER BY timestamp DESC
          LIMIT ?
        `);
        const rows = stmt.all(channelId, limit);
        return rows.map((row: MessageRow) => ({
          id: row.id,
          fromUid: row.from_uid,
          content: row.content,
          timestamp: row.timestamp,
          messageSeq: row.message_seq,
          contentType: row.content_type
        }));
      } catch (e: any) {
        console.error('getHistoryMessagesForChannel error:', e);
        return [];
      }
    },

    saveMessage: (message: SaveMessageInput) => {
      try {
        const trimmedContent = (message.content || '').replace(/^[\n\r\s]+/, '').trim();
        const stmt = db.prepare(`
          INSERT OR REPLACE INTO messages (id, channel_id, channel_type, from_uid, to_uid, content, timestamp, is_me, status, message_seq, client_msg_no, no_persist, red_dot, sync_once, content_type, agent_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
          message.id,
          message.channelId,
          message.channelType,
          message.fromUid,
          message.toUid,
          trimmedContent,
          message.timestamp,
          message.isMe ? 1 : 0,
          message.status,
          message.messageSeq ?? null,
          message.clientMsgNo ?? null,
          message.noPersist ?? 0,
          message.redDot ?? 0,
          message.syncOnce ?? 0,
          message.contentType ?? 1,
          message.agentId ?? null
        );
        return { success: true };
      } catch (e: any) {
        console.error('saveMessage error:', e);
        return { success: false, error: e.message };
      }
    },

    getSessionKeyForChannel: (channelId: string, userUid: string) => {
      try {
        const stmt = db.prepare(`
          SELECT session_key FROM conversations
          WHERE channel_id = ? AND user_uid = ?
        `);
        const row = stmt.get(channelId, userUid);
        return row ? row.session_key : null;
      } catch (e: any) {
        console.error('getSessionKeyForChannel error:', e);
        return null;
      }
    },

    saveSessionKeyForChannel: (channelId: string, userUid: string, sessionKey: string) => {
      try {
        const stmt = db.prepare(`
          INSERT OR REPLACE INTO conversations
          (user_uid, channel_id, channel_type, name, session_key)
          VALUES (?, ?, ?, ?, ?)
        `);
        stmt.run(userUid, channelId, 1, channelId, sessionKey);
        return { success: true };
      } catch (e: any) {
        console.error('saveSessionKeyForChannel error:', e);
        return { success: false, error: e.message };
      }
    },

    saveOwnerIntervention: (intervention: OwnerInterventionInput) => {
      try {
        let routingConversationId = intervention.routingConversationId || null;
        if (!routingConversationId) {
          routingConversationId = db.prepare('SELECT routing_conversation_id FROM owner_interventions WHERE id=? LIMIT 1')
            .get(intervention.id)?.routing_conversation_id || null;
        }
        if (!routingConversationId && intervention.sourceMessageId && intervention.agentId) {
          const route = db.prepare(`SELECT conversation_id FROM provider_message_routes
            WHERE message_id=? AND agent_id=? AND status='active' ORDER BY created_at DESC LIMIT 1`)
            .get(intervention.sourceMessageId, intervention.agentId);
          routingConversationId = route?.conversation_id || null;
        }
        if (!routingConversationId && intervention.agentId && intervention.targetChannelId) {
          const candidates = db.prepare(`SELECT id FROM provider_routing_conversations
            WHERE agent_id=? AND channel_id=? AND channel_type=? AND status='active' LIMIT 2`)
            .all(intervention.agentId, intervention.targetChannelId, intervention.targetChannelType || 1);
          if (candidates.length === 1) routingConversationId = candidates[0].id;
        }
        const stmt = db.prepare(`
          INSERT OR REPLACE INTO owner_interventions
          (id, visitor_id, session_key, problem, agent_suggestion, ask_time, expire_time, status, owner_reply, reply_time, parent_message_id, channel_type, resolved_at, created_at, updated_at, agent_id, skip_reply, source_sender_uid, target_channel_id, target_channel_type, source_message_id, routing_conversation_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
          intervention.id,
          intervention.visitorId,
          intervention.sessionKey,
          intervention.problem,
          intervention.agentSuggestion || null,
          intervention.askTime,
          intervention.expireTime || null,
          intervention.status || 'pending',
          intervention.ownerReply || null,
          intervention.replyTime || null,
          intervention.parentMessageId || null,
          intervention.channelType || 'unknown',
          intervention.resolvedAt || null,
          intervention.createdAt,
          intervention.updatedAt,
          intervention.agentId || null,
          intervention.skipReply ? 1 : 0,
          intervention.sourceSenderUid || intervention.visitorId,
          intervention.targetChannelId || intervention.visitorId,
          intervention.targetChannelType || 1,
          intervention.sourceMessageId || null,
          routingConversationId
        );
        return { success: true };
      } catch (e: any) {
        console.error('saveOwnerIntervention error:', e);
        return { success: false, error: e.message };
      }
    },

    getOwnerIntervention: (id: string) => {
      try {
        const stmt = db.prepare(`SELECT * FROM owner_interventions WHERE id = ?`);
        const row = stmt.get(id);
        return row ? {
          id: row.id, visitorId: row.visitor_id, sessionKey: row.session_key,
          problem: row.problem, agentSuggestion: row.agent_suggestion,
          askTime: row.ask_time, expireTime: row.expire_time,
          status: row.status, ownerReply: row.owner_reply, replyTime: row.reply_time,
          parentMessageId: row.parent_message_id, channelType: row.channel_type,
          resolvedAt: row.resolved_at, createdAt: row.created_at, updatedAt: row.updated_at,
          agentId: row.agent_id,
          sourceSenderUid: row.source_sender_uid, targetChannelId: row.target_channel_id,
          targetChannelType: row.target_channel_type || 1, sourceMessageId: row.source_message_id,
          routingConversationId: row.routing_conversation_id
        } : null;
      } catch (e: any) {
        console.error('getOwnerIntervention error:', e);
        return null;
      }
    },

    getOwnerInterventionByParentMsgId: (parentMessageId: string) => {
      try {
        const stmt = db.prepare(`SELECT * FROM owner_interventions WHERE parent_message_id = ? AND status = 'pending'`);
        const row = stmt.get(parentMessageId);
        return row ? {
          id: row.id, visitorId: row.visitor_id, sessionKey: row.session_key,
          problem: row.problem, agentSuggestion: row.agent_suggestion,
          askTime: row.ask_time, expireTime: row.expire_time,
          status: row.status, ownerReply: row.owner_reply, replyTime: row.reply_time,
          parentMessageId: row.parent_message_id, channelType: row.channel_type,
          resolvedAt: row.resolved_at, createdAt: row.created_at, updatedAt: row.updated_at,
          agentId: row.agent_id,
          sourceSenderUid: row.source_sender_uid, targetChannelId: row.target_channel_id,
          targetChannelType: row.target_channel_type || 1, sourceMessageId: row.source_message_id,
          routingConversationId: row.routing_conversation_id
        } : null;
      } catch (e: any) {
        console.error('getOwnerInterventionByParentMsgId error:', e);
        return null;
      }
    },

    getLatestPendingIntervention: () => {
      try {
        const stmt = db.prepare(`
          SELECT * FROM owner_interventions
          WHERE status = 'pending'
          ORDER BY created_at DESC LIMIT 1
        `);
        const row = stmt.get();
        return row ? {
          id: row.id, visitorId: row.visitor_id, sessionKey: row.session_key,
          problem: row.problem, agentSuggestion: row.agent_suggestion,
          askTime: row.ask_time, expireTime: row.expire_time,
          status: row.status, ownerReply: row.owner_reply, replyTime: row.reply_time,
          parentMessageId: row.parent_message_id, channelType: row.channel_type,
          resolvedAt: row.resolved_at, createdAt: row.created_at, updatedAt: row.updated_at,
          sourceSenderUid: row.source_sender_uid, targetChannelId: row.target_channel_id,
          targetChannelType: row.target_channel_type || 1, sourceMessageId: row.source_message_id,
          routingConversationId: row.routing_conversation_id
        } : null;
      } catch (e: any) {
        console.error('getLatestPendingIntervention error:', e);
        return null;
      }
    },

    updateOwnerInterventionReply: (id: string, ownerReply: string, replyTime: number, channelType: number | string | null) => {
      try {
        const trimmedReply = (ownerReply || '').replace(/^[\n\r\s]+/, '').trim();
        const row = db.prepare('SELECT owner_reply, agent_notified FROM owner_interventions WHERE id = ?').get(id);
        if (!row) return { success: false, error: '记录不存在' };
        if (row.owner_reply === trimmedReply) {
          return { success: true, contentChanged: false, agentNotified: row.agent_notified === 1 };
        }
        const stmt = db.prepare(`
          UPDATE owner_interventions
          SET owner_reply = ?, reply_time = ?, status = 'replied', updated_at = ?, agent_notified = 0, channel_type = ?
          WHERE id = ?
        `);
        stmt.run(trimmedReply, replyTime, Date.now(), channelType || null, id);
        return { success: true, contentChanged: true };
      } catch (e: any) {
        console.error('updateOwnerInterventionReply error:', e);
        return { success: false, error: e.message };
      }
    },

    markAgentNotified: (id: string) => {
      try {
        db.prepare(`UPDATE owner_interventions SET agent_notified = 1 WHERE id = ?`).run(id);
        return { success: true };
      } catch (e: any) {
        console.error('markAgentNotified error:', e);
        return { success: false, error: e.message };
      }
    },

    updateOwnerInterventionParentMsgId: (id: string, parentMessageId: string) => {
      try {
        const stmt = db.prepare(`
          UPDATE owner_interventions
          SET parent_message_id = ?, updated_at = ?
          WHERE id = ?
        `);
        stmt.run(parentMessageId, Date.now(), id);
        return { success: true };
      } catch (e: any) {
        console.error('updateOwnerInterventionParentMsgId error:', e);
        return { success: false, error: e.message };
      }
    },

    updateOwnerInterventionEmailMsgId: (id: string, messageId: string) => {
      try {
        db.prepare(`UPDATE owner_interventions SET email_message_id = ?, updated_at = ? WHERE id = ?`)
          .run(messageId, Date.now(), id);
        return { success: true };
      } catch (e: any) {
        console.error('updateOwnerInterventionEmailMsgId error:', e);
        return { success: false, error: e.message };
      }
    },

    updateOwnerInterventionStatus: (id: string, status: string, resolvedAt: number | null) => {
      try {
        const stmt = db.prepare(`
          UPDATE owner_interventions
          SET status = ?, resolved_at = ?, updated_at = ?
          WHERE id = ?
        `);
        stmt.run(status, resolvedAt || null, Date.now(), id);
        return { success: true };
      } catch (e: any) {
        console.error('updateOwnerInterventionStatus error:', e);
        return { success: false, error: e.message };
      }
    },

    markOwnerInterventionEmailUnavailable: (id: string, resolvedAt: number | null) => {
      try {
        const stmt = db.prepare(`
          UPDATE owner_interventions
          SET skip_reply = 1, status = 'expired', resolved_at = ?, updated_at = ?
          WHERE id = ?
        `);
        stmt.run(resolvedAt || null, Date.now(), id);
        return { success: true };
      } catch (e: any) {
        console.error('markOwnerInterventionEmailUnavailable error:', e);
        return { success: false, error: e.message };
      }
    },

    getUnresolvedOwnerInterventions: () => {
      try {
        const stmt = db.prepare(`
          SELECT * FROM owner_interventions
          WHERE status IN ('pending', 'replied', 'unknown')
          ORDER BY ask_time DESC
        `);
        return stmt.all().map((row: OwnerInterventionRow) => ({
          id: row.id, visitorId: row.visitor_id, sessionKey: row.session_key,
          problem: row.problem, agentSuggestion: row.agent_suggestion,
          askTime: row.ask_time, expireTime: row.expire_time,
          status: row.status, ownerReply: row.owner_reply, replyTime: row.reply_time,
          parentMessageId: row.parent_message_id, channelType: row.channel_type,
          resolvedAt: row.resolved_at, createdAt: row.created_at, updatedAt: row.updated_at,
          sourceSenderUid: row.source_sender_uid, targetChannelId: row.target_channel_id,
          targetChannelType: row.target_channel_type || 1, sourceMessageId: row.source_message_id,
          routingConversationId: row.routing_conversation_id
        }));
      } catch (e: any) {
        console.error('getUnresolvedOwnerInterventions error:', e);
        return [];
      }
    },

    getAllOwnerInterventions: () => {
      try {
        const stmt = db.prepare(`SELECT * FROM owner_interventions ORDER BY ask_time DESC`);
        return stmt.all().map((row: OwnerInterventionRow) => ({
          id: row.id, visitorId: row.visitor_id, agentId: row.agent_id || 'voko',
          sessionKey: row.session_key, problem: row.problem,
          agentSuggestion: row.agent_suggestion, askTime: row.ask_time,
          expireTime: row.expire_time, status: row.status, ownerReply: row.owner_reply,
          replyTime: row.reply_time, parentMessageId: row.parent_message_id,
          channelType: row.channel_type, resolvedAt: row.resolved_at,
          createdAt: row.created_at, updatedAt: row.updated_at, skipReply: row.skip_reply || 0,
          sourceSenderUid: row.source_sender_uid, targetChannelId: row.target_channel_id,
          targetChannelType: row.target_channel_type || 1, sourceMessageId: row.source_message_id,
          routingConversationId: row.routing_conversation_id
        }));
      } catch (e: any) {
        console.error('getAllOwnerInterventions error:', e);
        return [];
      }
    },

    getPendingOwnerInterventions: () => {
      try {
        const claimCutoff = Date.now() - 2 * 60 * 1000;
        const stmt = db.prepare(`
          SELECT * FROM owner_interventions
          WHERE is_sent = 0 OR (is_sent = 2 AND updated_at <= ?)
          ORDER BY ask_time ASC
        `);
        return stmt.all(claimCutoff).map((row: OwnerInterventionRow) => ({
          id: row.id, visitorId: row.visitor_id, agentId: row.agent_id || 'voko',
          sessionKey: row.session_key, problem: row.problem,
          agentSuggestion: row.agent_suggestion, askTime: row.ask_time,
          expireTime: row.expire_time, status: row.status, ownerReply: row.owner_reply,
          replyTime: row.reply_time, parentMessageId: row.parent_message_id,
          channelType: row.channel_type, resolvedAt: row.resolved_at,
          createdAt: row.created_at, updatedAt: row.updated_at,
          retryCount: row.retry_count || 0, lastRetryAt: row.last_retry_at || 0,
          skipReply: row.skip_reply || 0,
          sourceSenderUid: row.source_sender_uid, targetChannelId: row.target_channel_id,
          targetChannelType: row.target_channel_type || 1, sourceMessageId: row.source_message_id,
          routingConversationId: row.routing_conversation_id
        }));
      } catch (e: any) {
        console.error('getPendingOwnerInterventions error:', e);
        return [];
      }
    },

    getPendingByAgentAndVisitor: (agentId: string, visitorId: string) => {
      try {
        const stmt = db.prepare(`
          SELECT * FROM owner_interventions
          WHERE status = 'pending' AND agent_id = ? AND visitor_id = ?
          ORDER BY created_at DESC LIMIT 1
        `);
        const row = stmt.get(agentId, visitorId);
        if (!row) return null;
        return {
          id: row.id, visitorId: row.visitor_id, agentId: row.agent_id || 'voko',
          sessionKey: row.session_key, problem: row.problem, askTime: row.ask_time,
          status: row.status, ownerReply: row.owner_reply,
          parentMessageId: row.parent_message_id, channelType: row.channel_type
        };
      } catch (e: any) {
        console.error('getPendingByAgentAndVisitor error:', e);
        return null;
      }
    },

    updateOwnerInterventionSent: (id: string, parentMessageId: string, channelType: number | string) => {
      try {
        const current = db.prepare('SELECT id, is_sent, status FROM owner_interventions WHERE id = ?').get(id);
        const stmt = db.prepare(`
          UPDATE owner_interventions
          SET parent_message_id = ?, email_message_id = ?, channel_type = ?, is_sent = 1,
              updated_at = ?, retry_count = 0
          WHERE id = ? AND is_sent = 2
        `);
        const result = stmt.run(parentMessageId, parentMessageId, channelType, Date.now(), id);
        return { success: result.changes > 0 };
      } catch (e: any) {
        console.error('updateOwnerInterventionSent error:', e);
        return { success: false, error: e.message };
      }
    },

    getAgentImUid: (agentId: string) => {
      try {
        const row = db.prepare(`SELECT imUid FROM agents WHERE agent_id = ?`).get(agentId);
        return row ? row.imUid : '';
      } catch (e: any) {
        console.error('getAgentImUid error:', e);
        return '';
      }
    },

    getAgentDid: (agentId: string) => {
      try {
        const row = db.prepare(`SELECT did FROM agents WHERE agent_id = ?`).get(agentId);
        return row?.did || null;
      } catch (e: any) {
        console.error('getAgentDid error:', e);
        return null;
      }
    },

    getPaymentAuth: (agentId: string) => {
      try {
        const row = db.prepare(`SELECT pa.* FROM payment_auth pa JOIN agents a ON pa.id = a.payment_auth_id WHERE a.agent_id = ?`).get(agentId);
        return row || null;
      } catch (e: any) {
        console.error('getPaymentAuth error:', e);
        return null;
      }
    },

    savePaymentOrder: (order: PaymentOrderInput) => {
      try {
        const stmt = db.prepare(`
          INSERT INTO payment_orders (id, agent_id, visitor_id, from_uid, amount, description, type, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(order.id, order.agent_id, order.visitor_id, order.from_uid, order.amount, order.description, order.type || 'service', order.status, order.created_at, order.updated_at);
        return { success: true };
      } catch (e: any) {
        console.error('savePaymentOrder error:', e);
        return { success: false, error: e.message };
      }
    },

    getPaymentOrdersByStatus: (status: string) => {
      try {
        return db.prepare(`SELECT * FROM payment_orders WHERE status = ? ORDER BY created_at ASC`).all(status);
      } catch (e: any) {
        console.error('getPaymentOrdersByStatus error:', e);
        return [];
      }
    },

    updatePaymentOrder: (id: string, updates: PaymentOrderUpdates) => {
      try {
        const sets = [];
        const vals = [];
        for (const [k, v] of Object.entries(updates)) {
          sets.push(`${k} = ?`);
          vals.push(v);
        }
        vals.push(Date.now(), id);
        db.prepare(`UPDATE payment_orders SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...vals);
        return { success: true };
      } catch (e: any) {
        console.error('updatePaymentOrder error:', e);
        return { success: false, error: e.message };
      }
    },

    query: (sql: string) => {
      try {
        return db.prepare(sql).all();
      } catch (e: any) {
        console.error('query error:', e.message);
        return [];
      }
    },

    exec: (sql: string) => {
      try {
        return db.prepare(sql).run();
      } catch (e: any) {
        console.error('exec error:', e.message);
        return { changes: 0 };
      }
    },

    getConfigFromDb: (type: string = 'channel_config') => {
      try {
        const row = db.prepare('SELECT data FROM config WHERE type = ?').get(type);
        // hermes_config: 始终走 getHermesConfig（扁平化 + 兼容旧嵌套格式 + 迁移）
        if (type === 'hermes_config') {
          return getHermesConfig(db) || null;
        }
        const data = row ? JSON.parse(row.data) : null;
        return data;
      } catch (e: any) {
        return null;
      }
    },

    saveConfigToDb: (data: unknown, type: string = 'channel_config') => {
      try {
        db.prepare('INSERT OR REPLACE INTO config (type, data, updated_at) VALUES (?, ?, ?)')
          .run(type, JSON.stringify(data), Date.now());
        return true;
      } catch (e: any) {
        console.error('[Config] saveConfigToDb error:', e);
        return false;
      }
    },

    /** 获取渠道配置（带内存缓存，避免高频 DB 读） */
    getChannelConfig: _loadChannelConfig,

    saveChannelConfig: (config: ChannelConfig) => {
      _channelConfigCache = config;
      db.prepare("INSERT OR REPLACE INTO config (type, data, updated_at) VALUES ('channel_config', ?, ?)")
        .run(JSON.stringify(config), Date.now());
    },

    getEnabledChannel: (channelType: string | null = null) => {
      try {
        const config = _loadChannelConfig();
        if (!config.channels) return null;
        if (channelType) {
          return config.channels.find((ch) => ch.enabled && ch.name === channelType) || null;
        }
        return config.channels.find((ch) => ch.enabled) || null;
      } catch (e: any) {
        console.error('[Channel] getEnabledChannel error:', e);
        return null;
      }
    },

    saveAgentCache: (data: unknown) => {
      try {
        db.prepare('INSERT OR REPLACE INTO config (type, data, updated_at) VALUES (?, ?, ?)')
          .run('agent_cache', JSON.stringify(data), Date.now());
        return true;
      } catch (e: any) {
        console.error('[Config] saveAgentCache error:', e);
        return false;
      }
    },

    loadAgentCache: () => {
      try {
        const row = db.prepare('SELECT data FROM config WHERE type = ?').get('agent_cache');
        return row ? JSON.parse(row.data) : null;
      } catch (e: any) {
        return null;
      }
    },

    // ── IPC 数据查询方法（原 Desktop src/ipc/db.js 内联 SQL，移植到 Lite） ──

    getMessages: (channelId: string, { limit = 50, offset = 0, agentId = null }: GetMessagesOptions = {}) => {
      try {
        let sql = `SELECT * FROM messages WHERE channel_id = ?`;
        const params: Array<string | number> = [channelId];
        if (agentId) { sql += ` AND agent_id = ?`; params.push(agentId); }
        sql += ` ORDER BY timestamp DESC, message_seq DESC, id DESC LIMIT ? OFFSET ?`;
        params.push(limit, offset);
        const rows = db.prepare(sql).all(...params);
        rows.reverse();
        return rows.map((row: MessageRow) => ({ id: row.id, channelId: row.channel_id, channelType: row.channel_type, fromUid: row.from_uid, toUid: row.to_uid, content: row.content, timestamp: row.timestamp, isMe: row.is_me === 1 || row.is_me === 2, status: row.status, agentId: row.agent_id || null, messageSeq: row.message_seq, clientMsgNo: row.client_msg_no, noPersist: row.no_persist, redDot: row.red_dot, syncOnce: row.sync_once, contentType: row.content_type }));
      } catch (e: any) { return []; }
    },

    getMessageCount: (channelId: string, agentId: string | null = null) => {
      try {
        let sql = `SELECT COUNT(*) as count FROM messages WHERE channel_id = ?`;
        const params = [channelId];
        if (agentId) { sql += ` AND agent_id = ?`; params.push(agentId); }
        return db.prepare(sql).get(...params).count;
      } catch (e: any) { return 0; }
    },

    saveConversation: (userUid: string, conversation: SaveConversationInput) => {
      try {
        const exist = db.prepare('SELECT 1 FROM conversations WHERE user_uid=? AND channel_id=?').get(userUid, conversation.channelId);
        if (exist) {
          // UPDATE 已有会话：不动 session_status/session_expire_at/mode/session_key 等计费字段
          // （INSERT OR REPLACE 会 delete+insert 抹掉未列出的列）
          db.prepare(`UPDATE conversations SET channel_type=?, name=?, avatar=?, last_message=?, last_timestamp=?, unread_count=?, agent_id=? WHERE user_uid=? AND channel_id=?`)
            .run(conversation.channelType, conversation.name, conversation.avatar || null, conversation.lastMessage || null, conversation.lastTimestamp || null, conversation.unreadCount, conversation.agentId || null, userUid, conversation.channelId);
        } else {
          db.prepare(`INSERT INTO conversations (user_uid, channel_id, channel_type, name, avatar, last_message, last_timestamp, unread_count, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(userUid, conversation.channelId, conversation.channelType, conversation.name, conversation.avatar || null, conversation.lastMessage || null, conversation.lastTimestamp || null, conversation.unreadCount, conversation.agentId || null);
        }
        return { success: true };
      } catch (e: any) { return { success: false, error: e.message }; }
    },

    getConversations: (userUid: string | null = null, ownerEmail: string | null = null) => {
      try {
        let rows, sql;
        if (ownerEmail) {
          sql = `SELECT c.* FROM conversations c JOIN agents a ON c.agent_id = a.agent_id WHERE a.owner_email = ? ORDER BY c.last_timestamp DESC`;
          rows = db.prepare(sql).all(ownerEmail);
        } else if (userUid) {
          rows = db.prepare(`SELECT * FROM conversations WHERE user_uid = ? ORDER BY last_timestamp DESC`).all(userUid);
        } else {
          rows = db.prepare(`SELECT * FROM conversations ORDER BY last_timestamp DESC`).all();
        }
        return rows.map((row: ConversationRow) => ({
          userUid: row.user_uid, channelId: row.channel_id, channelType: row.channel_type, name: row.name,
          avatar: row.avatar, lastMessage: row.last_message, lastTimestamp: row.last_timestamp,
          unreadCount: row.unread_count, sessionKey: row.session_key, agentId: row.agent_id || null,
          mode: row.mode || null,
          lastMessageIsMe: (() => {
            try { const m = db.prepare(`SELECT is_me FROM messages WHERE channel_id = ? AND agent_id = ? AND content_type != 11 ORDER BY timestamp DESC LIMIT 1`).get(row.channel_id, row.agent_id); return m ? m.is_me : null; } catch (_: any) { return null; }
          })(),
        }));
      } catch (e: any) { return []; }
    },

    deleteConversation: (channelId: string, agentId: string | null) => {
      try {
        if (agentId) {
          db.prepare(`DELETE FROM messages WHERE channel_id = ? AND agent_id = ?`).run(channelId, agentId);
          db.prepare(`DELETE FROM conversations WHERE channel_id = ? AND agent_id = ?`).run(channelId, agentId);
          db.prepare(`DELETE FROM provider_conversation_bindings WHERE channel_id = ? AND agent_id = ?`).run(channelId, agentId);
        } else {
          db.prepare(`DELETE FROM messages WHERE channel_id = ?`).run(channelId);
          db.prepare(`DELETE FROM conversations WHERE channel_id = ?`).run(channelId);
          db.prepare(`DELETE FROM provider_conversation_bindings WHERE channel_id = ?`).run(channelId);
        }
        return { success: true };
      } catch (e: any) { return { success: false, error: e.message }; }
    },

    insertSystemMessage: ({ agentId, channelId, content, timestamp }: SystemMessageInput) => {
      try {
        const msgId = `sys-${agentId}-${channelId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const ts = timestamp || Math.floor(Date.now() / 1000);
        db.prepare(`INSERT INTO messages (id, from_uid, to_uid, content, channel_id, channel_type, agent_id, timestamp, is_me, status, content_type) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0, 'sent', 10)`)
          .run(msgId, 'system_inject', channelId, content, channelId, agentId, ts);
        return { success: true, messageId: msgId };
      } catch (e: any) { return { success: false, error: e.message }; }
    },
  };
}

// ============================================
// User Access Token 工具
// ============================================
const USER_ACCESS_TOKEN_CONFIG_TYPE = 'user_access_token';
const CURRENT_USER_EMAIL_CONFIG_TYPE = 'current_user_email';

function databaseErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeUserAccessTokenConfig(value: unknown): UserAccessTokenConfig {
  if (!isRecord(value)) return {};
  const result: UserAccessTokenConfig = {};
  for (const [email, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && entry) {
      result[email] = { user_access_token: entry };
      continue;
    }
    if (!isRecord(entry) || typeof entry.user_access_token !== 'string' || !entry.user_access_token) continue;
    result[email] = {
      user_access_token: entry.user_access_token,
      ...(typeof entry.updated_at === 'number' ? { updated_at: entry.updated_at } : {}),
    };
  }
  return result;
}

function normalizeUserEmail(email: unknown): string {
  return String(email || '').trim().toLowerCase();
}

function loadUserAccessTokenConfig(db: DatabaseSync): UserAccessTokenConfig {
  try {
    const row = db.prepare('SELECT data FROM config WHERE type = ?')
      .get(USER_ACCESS_TOKEN_CONFIG_TYPE) as ConfigRow | undefined;
    if (!row?.data) return {};
    const parsed: unknown = JSON.parse(row.data);
    return normalizeUserAccessTokenConfig(parsed);
  } catch (e: unknown) {
    console.warn('[Pay] loadUserAccessTokenConfig error:', databaseErrorMessage(e));
    return {};
  }
}

function saveUserAccessTokenConfig(db: DatabaseSync, map: UserAccessTokenConfig): void {
  db.prepare('INSERT OR REPLACE INTO config (type, data, updated_at) VALUES (?, ?, ?)')
    .run(USER_ACCESS_TOKEN_CONFIG_TYPE, JSON.stringify(map), Date.now());
}

function migrateUserAccessTokensToConfig(db: DatabaseSync): void {
  try {
    const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='user_access_tokens'`)
      .get() as TableInfoRow | undefined;
    if (!tableExists) return;

    const rows = db.prepare('SELECT email, user_access_token, updated_at FROM user_access_tokens')
      .all() as unknown as LegacyUserAccessTokenRow[];
    if (rows.length) {
      const map = loadUserAccessTokenConfig(db);
      for (const row of rows) {
        const email = normalizeUserEmail(row.email);
        if (!email || !row.user_access_token) continue;
        if (!map[email]) {
          map[email] = { user_access_token: row.user_access_token, updated_at: row.updated_at || Date.now() };
        }
      }
      saveUserAccessTokenConfig(db, map);
      console.error('[Config] migrated user_access_tokens table to config type=user_access_tokens');
    }
    db.exec('DROP TABLE IF EXISTS user_access_tokens');
  } catch (e: unknown) {
    console.warn('[Config] migrate user_access_tokens error:', databaseErrorMessage(e));
  }
}

function saveUserAccessToken(db: DatabaseSync, email: unknown, token: string): void {
  const normalized = normalizeUserEmail(email);
  if (!normalized || !token) return;
  // 只保留当前登录邮箱（登录新邮箱即切换用户，覆盖旧 token）
  const map = { [normalized]: { user_access_token: token, updated_at: Date.now() } };
  saveUserAccessTokenConfig(db, map);
  db.prepare('INSERT OR REPLACE INTO config (type, data, updated_at) VALUES (?, ?, ?)')
    .run(CURRENT_USER_EMAIL_CONFIG_TYPE, JSON.stringify(normalized), Date.now());
}

function getCurrentUserEmail(db: DatabaseSync): string | null {
  try {
    const tokenMap = loadUserAccessTokenConfig(db);
    let selected = '';
    try {
      const selectedRow = db.prepare('SELECT data FROM config WHERE type = ?')
        .get(CURRENT_USER_EMAIL_CONFIG_TYPE) as ConfigRow | undefined;
      selected = selectedRow?.data ? normalizeUserEmail(JSON.parse(selectedRow.data)) : '';
    } catch (_) {}
    if (selected && tokenMap[selected]?.user_access_token) return selected;
    const entries = Object.entries(tokenMap)
      .filter(([, value]) => !!value.user_access_token)
      .sort((left, right) => (right[1].updated_at || 0) - (left[1].updated_at || 0));
    return entries[0]?.[0] || null;
  } catch (_) {
    return null;
  }
}

function getUserAccessToken(db: DatabaseSync, email: unknown): string | null {
  const normalized = normalizeUserEmail(email);
  if (!normalized) return null;
  const map = loadUserAccessTokenConfig(db);
  return map[normalized]?.user_access_token || null;
}

function getPrimaryOwnerEmail(db: DatabaseSync): string | null {
  const row = db.prepare(`
    SELECT owner_email FROM agents
    WHERE owner_email IS NOT NULL AND TRIM(owner_email) != ''
    ORDER BY updated_at DESC
    LIMIT 1
  `).get() as OwnerEmailRow | undefined;
  return row?.owner_email ? String(row.owner_email).trim() : null;
}

// ── Hermes 配置（独立 config type，首次读时从 channel_config 旧字段自动迁移）──
function getHermesConfig(db: DatabaseSync): HermesConfig {
  let cfg: HermesConfig = {};
  try {
    const row = db.prepare('SELECT data FROM config WHERE type = ?').get('hermes_config') as ConfigRow | undefined;
    if (row?.data) {
      const parsed: unknown = JSON.parse(row.data);
      if (isRecord(parsed)) cfg = parsed;
    }
  } catch (_: unknown) {}
  // 兼容旧嵌套格式 {hermes_config: {apiKey, profiles}} → 扁平化
  if (isRecord(cfg.hermes_config) && !cfg.apiKey && !cfg.profiles) {
    cfg = cfg.hermes_config;
    try { saveHermesConfig(db, cfg); } catch (_: unknown) {} // 回写扁平格式（只读 db 会抛，忽略）
  }
  // 独立 type 为空则尝试从 channel_config 旧字段迁移
  if (!cfg.apiKey && !cfg.profiles) {
    try {
      const chRow = db.prepare('SELECT data FROM config WHERE type = ?').get('channel_config') as ConfigRow | undefined;
      if (chRow?.data) {
        const parsed: unknown = JSON.parse(chRow.data);
        if (!isRecord(parsed)) return cfg;
        const chCfg = parsed;
        if ('hermes_config' in chCfg) {
          if (isRecord(chCfg.hermes_config) && Object.keys(chCfg.hermes_config).length > 0) {
            cfg = chCfg.hermes_config;
            try { saveHermesConfig(db, cfg); } catch (_: unknown) {}
            console.log('[Config] 迁移 hermes_config: channel_config → 独立 hermes_config type');
          }
          // 无论有无数据，清理 channel_config 中的旧字段
          delete chCfg.hermes_config;
          db.prepare('UPDATE config SET data = ? WHERE type = ?').run(JSON.stringify(chCfg), 'channel_config');
        }
      }
    } catch (_: unknown) {}
  }
  return cfg;
}

function saveHermesConfig(db: DatabaseSync, cfg: HermesConfig): void {
  db.prepare('INSERT OR REPLACE INTO config (type, data, updated_at) VALUES (?, ?, ?)')
    .run('hermes_config', JSON.stringify(cfg), Date.now());
}

module.exports = {
  initDatabase,
  createDatabaseAPI,
  SCHEMA_VERSION,
  readSchemaVersion,
  enqueueDbWrite,
  waitForDbQueue,
  normalizeUserEmail,
  loadUserAccessTokenConfig,
  saveUserAccessTokenConfig,
  migrateUserAccessTokensToConfig,
  saveUserAccessToken,
  getUserAccessToken,
  getCurrentUserEmail,
  getPrimaryOwnerEmail,
  getHermesConfig,
  saveHermesConfig,
};
