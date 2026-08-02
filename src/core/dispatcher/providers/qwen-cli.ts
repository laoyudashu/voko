/**
 * Qwen Code headless provider.
 *
 * safe-mode removes local customizations and plan mode prevents writes/commands.
 * Tool, turn and wall-clock budgets provide a second boundary for unattended input.
 */
const os = require('os');
const { execFileSync } = require('child_process');
const { CliAdapter } = require('../../adapters/cli-adapter');
import type { CliProviderOptions } from '../../adapters/cli-adapter';

class QwenCliProvider extends CliAdapter {
  constructor(options: CliProviderOptions = {}) {
    const deepseekKey = process.env.DEEPSEEK_API_KEY?.trim();
    const deepseekModel = process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-chat';
    const deepseekBaseUrl = process.env.DEEPSEEK_BASE_URL?.trim() || 'https://api.deepseek.com';
    const modelArgs = deepseekKey
      ? ['--auth-type', 'openai', '--model', deepseekModel]
      : [];
    const baseArgs = [
      ...modelArgs,
      '--safe-mode',
      '--approval-mode', 'plan',
      '--exclude-tools', 'shell,write_file,replace,edit,agent',
      '--max-tool-calls', '0',
      '--max-session-turns', '4',
      '--max-wall-time', '120s',
      '--output-format', 'stream-json',
    ];
    super({
      name: 'QWEN CODE CLI',
      cmd: 'qwen',
      args: baseArgs,
      parser: 'gemini-stream-json',
      matchType: 'qwen-code',
      priority: 1,
      timeout: 150000,
      adapterType: 'qwen-cli',
      argsForSession: (sessionId: string | null) => [
        ...baseArgs,
        ...(sessionId ? ['--resume', sessionId] : []),
      ],
      sessionIdFromLine: (line: string) => {
        try {
          const event = JSON.parse(line);
          return event?.type === 'system' && event?.subtype === 'init'
            && typeof event.session_id === 'string'
            ? event.session_id
            : null;
        } catch { return null; }
      },
      resolveSessionIdAfterRun: ({ agentId, fromUid, startedAt, cwd }: {
        agentId: string;
        fromUid: string;
        startedAt: number;
        cwd: string;
      }) => {
        const output = String(execFileSync('qwen', ['sessions', 'list', '--json', '--limit', '50'], {
          cwd,
          encoding: 'utf8',
          windowsHide: true,
          timeout: 10000,
        }));
        const marker = `session: cli:${agentId}:${fromUid}`;
        const candidates = output.split(/\r?\n/).flatMap((line: string) => {
          if (!line.trim()) return [];
          try {
            const row = JSON.parse(line);
            const mtime = Number(row.mtime || 0);
            return typeof row.sessionId === 'string'
              && row.prompt?.includes(marker)
              && mtime >= startedAt - 5000
              ? [{ id: row.sessionId, mtime }]
              : [];
          } catch { return []; }
        }).sort((a: any, b: any) => b.mtime - a.mtime);
        return candidates.length === 1 ? candidates[0].id : null;
      },
      env: {
        QWEN_CODE_SAFE_MODE: 'true',
        NO_COLOR: '1',
        ...(deepseekKey ? {
          OPENAI_API_KEY: deepseekKey,
          OPENAI_BASE_URL: deepseekBaseUrl,
        } : {}),
      },
      promptTemplate: '只进行文字对话，不得调用工具、访问文件、执行命令或修改系统。\n\n{prompt}',
      db: options.db,
      contextWindow: options.contextWindow,
      cwd: options.cwd || os.tmpdir(),
    });
  }
}

module.exports = { QwenCliProvider };
