'use strict';

const { spawnSync } = require('node:child_process');

const locator = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['gitleaks'], {
  encoding: 'utf8',
});
if (locator.status !== 0) {
  console.error('[security:gitleaks] 未找到 Gitleaks。请安装后确保 gitleaks 在 PATH 中。');
  process.exit(1);
}

const result = spawnSync('gitleaks', ['git', '--redact', '--verbose'], {
  cwd: process.cwd(),
  encoding: 'utf8',
  stdio: 'inherit',
});

if (result.error) {
  console.error(`[security:gitleaks] 启动失败：${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
