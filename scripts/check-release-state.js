'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const mode = process.argv[2];
if (!['push', 'release', 'published'].includes(mode)) {
  console.error('Usage: node scripts/check-release-state.js <push|release|published>');
  process.exit(2);
}

function command(program, args, options = {}) {
  let executable = program;
  let commandArgs = args;
  if (program === 'npm') {
    const candidates = [
      process.env.npm_execpath,
      path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ].filter(Boolean);
    const npmCli = candidates.find((candidate) => fs.existsSync(candidate));
    if (!npmCli) {
      if (options.allowFailure) return null;
      fail('无法定位 npm CLI。');
    }
    executable = process.execPath;
    commandArgs = [npmCli, ...args];
  }
  const result = spawnSync(executable, commandArgs, {
    cwd: process.cwd(),
    encoding: 'utf8',
    ...options,
  });
  if (result.error || result.status !== 0) {
    if (options.allowFailure) return null;
    console.error(`[release-state] 命令失败：${program} ${args.join(' ')}`);
    process.exit(1);
  }
  return result.stdout.trim();
}

function fail(message) {
  console.error(`[release-state] ${message}`);
  process.exit(1);
}

const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const packageLock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
const version = packageJson.version;
const tag = `v${version}`;

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) fail(`版本号不是有效的 SemVer：${version}`);
if (packageLock.version !== version || packageLock.packages?.['']?.version !== version) {
  fail(`package.json 与 package-lock.json 的版本不一致（期望 ${version}）`);
}

if (mode !== 'published') {
  const status = command('git', ['status', '--porcelain']);
  if (status) fail('工作区不干净；请先审查并提交所有预期改动。');
  const branch = command('git', ['branch', '--show-current']);
  if (branch !== 'main') fail(`必须从 main 执行，当前分支为 ${branch || '(detached HEAD)'}`);
  const remoteMain = command('git', ['rev-parse', '--verify', '--quiet', 'refs/remotes/github/main'], { allowFailure: true });
  if (!remoteMain) fail('缺少 github/main 远端引用；请先执行 git fetch github main --tags。');
  if (command('git', ['merge-base', '--is-ancestor', 'refs/remotes/github/main', 'HEAD'], { allowFailure: true }) === null) {
    fail('当前 main 落后于或已偏离 github/main；请先同步并处理分支差异。');
  }
  if (mode === 'release' && command('git', ['rev-parse', 'HEAD']) !== remoteMain) {
    fail('发布提交尚未与 github/main 完全一致；请先推送并等待 GitHub 门禁通过。');
  }
}

if (mode === 'release') {
  if (command('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`], { allowFailure: true })) {
    fail(`本地 Tag ${tag} 已存在。`);
  }
  const published = command('npm', ['view', `${packageJson.name}@${version}`, 'version', '--registry=https://registry.npmjs.org/'], { allowFailure: true });
  if (published === version) fail(`npm 版本 ${packageJson.name}@${version} 已存在且不可覆盖。`);
}

if (mode === 'published') {
  const published = command('npm', ['view', `${packageJson.name}@${version}`, 'version', '--registry=https://registry.npmjs.org/'], { allowFailure: true });
  if (published !== version) fail(`npm 尚未查询到 ${packageJson.name}@${version}。`);
  if (!command('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`], { allowFailure: true })) {
    fail(`本地缺少 Tag ${tag}。`);
  }
}

console.log(`[release-state] ${mode} 状态检查通过：${packageJson.name}@${version}`);
