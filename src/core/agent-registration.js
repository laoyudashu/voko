/**
 * VOKO Agent 注册/验证共享逻辑
 *
 * 供桌面端 IPC handler 和 MCP 工具共同调用：
 * - 发送邮箱验证码
 * - 验证验证码并获取 DID/IM 账号/密钥
 * - 用本地 userAccessToken 静默创建 Agent
 * - 写入/更新本地 SQLite agents 表
 *
 * 注意：本模块只做“注册（published）”，不启动 worker。
 */

const { VOKO_API_URL } = require('./api-signature');
const ENDPOINTS = require('../endpoints.json');
const { t } = require('./i18n');
const { normalizeBackendType } = require('./agent-backend-types');
const {
  normalizeOfficialImServerUrl,
  normalizeOfficialPublicUrl,
} = require('./url-security');

const USER_ACCESS_TOKEN_CONFIG_TYPE = 'user_access_token';
const DEFAULT_IM_SERVER_URL = ENDPOINTS.im.wsUrl;

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasBooleanSuccess(value) {
  return isRecord(value) && typeof value.success === 'boolean';
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isAgentSummary(value) {
  return isRecord(value) && isNonEmptyString(value.agentId);
}

function hasRegistrationCredentials(value) {
  return isRecord(value)
    && isNonEmptyString(value.imUid)
    && isNonEmptyString(value.imToken)
    && isNonEmptyString(value.did)
    && isNonEmptyString(value.publicKey)
    && isNonEmptyString(value.privateKey);
}

function responseMessage(value, fallback) {
  return isRecord(value) && typeof value.message === 'string' ? value.message : fallback;
}

function parseJsonObject(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: t('errors.external_api.invalid_json') };
  }
  return isRecord(value)
    ? { value }
    : { error: t('errors.external_api.invalid_response') };
}

async function readJsonObject(res) {
  const text = await res.text();
  return { text, ...parseJsonObject(text) };
}

function normalizeUserEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function createAgentRegistration({ db, writeConfig, writeAgentRegister, writeAgentBinding }) {
  if (!db) throw new Error('AgentRegistration requires db');
  // Desktop 主进程 db 为只读；写操作经 Lite HTTP API

  // ─── userAccessToken 读写 ───
  function loadUserAccessTokenConfig() {
    try {
      const row = db.prepare('SELECT data FROM config WHERE type = ?').get(USER_ACCESS_TOKEN_CONFIG_TYPE);
      if (!row?.data) return {};
      const parsed = JSON.parse(row.data);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (e) {
      console.warn('[AgentRegistration] loadUserAccessTokenConfig error:', e.message);
      return {};
    }
  }

  async function saveUserAccessTokenConfig(map) {
    if (writeConfig) {
      await writeConfig(USER_ACCESS_TOKEN_CONFIG_TYPE, map);
      return;
    }
    db.prepare('INSERT OR REPLACE INTO config (type, data, updated_at) VALUES (?, ?, ?)')
      .run(USER_ACCESS_TOKEN_CONFIG_TYPE, JSON.stringify(map), Date.now());
  }

  async function saveUserAccessToken(email, token) {
    const normalized = normalizeUserEmail(email);
    if (!normalized || !token) return;
    // 只保留当前登录邮箱（登录新邮箱即切换用户，覆盖旧 token）
    await saveUserAccessTokenConfig({ [normalized]: { user_access_token: token, updated_at: Date.now() } });
    // 同步更新 runtime.userEmail，确保首页展示当前用户 agent（而非旧缓存）
    try {
      const rtRow = db.prepare("SELECT data FROM config WHERE type = 'runtime'").get();
      if (rtRow) {
        const rt = JSON.parse(rtRow.data);
        rt.userEmail = normalized;
        db.prepare('UPDATE config SET data = ?, updated_at = ? WHERE type = ?')
          .run(JSON.stringify(rt), Date.now(), 'runtime');
      }
    } catch (_) {}
  }

  function getUserAccessToken() {
    try {
      const map = loadUserAccessTokenConfig();
      const entries = Object.entries(map);
      if (entries.length === 0) return { success: true, data: null };
      entries.sort((a, b) => (b[1]?.updated_at || 0) - (a[1]?.updated_at || 0));
      const [email, val] = entries[0];
      if (val?.user_access_token) {
        return { success: true, data: { email, token: val.user_access_token } };
      }
      return { success: true, data: null };
    } catch (e) {
      console.error('[AgentRegistration] getUserAccessToken error:', e.message);
      return { success: false, error: e.message };
    }
  }

  async function saveUserAccessTokenFromVerify(email, verifyJson) {
    const normalizedEmail = normalizeUserEmail(verifyJson.email || email);
    if (!normalizedEmail || !verifyJson.userAccessToken) return null;
    await saveUserAccessToken(normalizedEmail, verifyJson.userAccessToken);
    console.log('[AgentRegistration] saved userAccessToken for', normalizedEmail);
    return verifyJson.userAccessToken;
  }

  // ─── 后端 API：发送验证码 ───
  async function sendCode({ email, agentName }) {
    try {
      const path = '/api/external/v1/send-code';
      const body = { email };
      if (agentName) body.agentName = agentName;

      console.log('[AgentRegistration] sendCode:', `${VOKO_API_URL}${path}`, 'email:', email);

      const res = await fetch(`${VOKO_API_URL}${path}`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      const parsed = await readJsonObject(res);
      console.log('[AgentRegistration] sendCode response status:', res.status);
      if (parsed.error) return { success: false, status: res.status, error: parsed.error };
      return { success: res.ok, status: res.status, data: parsed.value };
    } catch (e) {
      console.error('[AgentRegistration] sendCode error:', e);
      return { success: false, error: e.message };
    }
  }

  // ─── 后端 API：验证码预览（只验码不消费，返回 Agent 列表） ───
  async function verifyCodePreview({ email, code }) {
    try {
      const path = '/api/external/v1/verify-code-preview';
      const body = { email, code };
      const res = await fetch(`${VOKO_API_URL}${path}`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      const parsed = await readJsonObject(res);
      if (parsed.error) return { success: false, error: parsed.error };
      const json = parsed.value;
      if (!hasBooleanSuccess(json)) {
        return { success: false, error: t('errors.external_api.invalid_response') };
      }
      if (!res.ok || !json.success) {
        return {
          success: false,
          error: responseMessage(json, res.ok
            ? '验证失败'
            : t('errors.external_api.http_error', { status: res.status })),
        };
      }
      if (json.agents !== undefined
        && (!Array.isArray(json.agents) || !json.agents.every(isAgentSummary))) {
        return { success: false, error: t('errors.external_api.invalid_response') };
      }
      return { success: true, agents: json.agents || [], userExists: !!json.userExists };
    } catch (e) {
      console.error('[AgentRegistration] verifyCodePreview error:', e);
      return { success: false, error: e.message };
    }
  }

  // ─── 后端 API：验证码登录（消耗验证码，返回 userAccessToken，不创建 Agent）───
  async function loginByCode({ email, code }) {
    try {
      const path = '/api/external/v1/login';
      const body = { email, code };

      console.log('[AgentRegistration] loginByCode:', `${VOKO_API_URL}${path}`, 'email:', email);

      const res = await fetch(`${VOKO_API_URL}${path}`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      const parsed = await readJsonObject(res);
      console.log('[AgentRegistration] loginByCode response status:', res.status);
      if (parsed.error) return { success: false, error: parsed.error };
      const json = parsed.value;

      if (!hasBooleanSuccess(json)) {
        return { success: false, error: t('errors.external_api.invalid_response') };
      }
      if (!res.ok || !json.success) {
        const message = typeof json.message === 'string'
          ? json.message
          : (typeof json.msg === 'string' ? json.msg : null);
        return {
          success: false,
          error: message || (res.ok
            ? '登录失败'
            : t('errors.external_api.http_error', { status: res.status })),
        };
      }

      if (!isRecord(json.data)) {
        return { success: false, error: t('errors.external_api.invalid_response') };
      }
      const userAccessToken = typeof json.data.userAccessToken === 'string'
        ? json.data.userAccessToken
        : undefined;
      if (userAccessToken) {
        await saveUserAccessToken(email, userAccessToken);
        console.log('[AgentRegistration] loginByCode: saved userAccessToken for', email);
      }

      return {
        success: true,
        userAccessToken,
        email: typeof json.data.email === 'string' ? json.data.email : email,
        agents: Array.isArray(json.data.agents) ? json.data.agents : [],
      };
    } catch (e) {
      console.error('[AgentRegistration] loginByCode error:', e);
      return { success: false, error: e.message };
    }
  }

  // ─── 后端 API：验证验证码 ───
  async function verifyCode({ email, code, agentName, agentCategory, agentId }) {
    try {
      const path = '/api/external/v1/verify-code';
      const body = { email, code };
      if (agentName) body.agentName = agentName;
      if (agentId) body.agentId = agentId;
      if (agentCategory) body.agentCategory = agentCategory;
      console.log('[AgentRegistration] verifyCode:', `${VOKO_API_URL}${path}`, 'email:', email);

      const res = await fetch(`${VOKO_API_URL}${path}`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      const parsed = await readJsonObject(res);
      console.log('[AgentRegistration] verifyCode response status:', res.status);
      if (parsed.error) return { success: false, status: res.status, error: parsed.error };
      const json = parsed.value;

      if (res.ok
        && hasRegistrationCredentials(json)
        && Array.isArray(json.agents)
        && json.agents.length > 0
        && json.agents.every(isAgentSummary)) {
        const savedToken = await saveUserAccessTokenFromVerify(email, json);
        return { success: true, data: json, userAccessTokenSaved: !!savedToken };
      }
      if (res.ok) {
        return { success: false, status: res.status, error: t('errors.external_api.invalid_response') };
      }
      return { success: false, status: res.status, data: json };
    } catch (e) {
      console.error('[AgentRegistration] verifyCode error:', e);
      return { success: false, error: e.message };
    }
  }

  // ─── 后端 API：用本地 token 静默创建 Agent ───
  async function createAgentByToken({ agentId }) {
    try {
      if (!agentId) return { success: false, error: '缺少 agentId' };

      const tokenRes = getUserAccessToken();
      if (!tokenRes.success) return { success: false, error: tokenRes.error };
      if (!tokenRes.data?.token) return { success: false, error: '未找到 token', noToken: true };
      const token = tokenRes.data.token;

      const path = '/api/external/v1/agent/create';
      const body = { name: agentId };

      console.log('[AgentRegistration] createAgentByToken:', agentId);

      const res = await fetch(`${VOKO_API_URL}${path}`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });

      const parsed = await readJsonObject(res);
      if (parsed.error) return { success: false, error: parsed.error, status: res.status };
      const json = parsed.value;
      if (!hasBooleanSuccess(json)) {
        return { success: false, error: t('errors.external_api.invalid_response'), status: res.status };
      }
      if (!res.ok || !json.success) {
        const noToken = res.status === 401;
        return {
          success: false,
          error: responseMessage(json, res.ok
            ? '创建失败'
            : t('errors.external_api.http_error', { status: res.status })),
          noToken,
          status: res.status,
        };
      }
      if (!hasRegistrationCredentials(json.data) || !isNonEmptyString(json.data.agentId)) {
        return { success: false, error: t('errors.external_api.invalid_response'), status: res.status };
      }
      return { success: true, data: json.data };
    } catch (e) {
      console.error('[AgentRegistration] createAgentByToken error:', e.message);
      return { success: false, error: e.message };
    }
  }

  // ─── 本地 SQLite：写入 agents 表（注册，published） ───
  async function registerAgentInDb(data) {
    try {
      if (writeAgentRegister) return await writeAgentRegister(data);
      return registerAgentInDbOnDb(db, data);
    } catch (e) {
      console.error('[AgentRegistration] registerAgentInDb failed:', data?.agentId, e.message);
      return { success: false, error: e.message };
    }
  }

  // ─── 本地 SQLite：更新 agents 绑定字段 ───
  async function updateAgentBinding({ agentId, updates }) {
    try {
      if (writeAgentBinding) return await writeAgentBinding({ agentId, updates });
      return updateAgentBindingOnDb(db, { agentId, updates });
    } catch (e) {
      console.error('[AgentRegistration] updateAgentBinding error:', e);
      return { success: false, error: e.message };
    }
  }

  return {
    sendCode,
    verifyCode,
    verifyCodePreview,
    loginByCode,
    createAgentByToken,
    getUserAccessToken,
    saveUserAccessToken,
    saveUserAccessTokenFromVerify,
    registerAgentInDb,
    updateAgentBinding,
  };
}

/** 在可写 db 上注册 Agent（Lite 进程 / HTTP 端点共用） */
function registerAgentInDbOnDb(db, {
  agentId,
  uid,
  token,
  serverUrl,
  ownerEmail,
  backendType,
  instanceId,
  agentName,
  category,
  categoryLabel,
  description,
  did,
  publicKey,
  privateKey,
  loginToken,
  paymentFeeRate,
  agentUsageFeeRate,
  accessMode,
}) {
  try {
    const now = Date.now();
    const backend = normalizeBackendType(backendType);
    const imServerUrl = normalizeOfficialImServerUrl(serverUrl || DEFAULT_IM_SERVER_URL);
    const payRate = paymentFeeRate != null ? paymentFeeRate : 0.006;
    const usageRate = agentUsageFeeRate != null ? agentUsageFeeRate : 0.1;
    const resolvedAccessMode = accessMode === 'public' ? 'public' : 'private';

    // categoryLabel 缺失时从 i18n 自动补齐（MCP/CLI/web-add 注册只传 category 码）
    let resolvedCategoryLabel = categoryLabel || '';
    if (!resolvedCategoryLabel && category) {
      const key = 'db.agent.category.' + category;
      resolvedCategoryLabel = t(key);
      if (resolvedCategoryLabel === key) resolvedCategoryLabel = '';
    }

    db.prepare(`
      INSERT INTO agents (id, agent_id, imUid, imToken, im_server_url, owner_email,
        agent_name, category, category_label, description, did, public_key, private_key, login_token,
        payment_fee_rate, agent_usage_fee_rate,
        publish_status, access_mode, backend_type, backend_instance_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        imUid = excluded.imUid, imToken = excluded.imToken,
        im_server_url = excluded.im_server_url, owner_email = excluded.owner_email,
        agent_name = excluded.agent_name, category = excluded.category,
        category_label = excluded.category_label, description = excluded.description,
        did = excluded.did,
        public_key = excluded.public_key, private_key = excluded.private_key,
        login_token = excluded.login_token,
        payment_fee_rate = excluded.payment_fee_rate,
        agent_usage_fee_rate = excluded.agent_usage_fee_rate,
        access_mode = excluded.access_mode, backend_type = excluded.backend_type,
        backend_instance_id = excluded.backend_instance_id, updated_at = excluded.updated_at
    `).run(
      `agent-${agentId}`, agentId, uid, token, imServerUrl, ownerEmail || null,
      agentName || null, category || null, resolvedCategoryLabel || null, description || null,
      did || null, publicKey || null, privateKey || null, loginToken || null,
      payRate, usageRate,
      resolvedAccessMode, backend, instanceId || null, now, now
    );

    console.log('[AgentRegistration] registerAgentInDb success:', agentId);
    return { success: true };
  } catch (e) {
    console.error('[AgentRegistration] registerAgentInDb failed:', agentId, e.message);
    return { success: false, error: e.message };
  }
}

/** 在可写 db 上更新 Agent 绑定字段（Lite 进程 / HTTP 端点共用） */
function updateAgentBindingOnDb(db, { agentId, updates }) {
  try {
    const sets = [];
    const values = [];
    if (updates.owner_email !== undefined) { sets.push('owner_email = ?'); values.push(updates.owner_email); }
    if (updates.chatroom_url !== undefined) { sets.push('chatroom_url = ?'); values.push(normalizeOfficialPublicUrl(updates.chatroom_url)); }
    if (updates.payment_url !== undefined) { sets.push('payment_url = ?'); values.push(updates.payment_url); }
    if (updates.did !== undefined) { sets.push('did = ?'); values.push(updates.did); }
    if (updates.public_key !== undefined) { sets.push('public_key = ?'); values.push(updates.public_key); }
    if (updates.private_key !== undefined) { sets.push('private_key = ?'); values.push(updates.private_key); }
    if (updates.login_token !== undefined) { sets.push('login_token = ?'); values.push(updates.login_token); }
    if (updates.imUid !== undefined) { sets.push('imUid = ?'); values.push(updates.imUid); }
    if (updates.imToken !== undefined) { sets.push('imToken = ?'); values.push(updates.imToken); }
    if (updates.im_server_url !== undefined) { sets.push('im_server_url = ?'); values.push(normalizeOfficialImServerUrl(updates.im_server_url)); }
    if (updates.imUid !== undefined) { sets.push('chatroom_url = ?'); values.push(ENDPOINTS.im.baseUrl + '/#/chat?peer=' + updates.imUid); }
    if (updates.ability !== undefined) { sets.push('ability = ?'); values.push(updates.ability); }
    if (updates.publish_status !== undefined) { sets.push('publish_status = ?'); values.push(updates.publish_status); }
    if (updates.access_mode !== undefined) { sets.push('access_mode = ?'); values.push(updates.access_mode); }
    if (updates.short_link_url !== undefined) { sets.push('short_link_url = ?'); values.push(normalizeOfficialPublicUrl(updates.short_link_url, { canonicalMain: true })); }
    if (updates.qr_code_url !== undefined) { sets.push('qr_code_url = ?'); values.push(updates.qr_code_url); }
    if (updates.icon_url !== undefined) { sets.push('icon_url = ?'); values.push(updates.icon_url); }

    if (sets.length === 0) return { success: true };
    sets.push('updated_at = ?');
    values.push(Date.now());
    values.push(agentId);

    const sql = `UPDATE agents SET ${sets.join(', ')} WHERE agent_id = ?`;
    db.prepare(sql).run(...values);
    console.log('[AgentRegistration] updateAgentBinding success:', agentId, Object.keys(updates || {}));
    return { success: true };
  } catch (e) {
    console.error('[AgentRegistration] updateAgentBinding error:', e);
    return { success: false, error: e.message };
  }
}

module.exports = { createAgentRegistration, registerAgentInDbOnDb, updateAgentBindingOnDb };
