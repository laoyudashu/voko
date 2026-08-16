import crypto from 'node:crypto';
import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { A2ASecretStore } from './secret-store';

const SCOPE_VERSION = 1;

function encodeParts(parts: string[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const value = Buffer.from(part, 'utf8');
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(value.length);
    chunks.push(length, value);
  }
  return Buffer.concat(chunks);
}

function loadOrCreateScopeKey(db: DatabaseSync): { key: Buffer; keyId: string; version: number } {
  const secrets = new A2ASecretStore(db); const secretName = 'a2a-scope-hmac-v1.key';
  let key = secrets.read(secretName);
  const rows = db.prepare('PRAGMA database_list').all() as Array<{ name: string; file: string }>;
  const legacyPath = `${rows.find(row => row.name === 'main')?.file}.scope-key-v1`;
  if (!key && legacyPath && fs.existsSync(legacyPath)) {
    key = Buffer.from(fs.readFileSync(legacyPath, 'utf8').trim(), 'base64');
    secrets.create(secretName, key); fs.unlinkSync(legacyPath);
  }
  if (!key) {
    const recorded = db.prepare("SELECT value FROM a2a_meta WHERE key='scope_key_id_v1'").get();
    if (recorded) throw new Error('A2A_SCOPE_KEY_MISSING');
    key = crypto.randomBytes(32); secrets.create(secretName, key);
  }
  if (key.length !== 32) throw new Error('A2A_SCOPE_KEY_INVALID');
  return { key, keyId: crypto.createHash('sha256').update(key).digest('hex').slice(0, 16), version: SCOPE_VERSION };
}

class A2AScopeResolver {
  readonly keyId: string;
  readonly version: number;
  private readonly key: Buffer;
  constructor(db: DatabaseSync) {
    const loaded = loadOrCreateScopeKey(db);
    this.key = loaded.key;
    this.keyId = loaded.keyId;
    this.version = loaded.version;
    const row = db.prepare("SELECT value FROM a2a_meta WHERE key='scope_key_id_v1'").get() as { value?: string } | undefined;
    if (row?.value && row.value !== this.keyId) {
      db.prepare("UPDATE a2a_local_contexts SET status='stale',updated_at=? WHERE status='active'").run(Date.now());
      throw new Error('A2A_SCOPE_KEY_MISMATCH');
    }
    db.prepare(`INSERT INTO a2a_meta(key,value,updated_at) VALUES('scope_key_id_v1',?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(this.keyId, Date.now());
  }
  private digest(parts: string[]): string {
    return crypto.createHmac('sha256', this.key).update(encodeParts(parts)).digest('base64url');
  }
  principalScope(input: { issuer: string; provenance: string; principalId: string }): string {
    if (!input.issuer || !input.provenance || !input.principalId) throw new Error('A2A_PRINCIPAL_SCOPE_REQUIRED');
    return this.digest(['voko-a2a-principal/v1', input.issuer, input.provenance, input.principalId]);
  }
  sessionScope(agentId: string, principalScope: string, contextId: string): string {
    if (!agentId || !principalScope || !contextId) throw new Error('A2A_PRINCIPAL_SCOPE_REQUIRED');
    return this.digest(['voko-a2a-session/v1', agentId, principalScope, contextId]);
  }
}

export { A2AScopeResolver, SCOPE_VERSION };
