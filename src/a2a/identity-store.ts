import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

interface A2ALocalIdentity { keyId: string; publicKey: string; privateKey: string }
class A2AIdentityStore {
  constructor(private readonly db: DatabaseSync) {}
  getOrCreate(): A2ALocalIdentity {
    const row = this.db.prepare("SELECT value FROM a2a_meta WHERE key='agent_identity_v1'").get() as { value: string } | undefined;
    if (row) return JSON.parse(row.value);
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const publicPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
    const identity = { keyId: `agent-${crypto.createHash('sha256').update(publicPem).digest('hex').slice(0, 24)}`,
      publicKey: publicPem, privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() };
    this.db.prepare("INSERT INTO a2a_meta (key,value,updated_at) VALUES ('agent_identity_v1',?,?)").run(JSON.stringify(identity), Date.now());
    return identity;
  }
}
export { A2AIdentityStore };
export type { A2ALocalIdentity };
