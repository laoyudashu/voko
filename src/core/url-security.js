const net = require('net');
const { t } = require('./i18n');

const OFFICIAL_IM_WS_URL = 'wss://wukongim.vokovoko.com';
const LEGACY_IM_WS_URLS = new Set([
  'ws://8.153.167.187:5200',
  'ws://im.vokovoko.com:5200',
]);
const OFFICIAL_HOSTS = new Set([
  'vokovoko.com',
  'www.vokovoko.com',
  'im.vokovoko.com',
  'wukongim.vokovoko.com',
  'files.vokovoko.com',
  'emails.vokovoko.com',
]);

function normalizeHostname(hostname) {
  return String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
}

function isPrivateNetworkHost(hostname) {
  const host = normalizeHostname(hostname);
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
  if (net.isIP(host) !== 4) return false;
  const parts = host.split('.').map(Number);
  return parts[0] === 127
    || parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function assertSecureEndpoint(value, kind = 'http') {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch (_) {
    throw new Error(t('errors.security.invalid_endpoint'));
  }
  if (parsed.username || parsed.password) {
    throw new Error(t('errors.security.endpoint_credentials'));
  }

  const websocket = kind === 'websocket';
  const allowed = websocket ? new Set(['ws:', 'wss:']) : new Set(['http:', 'https:']);
  if (!allowed.has(parsed.protocol)) {
    throw new Error(t('errors.security.invalid_endpoint_protocol'));
  }

  const secureProtocol = websocket ? 'wss:' : 'https:';
  if (parsed.protocol !== secureProtocol && !isPrivateNetworkHost(parsed.hostname)) {
    throw new Error(t('errors.security.public_endpoint_https_required'));
  }
  return parsed.toString().replace(/\/$/, '');
}

function normalizeOfficialImServerUrl(value) {
  const trimmed = String(value || '').trim().replace(/\/$/, '');
  if (!trimmed || LEGACY_IM_WS_URLS.has(trimmed)) return OFFICIAL_IM_WS_URL;
  return assertSecureEndpoint(trimmed, 'websocket');
}

function normalizeOfficialPublicUrl(value, { canonicalMain = false } = {}) {
  if (value === null || value === undefined || value === '') return value;
  const parsed = new URL(String(value || '').trim());
  if (OFFICIAL_HOSTS.has(normalizeHostname(parsed.hostname))) {
    parsed.protocol = parsed.protocol === 'ws:' ? 'wss:' : 'https:';
    parsed.port = '';
    if (canonicalMain && parsed.hostname === 'www.vokovoko.com') {
      parsed.hostname = 'vokovoko.com';
    }
  }
  return parsed.toString();
}

module.exports = {
  OFFICIAL_IM_WS_URL,
  assertSecureEndpoint,
  isPrivateNetworkHost,
  normalizeOfficialImServerUrl,
  normalizeOfficialPublicUrl,
};
