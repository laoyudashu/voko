'use strict';

/**
 * 群管理服务端（chatroom /api/group/v1/*）客户端
 *
 * - 鉴权：用主人的 user_access_token（Authorization: Bearer）。主人只做鉴权。
 * - 操作人：acting agent 的 imUid，按各接口要求的 actor 字段（owner_uid/operator_uid/uid）放进 body。
 * - 群标识：lite 全程用 channel_id（即历史的 roomId）；group_id 留服务端内部，不暴露到 lite。
 *
 * 服务端响应统一为 { success:true, data } 或 { success:false, error }（HTTP 非 2xx）。
 */

const ENDPOINTS = require('../endpoints.json');
const { assertSecureEndpoint } = require('./url-security');

const GROUP_API_BASE = assertSecureEndpoint(process.env.VOKO_GROUP_API_BASE
  || (ENDPOINTS.im && ENDPOINTS.im.baseUrl)
  || '', 'http') + '/api/group';

/** 从 config 表读主人 user_access_token（JSON map keyed by email，取当前登录邮箱的 token）*/
function getOwnerToken(cx, agentId) {
  const row = cx.query(`SELECT data FROM config WHERE type='user_access_token'`)[0];
  if (!row || !row.data) return null;
  try {
    const map = JSON.parse(row.data);
    if (agentId) {
      const agent = cx.query(`SELECT owner_email FROM agents WHERE agent_id=?`, [agentId])[0];
      const ownerEmail = String(agent?.owner_email || '').trim().toLowerCase();
      if (!ownerEmail) return null;
      const matchedKey = Object.keys(map).find(email => email.toLowerCase() === ownerEmail);
      return (matchedKey && map[matchedKey] && map[matchedKey].user_access_token) || null;
    }
    const emails = Object.keys(map);
    if (emails.length !== 1) return null;
    return (map[emails[0]] && map[emails[0]].user_access_token) || null;
  } catch (_) {
    return null;
  }
}

/** 取 acting agent 的 imUid（作为群操作人）*/
function getAgentImUid(cx, agentId) {
  if (!agentId) return null;
  const row = cx.query(`SELECT imUid FROM agents WHERE agent_id=?`, [agentId])[0];
  return (row && row.imUid) || null;
}

async function _post(cx, path, body, agentId) {
  const token = getOwnerToken(cx, agentId);
  if (!token) {
    const e = new Error('缺少主人 user_access_token（请先邮箱验证码登录）');
    e.noToken = true;
    throw e;
  }
  let resp;
  try {
    const timeoutMs = Math.max(250, Number(process.env.VOKO_GROUP_API_TIMEOUT_MS) || 10000);
    resp = await fetch(GROUP_API_BASE + path, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new Error('群服务不可达: ' + e.message);
  }
  let json = null;
  try { json = await resp.json(); } catch (_) {}
  if (!resp.ok || !json || json.success === false) {
    throw new Error((json && (json.error || json.message)) || ('群服务 HTTP ' + resp.status));
  }
  return json.data;
}

/** 默认群名：群聊_ + 6 位随机（web 表单预填值与本兜底共用，格式统一；群名可重复）*/
function defaultGroupName() {
  return '群聊_' + Math.random().toString(36).slice(2, 8);
}

/** 创建群；actor = owner_uid（创建 agent 的 imUid）。返回 { id, channel_id, name, owner_uid, members } */
async function createGroup(cx, { agentId, name, members }) {
  const imUid = getAgentImUid(cx, agentId);
  if (!imUid) throw new Error('Agent 无 imUid');
  // 服务端 createGroup 要求 name 非空；未提供时用默认群名
  const groupName = (typeof name === 'string' && name.trim()) || defaultGroupName();
  return _post(cx, '/v1/create', { name: groupName, owner_uid: imUid, acting_agent_uid: imUid, members: members || [] }, agentId);
}

/** 邀请/加成员；actor = operator_uid */
async function invite(cx, { agentId, channelId, members }) {
  const imUid = getAgentImUid(cx, agentId);
  if (!imUid) throw new Error('Agent 无 imUid');
  return _post(cx, '/v1/invite', { channel_id: channelId, members: members || [], operator_uid: imUid, acting_agent_uid: imUid }, agentId);
}

/** 取群信息 + 成员；actor = uid（须为该群成员）。返回 { ...group, members:[{uid,role,joined_at}] } */
async function getInfo(cx, { agentId, channelId }) {
  const imUid = getAgentImUid(cx, agentId);
  if (!imUid) throw new Error('Agent 无 imUid');
  return _post(cx, '/v1/info', { channel_id: channelId, uid: imUid, acting_agent_uid: imUid }, agentId);
}

/** 取群入群申请列表（owner/admin）；返回 [{ id, uid, inviter_uid, type, status, created_at, ... }] */
async function getApplyList(cx, { agentId, channelId }) {
  const imUid = getAgentImUid(cx, agentId);
  if (!imUid) throw new Error('Agent 无 imUid');
  const data = await _post(cx, '/v1/apply/list', { channel_id: channelId, operator_uid: imUid, acting_agent_uid: imUid }, agentId);
  return data.applies || [];
}

/** 审批入群申请；action = 'approve' | 'reject' */
async function approveApply(cx, { agentId, channelId, applyId, action }) {
  const imUid = getAgentImUid(cx, agentId);
  if (!imUid) throw new Error('Agent 无 imUid');
  return _post(cx, '/v1/apply/approve', { channel_id: channelId, operator_uid: imUid, acting_agent_uid: imUid, apply_id: applyId, action }, agentId);
}

/** 列出 agent 所在的群（服务端权威，分页）；返回 { groups:[{...}], total } */
async function listMyGroups(cx, { agentId, limit, offset }) {
  const imUid = getAgentImUid(cx, agentId);
  if (!imUid) throw new Error('Agent 无 imUid');
  const body = { uid: imUid, acting_agent_uid: imUid };
  if (limit !== undefined) body.limit = limit;
  if (offset !== undefined) body.offset = offset;
  const data = await _post(cx, '/v1/list', body, agentId);
  return { groups: data.groups || [], total: data.total || 0 };
}

/** 踢出成员；actor = operator_uid（须为群 owner/admin）*/
async function kick(cx, { agentId, channelId, targetUid }) {
  const imUid = getAgentImUid(cx, agentId);
  if (!imUid) throw new Error('Agent 无 imUid');
  return _post(cx, '/v1/kick', { channel_id: channelId, operator_uid: imUid, acting_agent_uid: imUid, uid: targetUid }, agentId);
}

/** Quit as an Agent owned by the authenticated token user. */
async function quit(cx, { agentId, channelId }) {
  const imUid = getAgentImUid(cx, agentId);
  if (!imUid) throw new Error('Agent 无 imUid');
  return _post(cx, '/v1/quit', { channel_id: channelId, acting_agent_uid: imUid }, agentId);
}

/** Dissolve as an authenticated user's Agent; the server still verifies group ownership. */
async function dissolve(cx, { agentId, channelId }) {
  const imUid = getAgentImUid(cx, agentId);
  if (!imUid) throw new Error('Agent 无 imUid');
  return _post(cx, '/v1/dissolve', { channel_id: channelId, acting_agent_uid: imUid }, agentId);
}

/** 修改群资料（name/notice/avatar 任选其一或多个）；actor = operator_uid（须 owner/admin）*/
async function updateGroup(cx, { agentId, channelId, name, notice, avatar, approve_mode, searchable }) {
  const imUid = getAgentImUid(cx, agentId);
  if (!imUid) throw new Error('Agent 无 imUid');
  const body = { channel_id: channelId, operator_uid: imUid, acting_agent_uid: imUid };
  if (name !== undefined) body.name = name;
  if (notice !== undefined) body.notice = notice;
  if (avatar !== undefined) body.avatar = avatar;
  if (approve_mode !== undefined) body.approve_mode = approve_mode;
  if (searchable !== undefined) body.searchable = searchable;
  return _post(cx, '/v1/update', body, agentId);
}

/** 生成邀请链接；actor = created_by。返回 { code, channel_id, expires_at } */
async function createInviteLink(cx, { agentId, channelId, expiresInSeconds, maxUses }) {
  const imUid = getAgentImUid(cx, agentId);
  if (!imUid) throw new Error('Agent 无 imUid');
  const body = { channel_id: channelId, created_by: imUid, acting_agent_uid: imUid };
  if (expiresInSeconds) body.expires_in_seconds = expiresInSeconds;
  if (maxUses) body.max_uses = maxUses;
  return _post(cx, '/v1/invite-link/create', body, agentId);
}

/** 通过邀请码让当前 Agent 入群；返回 { joined, channel_id } 或 { already_member, channel_id } */
async function joinByInviteCode(cx, { code, agentId }) {
  const imUid = getAgentImUid(cx, agentId);
  if (!imUid) throw new Error('Agent 无 imUid');
  return _post(cx, '/v1/join', { invite_code: code, uid: imUid, acting_agent_uid: imUid }, agentId);
}

/** 禁言/解除禁言；actor = operator_uid。muted: true=禁言, false=解除 */
async function muteMember(cx, { agentId, channelId, targetUid, muted, durationSeconds }) {
  const imUid = getAgentImUid(cx, agentId);
  if (!imUid) throw new Error("Agent 无 imUid");
  const body = { channel_id: channelId, operator_uid: imUid, acting_agent_uid: imUid, uid: targetUid, muted };
  if (durationSeconds) body.duration_seconds = durationSeconds;
  return _post(cx, "/v1/mute", body, agentId);
}

/** 搜索可加入的公开群（按群名/channel_id 模糊）；actor = uid。返回 { groups:[{channel_id,name,notice,avatar,member_count,joined}], total } */
async function searchGroups(cx, { agentId, keyword, page, page_size }) {
  const imUid = getAgentImUid(cx, agentId);
  if (!imUid) throw new Error('Agent 无 imUid');
  const body = { keyword: keyword || '', uid: imUid, acting_agent_uid: imUid };
  if (page) body.page = page;
  if (page_size) body.page_size = page_size;
  const data = await _post(cx, '/v1/search', body, agentId);
  return { groups: data.groups || [], total: data.total || 0 };
}

/** 提交入群申请（审批→pending / 免审批→joined / already_member / duplicate）；actor = uid */
async function applyGroup(cx, { agentId, channelId, message }) {
  const imUid = getAgentImUid(cx, agentId);
  if (!imUid) throw new Error('Agent 无 imUid');
  const body = { channel_id: channelId, uid: imUid, acting_agent_uid: imUid };
  if (message) body.message = message;
  return _post(cx, '/v1/apply/submit', body, agentId);
}

module.exports = { createGroup, invite, getInfo, kick, quit, dissolve, updateGroup, listMyGroups, getApplyList, approveApply, createInviteLink, joinByInviteCode, muteMember, searchGroups, applyGroup, getOwnerToken, getAgentImUid, defaultGroupName };
