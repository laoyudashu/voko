const ENDPOINTS = require('../endpoints.json');
const { assertSecureEndpoint } = require('./url-security');

const VOKO_API_URL = assertSecureEndpoint(ENDPOINTS.api.baseUrl, 'http');

module.exports = {
  VOKO_API_URL,
};
