const os = require('os');
const { AcpAdapter } = require('../../adapters/acp-adapter');
const {
  buildOpenCodeVisitorContent,
  isolatedOpenCodeEnv,
  resolveOpenCodeCommand,
} = require('./opencode-runtime');
import type { PushPayload } from '../types';
import type { CliProviderOptions } from '../../adapters/cli-adapter';

class OpenCodeAcpProvider extends AcpAdapter {
  constructor(options: CliProviderOptions = {}) {
    super({
      name: 'OPENCODE ACP',
      matchType: 'opencode',
      adapterType: 'opencode-acp',
      cliPath: resolveOpenCodeCommand(),
      args: ['acp'],
      db: options.db,
      cwd: options.cwd || os.tmpdir(),
      env: isolatedOpenCodeEnv(),
    });
  }

  async push(payload: PushPayload): Promise<void> {
    return super.push({
      ...payload,
      content: buildOpenCodeVisitorContent(payload.agentId, payload.fromUid, payload.content),
    });
  }

  async steer(agentId: string, visitorId: string, content: string, metadata?: {
    turnId?: string;
    channelId?: string;
    channelType?: number;
    providerBinding?: PushPayload['providerBinding'];
  }): Promise<void> {
    const turnId = String(metadata?.turnId || `steer-${Date.now()}`);
    const channelType = metadata?.channelType === 2 || String(visitorId).startsWith('group:') ? 2 : 1;
    const channelId = String(metadata?.channelId || String(visitorId).replace(/^group:/, ''));
    return this.push({
      agentId,
      fromUid: channelType === 2 ? `group:${channelId}` : visitorId,
      content,
      messageId: turnId,
      turnId,
      channelId,
      channelType,
      sessionTarget: channelType === 2 ? `group:${channelId}` : visitorId,
      providerBinding: metadata?.providerBinding || null,
      timestamp: Date.now(),
    });
  }

}

module.exports = { OpenCodeAcpProvider };
