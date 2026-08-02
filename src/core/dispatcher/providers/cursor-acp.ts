const os = require('os');
const { AcpAdapter } = require('../../adapters/acp-adapter');
const { resolveCursorRuntime } = require('../cursor-command');
import type { AgentMeta } from '../types';
import type { CliProviderOptions } from '../../adapters/cli-adapter';

class CursorAcpProvider extends AcpAdapter {
  constructor(options: CliProviderOptions = {}) {
    const runtime = resolveCursorRuntime();
    const command = runtime.command;
    const fallbackBase = [...runtime.prefixArgs, '-p', '{prompt}', '--output-format', 'stream-json', '--mode', 'plan', '--trust', '--workspace', '.'];
    super({
      name: 'CURSOR ACP',
      matchType: 'cursor',
      adapterType: 'cursor-acp',
      cliPath: command,
      args: [...runtime.prefixArgs, 'acp'],
      db: options.db,
      cwd: options.cwd || os.tmpdir(),
      contextWindow: options.contextWindow,
      cliFallback: {
        cmd: command,
        args: fallbackBase,
        argsForPayload: (payload: any) => [
          ...fallbackBase,
          ...(payload.providerBinding?.providerType === 'cursor'
            ? ['--resume', payload.providerBinding.nativeSessionId]
            : []),
        ],
        sessionIdFromLine: (line: string) => {
          try {
            const event = JSON.parse(line.replace(/^(?:stdout|stderr):/, ''));
            return String(event.session_id || event.sessionId || '').trim() || null;
          } catch (_) { return null; }
        },
        adapterType: 'cursor-cli',
        parser: 'cursor-stream-json',
        timeout: 300000,
      },
    });
  }

  match(_agentId: string, meta?: AgentMeta | null): boolean {
    return meta?.backend_type === 'cursor';
  }
}

module.exports = { CursorAcpProvider };
