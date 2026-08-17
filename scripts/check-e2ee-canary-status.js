'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const root = path.resolve(__dirname, '..');
for (const line of fs.readFileSync(path.join(root, '.env.real-test.local'), 'utf8').split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (match && !line.trim().startsWith('#') && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
}
const expected = process.argv.find((value) => value.startsWith('--expect='))?.slice(9) || 'enabled';
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
  const body = await response.json();
  if (!response.ok || body?.data?.enabled !== true || body.data.mode !== 'e2ee_tofu') {
    throw new Error(`Expected enabled Canary, received HTTP ${response.status}`);
  }
  console.log(`E2EE Canary status: enabled; platforms=${body.data.platforms.join(',')}; agents=${body.data.agentCount}; devices=${body.data.deviceCount}`);
})().catch((error) => { console.error(`E2EE Canary status failed: ${error.message}`); process.exitCode = 1; });
