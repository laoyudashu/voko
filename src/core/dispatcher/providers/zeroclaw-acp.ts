const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AcpAdapter } = require('../../adapters/acp-adapter');
const { resolveZeroClawCommand } = require('../zeroclaw-command');
import type { AgentMeta } from '../types';
import type { CliProviderOptions } from '../../adapters/cli-adapter';

interface InstanceRow {
  backend_instance_id?: string | null;
}

class ZeroClawAcpProvider extends AcpAdapter {
  constructor(options: CliProviderOptions = {}) {
    const command = resolveZeroClawCommand();
    const db = options.db || null;
    const dbPath = String((db as any)?._dbPath || '');
    const stateRoot = dbPath && dbPath !== ':memory:'
      ? path.join(path.dirname(path.resolve(dbPath)), 'provider-sessions', 'zeroclaw')
      : path.join(os.tmpdir(), 'voko-provider-sessions', 'zeroclaw');
    const instanceAlias = (agentId: string): string | null => {
      if (!db) return null;
      try {
        const row = db.prepare(
          'SELECT backend_instance_id FROM agents WHERE agent_id=? AND backend_type=?'
        ).get(agentId, 'zeroclaw') as InstanceRow | undefined;
        const alias = String(row?.backend_instance_id || '').trim();
        return /^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(alias) ? alias : null;
      } catch {
        return null;
      }
    };
    const sessionStateFile = (payload: any): string => {
      const alias = instanceAlias(payload.agentId);
      if (!alias) throw new Error('ZeroClaw CLI fallback requires a persisted agent alias');
      fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
      const channelId = payload.channelId || String(payload.fromUid || '').replace(/^group:/, '');
      const channelType = payload.channelType === 2 ? 2 : 1;
      const digest = crypto.createHash('sha256')
        .update(`${alias}\0${payload.agentId}\0${channelType}\0${channelId}`)
        .digest('hex');
      return path.join(stateRoot, `${digest}.json`);
    };
    super({
      name: 'ZEROCLAW ACP',
      matchType: 'zeroclaw',
      adapterType: 'zeroclaw-acp',
      cliPath: command,
      args: ['acp'],
      cliFallback: {
        cmd: command,
        parser: 'zeroclaw-interactive',
        timeout: 180000,
        stdinPrompt: true,
        argsForPayload: (payload: any) => {
          const alias = instanceAlias(payload.agentId);
          if (!alias) throw new Error('ZeroClaw CLI fallback requires a persisted agent alias');
          const stateFile = sessionStateFile(payload);
          return [
            'agent', '--agent', alias,
            '--session-state-file', stateFile,
            '--log-level', 'warn',
          ];
        },
        afterRun: (payload: any) => {
          const stateFile = sessionStateFile(payload);
          if (fs.existsSync(stateFile)) fs.chmodSync(stateFile, 0o600);
        },
      },
      db: options.db,
      cwd: options.cwd || os.tmpdir(),
      sessionRequest: (agentId: string) => {
        const alias = instanceAlias(agentId);
        return alias ? { agentAlias: alias } : {};
      },
    });
    this._instanceAlias = instanceAlias;
  }

  match(_agentId: string, meta?: AgentMeta | null): boolean {
    return meta?.backend_type === 'zeroclaw';
  }

  isAvailable(agentId: string): boolean {
    return super.isAvailable(agentId) && !!this._instanceAlias(agentId);
  }

  _instanceAlias: (agentId: string) => string | null;
}

module.exports = { ZeroClawAcpProvider };
