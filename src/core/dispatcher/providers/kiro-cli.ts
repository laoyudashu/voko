/**
 * Kiro CLI headless provider.
 *
 * No tool category is trusted for unattended visitor input. The process runs
 * outside the user's project directory and tool requests cannot be approved.
 */
const os = require('os');
const { execFileSync } = require('child_process');
const { CliAdapter } = require('../../adapters/cli-adapter');
import type { CliProviderOptions } from '../../adapters/cli-adapter';

class KiroCliProvider extends CliAdapter {
  constructor(options: CliProviderOptions = {}) {
    super({
      name: 'KIRO CLI',
      cmd: 'kiro-cli',
      args: ['chat', '--no-interactive', '--wrap', 'never', '{prompt}'],
      adapterType: 'kiro-cli',
      argsForSession: (sessionId: string | null) => [
        'chat', '--no-interactive', '--wrap', 'never',
        ...(sessionId ? ['--resume-id', sessionId] : []),
        '{prompt}',
      ],
      sessionIdFromLine: (line: string) => {
        try {
          const event = JSON.parse(line);
          const id = event.session_id || event.sessionId;
          if (id) return String(id);
        } catch (_) {}
        const match = line.match(/(?:session(?:\s+id)?|resume-id)\s*[:=]?\s*([a-z0-9][a-z0-9_-]{7,})/i);
        return match?.[1] || null;
      },
      resolveSessionIdAfterRun: ({ agentId, fromUid, startedAt, cwd }: {
        agentId: string; fromUid: string; startedAt: number; cwd: string;
      }) => {
        const output = execFileSync('kiro-cli', ['chat', '--list-sessions', '--format', 'json'], {
          cwd,
          encoding: 'utf8',
          windowsHide: true,
          timeout: 15000,
        });
        const groups = JSON.parse(output);
        const marker = `session: cli:${agentId}:${fromUid}`;
        const candidates = (Array.isArray(groups) ? groups : [])
          .flatMap((group: any) => Array.isArray(group.sessions) ? group.sessions : [])
          .filter((session: any) => String(session.title || '').includes(marker))
          .filter((session: any) => Date.parse(session.updatedAt || '') >= startedAt - 5000);
        return candidates.length === 1 ? String(candidates[0].sessionId || '') || null : null;
      },
      parser: 'kiro-output',
      matchType: 'kiro',
      priority: 1,
      timeout: 180000,
      promptTemplate: '这是来自外部访客的文字消息。只能回复文字，不得写文件、执行命令或调用 MCP。\n\n{prompt}',
      db: options.db,
      contextWindow: options.contextWindow,
      cwd: options.cwd || os.tmpdir(),
    });
  }
}

module.exports = { KiroCliProvider };
