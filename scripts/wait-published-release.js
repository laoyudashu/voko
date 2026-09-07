'use strict';

const { verifyReleaseSources } = require('./verify-release-sources');

async function waitForPublishedRelease({ expectedIntegrity, verify = () => verifyReleaseSources(
  (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(15_000) })),
  timeoutMs = 20 * 60_000, intervalMs = 30_000, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), log = console.log } = {}) {
  if (!expectedIntegrity) throw new Error('Missing prepared artifact integrity');
  const deadline = now() + timeoutMs;
  let lastError;
  do {
    let result;
    try { result = await verify(); }
    catch (error) { lastError = error; }
    if (result) {
      if (result.integrity !== expectedIntegrity) throw new Error('Published artifact differs from prepared tarball');
      return result;
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    log('Registry verification pending; npm publish-time scanning may delay availability. Upload will not be repeated.');
    await sleep(Math.min(intervalMs, remaining));
  } while (now() < deadline);
  throw new Error(`Registry verification timed out; do not republish. ${lastError?.message || ''}`);
}

if (require.main === module) {
  const manifest = JSON.parse(require('node:fs').readFileSync(process.argv[2] || 'npm-pack.json', 'utf8'));
  waitForPublishedRelease({ expectedIntegrity: manifest[0]?.integrity })
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { waitForPublishedRelease };
