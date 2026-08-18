const os = require('node:os');
const { AcpAdapter } = require('../../adapters/acp-adapter');
const { codeBuddyRuntimeRequest } = require('../codebuddy-command');
import type { CliProviderOptions } from '../../adapters/cli-adapter';

/** Official CodeBuddy CLI ACP transport. Cross-channel fallback remains Dispatcher-owned. */
class CodeBuddyAcpProvider extends AcpAdapter {
  constructor(options: CliProviderOptions = {}) {
    const configuredCommand = String((options as any).binPath || '').trim();
    super({
      name: 'CODEBUDDY ACP',
      matchType: 'codebuddy',
      bindingProviderType: 'codebuddy',
      adapterType: 'codebuddy-acp',
      runtimeRequest: codeBuddyRuntimeRequest('acp', process.env, process.platform, configuredCommand),
      args: ['--acp', '--permission-mode', 'dontAsk', '--tools', '', '--strict-mcp-config'],
      db: options.db,
      contextWindow: options.contextWindow,
      sessionPersistence: options.sessionPersistence || 'transport',
      cwd: options.cwd || os.tmpdir(),
    });
  }

  acceptsBinding(binding: any): boolean {
    return binding?.providerType === 'codebuddy'
      && binding.adapterType === 'codebuddy-acp'
      && binding.deliveryMode === 'acp'
      && typeof binding.nativeSessionId === 'string'
      && binding.nativeSessionId.length > 0;
  }
}

module.exports = { CodeBuddyAcpProvider };
