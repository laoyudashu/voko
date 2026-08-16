/**
 * cursor-cli.js — Cursor Agent CLI Provider
 *
 * 通过 cursor-agent --print 非交互模式发送消息，解析 stream-json 回复。
 *
 * backend_type: 'cursor'
 *
 * Cursor Agent CLI 参考（Paperclip cursor-local）：
 *   agent -p / --print                 — 非交互模式（prompt 经 stdin 传入）
 *   agent --output-format stream-json  — Anthropic 兼容流式 JSON
 *   agent --trust                      — 非交互信任 workspace（勿用 --yolo，会放开写/执行）
 *   agent --workspace <dir>            — 工作目录
 *
 * 认证：本机 `agent login` 即可；无登录态时也可设环境变量 CURSOR_API_KEY。
 *
 * 注意：Cursor 底层使用 Anthropic 模型，stream-json 格式与 Claude CLI 兼容。
 *       stdout 可能带 "stdout:" 前缀，cursor-stream-json 解析器自动剥离。
 */

const os = require('os');
const { CliAdapter } = require('../../adapters/cli-adapter');
const { resolveCursorRuntime } = require('../cursor-command');
import type { CliProviderOptions } from '../../adapters/cli-adapter';

class CursorCliProvider extends CliAdapter {
  constructor(options: CliProviderOptions = {}) {
    const runtime = resolveCursorRuntime();
    const baseArgs = [...runtime.prefixArgs, '-p', '--output-format', 'stream-json', '--mode', 'plan', '--trust', '--workspace', '.'];
    super({
      name: 'CURSOR CLI',
      cmd: runtime.command,
      // --mode plan：只读；--trust：Lite 无 TTY，跳过 Workspace Trust 交互提示
      args: baseArgs,
      adapterType: 'cursor-cli',
      argsForSession: (sessionId: string | null) => [
        ...baseArgs,
        ...(sessionId ? ['--resume', sessionId] : []),
      ],
      sessionIdFromLine: (line: string) => {
        try {
          const event = JSON.parse(line.replace(/^(?:stdout|stderr):/, ''));
          return String(event.session_id || event.sessionId || '').trim() || null;
        } catch (_) { return null; }
      },
      parser: 'cursor-stream-json',   // stream-json + stdout: 前缀剥离
      matchType: 'cursor',
      priority: 1,
      timeout: 300000,
      db: options.db,
      sessionPersistence: options.sessionPersistence,
      contextWindow: options.contextWindow,
      cwd: options.cwd || os.tmpdir(),
    });
  }
}

module.exports = { CursorCliProvider };
