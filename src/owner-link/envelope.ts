import crypto from 'node:crypto';
import type { OwnerOperation, VokoOwnerEnvelope } from './contracts/voko-owner-v1';

const OWNER_VERSION = 'voko.owner/1' as const;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;
const ENVELOPE_KEYS = new Set(['version','kind','messageId','ownerConversationId','ownerIdentityId','ownerImUid',
  'agentId','ownershipEpoch','conversationEpoch','sequence','operation','payload','payloadDigest','keyId',
  'algorithm','createdAt','expiresAt','signature']);
const KINDS = new Set(['command','receipt','event']);
const OPERATIONS = new Set(['execute','cancel','accepted','working','completed','failed','canceled']);

class StrictJsonParser {
  private index = 0;
  constructor(private readonly input: string) {}
  parse(): unknown {
    const value = this.value(); this.space();
    if (this.index !== this.input.length) throw new Error('OWNER_JSON_TRAILING_DATA');
    return value;
  }
  private space(): void { while (/\s/.test(this.input[this.index] || '')) this.index += 1; }
  private value(): unknown {
    this.space(); const ch = this.input[this.index];
    if (ch === '{') return this.object();
    if (ch === '[') return this.array();
    if (ch === '"') return this.string();
    if (ch === '-' || /[0-9]/.test(ch || '')) return this.number();
    for (const [token, value] of [['true', true], ['false', false], ['null', null]] as const) {
      if (this.input.startsWith(token, this.index)) { this.index += token.length; return value; }
    }
    throw new Error('OWNER_JSON_INVALID_VALUE');
  }
  private object(): Record<string, unknown> {
    this.index += 1; const result: Record<string, unknown> = Object.create(null); const seen = new Set<string>();
    this.space(); if (this.input[this.index] === '}') { this.index += 1; return result; }
    while (true) {
      this.space(); if (this.input[this.index] !== '"') throw new Error('OWNER_JSON_INVALID_OBJECT_KEY');
      const key = this.string(); if (seen.has(key)) throw new Error('OWNER_JSON_DUPLICATE_KEY'); seen.add(key);
      this.space(); if (this.input[this.index] !== ':') throw new Error('OWNER_JSON_INVALID_OBJECT');
      this.index += 1; result[key] = this.value(); this.space();
      const ch = this.input[this.index++]; if (ch === '}') return result;
      if (ch !== ',') throw new Error('OWNER_JSON_INVALID_OBJECT');
    }
  }
  private array(): unknown[] {
    this.index += 1; const result: unknown[] = []; this.space();
    if (this.input[this.index] === ']') { this.index += 1; return result; }
    while (true) {
      result.push(this.value()); this.space(); const ch = this.input[this.index++];
      if (ch === ']') return result; if (ch !== ',') throw new Error('OWNER_JSON_INVALID_ARRAY');
    }
  }
  private string(): string {
    const start = this.index; this.index += 1; let escaped = false;
    while (this.index < this.input.length) {
      const code = this.input.charCodeAt(this.index); const ch = this.input[this.index++];
      if (!escaped && ch === '"') { const value = JSON.parse(this.input.slice(start, this.index)); assertWellFormedUnicode(value); return value; }
      if (!escaped && code < 0x20) throw new Error('OWNER_JSON_INVALID_STRING');
      if (!escaped && ch === '\\') escaped = true; else escaped = false;
    }
    throw new Error('OWNER_JSON_UNTERMINATED_STRING');
  }
  private number(): number {
    const match = this.input.slice(this.index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match) throw new Error('OWNER_JSON_INVALID_NUMBER');
    this.index += match[0].length; const value = Number(match[0]);
    if (!Number.isFinite(value)) throw new Error('OWNER_JSON_NON_FINITE_NUMBER'); return value;
  }
}

function assertWellFormedUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('OWNER_JSON_INVALID_UNICODE');
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error('OWNER_JSON_INVALID_UNICODE');
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') { assertWellFormedUnicode(value); return JSON.stringify(value); }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('OWNER_CANONICAL_NON_FINITE_NUMBER');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(',')}}`;
  }
  throw new Error('OWNER_CANONICAL_UNSUPPORTED_VALUE');
}

function digestPayload(payload: Record<string, unknown>): string {
  return crypto.createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

function unsignedEnvelope(envelope: VokoOwnerEnvelope): Omit<VokoOwnerEnvelope, 'signature'> {
  const { signature: _signature, ...unsigned } = envelope;
  return unsigned;
}

function validateOwnerEnvelope(value: unknown, options: { now?: number } = {}): VokoOwnerEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('OWNER_ENVELOPE_INVALID');
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (keys.length !== ENVELOPE_KEYS.size || keys.some((key) => !ENVELOPE_KEYS.has(key))) throw new Error('OWNER_ENVELOPE_ADDITIONAL_PROPERTY');
  if (row.version !== OWNER_VERSION || !KINDS.has(String(row.kind)) || !OPERATIONS.has(String(row.operation))) throw new Error('OWNER_ENVELOPE_UNSUPPORTED');
  for (const key of ['messageId','ownerConversationId','ownerIdentityId','ownerImUid','agentId','keyId']) {
    if (!ID_PATTERN.test(String(row[key] || ''))) throw new Error('OWNER_IDENTIFIER_INVALID');
  }
  for (const key of ['ownershipEpoch','conversationEpoch','sequence']) {
    if (!Number.isSafeInteger(row[key]) || Number(row[key]) < 1) throw new Error('OWNER_SEQUENCE_INVALID');
  }
  if (row.algorithm !== 'Ed25519') throw new Error('OWNER_ALGORITHM_UNSUPPORTED');
  if (!row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)
    || Object.keys(row.payload as object).length > 32) throw new Error('OWNER_PAYLOAD_INVALID');
  if (!DIGEST_PATTERN.test(String(row.payloadDigest || '')) || digestPayload(row.payload as Record<string, unknown>) !== row.payloadDigest) {
    throw new Error('OWNER_DIGEST_MISMATCH');
  }
  const createdAt = Date.parse(String(row.createdAt || '')); const expiresAt = Date.parse(String(row.expiresAt || ''));
  const now = options.now ?? Date.now();
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || expiresAt <= createdAt
    || expiresAt - createdAt > MAX_LIFETIME_MS || createdAt > now + CLOCK_SKEW_MS || expiresAt < now) throw new Error('OWNER_ENVELOPE_EXPIRED');
  if (typeof row.signature !== 'string' || row.signature.length < 1 || row.signature.length > 256
    || Buffer.from(row.signature, 'base64').length !== 64) throw new Error('OWNER_SIGNATURE_INVALID');
  return row as unknown as VokoOwnerEnvelope;
}

function parseOwnerEnvelopeJson(raw: string, options: { now?: number } = {}): VokoOwnerEnvelope {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 8192) throw new Error('OWNER_WIRE_TOO_LARGE');
  return validateOwnerEnvelope(new StrictJsonParser(raw).parse(), options);
}

function signOwnerEnvelope(input: Omit<VokoOwnerEnvelope, 'signature'|'payloadDigest'|'algorithm'> & {
  payloadDigest?: string; algorithm?: 'Ed25519';
}, privateKey: crypto.KeyLike): VokoOwnerEnvelope {
  const candidate = { ...input, payloadDigest: digestPayload(input.payload), algorithm: 'Ed25519',
    signature: Buffer.alloc(64).toString('base64') } as VokoOwnerEnvelope;
  validateOwnerEnvelope(candidate, { now: Date.parse(candidate.createdAt) });
  return { ...candidate, signature: crypto.sign(null,
    Buffer.from(canonicalJson(unsignedEnvelope(candidate)), 'utf8'), privateKey).toString('base64') };
}

function verifyOwnerEnvelope(envelope: VokoOwnerEnvelope, resolvePublicKey: (keyId: string) => crypto.KeyLike | null,
  options: { now?: number } = {}): boolean {
  validateOwnerEnvelope(envelope, options);
  const publicKey = resolvePublicKey(envelope.keyId); if (!publicKey) throw new Error('OWNER_KEY_UNKNOWN');
  return crypto.verify(null, Buffer.from(canonicalJson(unsignedEnvelope(envelope)), 'utf8'), publicKey,
    Buffer.from(envelope.signature, 'base64'));
}

export { OWNER_VERSION, StrictJsonParser, canonicalJson, digestPayload, parseOwnerEnvelopeJson, signOwnerEnvelope, validateOwnerEnvelope, verifyOwnerEnvelope };
export type { OwnerOperation, VokoOwnerEnvelope };
