const os = require('node:os');
const { CliAdapter } = require('../../adapters/cli-adapter');
const { resolveDeepSeekHarnessRuntime } = require('../deepseek-harness-command');
import type { ProviderDeliveryReceipt, PushPayload } from '../types';

/** DSH profile CLI transport. The shipped headless profile is deliberately one-shot. */
class DeepSeekHarnessCliProvider extends CliAdapter {
  constructor(options: Record<string, unknown> = {}) {
    const runtime = resolveDeepSeekHarnessRuntime();
    const profile = String(options.profile || 'headless').trim();
    super({
      name: 'DeepSeek Harness CLI',
      cmd: runtime.command || process.execPath,
      args: [...runtime.argsPrefix, '--profile', profile, '{prompt}'],
      parser: 'raw',
      matchType: 'deepseek-harness',
      adapterType: 'deepseek-harness-cli',
      bindingProviderType: 'deepseek-harness',
      priority: 20,
      timeout: Math.max(5000, Math.min(Number(options.timeout || 180_000), 600_000)),
      requireOutput: true,
      contextWindow: Number(options.contextWindow || 20),
      db: options.db as any,
      cwd: String(options.cwd || os.tmpdir()),
      runtimeRequest: null as any,
      sessionPersistence: 'dispatcher',
    });
    if (!runtime.command) (this as any)._available = false;
  }

  get capabilities(): string[] { return ['cli', 'one_shot']; }

  async push(payload: PushPayload): Promise<ProviderDeliveryReceipt> {
    if (payload.providerBinding?.nativeSessionId) {
      const error: any = new Error('DeepSeek Harness CLI profile cannot restore an existing native session');
      error.deliveryOutcome = 'not_delivered';
      throw error;
    }
    if (payload.attachments?.length) {
      const error: any = new Error('DeepSeek Harness CLI attachment delivery is not enabled');
      error.deliveryOutcome = 'not_delivered';
      throw error;
    }
    return super.push(payload);
  }
}

module.exports = { DeepSeekHarnessCliProvider };
