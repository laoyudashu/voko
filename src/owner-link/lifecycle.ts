import type { DatabaseSync } from 'node:sqlite';
import { initOwnerLinkDatabase } from './database';
import { resolveOwnerLinkDatabasePath } from './paths';

interface OwnerLinkModuleOptions {
  enabled?: boolean;
  dispatchEnabled?: boolean;
  trustedRemoteEnabled?: boolean;
  databasePath?: string;
  env?: NodeJS.ProcessEnv;
  openDatabase?: (databasePath: string) => DatabaseSync;
}

function parseFlag(value: unknown, defaultValue = false): boolean {
  if (value === undefined || value === null || String(value).trim() === '') return defaultValue;
  return ['1','true','yes','on'].includes(String(value).trim().toLowerCase());
}

function ownerLinkFlags(env: NodeJS.ProcessEnv = process.env): { trustedRemoteEnabled: boolean; verifyRoute: boolean; providerDispatch: boolean } {
  return {
    trustedRemoteEnabled: parseFlag(env.VOKO_TRUSTED_REMOTE_ENABLED, false),
    verifyRoute: parseFlag(env.VOKO_OWNER_LINK_VERIFY_ENABLED, true),
    providerDispatch: parseFlag(env.VOKO_OWNER_PROVIDER_DISPATCH_ENABLED, true),
  };
}

class OwnerLinkModule {
  readonly trustedRemoteEnabled: boolean;
  readonly enabled: boolean;
  readonly dispatchEnabled: boolean;
  readonly databasePath: string;
  private readonly openDatabase: (databasePath: string) => DatabaseSync;
  private database: DatabaseSync | null = null;
  constructor(options: OwnerLinkModuleOptions = {}) {
    const env = options.env || process.env;
    const flags = ownerLinkFlags(env);
    this.trustedRemoteEnabled = options.trustedRemoteEnabled ?? flags.trustedRemoteEnabled;
    // The dedicated master switch is deliberately required even when the legacy
    // per-feature flags are enabled. This keeps an old environment variable from
    // re-enabling the parked trusted-remote feature by accident.
    this.enabled = this.trustedRemoteEnabled && (options.enabled ?? flags.verifyRoute);
    this.dispatchEnabled = this.trustedRemoteEnabled && (options.dispatchEnabled ?? flags.providerDispatch);
    this.databasePath = options.databasePath || resolveOwnerLinkDatabasePath({ env });
    this.openDatabase = options.openDatabase || initOwnerLinkDatabase;
  }
  get running(): boolean { return this.database !== null; }
  getDatabase(): DatabaseSync {
    if (!this.database) throw new Error('Owner Link module is not running');
    return this.database;
  }
  start(): (() => void) | undefined {
    if (!this.enabled) return undefined;
    if (!this.database) this.database = this.openDatabase(this.databasePath);
    return () => this.stop();
  }
  stop(): void { const db = this.database; this.database = null; db?.close(); }
}

export { OwnerLinkModule, ownerLinkFlags };
export type { OwnerLinkModuleOptions };
