const { AcpAdapter } = require('../../adapters/acp-adapter');
const { resolveGooseCommand } = require('../goose-command');
import type { GooseCliOptions } from './goose-cli';

/** Goose ACP transport. Cross-provider fallback is owned by Dispatcher. */
class GooseAcpProvider extends AcpAdapter {
  constructor(options: GooseCliOptions = {}) {
    super({
      name: 'GOOSE ACP',
      matchType: 'acp-goose',
      adapterType: 'goose-acp',
      cliPath: options.binPath || resolveGooseCommand(),
      args: ['acp'],
      db: options.db,
      contextWindow: options.contextWindow,
    });
  }
}

module.exports = { GooseAcpProvider };
