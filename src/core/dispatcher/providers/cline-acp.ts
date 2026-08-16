/** Cline ACP provider. Cline is launched as an ACP server over stdio. */
const os = require('os');
const { AcpAdapter } = require('../../adapters/acp-adapter');
const { withClineRuntimeLock } = require('./cline-runtime-coordinator');
import type { AgentMeta } from '../types';
import type { CliProviderOptions } from '../../adapters/cli-adapter';
import type { ProviderDeliveryReceipt, PushPayload } from '../types';

const platformArtifact = process.platform === 'win32'
  ? { artifactPackage: `@cline/cli-windows-${process.arch}`, relativePath: 'bin/cline.exe' }
  : { artifactPackage: `@cline/cli-${process.platform}-${process.arch}`, relativePath: 'bin/cline' };

class ClineAcpProvider extends AcpAdapter {
  constructor(options: CliProviderOptions = {}) {
    super({
      name: 'CLINE ACP',
      cliPath: 'cline',
      runtimeRequest: {
        providerId: 'cline-acp',
        mode: 'acp',
        candidates: [
          { kind: 'node-package-artifact', command: 'cline', packageName: 'cline', ...platformArtifact },
          { kind: 'native', command: 'cline' },
          { kind: 'node-package-bin', command: 'cline', packageName: 'cline' },
        ],
      },
      args: ['--acp'],
      matchType: 'cline',
      adapterType: 'cline-acp',
      connectionKey: () => 'cline-shared',
      db: options.db,
      sessionPersistence: options.sessionPersistence,
      contextWindow: options.contextWindow,
      cwd: options.cwd || os.tmpdir(),
    });
  }

  match(_agentId: string, meta?: AgentMeta | null): boolean {
    return meta?.backend_type === 'cline';
  }

  async push(payload: PushPayload): Promise<ProviderDeliveryReceipt> {
    return withClineRuntimeLock(() => super.push(payload));
  }
}

module.exports = { ClineAcpProvider };
