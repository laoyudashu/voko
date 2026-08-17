const CONTENT_TYPE_E2EE = 13;
const MAX_ENVELOPE_BYTES = 540 * 1024;

export interface CanaryScope {
  localAgentId: string;
  targetAgentDid: string;
  senderDeviceKeyId: string;
  recipientDeviceKeyId: string;
  ownerScope: string;
  groupId: string;
  conversationScope: string;
}

export interface CanaryEnvelope {
  version: 'voko.e2ee/1'; contentType: 13; groupId: string; epoch: number;
  targetAgentDid: string; conversationScope: string; senderDeviceKeyId: string;
  messageId: string; channelType: 1; ciphertext: string;
}

function safe(value: unknown, max = 2048): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

export function parseCanaryEnvelope(content: unknown): CanaryEnvelope {
  const text = typeof content === 'string' ? content : '';
  if (!text || Buffer.byteLength(text) > MAX_ENVELOPE_BYTES) throw new Error('E2EE_ENVELOPE_INVALID');
  let row: Record<string, unknown>;
  try { row = JSON.parse(text); } catch { throw new Error('E2EE_ENVELOPE_INVALID'); }
  const expected = ['version','contentType','groupId','epoch','targetAgentDid','conversationScope','senderDeviceKeyId','messageId','channelType','ciphertext'];
  if (!row || Array.isArray(row) || Object.keys(row).sort().join() !== expected.sort().join()
      || row.version !== 'voko.e2ee/1' || row.contentType !== CONTENT_TYPE_E2EE || row.channelType !== 1
      || !Number.isSafeInteger(row.epoch) || Number(row.epoch) < 0
      || !safe(row.groupId) || !safe(row.targetAgentDid) || !safe(row.conversationScope)
      || !safe(row.senderDeviceKeyId) || !safe(row.messageId) || !safe(row.ciphertext, 512 * 1024)
      || !/^[A-Za-z0-9+/=_-]+$/.test(String(row.ciphertext))) throw new Error('E2EE_ENVELOPE_INVALID');
  return row as unknown as CanaryEnvelope;
}

export class CanaryRuntimePolicy {
  private readonly scopes = new Map<string, CanaryScope>();
  readonly enabled: boolean;

  constructor(env: NodeJS.ProcessEnv = process.env, productionEnabled = false) {
    this.enabled = env.VOKO_E2EE_INTERNAL_RUNTIME_ENABLED === 'true' && productionEnabled === false;
    let configured: unknown = [];
    try { configured = JSON.parse(env.VOKO_E2EE_INTERNAL_RUNTIME_SCOPES || '[]'); } catch { configured = []; }
    if (!Array.isArray(configured)) configured = [];
    for (const candidate of configured as Record<string, unknown>[]) {
      if (!candidate || !safe(candidate.localAgentId, 128) || !safe(candidate.targetAgentDid)
          || !safe(candidate.senderDeviceKeyId) || !safe(candidate.groupId) || !safe(candidate.conversationScope)) continue;
      if (!safe(candidate.recipientDeviceKeyId) || !safe(candidate.ownerScope)) continue;
      const scope = candidate as unknown as CanaryScope;
      this.scopes.set(`${scope.localAgentId}\0${scope.groupId}\0${scope.senderDeviceKeyId}`, Object.freeze({ ...scope }));
    }
  }

  claims(contentType: unknown): boolean { return Number(contentType) === CONTENT_TYPE_E2EE; }

  authorize(localAgentId: string, envelope: CanaryEnvelope): CanaryScope {
    if (!this.enabled) throw new Error('E2EE_CANARY_DISABLED');
    const scope = this.scopes.get(`${localAgentId}\0${envelope.groupId}\0${envelope.senderDeviceKeyId}`);
    if (!scope || scope.targetAgentDid !== envelope.targetAgentDid
        || scope.conversationScope !== envelope.conversationScope) throw new Error('E2EE_CANARY_SCOPE_REJECTED');
    return scope;
  }

  count(): number { return this.scopes.size; }
  configuredScopes(): CanaryScope[] { return [...this.scopes.values()]; }
}

module.exports = { CanaryRuntimePolicy, parseCanaryEnvelope, CONTENT_TYPE_E2EE, MAX_ENVELOPE_BYTES };
