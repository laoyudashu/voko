/**
 * Agent 基础信息更新
 *
 * 通过 DID 认证 Ed25519 签名调用服务端更新接口，并同步本地 SQLite。
 * 供主进程 IPC 和 MCP 工具共享。
 */

const { signAsync } = require('@noble/ed25519');
const { VOKO_API_URL } = require('./api-signature');
const { extractEd25519PrivateKey } = require('./did-auth');
import type { DatabaseLike } from '../types/database';

interface ProfileOptions {
  db?: DatabaseLike;
  agentId?: string;
  name?: string;
  description?: string;
  short_description?: string;
  category?: string;
  address?: string;
  contact_phone?: string;
  icon_url?: string;
  cover_url?: string;
  tags?: string | unknown[];
  backendType?: string;
}

interface CredentialRow {
  did?: string | null;
  private_key?: string | null;
}

interface ApiResult {
  success?: boolean;
  message?: string;
  data?: Record<string, unknown> & { categoryLabel?: string; category_label?: string };
}

interface ProfileResult {
  success: boolean;
  message?: string;
  error?: string;
  data?: unknown;
  detail?: unknown;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 更新 Agent 基础信息
 * @param {Object} opts
 * @param {Object} opts.db - better-sqlite3 Database 实例
 * @param {string} opts.agentId
 * @param {string} [opts.name]
 * @param {string} [opts.description]
 * @param {string} [opts.short_description]
 * @param {string} [opts.category]
 * @param {string} [opts.address]
 * @param {string} [opts.contact_phone]
 * @param {string} [opts.icon_url]
 * @param {string} [opts.cover_url]
 * @param {string|string[]} [opts.tags]
 * @returns {Promise<{success: boolean, message?: string, error?: string, data?: any}>}
 */
async function updateAgentProfile(opts?: ProfileOptions): Promise<ProfileResult> {
  const { db, agentId, name, description, short_description, category } = opts || {};
  const { address, contact_phone, icon_url, cover_url, tags, backendType } = opts || {};

  if (!db) return { success: false, error: 'db is required' };
  if (!agentId) return { success: false, error: 'agentId is required' };

  try {
    const stmt = db.prepare(`SELECT did, private_key FROM agents WHERE agent_id = ?`);
    const row = stmt.get<CredentialRow>(agentId);
    if (!row) return { success: false, error: 'Agent not found' };
    if (!row.did) return { success: false, error: 'Agent has no DID' };
    if (!row.private_key) return { success: false, error: 'Agent has no private key' };

    // 构建 bodyPayload（仅可更新字段，key 按字母序排序）
    const payload: Record<string, unknown> = {};
    if (name !== undefined) payload.name = name;
    if (description !== undefined) payload.description = description;
    if (address !== undefined) payload.address = address;
    if (contact_phone !== undefined) payload.contact_phone = contact_phone;
    if (category !== undefined) payload.category = category;
    if (short_description !== undefined) payload.short_description = short_description;
    if (icon_url !== undefined) payload.icon_url = icon_url;
    if (cover_url !== undefined) payload.cover_url = cover_url;
    if (tags !== undefined) payload.tags = typeof tags === 'string' ? JSON.parse(tags) : tags;
    if (backendType !== undefined) payload.backendType = backendType;
    const bodyPayload = JSON.stringify(payload, Object.keys(payload).sort());

    // 签名
    const nonce = Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
    const timestamp = Math.floor(Date.now() / 1000);
    const toSign = row.did + '\n' + nonce + '\n' + timestamp + '\n' + bodyPayload;
    const rawKey = extractEd25519PrivateKey(row.private_key);
    const sigBytes = await signAsync(new TextEncoder().encode(toSign), rawKey);
    const signature = Buffer.from(sigBytes).toString('base64');

    const requestBody = { did: row.did, nonce, timestamp, signature, ...payload };

    console.log(`[updateProfile] Agent ${agentId}: sending...`, JSON.stringify({ did: row.did, fields: Object.keys(payload) }));

    const response = await fetch(`${VOKO_API_URL}/api/did-auth/update-agent-profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });
    const result = await response.json() as ApiResult;
    console.log(`[updateProfile] Agent ${agentId} response:`, result);

    if (result.success) {
      // 本地同步更新
      const sets = ['updated_at = ?'];
      const vals: unknown[] = [Date.now()];
      if (name !== undefined) { sets.push('agent_name = ?'); vals.push(name); }
      if (description !== undefined) { sets.push('description = ?'); vals.push(description); }
      if (address !== undefined) { sets.push('address = ?'); vals.push(address); }
      if (contact_phone !== undefined) { sets.push('contact_phone = ?'); vals.push(contact_phone); }
      if (category !== undefined) { sets.push('category = ?'); vals.push(category); }
      // 从服务端响应中提取 category_label
      const serverCategoryLabel = result.data?.categoryLabel || result.data?.category_label;
      if (serverCategoryLabel) { sets.push('category_label = ?'); vals.push(serverCategoryLabel); }
      if (short_description !== undefined) { sets.push('short_description = ?'); vals.push(short_description); }
      if (icon_url !== undefined) { sets.push('icon_url = ?'); vals.push(icon_url); }
      if (cover_url !== undefined) { sets.push('cover_url = ?'); vals.push(cover_url); }
      if (tags !== undefined) { sets.push('tags = ?'); vals.push(typeof tags === 'string' ? tags : JSON.stringify(tags)); }
      vals.push(agentId);
      db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE agent_id = ?`).run(...vals);
      return { success: true, message: '基础信息已更新', data: result.data };
    }
    return { success: false, error: result.message || '更新失败', detail: result };
  } catch (e: unknown) {
    console.error('[updateProfile] error:', e);
    return { success: false, error: errorMessage(e) };
  }
}

module.exports = { updateAgentProfile };
