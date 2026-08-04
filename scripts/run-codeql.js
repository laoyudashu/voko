'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = process.cwd();
const database = path.join(root, '.codeql-db', 'javascript-typescript');
const resultsDir = path.join(root, '.codeql-results');
const sarifFile = path.join(resultsDir, 'javascript-typescript.sarif');
const allowlistFile = path.join(root, '.github', 'codeql-allowlist.json');

function findCodeql() {
  const locator = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['codeql'], {
    encoding: 'utf8',
  });
  if (locator.status === 0) return 'codeql';
  if (process.platform === 'win32') {
    const userProfile = process.env.USERPROFILE || '';
    const candidates = [
      path.join(userProfile, '.local', 'share', 'codeql', 'codeql.exe'),
      path.join(userProfile, '.local', 'bin', 'codeql.exe'),
    ];
    const installed = candidates.find((candidate) => fs.existsSync(candidate));
    if (installed) return installed;
  }
  return null;
}

const codeqlCommand = findCodeql();
if (!codeqlCommand) {
  console.error('[security:codeql] 未找到 CodeQL CLI。请手动安装并确保 codeql 在 PATH 中。');
  process.exit(1);
}

function run(args) {
  const result = spawnSync(codeqlCommand, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: 'inherit',
  });

  if (result.error) {
    console.error(`[security:codeql] 启动失败：${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

fs.mkdirSync(resultsDir, { recursive: true });
fs.mkdirSync(path.dirname(database), { recursive: true });

run([
  'database', 'create', database,
  '--language=javascript-typescript',
  '--build-mode=none',
  `--source-root=${root}`,
  `--codescanning-config=${path.join(root, '.github', 'codeql-config.yml')}`,
  '--overwrite',
]);

run([
  'database', 'analyze', database,
  'codeql/javascript-queries:codeql-suites/javascript-security-extended.qls',
  '--format=sarif-latest',
  `--output=${sarifFile}`,
  '--threads=0',
]);

const sarif = JSON.parse(fs.readFileSync(sarifFile, 'utf8'));
const allowlist = JSON.parse(fs.readFileSync(allowlistFile, 'utf8'));
const allowedByFingerprint = new Map();
for (const entry of allowlist.entries ?? []) {
  if (!entry.ruleId || !entry.file || !entry.fingerprint || !entry.reason) {
    console.error('[security:codeql] allowlist 条目缺少 ruleId、file、fingerprint 或 reason。');
    process.exit(1);
  }
  allowedByFingerprint.set(`${entry.ruleId}\0${entry.file}\0${entry.fingerprint}`, entry);
}
const severe = [];
const usedAllowlist = new Set();
for (const runResult of sarif.runs ?? []) {
  const rules = new Map((runResult.tool?.driver?.rules ?? []).map((rule) => [rule.id, rule]));
  for (const finding of runResult.results ?? []) {
    const rule = rules.get(finding.ruleId);
    const score = Number(rule?.properties?.['security-severity'] ?? 0);
    if (score >= 7) {
      const location = finding.locations?.[0]?.physicalLocation;
      const file = location?.artifactLocation?.uri ?? '?';
      const lineHash = finding.partialFingerprints?.primaryLocationLineHash;
      const column = finding.partialFingerprints?.primaryLocationStartColumnFingerprint;
      const fingerprint = lineHash && column ? `${lineHash}@${column}` : '';
      const allowlistKey = `${finding.ruleId}\0${file}\0${fingerprint}`;
      if (allowedByFingerprint.has(allowlistKey)) {
        usedAllowlist.add(allowlistKey);
        continue;
      }
      severe.push({
        ruleId: finding.ruleId,
        score,
        file,
        line: location?.region?.startLine ?? '?',
      });
    }
  }
}

const staleAllowlist = [...allowedByFingerprint.keys()].filter((key) => !usedAllowlist.has(key));
if (staleAllowlist.length > 0) {
  console.error('[security:codeql] allowlist 中存在已失效的精确指纹，请复核并更新或删除：');
  for (const key of staleAllowlist) {
    const entry = allowedByFingerprint.get(key);
    console.error(`- ${entry.ruleId} ${entry.file}: ${entry.reason}`);
  }
  process.exit(1);
}

if (severe.length > 0) {
  console.error(`[security:codeql] 发现 ${severe.length} 个 high/critical 结果，详见 ${sarifFile}`);
  for (const finding of severe) {
    console.error(`- ${finding.ruleId} (${finding.score}) ${finding.file}:${finding.line}`);
  }
  process.exit(1);
}

console.log(`[security:codeql] 未发现 high/critical 结果。SARIF：${sarifFile}`);
