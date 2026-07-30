const os = require('os');
const { AcpAdapter } = require('../../adapters/acp-adapter');
const { OpenCodeAttachProvider } = require('./opencode-attach');
const { OpenCodeCliProvider } = require('./opencode-cli');
const {
  buildOpenCodeVisitorContent,
  isolatedOpenCodeEnv,
  resolveOpenCodeCommand,
} = require('./opencode-runtime');
import type { PushPayload } from '../types';
import type { CliProviderOptions } from '../../adapters/cli-adapter';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class OpenCodeAcpProvider extends AcpAdapter {
  _attach: any;
  _cli: any;
  _acpDisabled = false;
  _attachDisabled = false;

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
    this._attach = new OpenCodeAttachProvider(options);
    this._cli = new OpenCodeCliProvider(options);
    this._attach.on('agent.reply', (...args: unknown[]) => this.emit('agent.reply', ...args));
    this._cli.on('agent.reply', (...args: unknown[]) => this.emit('agent.reply', ...args));
  }

  async push(payload: PushPayload): Promise<void> {
    if (!this._acpDisabled) {
      try {
        await this._pushViaAcp({
          ...payload,
          content: buildOpenCodeVisitorContent(payload.agentId, payload.fromUid, payload.content),
        });
        return;
      } catch (error) {
        this._acpDisabled = true;
        console.error(`[OPENCODE ACP] unavailable, falling back to attach: ${errorMessage(error)}`);
        try { await super.stop(); } catch {}
      }
    }
    if (!this._attachDisabled) {
      try {
        await this._attach.push(payload);
        return;
      } catch (error) {
        this._attachDisabled = true;
        console.error(`[OPENCODE ATTACH] unavailable, falling back to CLI: ${errorMessage(error)}`);
        try { await this._attach.stop(); } catch {}
      }
    }
    return this._cli.push(payload);
  }

  async steer(agentId: string, visitorId: string, content: string): Promise<void> {
    return this.push({
      agentId,
      fromUid: visitorId,
      content,
      messageId: `steer-${Date.now()}`,
      timestamp: Date.now(),
    });
  }

  async stop(): Promise<void> {
    await super.stop();
    await this._attach.stop();
    await this._cli.stop();
  }
}

module.exports = { OpenCodeAcpProvider };
