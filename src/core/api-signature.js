const ENDPOINTS = require('../endpoints.json');
const { assertSecureEndpoint } = require('./url-security');

// The production endpoint remains the default.  The E2E harness injects a
// loopback fake API through an explicit process-local override; URL validation
// still applies so this cannot silently widen the accepted endpoint policy.
const VOKO_API_URL = assertSecureEndpoint(
  process.env.VOKO_E2E_API_BASE_URL || ENDPOINTS.api.baseUrl,
  'http',
);

module.exports = {
  VOKO_API_URL,
};
