/**
 * gemini-cli.js — Google Gemini CLI Provider
 *
 * 通过 gemini --prompt 非交互模式发送消息，解析 stream-json 回复。
 *
 * backend_type: 'gemini'
 *
 * Gemini CLI 参考（Paperclip gemini-local）：
 *   gemini --output-format stream-json  — 流式 JSONL 输出
 *   gemini --approval-mode yolo          — 自动批准工具调用
 *   gemini --prompt <text>               — 非交互 prompt（命令行参数传入）
 *
 * 输出格式（JSONL 事件）：
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
 *   {"type":"message","role":"assistant","content":"..."}
 *   {"type":"result","stats":{...}}
 */

const os = require('os');
const { execFileSync } = require('child_process');
const { CliAdapter } = require('../../adapters/cli-adapter');
import type { CliProviderOptions } from '../../adapters/cli-adapter';

let sandboxAvailable: boolean | null = null;

function isGeminiSandboxAvailable(): boolean {
  if (sandboxAvailable !== null) return sandboxAvailable;
  try {
    execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
      stdio: 'ignore', windowsHide: true, timeout: 5000,
    });
    sandboxAvailable = true;
  } catch (_) {
    sandboxAvailable = false;
  }
  return sandboxAvailable;
}

class GeminiCliProvider extends CliAdapter {
  constructor(options: CliProviderOptions = {}) {
    super({
      name: 'GEMINI CLI',
      cmd: 'gemini',
      // prompt 经命令行参数传入（--prompt），与 Paperclip 一致
      args: ['--output-format', 'stream-json', '--approval-mode', 'yolo', '--skip-trust', '--prompt', '{prompt}'],
      parser: 'gemini-stream-json',
      matchType: 'gemini',
      priority: 1,
      timeout: 300000,
      env: { GEMINI_SANDBOX: 'docker' },   // Docker 容器隔离（宿主机文件系统不可见）
      db: options.db,
      contextWindow: options.contextWindow,
      cwd: options.cwd || os.tmpdir(),
    });
  }

  isAvailable(agentId: string): boolean {
    return super.isAvailable(agentId) && isGeminiSandboxAvailable();
  }
}

module.exports = { GeminiCliProvider, isGeminiSandboxAvailable };
