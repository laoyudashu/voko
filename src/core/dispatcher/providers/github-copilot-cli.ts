const os = require('os');
const { CliAdapter } = require('../../adapters/cli-adapter');
const {
  COPILOT_SAFETY_ARGS,
  resolveGitHubCopilotRuntime,
} = require('./github-copilot-runtime');
import type { CliProviderOptions } from '../../adapters/cli-adapter';

class GitHubCopilotCliProvider extends CliAdapter {
  constructor(options: CliProviderOptions = {}) {
    const runtime = resolveGitHubCopilotRuntime();
    super({
      name: 'GITHUB COPILOT CLI',
      cmd: runtime?.command || 'copilot',
      args: [
        ...(runtime?.prefixArgs || []),
        '-p', '{prompt}',
        '--silent',
        '--no-color',
        ...COPILOT_SAFETY_ARGS,
      ],
      parser: 'raw',
      matchType: 'github-copilot',
      adapterType: 'github-copilot-cli',
      priority: 1,
      timeout: 300000,
      requireOutput: true,
      db: options.db,
      contextWindow: options.contextWindow,
      cwd: options.cwd || os.tmpdir(),
    });
    this._runtime = runtime;
  }

  isAvailable(agentId: string): boolean {
    return !!this._runtime && super.isAvailable(agentId);
  }

  _runtime: { command: string; prefixArgs: string[] } | null;
}

module.exports = { GitHubCopilotCliProvider };
