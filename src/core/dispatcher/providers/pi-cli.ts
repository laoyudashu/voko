/**
 * pi-cli.js — Pi Coding Agent CLI Provider
 *
 * 通过 pi -p --mode json 非交互模式发送消息，解析 JSONL 回复。
 *
 * backend_type: 'pi'
 *
 * Pi Coding Agent 参考 (@mariozechner/pi-coding-agent)：
 *   pi -p "prompt"             — 非交互执行
 *   pi --mode json             — JSONL 输出（每行一个 JSON 事件）
 *   pi --tools <list>          — 启用的工具集
 *   pi --provider <name>       — 模型提供商
 *   pi --model <id>            — 模型 ID
 *   pi --session <path>        — 会话持久化
 *
 * 安装：npm i -g @mariozechner/pi-coding-agent
 *
 * 输出格式（JSONL 事件）：
 *   message_update  → assistantMessageEvent.delta（流式文本增量）
 *   turn_end        → message.content（完整回复）
 *   agent_end       → messages[last].content（最终消息）
 */

const os = require('os');
const { CliAdapter } = require('../../adapters/cli-adapter');
import type { CliProviderOptions } from '../../adapters/cli-adapter';

class PiCliProvider extends CliAdapter {
  constructor(options: CliProviderOptions = {}) {
    const deepseekKey = process.env.DEEPSEEK_API_KEY?.trim();
    const deepseekModel = process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-chat';
    const modelArgs = deepseekKey
      ? ['--provider', 'deepseek', '--model', deepseekModel]
      : [];
    super({
      name: 'PI CLI',
      cmd: 'pi',
      // --tools read,grep,find,ls：仅只读工具，无 bash/edit/write（禁止命令执行和文件修改）
      // 不含 {prompt} 占位 → CliAdapter 自动走 stdin 传 prompt，与 claude-cli 对齐
      args: [...modelArgs, '-p', '--mode', 'json', '--tools', 'read,grep,find,ls'],
      parser: 'pi-jsonl',       // Pi JSONL 格式：message_update / turn_end / agent_end
      matchType: 'pi',
      priority: 1,
      timeout: 300000,
      db: options.db,
      contextWindow: options.contextWindow,
      cwd: options.cwd || os.tmpdir(),
    });
  }
}

module.exports = { PiCliProvider };
