const { AcpAdapter } = require('../../adapters/acp-adapter');
const { resolveGooseCommand } = require('../goose-command');
import type { GooseCliOptions } from './goose-cli';
const { gooseRuntimeRequest } = require('../goose-command');

/** Goose ACP transport. Cross-provider fallback is owned by Dispatcher. */
class GooseAcpProvider extends AcpAdapter {
  constructor(options: GooseCliOptions = {}) {
    super({
      name: 'GOOSE ACP',
      matchType: 'acp-goose',
      bindingProviderType: 'goose',
      adapterType: 'goose-acp',
      runtimeRequest: gooseRuntimeRequest('acp', process.env, process.platform, options.binPath || resolveGooseCommand()),
      args: ['acp'],
      db: options.db,
      contextWindow: options.contextWindow,
      sessionPersistence: options.sessionPersistence || 'transport',
    });
  }

  acceptsBinding(binding: any): boolean {
    return binding?.providerType === 'goose'
      && !binding.providerInstanceId
      && (binding.adapterType === 'goose-acp' || binding.adapterType === 'goose-cli')
      && typeof binding.nativeSessionId === 'string'
      && binding.nativeSessionId.length > 0;
  }
}

module.exports = { GooseAcpProvider };
