import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

interface OwnerGatewayKeyDefinition {
  keyId: string;
  algorithm: 'Ed25519';
  publicKeySpkiBase64: string;
  status: 'active' | 'previous';
}

const KEY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function normalizeKey(value: unknown): OwnerGatewayKeyDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('OWNER_KEY_CONFIG_INVALID');
  const row = value as Record<string, unknown>;
  const allowed = new Set(['keyId','algorithm','publicKeySpkiBase64','status']);
  if (Object.keys(row).some((key) => !allowed.has(key))) throw new Error('OWNER_KEY_CONFIG_INVALID');
  if (!KEY_ID_PATTERN.test(String(row.keyId || '')) || row.algorithm !== 'Ed25519'
    || !['active','previous'].includes(String(row.status))) throw new Error('OWNER_KEY_CONFIG_INVALID');
  const der = Buffer.from(String(row.publicKeySpkiBase64 || ''), 'base64');
  if (!der.length || der.length > 256) throw new Error('OWNER_KEY_CONFIG_INVALID');
  const publicKey = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('OWNER_KEY_CONFIG_INVALID');
  return { keyId: String(row.keyId), algorithm: 'Ed25519', publicKeySpkiBase64: der.toString('base64'),
    status: row.status as 'active'|'previous' };
}

class OwnerGatewayKeyStore {
  private readonly cache = new Map<string, crypto.KeyObject>();
  constructor(private readonly db: DatabaseSync) { this.reload(); }

  configure(values: unknown): number {
    if (!Array.isArray(values) || values.length < 1 || values.length > 2) throw new Error('OWNER_KEY_CONFIG_INVALID');
    const keys = values.map(normalizeKey);
    if (new Set(keys.map((key) => key.keyId)).size !== keys.length
      || keys.filter((key) => key.status === 'active').length !== 1
      || keys.filter((key) => key.status === 'previous').length > 1) throw new Error('OWNER_KEY_CONFIG_INVALID');
    this.db.prepare(`INSERT INTO owner_link_settings(key,value,updated_at) VALUES('gateway_keys_v1',?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
      .run(JSON.stringify(keys), Date.now());
    this.reload();
    return keys.length;
  }

  configureFromEnvironment(env: NodeJS.ProcessEnv = process.env): number {
    const raw = String(env.VOKO_OWNER_GATEWAY_KEYS_JSON || '').trim();
    if (!raw) return this.cache.size;
    return this.configure(JSON.parse(raw));
  }

  resolve(keyId: string): crypto.KeyObject | null { return this.cache.get(keyId) || null; }
  count(): number { return this.cache.size; }

  private reload(): void {
    this.cache.clear();
    const row = this.db.prepare("SELECT value FROM owner_link_settings WHERE key='gateway_keys_v1'").get() as { value?: string } | undefined;
    if (!row?.value) return;
    const values = JSON.parse(row.value);
    if (!Array.isArray(values)) throw new Error('OWNER_KEY_CONFIG_INVALID');
    for (const value of values) {
      const key = normalizeKey(value);
      this.cache.set(key.keyId, crypto.createPublicKey({ key: Buffer.from(key.publicKeySpkiBase64, 'base64'), format: 'der', type: 'spki' }));
    }
  }
}

export { OwnerGatewayKeyStore };
export type { OwnerGatewayKeyDefinition };
