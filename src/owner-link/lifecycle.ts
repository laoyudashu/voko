import type { DatabaseSync } from 'node:sqlite';
import { initOwnerLinkDatabase } from './database';
import { resolveOwnerLinkDatabasePath } from './paths';

interface OwnerLinkModuleOptions {
  enabled?: boolean;
  dispatchEnabled?: boolean;
  databasePath?: string;
  env?: NodeJS.ProcessEnv;
  openDatabase?: (databasePath: string) => DatabaseSync;
}

function parseFlag(value: unknown, defaultValue = false): boolean {
  if (value === undefined || value === null || String(value).trim() === '') return defaultValue;
  return ['1','true','yes','on'].includes(String(value).trim().toLowerCase());
}

function ownerLinkFlags(env: NodeJS.ProcessEnv = process.env): { verifyRoute: boolean; providerDispatch: boolean } {
  return {
    verifyRoute: parseFlag(env.VOKO_OWNER_LINK_VERIFY_ENABLED, true),
    providerDispatch: parseFlag(env.VOKO_OWNER_PROVIDER_DISPATCH_ENABLED, true),
  };
}

class OwnerLinkModule {
  readonly enabled: boolean;
  readonly dispatchEnabled: boolean;
  readonly databasePath: string;
  private readonly openDatabase: (databasePath: string) => DatabaseSync;
  private database: DatabaseSync | null = null;
  constructor(options: OwnerLinkModuleOptions = {}) {
    const env = options.env || process.env;
    const flags = ownerLinkFlags(env);
    this.enabled = options.enabled ?? flags.verifyRoute;
    this.dispatchEnabled = options.dispatchEnabled ?? flags.providerDispatch;
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
