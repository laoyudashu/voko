'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const root = path.resolve(__dirname, '..');
for (const line of fs.readFileSync(path.join(root, '.env.real-test.local'), 'utf8').split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (match && !line.trim().startsWith('#') && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
}
const expected = process.argv.find((value) => value.startsWith('--expect='))?.slice(9) || 'enabled';
const revokeDrillDevice = process.argv.find((value) => value.startsWith('--drill-revoke='))?.slice(15);
const rotateDrillDevice = process.argv.find((value) => value.startsWith('--drill-rotate='))?.slice(15);
let dbPath = process.env.VOKO_REAL_DB_PATH;
if (process.platform === 'linux' && /^[A-Za-z]:\\/.test(dbPath || '')) dbPath = `/mnt/${dbPath[0].toLowerCase()}/${dbPath.slice(3).replaceAll('\\', '/')}`;
const db = new DatabaseSync(dbPath, { readOnly: true });
let token;
try {
  const agent = db.prepare('SELECT owner_email FROM agents WHERE agent_id=?').get(process.env.VOKO_REAL_AGENT_ID);
  const row = db.prepare("SELECT data FROM config WHERE type='user_access_token'").get();
  const tokens = JSON.parse(row?.data || '{}');
  const value = tokens[String(agent?.owner_email || '').toLowerCase()];
  token = value?.user_access_token || value;
} finally { db.close(); }
if (!String(token || '').startsWith('ut_')) throw new Error('Canary owner token is unavailable');
const baseUrl = String(process.env.VOKO_E2EE_CANARY_BASE_URL || require('../src/endpoints.json').api.baseUrl).replace(/\/+$/, '');

(async () => {
  const response = await fetch(`${baseUrl}/api/external/v1/e2ee/canary/status`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
  });
  if (expected === 'disabled') {
    if (response.status !== 404) throw new Error(`Expected fail-closed 404, received ${response.status}`);
    console.log('E2EE Canary status: disabled (fail-closed)');
    return;
  }
  const responseText = await response.text();
  let body;
  try { body = JSON.parse(responseText); }
  catch { throw new Error(`Canary status returned non-JSON HTTP ${response.status}`); }
  if (!response.ok || body?.data?.enabled !== true || body.data.mode !== 'e2ee_tofu') {
    throw new Error(`Expected enabled Canary, received HTTP ${response.status}`);
  }
  const endpoint = `${baseUrl}/api/external/v1/e2ee/devices`;
  const call = (url, requestBody) => fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`,
    accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(requestBody),
  signal: AbortSignal.timeout(10_000) });
  if (rotateDrillDevice) {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(rotateDrillDevice)) throw new Error('Invalid rotation drill device ID');
    const epoch = Date.now();
    const first = { ownerDeviceKeyId: rotateDrillDevice, keyEpoch: epoch,
      credentialPublicKey: crypto.randomBytes(32).toString('base64url') };
    const successor = { ...first, keyEpoch: epoch + 1, credentialPublicKey: crypto.randomBytes(32).toString('base64url') };
    const registered = await call(endpoint, first);
    if (![200, 201].includes(registered.status)) throw new Error(`Rotation drill registration failed: HTTP ${registered.status}`);
    const rotated = await call(endpoint, successor); const rotatedBody = await rotated.json().catch(() => ({}));
    if (!rotated.ok || rotatedBody?.data?.rotated !== true) throw new Error(`Rotation drill failed: HTTP ${rotated.status}`);
    const stale = await call(endpoint, first);
    if (stale.status !== 409) throw new Error(`Stale device epoch was not rejected: HTTP ${stale.status}`);
    const revoked = await call(`${endpoint}/revoke`, { ownerDeviceKeyId: rotateDrillDevice });
    if (!revoked.ok) throw new Error(`Rotation drill cleanup failed: HTTP ${revoked.status}`);
    console.log('E2EE Canary device rotation: successor accepted, stale epoch rejected, test device revoked');
  }
  if (revokeDrillDevice) {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(revokeDrillDevice)) throw new Error('Invalid revocation drill device ID');
    const payload = { ownerDeviceKeyId: revokeDrillDevice, keyEpoch: Date.now(),
      credentialPublicKey: crypto.randomBytes(32).toString('base64url') };
    const registered = await call(endpoint, payload);
    if (![200, 201].includes(registered.status)) throw new Error(`Revocation drill registration failed: HTTP ${registered.status}`);
    const revoked = await call(`${endpoint}/revoke`, { ownerDeviceKeyId: revokeDrillDevice });
    if (!revoked.ok) throw new Error(`Revocation drill failed: HTTP ${revoked.status}`);
    const replay = await call(endpoint, payload);
    const replayText = await replay.text();
    let replayBody;
    try { replayBody = JSON.parse(replayText); }
    catch { throw new Error(`Revocation replay returned non-JSON HTTP ${replay.status}`); }
    if (replay.status !== 409 || !/revoked/i.test(String(replayBody?.message || ''))) {
      throw new Error(`Revoked device was not rejected: HTTP ${replay.status}`);
    }
    console.log('E2EE Canary device revocation: irreversible rejection confirmed');
  }
  console.log(`E2EE Canary status: enabled; platforms=${body.data.platforms.join(',')}; agents=${body.data.agentCount}; devices=${body.data.deviceCount}`);
})().catch((error) => { console.error(`E2EE Canary status failed: ${error.message}`); process.exitCode = 1; });
