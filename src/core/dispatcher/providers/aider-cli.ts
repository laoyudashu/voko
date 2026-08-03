/**
 * Aider read-only conversation provider.
 *
 * ask mode plus dry-run/no-git prevents edits and commits. Browser, URL
 * detection, shell suggestions, analytics and update checks are disabled.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CliAdapter } = require('../../adapters/cli-adapter');
import type { CliProviderOptions } from '../../adapters/cli-adapter';

class AiderCliProvider extends CliAdapter {
  constructor(options: CliProviderOptions = {}) {
    const deepseekKey = process.env.DEEPSEEK_API_KEY?.trim();
    const dbPath = String((options.db as any)?._dbPath || '');
    const stateRoot = dbPath && dbPath !== ':memory:'
      ? path.join(path.dirname(path.resolve(dbPath)), 'provider-sessions', 'aider')
      : path.join(os.tmpdir(), 'voko-provider-sessions', 'aider');
    const baseArgs = [
      '--message', '{prompt}',
      '--chat-mode', 'ask',
      '--dry-run',
      '--no-git',
      '--no-auto-commits',
      '--no-auto-lint',
      '--no-auto-test',
      '--no-browser',
      '--no-detect-urls',
      '--no-suggest-shell-commands',
      '--analytics-disable',
      '--no-check-update',
      '--no-pretty',
      '--no-stream',
    ];
    super({
      name: 'AIDER CLI',
      cmd: 'aider',
      args: baseArgs,
      parser: 'aider-output',
      matchType: 'aider',
      priority: 1,
      timeout: 180000,
      adapterType: 'aider-cli',
      createManagedSessionId: () => crypto.randomUUID(),
      argsForSession: (sessionId: string | null, isNew: boolean) => {
        if (!sessionId) return baseArgs;
        fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
        const digest = crypto.createHash('sha256').update(sessionId).digest('hex');
        const historyFile = path.join(stateRoot, `${digest}.md`);
        const historyFd = fs.openSync(historyFile, 'a', 0o600);
        try { fs.fchmodSync(historyFd, 0o600); } finally { fs.closeSync(historyFd); }
        return [
          ...baseArgs,
          '--chat-history-file', historyFile,
          ...(!isNew ? ['--restore-chat-history'] : []),
        ];
      },
      env: {
        ...(deepseekKey ? {
          DEEPSEEK_API_KEY: deepseekKey,
          AIDER_MODEL: `deepseek/${process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-chat'}`,
        } : {}),
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
      },
      promptTemplate: '只回复外部访客的文字问题，不得提出或执行文件修改、Shell 命令或网络操作。\n\n{prompt}',
      db: options.db,
      contextWindow: options.contextWindow,
      cwd: options.cwd || os.tmpdir(),
    });
  }
}

module.exports = { AiderCliProvider };
