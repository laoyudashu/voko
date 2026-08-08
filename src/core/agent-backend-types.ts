/**
 * agent-backend-types.js — 支持的 Agent 后端类型集中配置
 *
 * 存储在 DB config 表（type='agent_backend_types'），避免各处硬编码。
 * 新增支持的 agent 类型只需更新 DB 该条 config，无需改代码。
 *
 * 数据结构：
 *   [{ value: 'openclaw', label: 'OpenClaw' }, ...]
 *
 * 用法：
 *   const { getBackendTypes, seedBackendTypes, getBackendTypeValues } = require('./agent-backend-types');
 *   const types = getBackendTypes(db);          // → [{value, label}, ...]
 *   const values = getBackendTypeValues(db);    // → ['openclaw', 'hermes', ...]
 */

const CONFIG_TYPE = 'agent_backend_types';
export {};

interface BackendType {
  value: string;
  label: string;
}

interface StatementLike {
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}

interface DatabaseLike {
  prepare(sql: string): StatementLike;
}

/** 默认兜底列表（DB 无此配置时使用） */
const DEFAULT_BACKEND_TYPES: BackendType[] = [
  { value: 'openclaw', label: 'OpenClaw' },
  { value: 'zeroclaw', label: 'ZeroClaw' },
  { value: 'hermes', label: 'Hermes' },
  { value: 'goose', label: 'Goose' },
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'codex', label: 'Codex (OpenAI)' },
  { value: 'gemini', label: 'Gemini (Google)' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'grok', label: 'Grok (xAI)' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'pi', label: 'Pi Coding Agent' },
  { value: 'qwen-code', label: 'Qwen Code' },
  { value: 'kiro', label: 'Kiro CLI' },
  { value: 'github-copilot', label: 'GitHub Copilot CLI' },
  { value: 'openhands', label: 'OpenHands' },
  { value: 'aider', label: 'Aider' },
  { value: 'cline', label: 'Cline' },
  { value: 'amazon-q', label: 'Amazon Q Developer CLI' },
  { value: 'reasonix', label: 'Reasonix' },
  { value: 'zcode', label: 'ZCode' },
  { value: 'workbuddy', label: 'WorkBuddy' },
  { value: 'doubao', label: '豆包' },
  { value: 'others', label: '其他' },
];

const DISCOVERABLE_ADDITIONS = DEFAULT_BACKEND_TYPES.filter(
  (type) => [
    'zeroclaw',
    'qwen-code', 'kiro', 'github-copilot', 'openhands', 'aider', 'amazon-q',
    'zcode', 'workbuddy', 'doubao', 'cline', 'reasonix',
  ].includes(type.value),
);

const BACKEND_TYPE_ALIASES: Record<string, string> = {
  'open-claw': 'openclaw',
  'openclaw-cli': 'openclaw',
  'zero-claw': 'zeroclaw',
  'zeroclaw-cli': 'zeroclaw',
  'hermes-cli': 'hermes',
  'goose-ai': 'goose',
  'goose-cli': 'goose',
  'goose-acp': 'acp-goose',
  'claudecode': 'claude-code',
  'claude-code': 'claude-code',
  'open-code': 'opencode',
  'cursor-cli': 'cursor',
  'gemini-cli': 'gemini',
  'codex-cli': 'codex',
  'grok-cli': 'grok',
  'opencode-cli': 'opencode',
  'pi-cli': 'pi',
  qwen: 'qwen-code',
  'qwen-cli': 'qwen-code',
  'qwen-code-cli': 'qwen-code',
  'kiro-cli': 'kiro',
  copilot: 'github-copilot',
  'copilot-cli': 'github-copilot',
  'github-copilot-cli': 'github-copilot',
  'openhands-cli': 'openhands',
  'aider-cli': 'aider',
  'cline-cli': 'cline',
  'amazon-q-cli': 'amazon-q',
};

/**
 * 规范化注册/运行时上报的 backend type。
 * 已知别名归一；自定义类型保留为稳定的小写短横线格式，供 pull-only runtime 使用。
 */
function normalizeBackendType(value: unknown): string {
  if (typeof value !== 'string') return 'others';
  const normalized = value.trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (!normalized) return 'others';
  return BACKEND_TYPE_ALIASES[normalized] || normalized;
}

/**
 * 从 DB config 表读取 agent 后端类型列表，无则回退到默认列表。
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {Array<{value: string, label: string}>}
 */
function getBackendTypes(db: DatabaseLike): BackendType[] {
  try {
    const row = db.prepare("SELECT data FROM config WHERE type = ?").get(CONFIG_TYPE) as { data?: string } | undefined;
    if (row?.data) {
      const parsed = JSON.parse(row.data);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed as BackendType[];
    }
  } catch (e) {
    console.warn('[AgentBackendTypes] 读取 config 失败，使用默认列表:', (e as Error).message);
  }
  return DEFAULT_BACKEND_TYPES;
}

/**
 * 初始化/更新 DB 中的 agent 后端类型配置（不存在则写入默认列表）。
 * @param {import('node:sqlite').DatabaseSync} db
 */
function seedBackendTypes(db: DatabaseLike): void {
  try {
    const row = db.prepare("SELECT data FROM config WHERE type = ?").get(CONFIG_TYPE) as { data?: string } | undefined;
    const existing = row?.data ? JSON.parse(row.data) as BackendType[] : [];
    const additions = DISCOVERABLE_ADDITIONS.filter(
      (candidate) => !existing.some((type) => type.value === candidate.value),
    );
    if (row && additions.length === 0) return;
    const merged = row
      ? [...existing.filter((type) => type.value !== 'others'), ...additions, ...existing.filter((type) => type.value === 'others')]
      : DEFAULT_BACKEND_TYPES;
    db.prepare('INSERT OR REPLACE INTO config (type, data, updated_at) VALUES (?, ?, ?)')
      .run(CONFIG_TYPE, JSON.stringify(merged), Date.now());
    console.error('[AgentBackendTypes] 已写入默认后端类型配置');
  } catch (e) {
    console.error('[AgentBackendTypes] seed 失败:', (e as Error).message);
  }
}

/**
 * 获取所有预定义后端类型的 value 列表（不含空字符串）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {string[]}
 */
function getBackendTypeValues(db: DatabaseLike): string[] {
  return getBackendTypes(db).map(t => t.value);
}

/**
 * 判断给定值是否为已知的预定义类型。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} value
 * @returns {boolean}
 */
function isKnownBackendType(db: DatabaseLike, value: string): boolean {
  if (!value) return false;
  return getBackendTypeValues(db).includes(normalizeBackendType(value));
}

module.exports = {
  CONFIG_TYPE,
  DEFAULT_BACKEND_TYPES,
  BACKEND_TYPE_ALIASES,
  normalizeBackendType,
  getBackendTypes,
  seedBackendTypes,
  getBackendTypeValues,
  isKnownBackendType,
};
