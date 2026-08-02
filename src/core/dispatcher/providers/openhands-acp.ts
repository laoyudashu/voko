const os = require('os');
const { AcpAdapter } = require('../../adapters/acp-adapter');
import type { AgentMeta } from '../types';
import type { CliProviderOptions } from '../../adapters/cli-adapter';

/**
 * OpenHands ACP runtime definition.
 *
 * This provider is intentionally not in the active provider registry until
 * OpenHands can complete a text-only ACP turn with all tool permissions denied.
 */
class OpenHandsAcpProvider extends AcpAdapter {
  constructor(options: CliProviderOptions = {}) {
    super({
      name: 'OPENHANDS ACP',
      matchType: 'openhands',
      adapterType: 'openhands-acp',
      cliPath: 'openhands',
      args: ['acp'],
      env: {
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
        OPENHANDS_SUPPRESS_BANNER: '1',
      },
      db: options.db,
      contextWindow: options.contextWindow,
      cwd: options.cwd || os.tmpdir(),
    });
  }

  match(_agentId: string, meta?: AgentMeta | null): boolean {
    return meta?.backend_type === 'openhands';
  }
}

module.exports = { OpenHandsAcpProvider };
