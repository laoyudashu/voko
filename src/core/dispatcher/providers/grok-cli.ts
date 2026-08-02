/**
 * xAI Grok CLI Provider.
 *
 * External visitor input is delivered in a single-turn, tool-free process.
 * Native Grok session IDs are managed by VOKO for restart-safe continuity.
 */
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { CliAdapter } = require('../../adapters/cli-adapter');
import type { CliProviderOptions } from '../../adapters/cli-adapter';

function resolveGrokProxyEnv(): NodeJS.ProcessEnv {
  const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy || httpsProxy;
  if (httpsProxy || httpProxy) {
    return {
      ...(httpsProxy ? { HTTPS_PROXY: httpsProxy } : {}),
      ...(httpProxy ? { HTTP_PROXY: httpProxy } : {}),
    };
  }
  if (process.platform !== 'win32') return {};
  try {
    const output = String(execFileSync('netsh', ['winhttp', 'show', 'proxy'], {
      encoding: 'utf8', windowsHide: true, timeout: 5000,
    }));
    const match = output.match(/\b((?:127\.0\.0\.1|localhost):\d{1,5})\b/i);
    if (!match) return {};
    const proxy = `http://${match[1]}`;
    return { HTTPS_PROXY: proxy, HTTP_PROXY: proxy };
  } catch { return {}; }
}

class GrokCliProvider extends CliAdapter {
  constructor(options: CliProviderOptions = {}) {
    const baseArgs = [
      '--output-format', 'streaming-json',
      '--permission-mode', 'plan',
      '--tools=none',
      '--disable-web-search',
      '--no-subagents',
      '--no-memory',
      '--max-turns', '1',
      '--verbatim',
    ];
    const argsForSession = (sessionId: string | null, isNew: boolean) => [
      ...baseArgs,
      ...(sessionId ? [isNew ? '--session-id' : '--resume', sessionId] : []),
      '--single', '{prompt}',
    ];
    super({
      name: 'GROK CLI',
      cmd: 'grok',
      args: argsForSession(null, false),
      parser: 'grok-stream-json',
      matchType: 'grok',
      priority: 1,
      timeout: 300000,
      env: resolveGrokProxyEnv(),
      adapterType: 'grok-cli',
      createManagedSessionId: () => crypto.randomUUID(),
      argsForSession,
      db: options.db,
      contextWindow: options.contextWindow,
      cwd: options.cwd || os.tmpdir(),
    });
  }
}

module.exports = { GrokCliProvider, resolveGrokProxyEnv };
