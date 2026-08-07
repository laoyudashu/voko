/**
 * claude-cli.js — Claude CLI Provider
 *
 * 通过 claude -p CLI（stdin 传入 prompt）+ stream-json 解析回复。
 * ACP 不可用时的兜底方案。
 *
 * backend_type: 'claude-code'
 * priority: 1（低于 ACP）
 *
 * 设计要点：
 * - prompt 经 stdin 传入（非命令行参数），避开 Windows cmd.exe 对含换行
 *   多行参数的破坏；
 * - cwd 设到系统临时目录，避免 claude 加载项目 CLUDE.md 而角色错乱。
 */

const os = require('os');
const crypto = require('crypto');
const { CliAdapter } = require('../../adapters/cli-adapter');
import type { CliProviderOptions } from '../../adapters/cli-adapter';

class ClaudeCliProvider extends CliAdapter {
  constructor(options: CliProviderOptions = {}) {
    super({
      name: 'CLAUDE CLI',
      cmd: 'claude',
      // 不含 {prompt} 占位 → CliAdapter 自动改走 stdin 传 prompt
      args: [
        '-p',
        '--output-format', 'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--bare',
        '--safe-mode',
        '--tools=',
        '--strict-mcp-config',
        '--no-chrome',
        '--disable-slash-commands',
        '--permission-mode', 'plan',
      ],
      adapterType: 'claude-cli',
      createManagedSessionId: () => crypto.randomUUID(),
      argsForSession: (sessionId: string | null, isNew: boolean) => [
        '-p',
        '--output-format', 'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--bare',
        '--safe-mode',
        '--tools=',
        '--strict-mcp-config',
        '--no-chrome',
        '--disable-slash-commands',
        ...(sessionId ? (isNew ? ['--session-id', sessionId] : ['--resume', sessionId]) : []),
        '--permission-mode', 'plan',
      ],
      sessionIdFromLine: (line: string) => {
        try {
          const event = JSON.parse(line);
          return String(event.session_id || event.sessionId || '').trim() || null;
        } catch (_) { return null; }
      },
      parser: 'stream-json',
      matchType: 'claude-code',
      priority: 1,
      timeout: 180000,
      db: options.db,
      contextWindow: options.contextWindow,
      cwd: options.cwd || os.tmpdir(),
    });
  }

  /**
   * Dispatcher 默认用 provider key 推导 family（claude-cli → claude），
   * 但 Claude 的真实 backend_type 是 claude-code。显式声明兼容性，
   * 让已保存的 Claude 原生 session 在后续消息中继续走 --resume。
   */
  acceptsBinding(binding: any): boolean {
    return binding?.providerType === 'claude-code'
      && binding.adapterType === 'claude-cli'
      && binding.deliveryMode === 'cli'
      && typeof binding.nativeSessionId === 'string'
      && binding.nativeSessionId.length > 0;
  }
}

module.exports = { ClaudeCliProvider };
