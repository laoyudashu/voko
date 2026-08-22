'use strict';

const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { arch, homedir, platform } = require('node:os');
const { join } = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { parseDuration, validateStabilitySummary } = require('./e2ee-stability-policy');

const executable = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
const localCargo = join(homedir(), '.cargo', 'bin', executable);
const cargo = existsSync(localCargo) ? localCargo : executable;
const root = join(__dirname, '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const requestedArgs = process.argv.slice(2);
const allowDirty = requestedArgs.includes('--allow-dirty');
const dirtyBefore = !!git('status', '--porcelain');
const testedCommit = git('rev-parse', 'HEAD');
const forwarded = requestedArgs.filter((value) => value !== '--allow-dirty');
if (!forwarded.some((value) => value.startsWith('--duration='))) forwarded.push('--duration=30m');
if (!forwarded.some((value) => value.startsWith('--output='))) forwarded.push('--output=e2ee-stability-summary.json');
const requestedDurationMs = parseDuration(forwarded.find((value) => value.startsWith('--duration=')).slice('--duration='.length));
if (dirtyBefore && !allowDirty) {
  throw new Error('E2EE release evidence requires a clean worktree; use --allow-dirty only for diagnostic evidence');
}
const result = spawnSync(cargo, [
  'run', '--release', '--locked', '--manifest-path', join('e2ee', 'Cargo.toml'),
  '--bin', 'voko-e2ee-stability', '--', ...forwarded,
], { cwd: root, env: process.env, stdio: 'inherit', shell: false, windowsHide: true });
if (result.error) throw result.error;
if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
const duration = forwarded.find((value) => value.startsWith('--duration=')).slice('--duration='.length);
const output = forwarded.find((value) => value.startsWith('--output=')).slice('--output='.length);
if (!allowDirty && git('status', '--porcelain')) throw new Error('Worktree changed during E2EE stability run');
if (git('rev-parse', 'HEAD') !== testedCommit) throw new Error('HEAD changed during E2EE stability run');
const outputFile = join(root, output);
const summary = {
  ...JSON.parse(readFileSync(outputFile, 'utf8')),
  commit: testedCommit,
  platform: platform(),
  arch: arch(),
  diagnosticOnly: allowDirty,
  worktreeDirty: dirtyBefore,
};
writeFileSync(outputFile, `${JSON.stringify(summary, null, 2)}\n`);
validateStabilitySummary(summary, parseDuration(duration));
console.log('E2EE stability policy gate passed.');
