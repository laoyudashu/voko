import crypto from 'node:crypto';

const KINDS = new Set(['request', 'control', 'event', 'ack']);
const OPERATIONS = new Set(['execute', 'continue', 'cancel', 'request_ack', 'accepted', 'working',
  'progress', 'message', 'artifact', 'input_required', 'auth_required', 'completed', 'failed',
  'rejected', 'cancel_ack']);
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

interface A2ACaller { principalId: string; actorKind: 'agent' | 'human'; provenance: string; issuer?: string }
interface A2AEnvelope { version: 'voko.a2a/1'; kind: string; operation: string; eventId: string;
  gatewayTaskId: string; contextId: string; gatewayMessageId: string; executionId: string;
  commandSequence?: number; producerId?: string; producerEpoch?: string; producerSequence?: number;
  agentId: string; caller: A2ACaller; payload: Record<string, unknown>;
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

function validatePayload(envelope: A2AEnvelope): void {
  const payload = envelope.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || Buffer.byteLength(JSON.stringify(payload), 'utf8') > 7168) throw new Error('Invalid A2A payload');
  if (envelope.operation === 'cancel_ack' && !['accepted', 'unsupported', 'too_late'].includes(String(payload.result || '')))
    throw new Error('Invalid A2A cancellation result');
  if (envelope.operation !== 'artifact') return;
  const artifact = (payload.artifact || payload) as Record<string, any>;
  const index = Number(payload.index || 0);
  if (!ID_PATTERN.test(String(artifact.artifactId || '')) || !Number.isSafeInteger(index) || index < 0
    || !Array.isArray(artifact.parts) || artifact.parts.length === 0) throw new Error('Invalid A2A artifact');
  for (const part of artifact.parts) {
    if (typeof part?.text === 'string' && part.text && Buffer.byteLength(part.text, 'utf8') <= 6144) continue;
    if (ID_PATTERN.test(String(part?.artifactRef || '')) && Object.keys(part).every((key) => key === 'artifactRef')) continue;
    throw new Error('Invalid A2A artifact part');
  }
}

function validateEnvelope(value: unknown, options: { now?: number } = {}): A2AEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid A2A envelope');
  const envelope = value as A2AEnvelope;
  if (envelope.version !== 'voko.a2a/1' || !KINDS.has(envelope.kind) || !OPERATIONS.has(envelope.operation)) throw new Error('Unsupported A2A envelope');
  for (const id of [envelope.eventId, envelope.gatewayTaskId, envelope.contextId, envelope.gatewayMessageId,
    envelope.executionId, envelope.agentId]) if (!ID_PATTERN.test(id || '')) throw new Error('Invalid A2A identifier');
  if ('sequence' in envelope) throw new Error('Legacy A2A sequence is not supported');
  if (['request', 'control'].includes(envelope.kind)) {
    if (!Number.isSafeInteger(envelope.commandSequence) || Number(envelope.commandSequence) < 1)
      throw new Error('Invalid A2A command sequence');
  } else if (!ID_PATTERN.test(String(envelope.producerId || ''))
    || !ID_PATTERN.test(String(envelope.producerEpoch || ''))
    || !Number.isSafeInteger(envelope.producerSequence) || Number(envelope.producerSequence) < 1) {
    throw new Error('Invalid A2A producer sequence');
  }
  const caller = envelope.caller;
  if (!caller || !ID_PATTERN.test(String(caller.principalId || ''))
    || !['agent', 'human'].includes(String(caller.actorKind || ''))
    || !ID_PATTERN.test(String(caller.provenance || ''))
    || (caller.issuer !== undefined && !ID_PATTERN.test(String(caller.issuer)))) {
    throw new Error('Invalid A2A caller');
  }
  validatePayload(envelope);
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
export type { A2ACaller, A2AEnvelope };
