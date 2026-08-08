const os = require('os');
const path = require('path');
const fs = require('fs');
const { AcpAdapter } = require('../../adapters/acp-adapter');
import type { AgentMeta } from '../types';
import type { CliProviderOptions } from '../../adapters/cli-adapter';

function resolveOpenHandsLlmEnv(): NodeJS.ProcessEnv {
  const apiKey = String(process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY || '').trim();
  if (!apiKey) return {};

  const baseUrl = String(process.env.LLM_BASE_URL || process.env.DEEPSEEK_BASE_URL || '').trim();
  const model = String(process.env.LLM_MODEL || process.env.DEEPSEEK_MODEL || '').trim();
  return {
    LLM_API_KEY: apiKey,
    ...(baseUrl ? { LLM_BASE_URL: baseUrl } : {}),
    ...(model ? { LLM_MODEL: model } : {}),
  };
}

function resolveOpenHandsPythonEnv(): NodeJS.ProcessEnv {
  const hookDir = path.join(__dirname, 'openhands-python');
  if (!fs.existsSync(path.join(hookDir, 'sitecustomize.py'))) return {};
  const existing = String(process.env.PYTHONPATH || '').trim();
  return {
    PYTHONPATH: existing ? `${hookDir}${path.delimiter}${existing}` : hookDir,
  };
}

function resolveOpenHandsGitEnv(): NodeJS.ProcessEnv {
  if (process.platform !== 'win32') return {};
  const entries: Array<[string, string]> = [
    ['http.lowspeedtime', '5'],
    ['http.lowspeedlimit', '1'],
  ];
  // OpenHands always updates public skills during session/new. Reset the
  // cache remote for this unattended child so Git fails fast and OpenHands
  // falls back to its already cached skills instead of touching the network.
  // Keep this reset in GIT_CONFIG_PARAMETERS: Windows Python drops empty
  // GIT_CONFIG_VALUE_* variables before launching Git.
  const env: NodeJS.ProcessEnv = {
    // OpenHands refreshes public skills synchronously during session/new.
    // Point Git at a deliberately nonexistent per-process directory so that
    // this refresh fails immediately and the already cached skills are used;
    // the Python sitecustomize hook separately prevents stdin inheritance.
    GIT_DIR: path.join(os.tmpdir(), `voko-openhands-git-disabled-${process.pid}`),
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
    GIT_OPTIONAL_LOCKS: '0',
    // Keep the remote reset compatible with Git versions that ignore the
    // structured multi-value override when launched through a Python wrapper.
    GIT_CONFIG_PARAMETERS: "'remote.origin.url'=''",
    GIT_CONFIG_COUNT: String(entries.length),
  };
  entries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

/**
 * OpenHands ACP runtime definition.
 *
 * OpenHands requires --override-with-envs for unattended ACP use. The local
 * VOKO configuration uses DEEPSEEK_* names, so map them to the LLM_* names
 * OpenHands reads without placing credentials in command arguments or logs.
 */
class OpenHandsAcpProvider extends AcpAdapter {
  constructor(options: CliProviderOptions = {}) {
    super({
      name: 'OPENHANDS ACP',
      matchType: 'openhands',
      adapterType: 'openhands-acp',
      cliPath: 'openhands',
      args: ['acp', '--override-with-envs'],
      env: {
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
        OPENHANDS_SUPPRESS_BANNER: '1',
        ...resolveOpenHandsPythonEnv(),
        // LiteLLM otherwise performs a remote model-cost download during
        // ACP session creation; offline/filtered Windows networks can make
        // session/new appear hung for minutes.
        LITELLM_LOCAL_MODEL_COST_MAP: 'True',
        // OpenHands refreshes its public-skills Git cache while creating a
        // session. Never let Git wait for an interactive credential prompt
        // on the ACP stdin pipe; OpenHands will use its cached skills.
        ...resolveOpenHandsGitEnv(),
        ...resolveOpenHandsLlmEnv(),
      },
      db: options.db,
      contextWindow: options.contextWindow,
      cwd: options.cwd || os.tmpdir(),
    });
  }

  match(_agentId: string, meta?: AgentMeta | null): boolean {
    return meta?.backend_type === 'openhands';
  }

  acceptsBinding(binding: any): boolean {
    return binding?.providerType === 'openhands'
      && (binding.adapterType === 'openhands-acp' || binding.adapterType === 'openhands-cli')
      && typeof binding.nativeSessionId === 'string'
      && binding.nativeSessionId.length > 0;
  }
}

module.exports = {
  OpenHandsAcpProvider,
  resolveOpenHandsLlmEnv,
  resolveOpenHandsPythonEnv,
  resolveOpenHandsGitEnv,
};
