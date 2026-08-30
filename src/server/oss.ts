export {};
const crypto = require('crypto');
const ENDPOINTS = require('../endpoints.json');

function uploadError(code: string, message: string, status = 0) { return Object.assign(new Error(message), { code, status }); }
function uploadBaseUrl() { return String(process.env.VOKO_E2E_API_BASE_URL || ENDPOINTS.api.baseUrl).replace(/\/+$/, ''); }
async function fetchUpload(url: string, options: any, code: string, timeoutMs: number) {
  let lastError: any;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { return await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) }); }
    catch (error: any) {
      lastError = error;
      if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw uploadError(code, `${code}: ${String(lastError?.cause?.code || lastError?.name || 'network_error')}`);
}
async function parseResponse(response: any) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.success !== true) throw uploadError(payload?.error?.code || 'UPLOAD_SERVICE_FAILED',
    payload?.error?.message || `Upload service failed (${response.status})`, response.status);
  return payload.data;
}
async function authorizeUpload(options: any) {
  const response = await fetchUpload(`${uploadBaseUrl()}/api/external/v1/uploads/authorize`, {
    method: 'POST', headers: { Authorization: `Bearer ${options.userAccessToken}`, 'Content-Type': 'application/json',
      'Idempotency-Key': options.idempotencyKey || `voko-${crypto.randomUUID()}` },
    body: JSON.stringify({ agentId: options.agentId, purpose: options.purpose, fileName: options.fileName,
      size: options.size, contentType: options.contentType || 'application/octet-stream', targetScopeType: options.targetScopeType || null,
      targetScopeId: options.targetScopeId || null }),
  }, 'UPLOAD_AUTH_NETWORK_ERROR', Number(process.env.VOKO_UPLOAD_AUTH_TIMEOUT_MS) || 10000);
  return parseResponse(response);
}
async function completeUpload(uploadId: string, token: string) {
  return parseResponse(await fetchUpload(`${uploadBaseUrl()}/api/external/v1/uploads/${encodeURIComponent(uploadId)}/complete`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}',
  }, 'UPLOAD_COMPLETE_NETWORK_ERROR', Number(process.env.VOKO_UPLOAD_COMPLETE_TIMEOUT_MS) || 15000));
}
async function getUploadDownload(uploadId: string, token: string, agentId?: string, targetScopeType?: string, targetScopeId?: string) {
  const query = new URLSearchParams();
  if (agentId) query.set('agentId', agentId);
  if (targetScopeType) query.set('targetScopeType', targetScopeType);
  if (targetScopeId) query.set('targetScopeId', targetScopeId);
  const suffix = query.size ? `?${query}` : '';
  return parseResponse(await fetchUpload(`${uploadBaseUrl()}/api/external/v1/uploads/${encodeURIComponent(uploadId)}/download${suffix}`, {
    headers: { Authorization: `Bearer ${token}` } }, 'UPLOAD_DOWNLOAD_NETWORK_ERROR', 10000));
}
async function bindUpload(uploadId: string, token: string, referenceType: string, referenceId: string) {
  return parseResponse(await fetchUpload(`${uploadBaseUrl()}/api/external/v1/uploads/${encodeURIComponent(uploadId)}/bind`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ referenceType, referenceId }) }, 'UPLOAD_BIND_NETWORK_ERROR', 10000));
}
async function uploadToOfficialStorage(options: any) {
  if (!options.userAccessToken) throw uploadError('UPLOAD_LOGIN_REQUIRED', '请先登录 VOKO 后再上传附件');
  const buffer = Buffer.isBuffer(options.content) ? options.content : Buffer.from(options.content);
  const authorized = await authorizeUpload({ ...options, size: buffer.length });
  if (authorized.completed) return { uploadId: authorized.uploadId, url: authorized.url || authorized.downloadPath };
  const form = new FormData();
  for (const [key, value] of Object.entries(authorized.fields || {})) form.append(key, String(value));
  const authorizedContentType = String(authorized.fields?.['Content-Type'] || options.contentType || 'application/octet-stream');
  form.append('file', new Blob([buffer], { type: authorizedContentType }), options.fileName || 'file');
  const response = await fetchUpload(authorized.endpoint, { method: 'POST', body: form }, 'UPLOAD_OBJECT_NETWORK_ERROR',
    Number(process.env.VOKO_OSS_UPLOAD_TIMEOUT_MS) || 30000);
  if (!response.ok) throw uploadError('UPLOAD_OBJECT_REJECTED', `对象存储拒绝上传 (${response.status})`, response.status);
  return { ...(await completeUpload(authorized.uploadId, options.userAccessToken)), uploadId: authorized.uploadId };
}
async function uploadToOSS(objectName?: any, content?: any, contentType?: any, _onProgress?: any, options: any = {}) {
  if (process.env.VOKO_E2E === '1' && process.env.VOKO_E2E_OSS_BASE_URL) {
    const buffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    const url = `${String(process.env.VOKO_E2E_OSS_BASE_URL).replace(/\/$/, '')}/${objectName}`;
    const response = await fetch(url, { method: 'PUT', headers: { 'Content-Type': contentType || 'application/octet-stream' }, body: buffer,
      signal: AbortSignal.timeout(Number(process.env.VOKO_OSS_UPLOAD_TIMEOUT_MS) || 30000) });
    if (!response.ok) throw uploadError('UPLOAD_OBJECT_REJECTED', `测试对象存储拒绝上传 (${response.status})`, response.status);
    return url;
  }
  const result = await uploadToOfficialStorage({ ...options, content, contentType,
    fileName: options.fileName || String(objectName || 'file').split('/').pop(), purpose: options.purpose || 'agent_attachment' });
  if (options.bind !== false) await bindUpload(result.uploadId, options.userAccessToken,
    options.referenceType || 'voko_pending_message', options.referenceId || String(objectName));
  return result.url || result.downloadPath;
}
async function uploadBase64ToOSS(base64DataUrl?: any, objectName?: any, onProgress?: any, options: any = {}) {
  const matches = String(base64DataUrl || '').match(/^data:(.+?);base64,(.+)$/);
  if (!matches) throw uploadError('UPLOAD_DATA_INVALID', '无效的 base64 data URL');
  onProgress?.(0);
  const result = await uploadToOSS(objectName, Buffer.from(matches[2], 'base64'), matches[1], null, options);
  onProgress?.(100); return result;
}
async function generateOSSSignature(options: any) { return authorizeUpload(options); }
function initOSSFromConfig() { /* 已废弃：正式上传只使用服务端短期授权。 */ }
module.exports = { authorizeUpload, completeUpload, bindUpload, getUploadDownload, generateOSSSignature, uploadToOfficialStorage,
  uploadBase64ToOSS, uploadToOSS, uploadToOSSWithProgress: uploadToOSS, initOSSFromConfig };
