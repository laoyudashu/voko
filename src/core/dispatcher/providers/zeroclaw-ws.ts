const { WebSocket } = require('ws');
const { AcpAdapter } = require('../../adapters/acp-adapter');
import type { AgentMeta } from '../types';
import type { CliProviderOptions } from '../../adapters/cli-adapter';

interface InstanceRow {
  backend_instance_id?: string | null;
}

class GuardedWebSocket extends WebSocket {
  constructor(url: string, protocols?: string | string[], options?: { headers?: Record<string, string> }) {
    super(url, protocols, options);
    // The ACP SDK may cancel its Web stream during shutdown while ws is still
    // finishing the upgrade. Keep that transport error from becoming an
    // uncaught EventEmitter error; connectWith still receives the failure.
    this.on('error', () => {});
  }
}

function configuredUrl(): string | null {
  const raw = String(process.env.ZEROCLAW_ACP_URL || 'ws://127.0.0.1:42617/acp').trim();
  try {
    const url = new URL(raw);
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
    if (!loopback || !['ws:', 'wss:'].includes(url.protocol) || url.username || url.password
      || url.search || url.hash) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function configuredToken(): string | null {
  const token = String(process.env.ZEROCLAW_ACP_TOKEN || '').trim();
  return token && !/[\r\n]/.test(token) ? token : null;
}

class ZeroClawWsProvider extends AcpAdapter {
  _db: any;
  _instanceAlias: (agentId: string) => string | null;

  constructor(options: CliProviderOptions = {}) {
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
      name: 'ZEROCLAW ACP WS',
      matchType: 'zeroclaw',
      adapterType: 'zeroclaw-ws',
      db,
      sessionPersistence: options.sessionPersistence,
      cwd: options.cwd,
      connectionKey: () => configuredUrl() || 'zeroclaw-ws',
      sessionRequest: (agentId: string) => {
        const alias = instanceAlias(agentId);
        return alias ? { agentAlias: alias } : {};
      },
      streamFactory: async () => {
        const url = configuredUrl();
        const token = configuredToken();
        if (!url || !token) throw new Error('ZeroClaw ACP WebSocket is not configured');
        const wsClientModule = '@agentclientprotocol/sdk/experimental/ws-client';
        const wsSdk = await import(wsClientModule);
        const stream = wsSdk.createWebSocketStream(url, {
          WebSocket: GuardedWebSocket,
          protocols: ['zeroclaw.acp.v1'],
          headers: { Authorization: `Bearer ${token}` },
          cookies: 'omit',
        });
        return { stream };
      },
    });
    this._db = db;
    this._instanceAlias = instanceAlias;
  }

  get priority() { return 20; }
  get capabilities() {
    return ['acp', 'websocket', 'streaming', 'session_resume', 'shared_connection'];
  }

  match(_agentId: string, meta?: AgentMeta | null): boolean {
    return meta?.backend_type === 'zeroclaw';
  }

  isAvailable(agentId: string): boolean {
    return super.isAvailable(agentId)
      && !!configuredUrl()
      && !!configuredToken()
      && !!this._instanceAlias(agentId);
  }

  async preflightDelivery(agentId: string): Promise<Record<string, unknown>> {
    const missing: string[] = [];
    if (!configuredUrl()) missing.push('ZEROCLAW_ACP_URL');
    if (!configuredToken()) missing.push('ZEROCLAW_ACP_TOKEN');
    if (!this._instanceAlias(agentId)) missing.push('backend_instance_id');
    if (missing.length > 0) {
      return {
        ok: false,
        status: 'configuration_required',
        code: 'ZEROCLAW_ACP_WS_CONFIGURATION_REQUIRED',
        missing,
        sideEffects: false,
      };
    }
    const ready = this.isAvailable(agentId);
    return { ok: ready, status: ready ? 'preflight_passed' : 'unavailable', sideEffects: false };
  }
}

module.exports = {
  ZeroClawWsProvider,
  configuredUrl,
  configuredToken,
};
