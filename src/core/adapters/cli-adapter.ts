/**
 * cli-adapter.js — 通用 CLI stdout PushProvider
 *
 * 基于 cli-spawner + cli-parsers 的 PushProvider，支持多种 CLI 输出格式。
 * 适用于「不支持 ACP 但可通过 stdout 回复」的 agent。
 *
 * 与 openclaw-cli/hermes-cli（fire-and-forget 通知模式）不同，
 * 本 adapter 关注「spawn → stdout 解析 → emit agent.reply」完整链路。
 *
 * 用法（在 index.js 注册时）：
 *   providers['cli-claude'] = new CliAdapter({
 *     name: 'claude',
 *     cmd: 'claude',
 *     args: ['-p', '{prompt}', '--output-format', 'stream-json', '--include-partial-messages'],
 *     parser: 'stream-json',
 *     matchType: 'cli-claude',
 *   });
 *
 * {prompt} 占位符在 push 时替换为实际访客消息。
 */

const { PushProvider } = require('../dispatcher/base-provider');
const { runCli, checkCliAvailable, killTree, sanitizeCmdArg } = require('./cli-spawner');
const { createParser } = require('./cli-parsers');
import type { DatabaseLike } from '../../types/database';
import type { AgentMeta, PushPayload } from '../dispatcher/types';

export interface CliAdapterOptions {
  name: string;
  cmd: string;
  args?: string[];
  parser?: string;
  parserOpts?: Record<string, unknown>;
  matchType: string;
  priority?: number;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
  promptTemplate?: string;
  contextWindow?: number;
  db?: Pick<DatabaseLike, 'prepare'> | null;
  cwd?: string;
}

export type CliProviderOptions = Pick<CliAdapterOptions, 'contextWindow' | 'db' | 'cwd'>;

interface ContextMessage {
  content: string;
  is_me: number;
  timestamp: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const MAX_REPLY_CHARS = 2 * 1024 * 1024; // 单次回复字符上限，防 agent 输出失控撑爆内存

class CliAdapter extends PushProvider {
  /**
   * @param {object}   opts
   * @param {string}   opts.name            - 显示名（用于日志）
   * @param {string}   opts.cmd             - CLI 命令或路径
   * @param {string[]} [opts.args]          - 参数，{prompt} 会被替换为访客消息
   * @param {string}   [opts.parser='raw']  - 解析器名（stream-json / jsonl / raw / silent）
   * @param {object}   [opts.parserOpts]    - 解析器选项
   * @param {string}   opts.matchType       - match 匹配的 backend_type
   * @param {number}   [opts.priority=1]    - 优先级
   * @param {number}   [opts.timeout=120000]- 超时 ms
   * @param {object}   [opts.env]           - 额外环境变量
   * @param {string}   [opts.promptTemplate]- 自定义 prompt 模板，{prompt} 替换
   */
  constructor(opts: CliAdapterOptions) {
    super();
    this._name = opts.name || 'cli';
    this._cmd = opts.cmd;
    this._args = opts.args || [];
    this._parserName = opts.parser || 'raw';
    this._parserOpts = opts.parserOpts || {};
    this._matchType = opts.matchType;
    this._priority = opts.priority ?? 1;
    this._timeout = opts.timeout ?? 120000;
    this._env = opts.env;
    this._promptTemplate = opts.promptTemplate;

    this._contextWindow = opts.contextWindow ?? 0;
    this._db = opts.db || null;
    this._cwd = opts.cwd || null;
    this._available = null;
  }

  get priority() { return this._priority; }
  get capabilities() { return ['streaming']; }

  match(_agentId: string, meta?: AgentMeta | null): boolean {
    return meta?.backend_type === this._matchType;
  }

  isAvailable(_agentId: string): boolean {
    if (this._available !== null) return this._available;
    this._available = checkCliAvailable(this._cmd);
    return this._available;
  }

  async push(payload: PushPayload): Promise<void> {
    const { agentId, fromUid, content, messageId } = payload;
    const turnId = String(payload.turnId || messageId || `cli-${Date.now()}`);
    const sessionKey = `cli:${agentId}:${fromUid}`;

    // 取上下文
    let contextMsgs: ContextMessage[] = [];
    if (this._contextWindow > 0 && this._db) {
      try {
        contextMsgs = (this._db.prepare(
          `SELECT content, is_me, timestamp FROM messages WHERE channel_id=? AND agent_id=? AND content_type!=11 ORDER BY timestamp DESC LIMIT ?`
        ).all(fromUid, agentId, this._contextWindow) as ContextMessage[]).reverse();
      } catch (_) {}
    }

    const contextPrompt = _buildContextPrompt(agentId, fromUid, content, contextMsgs);
    const prompt = this._promptTemplate
      ? this._promptTemplate.replace('{prompt}', () => contextPrompt)
      : contextPrompt;

    // 构造参数：args 含 {prompt} 占位则替换；否则 prompt 经 stdin 传入
    // （避开 Windows cmd.exe 对含换行多行命令行参数的破坏）
    const useStdin = !this._args.includes('{prompt}');
    // Windows 下 {prompt} 经命令行参数传入时须净化 cmd.exe 元字符，否则访客
    // 消息中的 " 会断裂 cmd 引号、&|<> 充当命令分隔/重定向 → 任意命令执行 (RCE)，
    // 换行会截断命令行。用函数式 replacement 避免 String.replace 对 $ 模式的展开。
    const safePrompt = process.platform === 'win32' ? sanitizeCmdArg(prompt) : prompt;
    const args = useStdin
      ? [...this._args]
      : this._args.map((a: string) => a.replace('{prompt}', () => safePrompt));
    const cmd = this._cmd;

    let fullContent = '';
    let error: Error | null = null;
    let exitCode: number | null = null;

    // 创建解析器
    const parser = createParser({
      format: this._parserName,
      parserOpts: this._parserOpts,
      onText: (chunk: string) => {
        fullContent += chunk;
        if (fullContent.length > MAX_REPLY_CHARS) fullContent = fullContent.slice(0, MAX_REPLY_CHARS) + '\n…[回复过长，已截断]';
        this.emit('agent.reply', {
          agentId, visitorId: fromUid,
          content: fullContent,
          done: false,
          sessionKey,
          turnId,
          replyId: turnId,
        });
      },
      onDone: () => {
        // silent 模式下由 finish() 触发
      },
    });

    try {
      const result = await runCli({
        cmd,
        args,
        stdinInput: useStdin ? prompt : undefined,
        cwd: this._cwd || undefined,
        tag: this._name,
        timeout: this._timeout,
        env: this._env,
        onStdoutLine: (line: string) => parser.handleLine(line),
        onStderrLine: (line: string) => console.error(`[${this._name}] ${line}`),
      });

      exitCode = result.code;

      // silent 模式：不解析，进程退出即完成
      if (this._parserName === 'silent') {
        parser.finish();
      }

      if (exitCode !== 0 && !fullContent) {
        error = new Error(`${this._name} 退出 code=${exitCode}`);
      }
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
      console.error(`[${this._name}] push 失败: ${errorMessage(err)}`);
    }

    this.emit('agent.reply', {
      agentId, visitorId: fromUid,
      content: fullContent || (error ? `[${this._name} Error] ${error.message}` : ''),
      done: true,
      sessionKey,
      turnId,
      replyId: turnId,
      error: error ? { code: `cli_${exitCode || 'failed'}`, message: error.message } : undefined,
    });
  }

  async steer(
    agentId: string,
    visitorId: string,
    content: string,
    metadata?: { turnId?: string },
  ): Promise<void> {
    // owner intervention：走同样的 push 路径
    const messageId = metadata?.turnId || `steer-${Date.now()}`;
    return this.push({ agentId, fromUid: visitorId, content, messageId, turnId: messageId, timestamp: Date.now() });
  }

  start() { this._available = null; }
  stop() {}
  healthCheck() { this._available = null; }
}

function _buildContextPrompt(
  agentId: string,
  fromUid: string,
  content: string,
  contextMsgs: ContextMessage[],
): string {
  let msg = `session: cli:${agentId}:${fromUid}\n\n【访客最新消息】\n${content}`;

  if (contextMsgs && contextMsgs.length > 0) {
    msg += `\n\n【最近对话】\n${contextMsgs.map((m: ContextMessage, i: number) => {
      const role = m.is_me >= 1 ? 'Agent' : '访客';
      return `[${i + 1}] ${role}: ${m.content}`;
    }).join('\n')}`;
  }

  return msg;
}

module.exports = { CliAdapter };
