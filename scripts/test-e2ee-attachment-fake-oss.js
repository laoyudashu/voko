'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const cargo = process.env.CARGO || path.join(os.homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo');
const executable = path.join(root, 'e2ee', 'target', 'debug', process.platform === 'win32'
  ? 'voko-e2ee-attachment-endpoint.exe' : 'voko-e2ee-attachment-endpoint');
execFileSync(cargo, ['build', '--locked', '--manifest-path', 'e2ee/Cargo.toml', '--bin', 'voko-e2ee-attachment-endpoint'], { cwd: root, stdio: 'inherit' });

function request(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(options.timeoutMs || 2_000) });
}

async function startStore(objects, fault) {
  const server = http.createServer(async (req, res) => {
    const key = decodeURIComponent(new URL(req.url, 'http://localhost').pathname.slice(1));
    if (fault.mode === 'timeout' && fault.count-- > 0) return;
    if (fault.mode === '500' && fault.count-- > 0) { res.writeHead(500); return res.end('fault'); }
    if (req.method === 'PUT') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      objects.set(key, Buffer.concat(chunks)); res.writeHead(201); return res.end();
    }
    if (req.method === 'GET' && objects.has(key)) {
      let body = Buffer.from(objects.get(key));
      if (fault.mode === 'corrupt' && fault.count-- > 0 && body.length) body[0] ^= 1;
      res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(body);
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

(async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-e2ee-attachment-'));
  const plaintextPath = path.join(temporary, 'source.bin');
  const encryptedDir = path.join(temporary, 'encrypted');
  const downloadedDir = path.join(temporary, 'downloaded');
  const outputPath = path.join(temporary, 'output.bin');
  const keyPath = path.join(temporary, 'file-key.bin');
  const marker = `E2EE_ATTACHMENT_SERVER_MUST_NOT_SEE_${crypto.randomUUID()}`;
  const plaintext = Buffer.concat([Buffer.from(marker), crypto.randomBytes(2 * 1024 * 1024 + 37)]);
  fs.writeFileSync(plaintextPath, plaintext);
  execFileSync(executable, ['encrypt', `--input=${plaintextPath}`, `--directory=${encryptedDir}`, `--key=${keyPath}`], { encoding: 'utf8' });
  const manifest = JSON.parse(fs.readFileSync(path.join(encryptedDir, 'manifest.json'), 'utf8'));
  const names = ['manifest.json', ...manifest.ciphertextHashes.map((_, index) => `chunk-${String(index).padStart(4, '0')}.bin`)];
  const objects = new Map(); const fault = { mode: '', count: 0 }; let store = await startStore(objects, fault);
  let finalized = false;
  try {
    fault.mode = '500'; fault.count = 1;
    assert.equal((await request(`${store.url}/canary/manifest.json`, { method: 'PUT', body: fs.readFileSync(path.join(encryptedDir, 'manifest.json')) })).status, 500);
    assert.equal(finalized, false);
    const manifestBytes = fs.readFileSync(path.join(encryptedDir, 'manifest.json'));
    fault.mode = 'timeout'; fault.count = 1;
    await assert.rejects(request(`${store.url}/canary/manifest.json`, { method: 'PUT', body: manifestBytes, timeoutMs: 100 }));
    assert.equal(finalized, false);
    fault.mode = '';
    for (const name of names) {
      const bytes = fs.readFileSync(path.join(encryptedDir, name));
      const response = await request(`${store.url}/canary/${name}`, { method: 'PUT', body: bytes }); assert.equal(response.status, 201);
      assert.deepEqual(objects.get(`canary/${name}`), bytes);
    }
    const stored = Buffer.concat([...objects.values()]); assert.equal(stored.includes(Buffer.from(marker)), false);
    await store.close(); store = await startStore(objects, fault);
    fs.mkdirSync(downloadedDir);
    for (const name of [...names].reverse()) {
      const response = await request(`${store.url}/canary/${name}`); assert.equal(response.status, 200);
      fs.writeFileSync(path.join(downloadedDir, name), Buffer.from(await response.arrayBuffer()));
    }
    const missingBytes = objects.get('canary/chunk-0000.bin'); objects.delete('canary/chunk-0000.bin');
    assert.equal((await request(`${store.url}/canary/chunk-0000.bin`)).status, 404); objects.set('canary/chunk-0000.bin', missingBytes);
    fault.mode = 'corrupt'; fault.count = 1;
    const corrupted = await request(`${store.url}/canary/chunk-0000.bin`);
    fs.writeFileSync(path.join(downloadedDir, 'chunk-0000.bin'), Buffer.from(await corrupted.arrayBuffer()));
    assert.throws(() => execFileSync(executable, ['decrypt', `--input=${outputPath}`, `--directory=${downloadedDir}`, `--key=${keyPath}`], { stdio: 'pipe' }));
    fs.writeFileSync(path.join(downloadedDir, 'chunk-0000.bin'), objects.get('canary/chunk-0000.bin'));
    execFileSync(executable, ['decrypt', `--input=${outputPath}`, `--directory=${downloadedDir}`, `--key=${keyPath}`], { stdio: 'pipe' });
    assert.deepEqual(fs.readFileSync(outputPath), plaintext); finalized = true;
    console.log(JSON.stringify({ passed: true, chunks: manifest.ciphertextHashes.length, plaintextHits: 0,
      faults: ['500', 'timeout', 'restart', 'reverse-download', 'missing-chunk', 'corruption'], finalized }));
  } finally { await store.close(); fs.rmSync(temporary, { recursive: true, force: true }); }
})().catch((error) => { console.error(`E2EE attachment Fake OSS failed: ${error.message}`); process.exitCode = 1; });
