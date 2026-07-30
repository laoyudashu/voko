/**
 * grok-cli.js — xAI Grok CLI Provider
 *
 * 通过 grok --single 非交互模式发送消息，解析 streaming-json 回复。
 *
 * backend_type: 'grok'
 *
 * Grok CLI 参考（Paperclip grok-local）：
 *   grok --output-format streaming-json  — 流式 JSONL 输出
 *   grok --single <prompt>                — 非交互 prompt
 *   grok --always-approve                 — 自动批准工具调用
 *
 * 输出格式（JSONL 事件，参考 Paperclip grok-local parse.ts）：
 *   {"type":"text","data":"流式文本块"}
 *   {"type":"thought","data":"思考内容"}
 *   {"type":"end","sessionId":"...","stopReason":"..."}
 */

const os = require('os');
const { CliAdapter } = require('../../adapters/cli-adapter');
import type { CliProviderOptions } from '../../adapters/cli-adapter';

class GrokCliProvider extends CliAdapter {
  constructor(options: CliProviderOptions = {}) {
    super({
      name: 'GROK CLI',
      cmd: 'grok',
      // --disable-web-search：禁用内置 Web 搜索；--max-turns 10：限制工具调用轮数
      args: ['--output-format', 'streaming-json', '--always-approve', '--disable-web-search', '--max-turns', '10', '--single', '{prompt}'],
      parser: 'grok-stream-json',
      matchType: 'grok',
      priority: 1,
      timeout: 300000,
      db: options.db,
      contextWindow: options.contextWindow,
      cwd: options.cwd || os.tmpdir(),
    });
  }
}

module.exports = { GrokCliProvider };
