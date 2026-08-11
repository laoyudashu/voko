const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CliAdapter } = require('../../adapters/cli-adapter');
const { resolveZeroClawCommand } = require('../zeroclaw-command');
import type { PushPayload } from '../types';
import type { CliProviderOptions } from '../../adapters/cli-adapter';

interface InstanceRow { backend_instance_id?: string | null }

class ZeroClawCliProvider extends CliAdapter {
  constructor(options: CliProviderOptions = {}) {
    const db = options.db || null;
    const command = resolveZeroClawCommand();
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
    const stateFileFor = (payload: PushPayload): string => {
      const alias = instanceAlias(payload.agentId);
      if (!alias) throw new Error('ZeroClaw CLI requires a persisted agent alias');
      fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
      const channelId = payload.channelId || String(payload.fromUid || '').replace(/^group:/, '');
      const channelType = payload.channelType === 2 ? 2 : 1;
      const digest = crypto.createHash('sha256')
        .update(`${alias}\0${payload.agentId}\0${channelType}\0${channelId}`)
        .digest('hex');
      return path.join(stateRoot, `${digest}.json`);
    };
    super({
      name: 'ZEROCLAW CLI',
      cmd: command,
      args: [],
      parser: 'zeroclaw-interactive',
      matchType: 'zeroclaw',
      adapterType: 'zeroclaw-cli',
      priority: 1,
      timeout: 180000,
      requireOutput: true,
      db,
      sessionPersistence: options.sessionPersistence,
      contextWindow: options.contextWindow,
      cwd: options.cwd || os.tmpdir(),
      prepareInvocation: (payload: PushPayload, prompt: string) => {
        const alias = instanceAlias(payload.agentId);
        if (!alias) throw new Error('ZeroClaw CLI requires a persisted agent alias');
        const stateFile = stateFileFor(payload);
        return {
          args: [
            'agent', '--agent', alias,
            '--session-state-file', stateFile,
            '--log-level', 'warn',
          ],
          stdinInput: `${prompt.replace(/\s*[\r\n]+\s*/g, ' ').trim()}\n`,
          afterRun: () => {
            if (fs.existsSync(stateFile)) fs.chmodSync(stateFile, 0o600);
          },
        };
      },
    });
    this._instanceAlias = instanceAlias;
    this._stateFileFor = stateFileFor;
  }

  isAvailable(agentId: string): boolean {
    return super.isAvailable(agentId) && !!this._instanceAlias(agentId);
  }

  _instanceAlias: (agentId: string) => string | null;
  _stateFileFor: (payload: PushPayload) => string;
}

module.exports = { ZeroClawCliProvider };
