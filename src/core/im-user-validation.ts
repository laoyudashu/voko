const ENDPOINTS = require('../endpoints.json');

const DEFAULT_TIMEOUT_MS = 3000;

export async function validateImUidExists(imUid: string, options: {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
} = {}): Promise<{ exists: boolean; reason?: string }> {
  const uid = String(imUid || '').trim();
  if (!uid) return { exists: false, reason: 'missing_uid' };

  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('IM user directory is unavailable');
  const baseUrl = String(options.baseUrl || ENDPOINTS.im?.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('IM user directory is unavailable');

  const response = await fetchImpl(`${baseUrl}/api/users/${encodeURIComponent(uid)}`, {
    signal: AbortSignal.timeout(options.timeoutMs || DEFAULT_TIMEOUT_MS),
  });
  if (response.status === 404) return { exists: false, reason: 'not_found' };
  if (!response.ok) throw new Error(`IM user directory request failed: HTTP ${response.status}`);

  const profile = await response.json();
  const returnedUid = String(profile?.uid || profile?.imUid || profile?.im_uid || uid);
  if (returnedUid !== uid) return { exists: false, reason: 'identity_mismatch' };
  return { exists: true };
}

module.exports = { validateImUidExists };
