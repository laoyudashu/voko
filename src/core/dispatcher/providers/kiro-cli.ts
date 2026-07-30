/**
 * Kiro CLI headless provider.
 *
 * No tool category is trusted for unattended visitor input. The process runs
 * outside the user's project directory and tool requests cannot be approved.
 */
const os = require('os');
const { CliAdapter } = require('../../adapters/cli-adapter');
import type { CliProviderOptions } from '../../adapters/cli-adapter';

class KiroCliProvider extends CliAdapter {
  constructor(options: CliProviderOptions = {}) {
    super({
      name: 'KIRO CLI',
      cmd: 'kiro-cli',
      args: ['chat', '--no-interactive', '{prompt}'],
      parser: 'raw',
      matchType: 'kiro',
      priority: 1,
      timeout: 180000,
      promptTemplate: '这是来自外部访客的文字消息。只能回复文字，不得写文件、执行命令或调用 MCP。\n\n{prompt}',
      db: options.db,
      contextWindow: options.contextWindow,
      cwd: options.cwd || os.tmpdir(),
    });
  }
}

module.exports = { KiroCliProvider };
