import crypto from 'node:crypto';

const KINDS = new Set(['request', 'control', 'event', 'ack']);
const OPERATIONS = new Set(['execute', 'continue', 'cancel', 'request_ack', 'accepted', 'working',
  'progress', 'message', 'artifact', 'input_required', 'auth_required', 'completed', 'failed',
  'rejected', 'cancel_ack']);
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

interface A2AEnvelope { version: 'voko.a2a/1'; kind: string; operation: string; eventId: string;
  gatewayTaskId: string; contextId: string; gatewayMessageId: string; executionId: string;
  sequence: number; agentId: string; caller: Record<string, unknown>; payload: Record<string, unknown>;
  bindingGeneration?: number; ownerEpoch?: number; policyRevision?: number;
  trace: { correlationId: string }; timestamps: { createdAt: string; expiresAt: string };
  signature?: { keyId: string; algorithm: 'Ed25519'; value: string } }

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('A2A canonical JSON rejects non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new Error('A2A canonical JSON rejects unsupported values');
}

function unsignedEnvelope(envelope: A2AEnvelope): A2AEnvelope {
  const { signature: _signature, ...unsigned } = envelope;
  return unsigned as A2AEnvelope;
}

function validateEnvelope(value: unknown, options: { now?: number } = {}): A2AEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid A2A envelope');
  const envelope = value as A2AEnvelope;
  if (envelope.version !== 'voko.a2a/1' || !KINDS.has(envelope.kind) || !OPERATIONS.has(envelope.operation)) throw new Error('Unsupported A2A envelope');
  for (const id of [envelope.eventId, envelope.gatewayTaskId, envelope.contextId, envelope.gatewayMessageId,
    envelope.executionId, envelope.agentId]) if (!ID_PATTERN.test(id || '')) throw new Error('Invalid A2A identifier');
  if (!Number.isSafeInteger(envelope.sequence) || envelope.sequence < 1) throw new Error('Invalid A2A sequence');
  for (const revision of [envelope.bindingGeneration, envelope.ownerEpoch, envelope.policyRevision]) {
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) throw new Error('Invalid A2A policy snapshot');
  }
  const createdAt = Date.parse(envelope.timestamps?.createdAt);
  const expiresAt = Date.parse(envelope.timestamps?.expiresAt);
  const now = options.now ?? Date.now();
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || expiresAt <= createdAt || expiresAt - createdAt > 86_400_000 || expiresAt < now) throw new Error('Expired A2A envelope');
  if (envelope.signature && (envelope.signature.algorithm !== 'Ed25519' || !ID_PATTERN.test(envelope.signature.keyId))) throw new Error('Invalid A2A signature metadata');
  return envelope;
}

function signEnvelope(envelope: A2AEnvelope, keyId: string, privateKey: crypto.KeyLike): A2AEnvelope {
  validateEnvelope(envelope);
  const value = crypto.sign(null, Buffer.from(canonicalJson(unsignedEnvelope(envelope))), privateKey).toString('base64');
  return { ...unsignedEnvelope(envelope), signature: { keyId, algorithm: 'Ed25519', value } };
}

function verifyEnvelope(envelope: A2AEnvelope, publicKey: crypto.KeyLike, options: { now?: number } = {}): boolean {
  validateEnvelope(envelope, options);
  if (!envelope.signature) return false;
  return crypto.verify(null, Buffer.from(canonicalJson(unsignedEnvelope(envelope))), publicKey,
    Buffer.from(envelope.signature.value, 'base64'));
}

export { canonicalJson, signEnvelope, validateEnvelope, verifyEnvelope };
export type { A2AEnvelope };
