/**
 * Aider read-only conversation provider.
 *
 * ask mode plus dry-run/no-git prevents edits and commits. Browser, URL
 * detection, shell suggestions, analytics and update checks are disabled.
 */
const os = require('os');
const { CliAdapter } = require('../../adapters/cli-adapter');
import type { CliProviderOptions } from '../../adapters/cli-adapter';

class AiderCliProvider extends CliAdapter {
  constructor(options: CliProviderOptions = {}) {
    const deepseekKey = process.env.DEEPSEEK_API_KEY?.trim();
    super({
      name: 'AIDER CLI',
      cmd: 'aider',
      args: [
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
      ],
      parser: 'aider-output',
      matchType: 'aider',
      priority: 1,
      timeout: 180000,
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
