/** Cline ACP provider. Cline is launched as an ACP server over stdio. */
const os = require('os');
const { AcpAdapter } = require('../../adapters/acp-adapter');
import type { AgentMeta } from '../types';
import type { CliProviderOptions } from '../../adapters/cli-adapter';

class ClineAcpProvider extends AcpAdapter {
  constructor(options: CliProviderOptions = {}) {
    super({
      name: 'CLINE ACP',
      cliPath: 'cline',
      runtimeRequest: {
        providerId: 'cline-acp',
        mode: 'acp',
        candidates: process.platform === 'win32'
          ? [{ kind: 'node-package-bin', command: 'cline', packageName: 'cline' }, { kind: 'native', command: 'cline' }]
          : [{ kind: 'native', command: 'cline' }, { kind: 'node-package-bin', command: 'cline', packageName: 'cline' }],
      },
      args: ['--acp'],
      matchType: 'cline',
      adapterType: 'cline-acp',
      db: options.db,
      contextWindow: options.contextWindow,
      cwd: options.cwd || os.tmpdir(),
    });
  }

  match(_agentId: string, meta?: AgentMeta | null): boolean {
    return meta?.backend_type === 'cline';
  }
}

module.exports = { ClineAcpProvider };
