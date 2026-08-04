/**
 * VOKO Agent 能力搜索共享逻辑
 *
 * 供桌面端主进程（src/main.js）和 MCP Lite 模式（src/mcp/standalone.js）共同调用：
 * - DID 认证搜索：/api/did-auth/search-agents（优先）
 * - HMAC 认证搜索：/api/external/v1/agents/search（兜底）
 */

const { signAsync } = require('@noble/ed25519');
const { VOKO_API_URL } = require('./api-signature');
const { t } = require('./i18n');
import type { DatabaseLike } from '../types/database';

interface SearchFields {
  keyword?: string;
  page?: number | string;
  limit?: number | string;
}

interface UserTokenSearchOptions extends SearchFields {
  token: string;
}

interface DidSearchOptions extends SearchFields {
  db?: DatabaseLike;
  agentId?: string;
}

interface CredentialRow {
  did?: string | null;
  private_key?: string | null;
}

interface SearchApiResult {
  success: boolean;
  message?: string;
  data?: unknown;
  page?: number;
  count?: number;
}

interface SearchResult {
  success: true;
  data: unknown;
  page: number | undefined;
  count: number | undefined;
  onlineStatus: { source: 'agentdid_search'; checkedAt: number };
}

function isSearchApiResult(value: unknown): value is SearchApiResult {
  if (!value || typeof value !== 'object' || typeof (value as SearchApiResult).success !== 'boolean') {
    return false;
  }
  const result = value as SearchApiResult;
  return (result.message === undefined || typeof result.message === 'string')
    && (result.page === undefined || typeof result.page === 'number')
    && (result.count === undefined || typeof result.count === 'number');
}

async function readSearchApiResult(response: Response): Promise<SearchApiResult> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error(t('errors.external_api.invalid_json'));
  }
  if (!isSearchApiResult(value)) throw new Error(t('errors.external_api.invalid_response'));
  if (response.ok === false) {
    throw new Error(value.message || t('errors.external_api.http_error', { status: response.status }));
  }
  return value;
}

/**
 * 将 PEM 格式 Ed25519 私钥解析为 raw 32 字节
 * @param {string} pem
 * @returns {Uint8Array}
 */
function extractEd25519PrivateKey(pem: string): Uint8Array {
  const cleaned = String(pem || '')
    .replace(/-----BEGIN [\w\s]+ KEY-----/g, '')
    .replace(/-----END [\w\s]+ KEY-----/g, '')
    .replace(/\s/g, '');
  const bytes = Buffer.from(cleaned, 'base64');

  if (bytes.length === 32) return new Uint8Array(bytes);

  if (bytes.length > 32) {
    const slice = bytes.slice(-32);
    if (slice.length === 32) return new Uint8Array(slice);
  }

  if (cleaned.length === 64 && /^[0-9a-f]+$/i.test(cleaned)) {
    return new Uint8Array(Buffer.from(cleaned, 'hex'));
  }

  console.warn('[extractEd25519PrivateKey] unexpected key length:', bytes.length, 'trying first 32 bytes');
  return new Uint8Array(bytes.slice(0, 32));
}

/**
 * 生成 DID 认证搜索请求签名
 *
 * 注意：/api/did-auth/search-agents 要求 bodyPayload 仅含 keyword/page/limit
 * 三个 key，且顺序固定为 keyword、page、limit，不是字母序。
 *
 * @param {string} did
 * @param {string} privateKey
 * @param {object} businessFields
 * @returns {Promise<{did, nonce, timestamp, signature}>}
 */
async function signDidSearchRequest(did: string, privateKey: string, businessFields: SearchFields) {
  const nonce = Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
  const timestamp = Math.floor(Date.now() / 1000);
  const orderedPayload = {
    keyword: businessFields.keyword || '',
    page: businessFields.page || 1,
    limit: businessFields.limit || 50,
  };
  const bodyPayload = JSON.stringify(orderedPayload);
  const toSign = did + '\n' + nonce + '\n' + timestamp + '\n' + bodyPayload;
  const rawKey = extractEd25519PrivateKey(privateKey);
  const sigBytes = await signAsync(new TextEncoder().encode(toSign), rawKey);
  const signature = Buffer.from(sigBytes).toString('base64');
  return { did, nonce, timestamp, signature };
}

/**
 * 使用 DID + Ed25519 签名搜索 agent 能力
 * @param {object} options
 * @param {object} options.db - better-sqlite3 数据库实例
 * @param {string} options.agentId - 发起搜索的 agent ID
 * @param {string} [options.keyword='']
 * @param {number} [options.page=1]
 * @param {number} [options.limit=20]
 * @returns {Promise<{success:true, data, page, count}>}
 */
async function searchCapabilitiesByDid({ db, agentId, keyword = '', page = 1, limit = 50 }: DidSearchOptions): Promise<SearchResult> {
  if (!db) throw new Error('searchCapabilitiesByDid requires db');
  if (!agentId) throw new Error('缺少 agentId');

  const row = db.prepare('SELECT did, private_key FROM agents WHERE agent_id = ?').get<CredentialRow>(agentId);
  if (!row) throw new Error('Agent not found');
  if (!row.did) throw new Error('Agent has no DID');
  if (!row.private_key) throw new Error('Agent has no private key');

  const safePage = parseInt(String(page), 10) || 1;
  const safeLimit = Math.min(parseInt(String(limit), 10) || 20, 100);
  const businessFields = { keyword: keyword || '', page: safePage, limit: safeLimit };

  const { did, nonce, timestamp, signature } = await signDidSearchRequest(row.did, row.private_key, businessFields);

  const res = await fetch(`${VOKO_API_URL}/api/did-auth/search-agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ did, nonce, timestamp, signature, ...businessFields }),
  });

  const json = await readSearchApiResult(res);
  if (!json.success) throw new Error(json.message || '搜索失败');
  return {
    success: true, data: json.data, page: json.page, count: json.count,
    onlineStatus: { source: 'agentdid_search', checkedAt: Date.now() },
  };
}

async function searchCapabilitiesByUserToken({
  token, keyword = '', page = 1, limit = 50,
}: UserTokenSearchOptions): Promise<SearchResult> {
  if (!token) throw new Error('未找到当前用户的访问令牌，请重新登录');
  const apiPath = '/api/external/v1/agents/search';
  const safePage = parseInt(String(page), 10) || 1;
  const safeLimit = Math.min(parseInt(String(limit), 10) || 20, 100);
  const body = { keyword: keyword || '', page: safePage, limit: safeLimit };
  const res = await fetch(`${VOKO_API_URL}${apiPath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const json = await readSearchApiResult(res);
  if (!json.success) throw new Error(json.message || '搜索失败');
  return {
    success: true, data: json.data, page: json.page, count: json.count,
    onlineStatus: { source: 'agentdid_search', checkedAt: Date.now() },
  };
}

module.exports = {
  searchCapabilitiesByDid,
  searchCapabilitiesByUserToken,
};
