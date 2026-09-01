/**
 * Reasonix CLI provider.
 *
 * Current Reasonix versions require a positional task argument. VOKO uses the
 * CliAdapter prompt placeholder so the sanitized visitor prompt occupies that
 * argument instead of being sent only through stdin (which exits with usage 2
 * on Reasonix 1.27).
 *
 * `dontAsk` is the unattended permission mode: read-only inspection remains
 * available, while writes and dynamic shell commands are denied instead of
 * waiting for an interactive approval. The prompt template adds a second,
 * model-level boundary for visitor messages.
 */

const os = require('os');
const { CliAdapter } = require('../../adapters/cli-adapter');
import type { CliProviderOptions } from '../../adapters/cli-adapter';

const BASE_ARGS = ['run', '--output-format', 'stream-json', '--permission-mode', 'dontAsk'];

class ReasonixCliProvider extends CliAdapter {
  constructor(options: CliProviderOptions = {}) {
    super({
      name: 'REASONIX CLI',
      cmd: 'reasonix',
      args: [...BASE_ARGS, '{prompt}'],
      adapterType: 'reasonix-cli',
      argsForSession: (sessionId: string | null) => [
        ...BASE_ARGS,
        ...(sessionId ? ['--resume', sessionId] : []),
        '{prompt}',
      ],
      sessionIdFromLine: (line: string) => {
        try {
          const event = JSON.parse(line);
          return String(event.session_id || event.sessionId || '').trim() || null;
        } catch (_) { return null; }
      },
      parser: 'reasonix-stream-json',
      matchType: 'reasonix',
      priority: 1,
      timeout: 300000,
      promptTemplate: '仅进行文本回答，不得调用工具、读取或修改文件、执行命令或访问网络。\n\n{prompt}',
      db: options.db,
      contextWindow: options.contextWindow,
      cwd: options.cwd || os.tmpdir(),
    });
  }
}

module.exports = { ReasonixCliProvider };
