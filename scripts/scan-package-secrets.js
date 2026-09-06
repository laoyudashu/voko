#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const childProcess = require('node:child_process');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const DEFAULT_TARGETS = ['src', 'scripts', 'dist', 'package.json'];
const TEXT_EXTENSIONS = new Set([
  '.js', '.cjs', '.mjs', '.ts', '.json', '.html', '.css', '.md', '.txt', '.yml', '.yaml',
]);

const RULES = [
  { name: 'private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: 'aliyun-access-key-id', pattern: /\bLTAI[A-Za-z0-9]{12,}\b/g },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g },
  {
    name: 'literal-secret',
    pattern: /\b(?:access[_-]?key[_-]?secret|secret[_-]?key|client[_-]?secret|private[_-]?key|master[_-]?key|password)\b\s*[:=]\s*['"`]([^'"`\r\n]{12,})['"`]/gi,
  },
];

function listTextFiles(root, targets = DEFAULT_TARGETS) {
  const files = [];
  const visit = (candidate) => {
    if (!fs.existsSync(candidate)) return;
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(candidate)) visit(path.join(candidate, entry));
      return;
    }
    if (TEXT_EXTENSIONS.has(path.extname(candidate).toLowerCase()) || path.basename(candidate) === 'package.json') {
      files.push(candidate);
    }
  };
  for (const target of targets) visit(path.resolve(root, target));
  return files;
}

function lineNumber(source, offset) {
  return source.slice(0, offset).split(/\r?\n/).length;
}

function scanText(source, file) {
  const findings = [];
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    let match;
    while ((match = rule.pattern.exec(source))) {
      findings.push({ rule: rule.name, file, line: lineNumber(source, match.index) });
      if (match[0].length === 0) rule.pattern.lastIndex++;
    }
  }
  return findings;
}

function scanFiles(root, targets = DEFAULT_TARGETS) {
  const findings = [];
  for (const file of listTextFiles(root, targets)) {
    const source = fs.readFileSync(file, 'utf8');
    findings.push(...scanText(source, path.relative(root, file)));
  }
  return findings;
}

function archiveText(bytes) {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  if (encoding === 'utf-8' && bytes.includes(0)) return null;
  try { return new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch (_) { return null; }
}

// Inspect and read the same opened object; path replacement cannot redirect the read.
function readBoundedRegularFile(file, maxBytes) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    | (fs.constants.O_NONBLOCK || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('Unsafe release archive file type');
    if (stat.size > maxBytes) throw new Error('Release archive exceeds size budget');
    const chunks = [];
    let total = 0;
    while (true) {
      // One extra byte detects growth after fstat without an unbounded read.
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes - total + 1));
      const length = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!length) break;
      total += length;
      if (total > maxBytes) throw new Error('Release archive exceeds size budget');
      chunks.push(chunk.subarray(0, length));
    }
    return { stat, bytes: Buffer.concat(chunks, total) };
  } finally {
    fs.closeSync(fd);
  }
}

/** Scan the bytes of the already-created npm artifact, never the mutable build tree.
 * Requires the system tar utility (available on the release Ubuntu runner).
 * Only regular files/directories under package/ are accepted for extraction. */
function scanTarball(archivePath, { maxMembers = 10000, maxExpandedBytes = 256 * 1024 * 1024 } = {}) {
  const maxArchiveBytes = 64 * 1024 * 1024;
  if (!Number.isSafeInteger(maxMembers) || maxMembers < 1
    || !Number.isSafeInteger(maxExpandedBytes) || maxExpandedBytes < 1) throw new Error('Invalid archive scan budget');
  const { bytes: compressed } = readBoundedRegularFile(archivePath, maxArchiveBytes);
  let expanded;
  try { expanded = zlib.gunzipSync(compressed, { maxOutputLength: maxExpandedBytes }); }
  catch (_) { throw new Error('Invalid release archive or expanded size budget exceeded'); }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-artifact-scan-'));
  try {
    const snapshot = path.join(temporary, 'artifact.tar');
    fs.writeFileSync(snapshot, expanded, { mode: 0o600 });
    const tar = (args, strictNames = false) => {
      let output;
      try { output = childProcess.execFileSync('tar', args, { encoding: 'buffer', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, TAR_OPTIONS: '' }, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (_) { throw new Error('Unable to inspect or extract release archive with tar'); }
      // Verbose metadata can contain localized dates; only the separate name
      // listing is authoritative for paths and must be decoded without loss.
      if (!strictNames) return output.toString('utf8');
      try { return new TextDecoder('utf-8', { fatal: true }).decode(output); }
      catch (_) { throw new Error('Invalid release archive listing encoding'); }
    };
    const names = tar(['-tf', snapshot], true).trimEnd().split(/\r?\n/).filter(Boolean);
    const details = tar(['--numeric-owner', '-tvf', snapshot]).trimEnd().split(/\r?\n/).filter(Boolean);
    if (!names.length || names.length > maxMembers || details.length !== names.length) throw new Error('Invalid release archive member count');
    const seen = new Set();
    const regularNames = [];
    let totalSize = 0;
    for (let index = 0; index < names.length; index++) {
      const name = names[index];
      const normalized = name.replace(/\/$/, '');
      if (/[\x00-\x1f\x7f]/.test(name)) throw new Error('Unsafe release archive path');
      const collisionKey = normalized.normalize('NFC').toLowerCase();
      if (name.includes('\\') || (normalized !== 'package' && !normalized.startsWith('package/'))
        || normalized.split('/').some(part => !part || part === '.' || part === '..') || seen.has(collisionKey)) {
        throw new Error('Unsafe release archive path');
      }
      seen.add(collisionKey);
      const fields = details[index].trim().split(/\s+/);
      // GNU tar prints uid/gid together; bsdtar prints links, uid and gid separately.
      const size = Number(fields[1]?.includes('/') ? fields[2] : fields[4]);
      if (!['-', 'd'].includes(details[index][0]) || (normalized === 'package' && details[index][0] !== 'd')
        || !Number.isSafeInteger(size) || size < 0) {
        throw new Error('Unsafe release archive member type or size');
      }
      if (details[index][0] === '-') regularNames.push(name);
      totalSize += size;
      if (totalSize > maxExpandedBytes) throw new Error('Release archive exceeds member size budget');
    }
    const extracted = path.join(temporary, 'contents');
    fs.mkdirSync(extracted, { mode: 0o700 });
    tar(['--no-same-owner', '--no-same-permissions', '-xf', snapshot, '-C', extracted]);
    const findings = [];
    let filesScanned = 0;
    const fileIdentities = new Set();
    let totalRead = 0;
    for (const name of regularNames) {
      const file = path.join(extracted, name);
      const { stat, bytes } = readBoundedRegularFile(file, maxExpandedBytes - totalRead);
      totalRead += bytes.length;
      // Fail closed for additional aliases recognized by the extraction filesystem.
      const identity = `${stat.dev}:${stat.ino}`;
      if (fileIdentities.has(identity)) throw new Error('Aliased release archive members');
      fileIdentities.add(identity);
      const source = archiveText(bytes);
      if (source === null) continue;
      filesScanned++;
      findings.push(...scanText(source, name.slice('package/'.length)));
    }
    return { findings, filesScanned, sha256: crypto.createHash('sha256').update(compressed).digest('hex') };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--tarball')) throw new Error('Usage: scan-package-secrets.js [--tarball path.tgz]');
  const result = args.length ? scanTarball(path.resolve(args[1])) : null;
  const findings = result ? result.findings : scanFiles(PACKAGE_ROOT);
  if (findings.length > 0) {
    console.error('[secret-scan] Potential packaged secrets found:');
    for (const finding of findings) {
      console.error(`- ${finding.rule}: ${finding.file}:${finding.line}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`[secret-scan] OK (${result ? result.filesScanned : listTextFiles(PACKAGE_ROOT).length} text files scanned)`);
  if (result) console.log(`[secret-scan] artifact sha256=${result.sha256}`);
}

if (require.main === module) {
  try { main(); }
  catch (error) { console.error(`[secret-scan] ${error.message}`); process.exitCode = 1; }
}

module.exports = { listTextFiles, scanFiles, scanTarball };
