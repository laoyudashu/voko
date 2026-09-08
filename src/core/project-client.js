'use strict';
const endpoints = require('../endpoints.json');
const { assertSecureEndpoint } = require('./url-security');
const { getOwnerToken, getAgentImUid } = require('./group-client');
const actions = Object.freeze({ get: 'get', enable: 'enable', update: 'update', create: 'plans/create', edit: 'plans/update', move: 'plans/move', archive: 'plans/archive', taskGet:'tasks/get', taskMessage:'tasks/message', taskDispatch:'tasks/dispatch', executionCancel:'executions/cancel', executionResolve:'executions/resolve', executionQueue:'executions/queue', executionClaim:'executions/claim', executionFinish:'executions/finish', assetsList:'assets/list', assetPrepare:'assets/prepare', assetCommit:'assets/commit', assetDownload:'assets/download', storageGet: 'storage/get', storageConfigure: 'storage/configure' });

// Credentials stay in Lite. The remote service verifies Agent ownership and live membership.
function createProjectClient(db, fetchImpl = fetch) {
  const cx = { query: (sql, args = []) => db.prepare(sql).all(...args) };
  return async (agentId, channelId, action, input = {}) => {
    if (!Object.hasOwn(actions, action)) return { status: 404, body: { success: false, code: 'PROJECT_ACTION_INVALID' } };
    const token = getOwnerToken(cx, agentId), uid = getAgentImUid(cx, agentId);
    if (!token || !uid) return { status: 401, body: { success: false, code: 'PROJECT_AGENT_AUTH_REQUIRED' } };
    try {
      const response = await fetchImpl(`${assertSecureEndpoint(process.env.VOKO_GROUP_API_BASE || endpoints.im.baseUrl, 'http')}/api/projects/v1/${actions[action]}`, {
        method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Voko-Agent-Uid': uid },
        body: JSON.stringify({ ...input, channel_id: channelId })
      });
      const result = await response.json();
      if (response.ok && result.success === true) return { status: 200, body: { success: true, data: { ...result.data, viewer_uid: uid } } };
      const code = /^(PROJECT_[A-Z_]+|PLAN_[A-Z_]+|ASSIGNEE_NOT_MEMBER|GROUP_DISSOLVED)$/.test(result.code || '') ? result.code : 'PROJECT_UNAVAILABLE';
      return { status: response.ok ? 502 : response.status, body: { success: false, code } };
    } catch (error) {
      return { status: 503, body: { success: false, code: error.name === 'TimeoutError' ? 'PROJECT_TIMEOUT' : 'PROJECT_UNAVAILABLE' } };
    }
  };
}
module.exports = { createProjectClient };
