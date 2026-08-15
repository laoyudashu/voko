import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

function databasePath(db: DatabaseSync): string {
  const rows = db.prepare('PRAGMA database_list').all() as Array<{ name: string; file: string }>;
  const file = rows.find(row => row.name === 'main')?.file;
  if (!file) throw new Error('A2A_SECRET_DATABASE_PATH_UNAVAILABLE');
  return path.resolve(file);
}

class A2ASecretStore {
  readonly directory: string;
  constructor(db: DatabaseSync) {
    this.directory = path.join(path.dirname(databasePath(db)), '.voko-secrets');
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.directory, 0o700); } catch (_) {}
  }
  path(name: string): string {
    if (!/^[a-z0-9._-]{1,80}$/i.test(name)) throw new Error('A2A_SECRET_NAME_INVALID');
    return path.join(this.directory, name);
  }
  read(name: string): Buffer | null {
    try { return fs.readFileSync(this.path(name)); }
    catch (error: any) { if (error?.code === 'ENOENT') return null; throw error; }
  }
  create(name: string, value: Buffer | string): void {
    fs.writeFileSync(this.path(name), value, { flag: 'wx', mode: 0o600 });
    try { fs.chmodSync(this.path(name), 0o600); } catch (_) {}
  }
  ensure(name: string, value: Buffer | string): void {
    const existing = this.read(name); const expected = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (existing) {
      if (!existing.equals(expected)) throw new Error('A2A_SECRET_CONFLICT');
      return;
    }
    this.create(name, expected);
  }
}

export { A2ASecretStore };
