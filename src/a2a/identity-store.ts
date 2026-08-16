import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { A2ASecretStore } from './secret-store';

interface A2ALocalIdentity { keyId: string; publicKey: string; privateKey: string; producerId: string; producerEpoch: string }
class A2AIdentityStore {
  constructor(private readonly db: DatabaseSync) {}
  getOrCreate(): A2ALocalIdentity {
    const secrets = new A2ASecretStore(this.db); const secretName = 'a2a-ed25519-v1.pem';
    const row = this.db.prepare("SELECT value FROM a2a_meta WHERE key='agent_identity_v1'").get() as { value: string } | undefined;
    if (row) {
      const stored = JSON.parse(row.value);
      if (stored.privateKey) secrets.ensure(secretName, stored.privateKey);
      const privateKey = secrets.read(secretName)?.toString();
      if (!privateKey) throw new Error('A2A_IDENTITY_PRIVATE_KEY_MISSING');
      const upgraded = { keyId: stored.keyId, publicKey: stored.publicKey,
        producerId: stored.producerId || stored.keyId, producerEpoch: stored.producerEpoch || crypto.randomUUID(),
        secretRef: secretName };
      this.db.prepare("UPDATE a2a_meta SET value=?,updated_at=? WHERE key='agent_identity_v1'")
        .run(JSON.stringify(upgraded), Date.now());
      return { ...upgraded, privateKey };
    }
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const publicPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
    const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const identity = { keyId: `agent-${crypto.createHash('sha256').update(publicPem).digest('hex').slice(0, 24)}`,
      publicKey: publicPem,
      producerId: `agent-${crypto.createHash('sha256').update(publicPem).digest('hex').slice(0, 24)}`,
      producerEpoch: crypto.randomUUID(), secretRef: secretName };
    secrets.create(secretName, privatePem);
    this.db.prepare("INSERT INTO a2a_meta (key,value,updated_at) VALUES ('agent_identity_v1',?,?)").run(JSON.stringify(identity), Date.now());
    return { ...identity, privateKey: privatePem };
  }
}
export { A2AIdentityStore };
export type { A2ALocalIdentity };
