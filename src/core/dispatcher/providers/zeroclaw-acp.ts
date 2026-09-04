const os = require('os');
const fs = require('fs');
const { AcpAdapter } = require('../../adapters/acp-adapter');
const { resolveZeroClawCommand, resolveZeroClawConfigDir, isZeroClawAgentDispatchable } = require('../zeroclaw-command');
import type { AgentMeta } from '../types';
import type { CliProviderOptions } from '../../adapters/cli-adapter';

interface InstanceRow {
  backend_instance_id?: string | null;
}

class ZeroClawAcpProvider extends AcpAdapter {
  constructor(options: CliProviderOptions = {}) {
    const command = resolveZeroClawCommand();
    const db = options.db || null;
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
    super({
      name: 'ZEROCLAW ACP',
      matchType: 'zeroclaw',
      adapterType: 'zeroclaw-acp',
      cliPath: command,
      args: ['acp', '--config-dir', resolveZeroClawConfigDir()],
      db: options.db,
      sessionPersistence: options.sessionPersistence,
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
    const alias = this._instanceAlias(agentId);
    return super.isAvailable(agentId) && !!alias && isZeroClawAgentDispatchable(alias);
  }

  _instanceAlias: (agentId: string) => string | null;
}

module.exports = { ZeroClawAcpProvider };
