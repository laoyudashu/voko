const os = require('os');
const { AcpAdapter } = require('../../adapters/acp-adapter');
const { resolveTraeCliCommand, traeCliRuntimeRequest } = require('../trae-command');
import type { CliProviderOptions } from '../../adapters/cli-adapter';

/** Trae's separate headless CLI ACP transport. Cross-provider fallback is Dispatcher-owned. */
class TraeAcpProvider extends AcpAdapter {
  constructor(options: CliProviderOptions = {}) {
    const configuredCommand = String((options as any).binPath || '').trim();
    const command = configuredCommand || resolveTraeCliCommand();
    super({
      name: 'TRAE CLI ACP',
      matchType: 'trae',
      bindingProviderType: 'trae',
      adapterType: 'traecli-acp',
      runtimeRequest: traeCliRuntimeRequest('acp', process.env, process.platform, command),
      args: ['acp', 'serve', '--yolo'],
      db: options.db,
      contextWindow: options.contextWindow,
      sessionPersistence: options.sessionPersistence || 'transport',
      cwd: options.cwd || os.tmpdir(),
    });
  }

  acceptsBinding(binding: any): boolean {
    return binding?.providerType === 'trae'
      && binding.adapterType === 'traecli-acp'
      && binding.deliveryMode === 'acp'
      && typeof binding.nativeSessionId === 'string'
      && binding.nativeSessionId.length > 0;
  }
}

module.exports = { TraeAcpProvider };
