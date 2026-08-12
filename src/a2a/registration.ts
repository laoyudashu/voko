import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { A2AIdentityStore } from './identity-store';

interface RegistrationOptions { mainDb: any; a2aDb: DatabaseSync; apiBaseUrl: string; ownerEmail: string;
  userAccessToken: string; fetchImpl?: typeof fetch }
class A2ARegistrationService {
  constructor(private readonly options: RegistrationOptions) {}
  async ensureRegistered(): Promise<Record<string, any>> {
    const identity = new A2AIdentityStore(this.options.a2aDb).getOrCreate();
    const agents: Array<{ publicAgentId: string; localAgentId: string }> = this.options.mainDb.prepare(`SELECT agent_id FROM agents WHERE publish_status='published' AND LOWER(TRIM(owner_email))=? ORDER BY agent_id`)
      .all(this.options.ownerEmail.toLowerCase()).map((row: any) => ({ publicAgentId: row.agent_id, localAgentId: row.agent_id }));
    if (!agents.length) throw new Error('A2A requires at least one published Agent');
    let deviceId = (this.options.a2aDb.prepare("SELECT value FROM a2a_meta WHERE key='device_id'").get() as any)?.value;
    if (!deviceId) { deviceId = crypto.randomUUID(); this.options.a2aDb.prepare("INSERT INTO a2a_meta(key,value,updated_at) VALUES('device_id',?,?)").run(deviceId, Date.now()); }
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ agents, keyId: identity.keyId })).digest('hex');
    const existingRow = this.options.a2aDb.prepare("SELECT value FROM a2a_settings WHERE key='bridge_config_v1'").get() as any;
    if (existingRow) { const existing = JSON.parse(existingRow.value); if (existing.fingerprint === fingerprint) return existing; }
    const baseUrl = this.options.apiBaseUrl.replace(/\/+$/, ''); const response = await (this.options.fetchImpl || fetch)(`${baseUrl}/api/a2a/v1/devices/register`, {
      method: 'POST', headers: { authorization: `Bearer ${this.options.userAccessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId, keyId: identity.keyId, publicKey: identity.publicKey, agents }), signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`A2A device registration failed (${response.status})`);
    const result: any = await response.json();
    const config = { fingerprint, deviceId, token: result.token, mailboxUrl: `${baseUrl}${result.mailboxPath}`,
      gatewayKeyId: result.gatewayKeyId, gatewayPublicKeyB64: Buffer.from(result.gatewayPublicKey).toString('base64'),
      registeredAgentIds: Array.isArray(result.registeredAgentIds) ? result.registeredAgentIds : agents.map((agent) => agent.publicAgentId),
      rejectedAgentIds: Array.isArray(result.rejectedAgentIds) ? result.rejectedAgentIds : [] };
    this.options.a2aDb.prepare(`INSERT INTO a2a_settings(key,value,updated_at) VALUES('bridge_config_v1',?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(JSON.stringify(config), Date.now());
    return config;
  }
}
export { A2ARegistrationService };
export type { RegistrationOptions };
