'use strict';

const ENDPOINTS = require('../endpoints.json');

const DEFAULT_TIMEOUT_MS = 3000;
const MAX_BATCH_SIZE = 200;
const inFlightByDb = new WeakMap();

function normalizeUids(uids) {
  return [...new Set((Array.isArray(uids) ? uids : [])
    .map(uid => String(uid || '').trim())
    .filter(Boolean))]
    .slice(0, MAX_BATCH_SIZE);
}

async function requestProfiles(db, uids, options) {
  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');

  const baseUrl = String(options.baseUrl || ENDPOINTS.im?.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('IM base URL is unavailable');

  const response = await fetchImpl(`${baseUrl}/api/users/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uids }),
    signal: AbortSignal.timeout(options.timeoutMs || DEFAULT_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`user profile request failed: HTTP ${response.status}`);

  const payload = await response.json();
  const requested = new Set(uids);
  const profiles = Array.isArray(payload?.users)
    ? payload.users.filter(profile => profile && requested.has(String(profile.uid || '')))
    : [];
  const upsert = db.prepare(`
    INSERT INTO user_cache (uid, nickname, avatar_url, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(uid) DO UPDATE SET
      nickname = excluded.nickname,
      avatar_url = excluded.avatar_url,
      updated_at = excluded.updated_at
  `);
  const updatedAt = Date.now();
  for (const profile of profiles) {
    upsert.run(
      String(profile.uid),
      profile.nickname || null,
      profile.avatar_url || profile.avatar || null,
      updatedAt
    );
  }
  return { success: true, profiles };
}

async function refreshUserProfiles(db, uids, options = {}) {
  const normalized = normalizeUids(uids);
  if (!db || normalized.length === 0) return { success: true, profiles: [] };

  let inFlight = inFlightByDb.get(db);
  if (!inFlight) {
    inFlight = new Map();
    inFlightByDb.set(db, inFlight);
  }
  const key = [...normalized].sort().join('\n');
  if (inFlight.has(key)) return inFlight.get(key);

  const task = requestProfiles(db, normalized, options)
    .catch(error => ({ success: false, profiles: [], error: error.message }))
    .finally(() => inFlight.delete(key));
  inFlight.set(key, task);
  return task;
}

module.exports = { refreshUserProfiles };
