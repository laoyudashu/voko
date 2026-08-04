/**
 * Cline CLI provider.
 *
 * Visitor messages run in Cline plan mode with tool approval disabled. The
 * command-permission policy denies shell execution as an additional boundary;
 * VOKO only forwards the model's textual plan/reply.
 */
const os = require('os');
const { CliAdapter } = require('../../adapters/cli-adapter');
import type { CliProviderOptions } from '../../adapters/cli-adapter';

class ClineCliProvider extends CliAdapter {
  constructor(options: CliProviderOptions = {}) {
    super({
      name: 'CLINE CLI',
      cmd: 'cline',
      runtimeRequest: {
        providerId: 'cline-cli',
        mode: 'cli',
        candidates: process.platform === 'win32'
          ? [{ kind: 'node-package-bin', command: 'cline', packageName: 'cline' }, { kind: 'native', command: 'cline' }]
          : [{ kind: 'native', command: 'cline' }, { kind: 'node-package-bin', command: 'cline', packageName: 'cline' }],
      },
      args: [
        '--plan',
        '--json',
        '--auto-approve', 'false',
        '--timeout', '150',
        '{prompt}',
      ],
      parser: 'cline-jsonl',
      matchType: 'cline',
      priority: 1,
      timeout: 180000,
      adapterType: 'cline-cli',
      env: {
        CLINE_COMMAND_PERMISSIONS: JSON.stringify({
          allow: [],
          deny: ['*'],
          allowRedirects: false,
        }),
      },
      promptTemplate: '这是来自外部访客的文本消息。仅返回安全的文字答复或计划，不得修改文件、执行命令、调用工具或访问外部系统。\n\n{prompt}',
      db: options.db,
      contextWindow: options.contextWindow,
      cwd: options.cwd || os.tmpdir(),
    });
  }
}

module.exports = { ClineCliProvider };
