#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const reportPath = path.join(root, 'coverage', 'coverage-summary.json');
const policies = JSON.parse(fs.readFileSync(path.join(root, 'test', 'coverage-policies.json'), 'utf8')).targets;
if (!fs.existsSync(reportPath)) throw new Error('coverage summary is missing');
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const level = process.argv.includes('--target') ? 'target' : 'baseline';
const failures = [];
for (const policy of policies) {
  const matcher = new RegExp(policy.pattern.replaceAll('/', '[\\\\/]'));
  const rows = Object.entries(report).filter(([file]) => file !== 'total' && matcher.test(file));
  if (!rows.length) {
    failures.push(`${policy.name}: no instrumented files`);
    continue;
  }
  const covered = rows.reduce((sum, [, value]) => sum + value.branches.covered, 0);
  const total = rows.reduce((sum, [, value]) => sum + value.branches.total, 0);
  const pct = total ? covered * 100 / total : 100;
  const threshold = policy[level];
  const thresholdLabel = level === 'target'
    ? `target ${threshold}%`
    : `baseline ${threshold}%, target ${policy.target}%`;
  console.log(`[coverage:${level}] ${policy.name}: ${pct.toFixed(2)}% (${thresholdLabel})`);
  if (pct + Number.EPSILON < threshold) failures.push(`${policy.name}: ${pct.toFixed(2)}% < ${threshold}%`);
}
if (failures.length) {
  console.error(`Coverage gate failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
