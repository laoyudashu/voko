const os = require('os');
const { CliAdapter } = require('../../adapters/cli-adapter');
const { runCli } = require('../../adapters/cli-spawner');
const { createParser } = require('../../adapters/cli-parsers');
const { withRuntimePath } = require('../../runtime/agent-runtime-resolver');
const { resolveQwenOfficeCommand, qwenOfficeRuntimeRequest } = require('../qwen-office-command');
import type { CliProviderOptions } from '../../adapters/cli-adapter';

/**
 * QwenWork's bundled qoderclicn stream-json transport.  Tool access and
 * permission prompts stay disabled for unattended VOKO messages.
 */
class QwenOfficeCliProvider extends CliAdapter {
  constructor(options: CliProviderOptions = {}) {
    const configuredCommand = String((options as any).binPath || '').trim();
    const command = configuredCommand || resolveQwenOfficeCommand();
    const baseArgs = [
      '--print',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--permission-mode', 'dont_ask',
      '--tools', '',
    ];
    super({
      name: 'QWEN OFFICE CLI',
      cmd: command,
      runtimeRequest: qwenOfficeRuntimeRequest('cli', process.env, process.platform, command),
      args: baseArgs,
      parser: 'gemini-stream-json',
      matchType: 'qwen-office',
      priority: 1,
      timeout: 180000,
      adapterType: 'qwen-office-cli',
      bindingProviderType: 'qwen-office',
      argsForSession: (sessionId: string | null) => [
        ...baseArgs,
        ...(sessionId ? ['--resume', sessionId] : []),
      ],
      sessionIdFromLine: (line: string) => {
        try {
          const event = JSON.parse(line);
          const id = event?.session_id || event?.sessionId;
          return typeof id === 'string' && id.trim() ? id : null;
        } catch { return null; }
      },
      preparePrompt: (prompt: string, context: { configuredArgs: string[] }) => ({
        args: [...context.configuredArgs],
        useStdin: true,
        stdinInput: JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: prompt }] },
        }),
      }),
      env: { NO_COLOR: '1' },
      promptTemplate: '这是来自 VOKO 的外部访客消息。只允许安全的文字回复，不得执行工具、修改文件或运行命令。\n\n{prompt}',
      db: options.db,
      contextWindow: options.contextWindow,
      cwd: options.cwd || os.tmpdir(),
    });
  }

  acceptsBinding(binding: any): boolean {
    return binding?.providerType === 'qwen-office'
      && binding.adapterType === 'qwen-office-cli'
      && binding.deliveryMode === 'cli'
      && typeof binding.nativeSessionId === 'string'
      && binding.nativeSessionId.length > 0;
  }

  async runLoopbackTest(_agentId: string, options: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (options.acknowledgeCost !== true) {
      return { ok: false, status: 'failed', code: 'LOOPBACK_CONFIRMATION_REQUIRED' };
    }
    const challenge = String(options.challenge || '');
    if (!/^voko-[a-f0-9]{24}$/.test(challenge)) {
      return { ok: false, status: 'failed', code: 'LOOPBACK_CHALLENGE_INVALID' };
    }
    const runtime = this._resolveRuntime();
    if (!runtime.available || !runtime.executable) {
      return { ok: false, status: 'unavailable', code: 'QWEN_OFFICE_CLI_UNAVAILABLE', detail: runtime.reason || 'QwenWork CLI is unavailable' };
    }

    let reply = '';
    const parser = createParser({
      format: 'gemini-stream-json',
      onText: (text: string) => { reply += text; },
      onDone: () => {},
    });
    const prompt = `VOKO local loopback test. Do not use tools. Reply with exactly: ${challenge}`;
    const result = await runCli({
      cmd: runtime.executable,
      args: [...runtime.argvPrefix, ...this._args],
      stdinInput: JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: prompt }] },
      }),
      cwd: this._cwd || os.tmpdir(),
      env: withRuntimePath({ ...this._env }, runtime),
      tag: 'qwen-office-cli-loopback',
      timeout: 120000,
      logOutput: false,
      onStdoutLine: (line: string) => parser.handleLine(line),
    });
    parser.finish();
    const matched = result.code === 0 && reply.trim() === challenge;
    return {
      ok: matched,
      status: matched ? 'loopback_verified' : 'failed',
      challengeMatched: matched,
      detail: matched
        ? 'QwenWork CLI loopback verified'
        : (result.stderr.trim() || 'QwenWork CLI did not return the expected challenge'),
    };
  }
}

module.exports = { QwenOfficeCliProvider };
