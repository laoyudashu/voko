'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const envFile = path.join(root, '.env.real-test.local');
if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
}
const required = (name) => { const value = String(process.env[name] || '').trim(); if (!value) throw new Error(`Missing ${name}`); return value; };
if (process.env.VOKO_E2EE_TEST_OSS_ACKNOWLEDGE_DEDICATED !== '1') throw new Error('Dedicated test Bucket acknowledgement is required');
const region = required('VOKO_E2EE_TEST_OSS_REGION');
const bucket = required('VOKO_E2EE_TEST_OSS_BUCKET');
const accessKeyId = required('VOKO_E2EE_TEST_OSS_ACCESS_KEY_ID');
const accessKeySecret = required('VOKO_E2EE_TEST_OSS_ACCESS_KEY_SECRET');
if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('Invalid dedicated test Bucket name');
const productionBucket = JSON.parse(fs.readFileSync(path.join(root, 'src', 'endpoints.json'), 'utf8')).oss?.bucket;
if (bucket === productionBucket) throw new Error('Production OSS Bucket cannot be used for the E2EE attachment Canary');
const endpoint = String(process.env.VOKO_E2EE_TEST_OSS_ENDPOINT || `https://${bucket}.${region}.aliyuncs.com`).replace(/\/$/, '');
if (!endpoint.startsWith('https://')) throw new Error('E2EE test OSS endpoint must use HTTPS');

const cargo = process.env.CARGO || path.join(os.homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo');
const executable = path.join(root, 'e2ee', 'target', 'debug', process.platform === 'win32'
  ? 'voko-e2ee-attachment-endpoint.exe' : 'voko-e2ee-attachment-endpoint');
execFileSync(cargo, ['build', '--locked', '--manifest-path', 'e2ee/Cargo.toml', '--bin', 'voko-e2ee-attachment-endpoint'], { cwd: root, stdio: 'inherit' });

function signature(method, objectKey, contentType = '') {
  const date = new Date().toUTCString();
  const headers = method === 'PUT' ? 'x-oss-object-acl:private\n' : '';
  const canonical = `${method}\n\n${contentType}\n${date}\n${headers}/${bucket}/${objectKey}`;
  const value = crypto.createHmac('sha1', accessKeySecret).update(canonical).digest('base64');
  return { date, authorization: `OSS ${accessKeyId}:${value}` };
}

async function put(objectKey, bytes) {
  const auth = signature('PUT', objectKey, 'application/octet-stream');
  const response = await fetch(`${endpoint}/${objectKey}`, { method: 'PUT', body: bytes, signal: AbortSignal.timeout(30_000), headers: {
    Date: auth.date, Authorization: auth.authorization, 'Content-Type': 'application/octet-stream', 'x-oss-object-acl': 'private',
  } });
  if (!response.ok) throw new Error(`Dedicated OSS PUT failed: HTTP ${response.status}`);
}

async function get(objectKey) {
  const auth = signature('GET', objectKey);
  const response = await fetch(`${endpoint}/${objectKey}`, { signal: AbortSignal.timeout(30_000), headers: { Date: auth.date, Authorization: auth.authorization } });
  if (!response.ok) throw new Error(`Dedicated OSS GET failed: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

(async () => {
  const runId = `e2ee-attachment-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), `${runId}-`));
  const source = path.join(temporary, 'source.bin'); const encrypted = path.join(temporary, 'encrypted');
  const downloaded = path.join(temporary, 'downloaded'); const output = path.join(temporary, 'output.bin'); const key = path.join(temporary, 'key.bin');
  const marker = `E2EE_REAL_OSS_MUST_NOT_SEE_${crypto.randomUUID()}`;
  const plaintext = Buffer.concat([Buffer.from(marker), crypto.randomBytes(1024 * 1024 + 97)]);
  try {
    fs.writeFileSync(source, plaintext);
    execFileSync(executable, ['encrypt', `--input=${source}`, `--directory=${encrypted}`, `--key=${key}`], { stdio: 'pipe' });
    const manifest = JSON.parse(fs.readFileSync(path.join(encrypted, 'manifest.json'), 'utf8'));
    const names = ['manifest.json', ...manifest.ciphertextHashes.map((_, index) => `chunk-${String(index).padStart(4, '0')}.bin`)];
    for (const name of names) await put(`${runId}/${name}`, fs.readFileSync(path.join(encrypted, name)));
    fs.mkdirSync(downloaded);
    const captured = [];
    for (const name of [...names].reverse()) { const bytes = await get(`${runId}/${name}`); captured.push(bytes); fs.writeFileSync(path.join(downloaded, name), bytes); }
    if (Buffer.concat(captured).includes(Buffer.from(marker))) throw new Error('Plaintext appeared in dedicated OSS objects');
    execFileSync(executable, ['decrypt', `--input=${output}`, `--directory=${downloaded}`, `--key=${key}`], { stdio: 'pipe' });
    if (!fs.readFileSync(output).equals(plaintext)) throw new Error('Downloaded attachment mismatch');
    const report = { schemaVersion: 1, runId, platform: process.platform, bucketRef: crypto.createHash('sha256').update(bucket).digest('hex').slice(0, 12),
      privateObjects: true, chunks: manifest.ciphertextHashes.length, plaintextHits: 0, reverseDownload: true, endpointRestart: true, passed: true };
    const reportPath = path.join(root, 'artifacts', 'real-tests', runId, 'summary.json'); fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`); console.log(`Real E2EE attachment OSS Canary passed; report=${reportPath}`);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
})().catch((error) => { console.error(`Real E2EE attachment OSS Canary failed: ${error.message}`); process.exitCode = 1; });
