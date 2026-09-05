const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const root = process.cwd();
const { stageProviderAttachments, verifyProviderAttachment } = require(root + '/build/core/dispatcher/provider-attachments');
const { encryptE2eeV2Attachment, decryptE2eeV2Attachment } = require(root + '/build/e2ee/v2-attachment');
const [mode, sizeMiB, concurrency] = process.argv.slice(2);
const count = Number(concurrency), size = Number(sizeMiB) * 1024 * 1024;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-r14-benchmark-'));
  const input = Buffer.alloc(size, 0x5a);
  const source = path.join(temp, 'synthetic.bin');
  fs.writeFileSync(source, input, { mode: 0o600 });
  const sha256 = crypto.createHash('sha256').update(input).digest('hex');
  const file = { path: source, name: 'synthetic.bin', size, sha256, mediaType: 'application/octet-stream' };
  const samples = [];
  let permissionsValid = true, integrityValid = true, cleanupValid = true;
  try {
    for (let repetition = 0; repetition < 3; repetition++) {
      global.gc?.();
      const rssStart = process.memoryUsage().rss;
      const histogram = monitorEventLoopDelay({ resolution: 1 }); histogram.enable();
      await sleep(15);
      const scheduled = performance.now();
      const lag = new Promise(resolve => setTimeout(() => resolve(Math.max(0, performance.now() - scheduled - 1)), 1));
      const started = performance.now();
      // Promise concurrency mirrors simultaneous requests on a single Node
      // event loop: synchronous code serializes them and blocks timer delivery.
      const results = await Promise.all(Array.from({ length: count }, (_, index) => Promise.resolve().then(() => {
        if (mode === 'staging') {
          return stageProviderAttachments({ content: 'synthetic', attachments: [file] }, {
            cwd: temp, agentId: 'synthetic-agent', turnId: `synthetic-${repetition}-${index}`,
          });
        }
        const encrypted = encryptE2eeV2Attachment(input, { messageId: `synthetic-${repetition}-${index}`, kind: 'file', fileName: 'synthetic.bin', mediaType: 'application/octet-stream' });
        const decrypted = decryptE2eeV2Attachment(encrypted.ciphertext, encrypted.manifest);
        return { encrypted, decrypted };
      })));
      const elapsedMs = performance.now() - started;
      const rssAfter = process.memoryUsage().rss;
      const timerLagMs = await lag;
      await sleep(10);
      histogram.disable();
      for (const result of results) {
        if (mode === 'staging') {
          integrityValid &&= verifyProviderAttachment(result.attachments[0]).equals(input);
          permissionsValid &&= (fs.statSync(result.directory).mode & 0o777) === 0o700
            && (fs.statSync(result.attachments[0].path).mode & 0o777) === 0o400;
          result.cleanup(); cleanupValid &&= !fs.existsSync(result.directory);
        } else {
          integrityValid &&= result.decrypted.equals(input);
          result.decrypted.fill(0);
        }
      }
      samples.push({ elapsedMs, timerLagMs, eventLoopP95Ms: histogram.percentile(95) / 1e6,
        eventLoopMaxMs: histogram.max / 1e6, rssStartMiB: rssStart / 1024 / 1024,
        rssAfterMiB: rssAfter / 1024 / 1024, rssDeltaMiB: (rssAfter - rssStart) / 1024 / 1024 });
    }
    process.stdout.write(JSON.stringify({ mode, sizeMiB: Number(sizeMiB), concurrency: count, node: process.version,
      platform: process.platform, arch: process.arch, repetitions: 3, integrityValid, permissionsValid, cleanupValid,
      processMaxRssMiB: process.resourceUsage().maxRSS / 1024, samples }) + '\n');
  } finally { input.fill(0); fs.rmSync(temp, { recursive: true, force: true }); }
})().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
