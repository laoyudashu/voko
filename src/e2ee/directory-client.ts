const MAX_HANDSHAKE_BYTES = 256 * 1024;

export interface E2eeDirectoryEstablishment {
  establishmentId: string;
  creatorPrincipalId: string;
  keyPackageRef: string;
  keyEpoch: number;
  groupId: string;
  conversationScope: string;
  commit: string;
  welcome: string;
  state: 'commit_accepted';
  conversationMode: 'e2ee_available'|'e2ee_active'|'e2ee_required';
  ownerEpoch: number;
  bindingGeneration: number;
  policyRevision: number;
  mlsEpoch: number;
  expiresAt: string;
}

function bounded(value: unknown, name: string, max = 2048): string {
  const result = String(value || '');
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/.test(result)) throw new Error(`E2EE_DIRECTORY_INVALID_${name}`);
  return result;
}

function base64url(value: unknown, name: string, maxBytes = MAX_HANDSHAKE_BYTES): string {
  const result = bounded(value, name, Math.ceil(maxBytes * 4 / 3) + 4);
  if (!/^[A-Za-z0-9_-]+$/.test(result)) throw new Error(`E2EE_DIRECTORY_INVALID_${name}`);
  const bytes = Buffer.from(result, 'base64url');
  if (!bytes.length || bytes.length > maxBytes || bytes.toString('base64url') !== result) {
    throw new Error(`E2EE_DIRECTORY_INVALID_${name}`);
  }
  return result;
}

export class E2eeDirectoryClient {
  private readonly baseUrl: string;
  constructor(private readonly options: { baseUrl: string; token: string; timeoutMs?: number; fetchImpl?: typeof fetch }) {
    this.baseUrl = bounded(options.baseUrl, 'BASE_URL', 2048).replace(/\/+$/, '');
    if (!/^https:\/\//i.test(this.baseUrl) && !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(this.baseUrl)) {
      throw new Error('E2EE_DIRECTORY_HTTPS_REQUIRED');
    }
    bounded(options.token, 'TOKEN', 8192);
  }

  private async request(path: string, init: RequestInit = {}): Promise<any> {
    const response = await (this.options.fetchImpl || fetch)(`${this.baseUrl}/api/external${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.options.token}`, accept: 'application/json',
        ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers || {}) },
      signal: AbortSignal.timeout(this.options.timeoutMs || 10_000),
    });
    let body: any = null;
    try { body = await response.json(); } catch { /* stable error below */ }
    if (!response.ok || !body?.success) {
      const error: any = new Error(String(body?.error?.message || body?.message || `E2EE directory HTTP ${response.status}`));
      error.code = String(body?.error?.code || body?.code || `E2EE_DIRECTORY_HTTP_${response.status}`);
      error.status = response.status;
      error.operation = path;
      if (response.status === 429) {
        const seconds = Number.parseInt(response.headers.get('retry-after') || '', 10);
        error.retryAfterMs = Number.isSafeInteger(seconds) && seconds > 0 ? Math.min(seconds, 300) * 1000 : 60_000;
      }
      throw error;
    }
    return body.data;
  }

  status(): Promise<any> { return this.request('/v1/e2ee/status'); }

  registerDevice(input: { ownerDeviceKeyId: string; keyEpoch: number; credentialPublicKey: string }): Promise<any> {
    return this.request('/v1/e2ee/devices', { method: 'POST', body: JSON.stringify(input) });
  }

  publishKeyPackage(input: { agentId: string; ownerDeviceKeyId: string; keyEpoch: number; keyPackage: string; expiresAtMs: number }): Promise<any> {
    return this.request('/v1/e2ee/key-packages', { method: 'POST', body: JSON.stringify(input) });
  }

  keyPackageStatus(input: { ownerDeviceKeyId: string; agentIds: string[] }): Promise<any> {
    return this.request('/v1/e2ee/key-packages/status', { method: 'POST', body: JSON.stringify(input) });
  }

  async pullEstablishments(input: { agentId: string; ownerDeviceKeyId: string; limit?: number }): Promise<E2eeDirectoryEstablishment[]> {
    const data = await this.request('/v1/e2ee/establishments/pull', { method: 'POST', body: JSON.stringify(input) });
    if (!Array.isArray(data?.establishments)) throw new Error('E2EE_DIRECTORY_INVALID_ESTABLISHMENTS');
    return data.establishments.map((row: any) => ({
      establishmentId: bounded(row.establishmentId, 'ESTABLISHMENT_ID'),
      creatorPrincipalId: bounded(row.creatorPrincipalId, 'CREATOR_PRINCIPAL_ID'),
      keyPackageRef: base64url(row.keyPackageRef, 'KEY_PACKAGE_REF', 64),
      keyEpoch: Number(row.keyEpoch),
      groupId: base64url(row.groupId, 'GROUP_ID', 255),
      conversationScope: base64url(row.conversationScope, 'CONVERSATION_SCOPE', 255),
      commit: base64url(row.commit, 'COMMIT'), welcome: base64url(row.welcome, 'WELCOME'),
      state: row.state === 'commit_accepted' ? row.state : (() => { throw new Error('E2EE_DIRECTORY_INVALID_STATE'); })(),
      conversationMode: row.conversationMode === 'e2ee_required' ? row.conversationMode
        : row.conversationMode === 'e2ee_active' ? row.conversationMode : 'e2ee_available',
      ownerEpoch: Number(row.ownerEpoch), bindingGeneration: Number(row.bindingGeneration),
      policyRevision: Number(row.policyRevision), mlsEpoch: Number(row.mlsEpoch),
      expiresAt: bounded(row.expiresAt, 'EXPIRES_AT'),
    })).map((row: E2eeDirectoryEstablishment) => {
      if (!Number.isSafeInteger(row.keyEpoch) || row.keyEpoch < 1) throw new Error('E2EE_DIRECTORY_INVALID_KEY_EPOCH');
      if (![row.ownerEpoch,row.bindingGeneration,row.policyRevision].every(value => Number.isSafeInteger(value) && value >= 1)
          || !Number.isSafeInteger(row.mlsEpoch) || row.mlsEpoch < 0) throw new Error('E2EE_DIRECTORY_INVALID_GENERATION');
      if (!Number.isFinite(Date.parse(row.expiresAt))) throw new Error('E2EE_DIRECTORY_INVALID_EXPIRES_AT');
      return row;
    });
  }

  acknowledge(input: { establishmentId: string; agentId: string; ownerDeviceKeyId: string; ack: string }): Promise<any> {
    return this.request('/v1/e2ee/establishments/ack', { method: 'POST', body: JSON.stringify(input) });
  }

  reject(input: { establishmentId: string; agentId: string; ownerDeviceKeyId: string;
    reasonCode: 'INVALID_WELCOME'|'SCOPE_MISMATCH'|'LOCAL_CRYPTO_ERROR' }): Promise<any> {
    return this.request('/v1/e2ee/establishments/reject', { method: 'POST', body: JSON.stringify(input) });
  }
}

module.exports = { E2eeDirectoryClient };
