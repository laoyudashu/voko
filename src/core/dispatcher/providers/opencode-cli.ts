/**
 * opencode-cli.js — OpenCode CLI Provider
 *
 * 通过 opencode run 非交互模式发送消息，解析 JSON 回复。
 *
 * backend_type: 'opencode'
 *
 * OpenCode CLI 参考（Paperclip opencode-local）：
 *   opencode run --format json  — NDJSON 事件流（prompt 经 stdin 传入）
 *   opencode run --print-logs   — 打印日志（调试用，通过环境变量控制）
 *
 * 输出格式（JSONL 事件，参考 Paperclip opencode-local parse.ts）：
 *   {"type":"text","part":{"text":"流式文本块"}}
 *   {"type":"step_finish","part":{"tokens":{...}}}
 *   {"type":"error","error":"..."}
 *
 * 支持 75+ LLM provider（通过 -m 切换模型）。
 */

const os = require('os');
const { CliAdapter } = require('../../adapters/cli-adapter');
const {
  buildOpenCodeVisitorContent,
  isolatedOpenCodeEnv,
  resolveOpenCodeCommand,
} = require('./opencode-runtime');
import type { CliProviderOptions } from '../../adapters/cli-adapter';
import type { PushPayload } from '../types';

class OpenCodeCliProvider extends CliAdapter {
  constructor(options: CliProviderOptions = {}) {
    super({
      name: 'OPENCODE CLI',
      cmd: resolveOpenCodeCommand(),
      // prompt 经 stdin 传入（Paperclip 一致）
      args: ['run', '--format', 'json', '{prompt}'],
      parser: 'opencode-json',    // text 事件 → part.text
      matchType: 'opencode',
      priority: 1,
      timeout: 300000,
      env: isolatedOpenCodeEnv(),
      db: options.db,
      contextWindow: options.contextWindow,
      cwd: options.cwd || os.tmpdir(),
    });
  }

  async push(payload: PushPayload): Promise<void> {
    return super.push({
      ...payload,
      content: buildOpenCodeVisitorContent(payload.agentId, payload.fromUid, payload.content),
    });
  }
}

module.exports = { OpenCodeCliProvider };
