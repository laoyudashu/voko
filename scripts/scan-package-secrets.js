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

/** Scan the bytes of the already-created npm artifact, never the mutable build tree.
 * Requires the system tar utility (available on the release Ubuntu runner).
 * Only regular files/directories under package/ are accepted for extraction. */
function scanTarball(archivePath, { maxMembers = 10000, maxExpandedBytes = 256 * 1024 * 1024 } = {}) {
  const maxArchiveBytes = 64 * 1024 * 1024;
  if (!Number.isSafeInteger(maxMembers) || maxMembers < 1
    || !Number.isSafeInteger(maxExpandedBytes) || maxExpandedBytes < 1) throw new Error('Invalid archive scan budget');
  if (fs.statSync(archivePath).size > maxArchiveBytes) throw new Error('Release archive exceeds compressed size budget');
  const compressed = fs.readFileSync(archivePath);
  if (compressed.length > maxArchiveBytes) throw new Error('Release archive exceeds compressed size budget');
  let expanded;
  try { expanded = zlib.gunzipSync(compressed, { maxOutputLength: maxExpandedBytes }); }
  catch (_) { throw new Error('Invalid release archive or expanded size budget exceeded'); }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-artifact-scan-'));
  try {
    const snapshot = path.join(temporary, 'artifact.tar');
    fs.writeFileSync(snapshot, expanded, { mode: 0o600 });
    const tar = (args) => {
      try { return childProcess.execFileSync('tar', args, { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, TAR_OPTIONS: '' }, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (_) { throw new Error('Unable to inspect or extract release archive with tar'); }
    };
    const names = tar(['-tf', snapshot]).trimEnd().split('\n').filter(Boolean);
    const details = tar(['--numeric-owner', '-tvf', snapshot]).trimEnd().split('\n').filter(Boolean);
    if (!names.length || names.length > maxMembers || details.length !== names.length) throw new Error('Invalid release archive member count');
    const seen = new Set();
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
      totalSize += size;
      if (totalSize > maxExpandedBytes) throw new Error('Release archive exceeds member size budget');
    }
    const extracted = path.join(temporary, 'contents');
    fs.mkdirSync(extracted, { mode: 0o700 });
    tar(['--no-same-owner', '--no-same-permissions', '-xf', snapshot, '-C', extracted]);
    const findings = [];
    let filesScanned = 0;
    const fileIdentities = new Set();
    for (const name of names) {
      const file = path.join(extracted, name);
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) continue;
      if (!stat.isFile() || stat.size > maxExpandedBytes) throw new Error('Unsafe extracted release archive member');
      // Fail closed for additional aliases recognized by the extraction filesystem.
      const identity = `${stat.dev}:${stat.ino}`;
      if (fileIdentities.has(identity)) throw new Error('Aliased release archive members');
      fileIdentities.add(identity);
      const source = archiveText(fs.readFileSync(file));
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
