const os = require('os');
const { AcpAdapter } = require('../../adapters/acp-adapter');
const { resolveCursorRuntime } = require('../cursor-command');
import type { AgentMeta } from '../types';
import type { CliProviderOptions } from '../../adapters/cli-adapter';

class CursorAcpProvider extends AcpAdapter {
  constructor(options: CliProviderOptions = {}) {
    const runtime = resolveCursorRuntime();
    const command = runtime.command;
    super({
      name: 'CURSOR ACP',
      matchType: 'cursor',
      adapterType: 'cursor-acp',
      cliPath: command,
      args: [...runtime.prefixArgs, 'acp'],
      db: options.db,
      sessionPersistence: options.sessionPersistence,
      cwd: options.cwd || os.tmpdir(),
      contextWindow: options.contextWindow,
    });
  }

  match(_agentId: string, meta?: AgentMeta | null): boolean {
    return meta?.backend_type === 'cursor';
  }
}

module.exports = { CursorAcpProvider };
