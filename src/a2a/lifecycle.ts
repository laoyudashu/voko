import type { DatabaseSync } from 'node:sqlite';
import { initA2ADatabase } from './database';
import { resolveA2ADatabasePath } from './paths';

interface A2AModuleOptions {
  enabled?: boolean;
  databasePath?: string;
  env?: NodeJS.ProcessEnv;
  openDatabase?: (databasePath: string) => DatabaseSync;
}

function isA2AEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = String(env.VOKO_A2A_ENABLED || '').trim().toLowerCase();
  return value !== '0' && value !== 'false';
}

class A2AModule {
  readonly enabled: boolean;
  readonly databasePath: string;
  private readonly openDatabase: (databasePath: string) => DatabaseSync;
  private database: DatabaseSync | null = null;

  constructor(options: A2AModuleOptions = {}) {
    const env = options.env || process.env;
    this.enabled = options.enabled ?? isA2AEnabled(env);
    this.databasePath = options.databasePath || resolveA2ADatabasePath({ env });
    this.openDatabase = options.openDatabase || ((databasePath) => initA2ADatabase(databasePath));
  }

  get running(): boolean {
    return this.database !== null;
  }
  getDatabase(): DatabaseSync {
    if (!this.database) throw new Error('A2A module is not running');
    return this.database;
  }

  withDatabase<T>(operation: (database: DatabaseSync) => T): T {
    if (this.database) return operation(this.database);
    const database = this.openDatabase(this.databasePath);
    try { return operation(database); } finally { database.close(); }
  }

  start(): (() => void) | undefined {
    if (!this.enabled) return undefined;
    if (!this.database) this.database = this.openDatabase(this.databasePath);
    return () => this.stop();
  }

  stop(): void {
    const database = this.database;
    this.database = null;
    database?.close();
  }
}

export { A2AModule, isA2AEnabled };
export type { A2AModuleOptions };
