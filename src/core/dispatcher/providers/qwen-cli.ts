/**
 * Qwen Code headless provider.
 *
 * safe-mode removes local customizations and plan mode prevents writes/commands.
 * Tool, turn and wall-clock budgets provide a second boundary for unattended input.
 */
const os = require('os');
const { CliAdapter } = require('../../adapters/cli-adapter');
import type { CliProviderOptions } from '../../adapters/cli-adapter';

class QwenCliProvider extends CliAdapter {
  constructor(options: CliProviderOptions = {}) {
    super({
      name: 'QWEN CODE CLI',
      cmd: 'qwen',
      args: [
        '--safe-mode',
        '--approval-mode', 'plan',
        '--exclude-tools', 'shell,write_file,replace,edit,agent',
        '--max-tool-calls', '0',
        '--max-session-turns', '4',
        '--max-wall-time', '120s',
        '--output-format', 'stream-json',
      ],
      parser: 'gemini-stream-json',
      matchType: 'qwen-code',
      priority: 1,
      timeout: 150000,
      env: { QWEN_CODE_SAFE_MODE: 'true', NO_COLOR: '1' },
      promptTemplate: '只进行文字对话，不得调用工具、访问文件、执行命令或修改系统。\n\n{prompt}',
      db: options.db,
      contextWindow: options.contextWindow,
      cwd: options.cwd || os.tmpdir(),
    });
  }
}

module.exports = { QwenCliProvider };
