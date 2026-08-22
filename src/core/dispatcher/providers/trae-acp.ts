const os = require('os');
const { AcpAdapter } = require('../../adapters/acp-adapter');
const { resolveTraeCliCommand, traeCliRuntimeRequest, getTraeCliReadiness } = require('../trae-command');
const { withTraeRuntimeLock } = require('./trae-runtime-coordinator');
import type { CliProviderOptions } from '../../adapters/cli-adapter';
import type { ProviderDeliveryReceipt, PushPayload } from '../types';

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
      args: [
        'acp', 'serve',
        '--permission-mode', 'plan',
        '--disallowed-tool', 'Bash',
        '--disallowed-tool', 'Edit',
        '--disallowed-tool', 'Write',
      ],
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

  async push(payload: PushPayload): Promise<ProviderDeliveryReceipt> {
    return withTraeRuntimeLock(payload.agentId, () => super.push(payload));
  }

  async preflightDelivery(_agentId: string): Promise<Record<string, unknown>> {
    const readiness = getTraeCliReadiness();
    return { ok: readiness.ready, status: readiness.ready ? 'preflight_passed' :
      (readiness.executable ? 'configuration_required' : 'unavailable'), sideEffects: false, code: readiness.reason };
  }
}

module.exports = { TraeAcpProvider };
