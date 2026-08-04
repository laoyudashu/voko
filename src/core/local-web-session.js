'use strict';

const crypto = require('crypto');

const COOKIE_NAME = 'voko_session';
const CSRF_COOKIE_NAME = 'voko_csrf';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function digest(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    try { cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim()); } catch (_) {}
  }
  return cookies;
}

function createLocalWebSessionStore(db, options = {}) {
  const now = options.now || Date.now;
  const ttlMs = options.ttlMs || SESSION_TTL_MS;
  db.exec(`CREATE TABLE IF NOT EXISTS local_web_sessions (
    token_hash TEXT PRIMARY KEY,
    owner_email TEXT NOT NULL,
    csrf_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`);

  function create(ownerEmail) {
    const normalized = String(ownerEmail || '').trim().toLowerCase();
    if (!normalized) throw new Error('owner email is required');
    const token = crypto.randomBytes(32).toString('base64url');
    const csrfToken = crypto.randomBytes(32).toString('base64url');
    const timestamp = now();
    db.prepare(`INSERT INTO local_web_sessions
      (token_hash, owner_email, csrf_hash, created_at, last_used_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(digest(token), normalized, digest(csrfToken), timestamp, timestamp, timestamp + ttlMs);
    return { token, csrfToken, ownerEmail: normalized, expiresAt: timestamp + ttlMs };
  }

  function resolveRequest(req) {
    const token = parseCookies(req?.headers?.cookie)[COOKIE_NAME];
    if (!token) return null;
    const timestamp = now();
    const row = db.prepare(`SELECT owner_email, csrf_hash, expires_at
      FROM local_web_sessions WHERE token_hash=? LIMIT 1`).get(digest(token));
    if (!row || Number(row.expires_at) <= timestamp) {
      if (row) db.prepare('DELETE FROM local_web_sessions WHERE token_hash=?').run(digest(token));
      return null;
    }
    db.prepare('UPDATE local_web_sessions SET last_used_at=? WHERE token_hash=?').run(timestamp, digest(token));
    return { ownerEmail: row.owner_email, csrfHash: row.csrf_hash, tokenHash: digest(token) };
  }

  function destroyRequest(req) {
    const token = parseCookies(req?.headers?.cookie)[COOKIE_NAME];
    if (token) db.prepare('DELETE FROM local_web_sessions WHERE token_hash=?').run(digest(token));
  }

  function setCookie(res, session) {
    res.setHeader('Set-Cookie', [
      `${COOKIE_NAME}=${encodeURIComponent(session.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(ttlMs / 1000)}`,
      `${CSRF_COOKIE_NAME}=${encodeURIComponent(session.csrfToken)}; SameSite=Strict; Path=/; Max-Age=${Math.floor(ttlMs / 1000)}`,
    ]);
  }

  function clearCookie(res) {
    res.setHeader('Set-Cookie', [
      `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
      `${CSRF_COOKIE_NAME}=; SameSite=Strict; Path=/; Max-Age=0`,
    ]);
  }

  function verifyCsrf(req, session) {
    if (!session?.csrfHash) return false;
    const cookies = parseCookies(req?.headers?.cookie);
    const cookieToken = cookies[CSRF_COOKIE_NAME];
    const supplied = req?.headers?.['x-voko-csrf'] || req?.body?._csrf;
    if (!cookieToken || !supplied || cookieToken !== supplied) return false;
    return digest(supplied) === session.csrfHash;
  }

  function requestCsrfToken(req) {
    return parseCookies(req?.headers?.cookie)[CSRF_COOKIE_NAME] || '';
  }

  return { create, resolveRequest, destroyRequest, setCookie, clearCookie, verifyCsrf, requestCsrfToken, digest };
}

module.exports = { COOKIE_NAME, CSRF_COOKIE_NAME, SESSION_TTL_MS, createLocalWebSessionStore, parseCookies };
