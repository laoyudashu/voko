'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fetchWithDidClockRetry,
  calibratedNowMs,
  resetDidClockCacheForTests,
} = require('../build/core/did-auth-client');

test('DID client samples server time and retries CLOCK_SKEW exactly once', async () => {
  resetDidClockCacheForTests();
  const serverTimeMs = Date.now() - 15 * 60 * 60 * 1000;
  const calls = [];
  let signedRequests = 0;
  const fakeFetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (String(url).endsWith('/api/external/v1/time')) {
      return new Response(JSON.stringify({ success: true, serverTimeMs }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    signedRequests += 1;
    if (signedRequests === 1) {
      return new Response(JSON.stringify({
        success: false,
        message: 'timestamp 超出允许范围（±5 分钟）',
        error: { code: 'CLOCK_SKEW', retryable: true },
      }), { status: 401, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const signed = [];
  const response = await fetchWithDidClockRetry(
    'https://api.example.com/api/did-auth/update-agent-profile',
    async (timestamp) => {
      signed.push({ timestamp, nonce: `nonce-${signed.length}` });
      return { method: 'POST', body: JSON.stringify(signed.at(-1)) };
    },
    { fetchImpl: fakeFetch },
  );

  assert.equal(response.status, 200);
  assert.equal(signedRequests, 2);
  assert.equal(calls.filter((call) => call.url.endsWith('/v1/time')).length, 2);
  assert.notEqual(signed[0].nonce, signed[1].nonce);
  assert.ok(Math.abs(signed[1].timestamp - Math.floor(serverTimeMs / 1000)) <= 1);
  assert.ok(Math.abs(calibratedNowMs('https://api.example.com/test') - serverTimeMs) <= 1000);
  assert.equal(Number.isInteger(calibratedNowMs('https://api.example.com/test')), true);
});

test('DID client never retries a non-clock 401', async () => {
  resetDidClockCacheForTests();
  let signedRequests = 0;
  const fakeFetch = async (url) => {
    if (String(url).endsWith('/api/external/v1/time')) {
      return new Response(JSON.stringify({ success: true, serverTimeMs: Date.now() }), { status: 200 });
    }
    signedRequests += 1;
    return new Response(JSON.stringify({ success: false, message: '签名验证失败' }), { status: 401 });
  };
  const response = await fetchWithDidClockRetry(
    'https://api.example.com/api/did-auth/set-agent-status',
    () => ({ method: 'POST' }),
    { fetchImpl: fakeFetch },
  );
  assert.equal(response.status, 401);
  assert.equal(signedRequests, 1);
});
