#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

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

function scanFiles(root, targets = DEFAULT_TARGETS) {
  const findings = [];
  for (const file of listTextFiles(root, targets)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const rule of RULES) {
      rule.pattern.lastIndex = 0;
      let match;
      while ((match = rule.pattern.exec(source))) {
        findings.push({
          rule: rule.name,
          file: path.relative(root, file),
          line: lineNumber(source, match.index),
        });
        if (match[0].length === 0) rule.pattern.lastIndex++;
      }
    }
  }
  return findings;
}

function main() {
  const findings = scanFiles(PACKAGE_ROOT);
  if (findings.length > 0) {
    console.error('[secret-scan] Potential packaged secrets found:');
    for (const finding of findings) {
      console.error(`- ${finding.rule}: ${finding.file}:${finding.line}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`[secret-scan] OK (${listTextFiles(PACKAGE_ROOT).length} files scanned)`);
}

if (require.main === module) main();

module.exports = { listTextFiles, scanFiles };
