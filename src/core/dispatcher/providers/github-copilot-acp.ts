const os = require('os');
const fs = require('fs');
const { AcpAdapter } = require('../../adapters/acp-adapter');
const {
  COPILOT_SAFETY_ARGS,
  resolveGitHubCopilotRuntime,
} = require('./github-copilot-runtime');
import type { CliProviderOptions } from '../../adapters/cli-adapter';

class GitHubCopilotAcpProvider extends AcpAdapter {
  constructor(options: CliProviderOptions = {}) {
    const runtime = resolveGitHubCopilotRuntime();
    super({
      name: 'GITHUB COPILOT ACP',
      matchType: 'github-copilot',
      adapterType: 'github-copilot-acp',
      cliPath: runtime?.command || null,
      args: runtime ? [...runtime.prefixArgs, '--acp', ...COPILOT_SAFETY_ARGS] : [],
      cliFallback: runtime ? {
        cmd: runtime.command,
        args: [
          ...runtime.prefixArgs,
          '-p', '{prompt}',
          '--silent',
          '--no-color',
          ...COPILOT_SAFETY_ARGS,
        ],
        parser: 'raw',
        timeout: 300000,
      } : null,
      db: options.db,
      cwd: options.cwd || os.tmpdir(),
    });
    this._runtime = runtime;
  }

  isAvailable(): boolean {
    if (!this._runtime) return false;
    return this._runtime.command === process.execPath
      ? fs.existsSync(this._runtime.prefixArgs[0])
      : super.isAvailable('');
  }

  _runtime: { command: string; prefixArgs: string[] } | null;
}

module.exports = { GitHubCopilotAcpProvider };
