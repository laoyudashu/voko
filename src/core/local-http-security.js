'use strict';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const SAFE_FETCH_SITES = new Set(['', 'none', 'same-origin', 'same-site']);

function parseLoopbackAuthority(value, asOrigin = false) {
  try {
    const raw = String(value || '');
    const parsed = new URL(asOrigin ? raw : `http://${raw}`);
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) return null;
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!['localhost', '127.0.0.1', '::1'].includes(hostname)) return null;
    if (asOrigin && parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return { port: parsed.port };
  } catch (_) {
    return null;
  }
}

function isAllowedLocalOrigin(origin, host, method, secFetchSite) {
  if (SAFE_METHODS.has(String(method || '').toUpperCase()) || !origin) return true;

  const localHost = parseLoopbackAuthority(host);
  if (!localHost) return false;

  if (String(origin).toLowerCase() === 'null') {
    return SAFE_FETCH_SITES.has(String(secFetchSite || '').toLowerCase());
  }

  const localOrigin = parseLoopbackAuthority(origin, true);
  return !!localOrigin && localOrigin.port === localHost.port;
}

function isAllowedLocalHost(host) {
  return !host || !!parseLoopbackAuthority(host);
}

function isAllowedLocalWebSocketOrigin(origin, host) {
  const localHost = parseLoopbackAuthority(host);
  if (!localHost) return false;
  if (!origin) return true;
  const localOrigin = parseLoopbackAuthority(origin, true);
  return !!localOrigin && localOrigin.port === localHost.port;
}

function requiresLocalToken(path) {
  const requestPath = String(path || '');
  return requestPath === '/mcp' ||
    requestPath.startsWith('/mcp/');
}

function setLocalSecurityHeaders(res) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
}

module.exports = {
  isAllowedLocalHost,
  isAllowedLocalOrigin,
  isAllowedLocalWebSocketOrigin,
  requiresLocalToken,
  setLocalSecurityHeaders,
};
