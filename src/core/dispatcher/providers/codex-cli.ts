/**
 * codex-cli.js — OpenAI Codex CLI Provider
 *
 * 通过 codex exec 非交互模式发送消息，解析 NDJSON 流式回复。
 *
 * backend_type: 'codex'
 *
 * Codex CLI 参考（Paperclip codex-local）：
 *   codex exec --json                  — NDJSON 事件流
 *   codex exec --dangerously-bypass-approvals-and-sandbox  — 自动批准
 *   末尾的 - 表示从 stdin 读取 prompt
 *
 * 输出格式（NDJSON ThreadEvent）：
 *   {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
 */

const os = require('os');
const { CliAdapter } = require('../../adapters/cli-adapter');
import type { CliProviderOptions } from '../../adapters/cli-adapter';

class CodexCliProvider extends CliAdapter {
  constructor(options: CliProviderOptions = {}) {
    super({
      name: 'CODEX CLI',
      cmd: 'codex',
      // --sandbox read-only：禁止写操作和命令执行（含 curl），仅允许读文件
      args: ['exec', '--json', '--sandbox', 'read-only', '-'],
      parser: 'codex-jsonl',
      matchType: 'codex',
      priority: 1,
      timeout: 300000,
      db: options.db,
      contextWindow: options.contextWindow,
      cwd: options.cwd || os.tmpdir(),
    });
  }
}

module.exports = { CodexCliProvider };
