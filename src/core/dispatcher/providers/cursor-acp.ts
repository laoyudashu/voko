const os = require('os');
const { AcpAdapter } = require('../../adapters/acp-adapter');
const { resolveCursorCommand } = require('../cursor-command');
import type { AgentMeta } from '../types';
import type { CliProviderOptions } from '../../adapters/cli-adapter';

class CursorAcpProvider extends AcpAdapter {
  constructor(options: CliProviderOptions = {}) {
    const command = resolveCursorCommand();
    super({
      name: 'CURSOR ACP',
      matchType: 'cursor',
      adapterType: 'cursor-acp',
      cliPath: command,
      args: ['acp'],
      db: options.db,
      cwd: options.cwd || os.tmpdir(),
      contextWindow: options.contextWindow,
      cliFallback: {
        cmd: command,
        args: ['-p', '{prompt}', '--output-format', 'stream-json', '--mode', 'plan', '--trust', '--workspace', '.'],
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
