import crypto from 'node:crypto';

const OWNER_VERSION = 'voko.owner/1' as const;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_LIFETIME_MS = 5 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;
const EXACT_ENVELOPE_KEYS = new Set(['version','kind','messageId','conversationId','ownerIdentityId','agentId',
  'ownershipEpoch','conversationEpoch','sequence','issuedAt','expiresAt','payload','payloadDigest','keyId',
  'algorithm','signature']);

type OwnerEnvelopeKind = 'instruction' | 'approval' | 'control';
type OwnerEnvelopePayload =
  | { text: string }
  | { approvalId: string; decision: 'confirm' | 'reject'; actionDigest: string }
  | { action: 'revoke_binding'; reasonCode?: string };

interface OwnerEnvelope {
  version: typeof OWNER_VERSION;
  kind: OwnerEnvelopeKind;
  messageId: string;
  conversationId: string;
  ownerIdentityId: string;
  agentId: string;
  ownershipEpoch: number;
  conversationEpoch: number;
  sequence: number;
  issuedAt: string;
  expiresAt: string;
  payload: OwnerEnvelopePayload;
  payloadDigest: string;
  keyId: string;
  algorithm: 'Ed25519';
  signature?: string;
}

interface OwnerWire { _voko: { owner: OwnerEnvelope } }

class StrictJsonParser {
  private index = 0;
  constructor(private readonly input: string) {}
  parse(): unknown {
    const value = this.value();
    this.space();
    if (this.index !== this.input.length) throw new Error('OWNER_JSON_TRAILING_DATA');
    return value;
  }
  private space(): void { while (/\s/.test(this.input[this.index] || '')) this.index += 1; }
  private value(): unknown {
    this.space();
    const ch = this.input[this.index];
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
    this.index += 1;
    const result: Record<string, unknown> = Object.create(null);
    const seen = new Set<string>();
    this.space();
    if (this.input[this.index] === '}') { this.index += 1; return result; }
    while (true) {
      this.space();
      if (this.input[this.index] !== '"') throw new Error('OWNER_JSON_INVALID_OBJECT_KEY');
      const key = this.string();
      if (seen.has(key)) throw new Error('OWNER_JSON_DUPLICATE_KEY');
      seen.add(key);
      this.space();
      if (this.input[this.index] !== ':') throw new Error('OWNER_JSON_INVALID_OBJECT');
      this.index += 1;
      result[key] = this.value();
      this.space();
      const ch = this.input[this.index++];
      if (ch === '}') return result;
      if (ch !== ',') throw new Error('OWNER_JSON_INVALID_OBJECT');
    }
  }
  private array(): unknown[] {
    this.index += 1;
    const result: unknown[] = [];
    this.space();
    if (this.input[this.index] === ']') { this.index += 1; return result; }
    while (true) {
      result.push(this.value());
      this.space();
      const ch = this.input[this.index++];
      if (ch === ']') return result;
      if (ch !== ',') throw new Error('OWNER_JSON_INVALID_ARRAY');
    }
  }
  private string(): string {
    const start = this.index;
    this.index += 1;
    let escaped = false;
    while (this.index < this.input.length) {
      const code = this.input.charCodeAt(this.index);
      const ch = this.input[this.index++];
      if (!escaped && ch === '"') {
        const value = JSON.parse(this.input.slice(start, this.index));
        assertWellFormedUnicode(value);
        return value;
      }
      if (!escaped && code < 0x20) throw new Error('OWNER_JSON_INVALID_STRING');
      if (!escaped && ch === '\\') escaped = true;
      else escaped = false;
    }
    throw new Error('OWNER_JSON_UNTERMINATED_STRING');
  }
  private number(): number {
    const rest = this.input.slice(this.index);
    const match = rest.match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match) throw new Error('OWNER_JSON_INVALID_NUMBER');
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw new Error('OWNER_JSON_NON_FINITE_NUMBER');
    return value;
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
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => {
      assertWellFormedUnicode(key);
      return `${JSON.stringify(key)}:${canonicalJson(record[key])}`;
    }).join(',')}}`;
  }
  throw new Error('OWNER_CANONICAL_UNSUPPORTED_VALUE');
}

function digestPayload(payload: OwnerEnvelopePayload): string {
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex')}`;
}

function unsignedEnvelope(envelope: OwnerEnvelope): Omit<OwnerEnvelope, 'signature'> {
  const { signature: _signature, ...unsigned } = envelope;
  return unsigned;
}

function exactKeys(record: Record<string, unknown>, allowed: Set<string>, code: string): void {
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new Error(code);
}

function validatePayload(kind: OwnerEnvelopeKind, payload: unknown): asserts payload is OwnerEnvelopePayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('OWNER_PAYLOAD_INVALID');
  const row = payload as Record<string, unknown>;
  if (kind === 'instruction') {
    exactKeys(row, new Set(['text']), 'OWNER_PAYLOAD_ADDITIONAL_PROPERTY');
    if (typeof row.text !== 'string' || !row.text.trim() || Buffer.byteLength(row.text, 'utf8') > 6144) throw new Error('OWNER_TEXT_INVALID');
  } else if (kind === 'approval') {
    exactKeys(row, new Set(['approvalId','decision','actionDigest']), 'OWNER_PAYLOAD_ADDITIONAL_PROPERTY');
    if (!ID_PATTERN.test(String(row.approvalId || '')) || !['confirm','reject'].includes(String(row.decision))
      || !DIGEST_PATTERN.test(String(row.actionDigest || ''))) throw new Error('OWNER_APPROVAL_INVALID');
  } else {
    exactKeys(row, new Set(['action','reasonCode']), 'OWNER_PAYLOAD_ADDITIONAL_PROPERTY');
    if (row.action !== 'revoke_binding' || (row.reasonCode != null && typeof row.reasonCode !== 'string')) throw new Error('OWNER_CONTROL_INVALID');
  }
}

function validateOwnerEnvelope(value: unknown, options: { now?: number } = {}): OwnerEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('OWNER_ENVELOPE_INVALID');
  const row = value as Record<string, unknown>;
  exactKeys(row, EXACT_ENVELOPE_KEYS, 'OWNER_ENVELOPE_ADDITIONAL_PROPERTY');
  if (row.version !== OWNER_VERSION || !['instruction','approval','control'].includes(String(row.kind))) throw new Error('OWNER_ENVELOPE_UNSUPPORTED');
  for (const key of ['messageId','conversationId','ownerIdentityId','agentId','keyId']) {
    if (!ID_PATTERN.test(String(row[key] || ''))) throw new Error('OWNER_IDENTIFIER_INVALID');
  }
  for (const key of ['ownershipEpoch','conversationEpoch','sequence']) {
    if (!Number.isSafeInteger(row[key]) || Number(row[key]) < 1) throw new Error('OWNER_SEQUENCE_INVALID');
  }
  if (row.algorithm !== 'Ed25519') throw new Error('OWNER_ALGORITHM_UNSUPPORTED');
  if (!DIGEST_PATTERN.test(String(row.payloadDigest || ''))) throw new Error('OWNER_DIGEST_INVALID');
  if (typeof row.signature !== 'string' || Buffer.from(row.signature, 'base64').length !== 64) throw new Error('OWNER_SIGNATURE_INVALID');
  const issuedAt = Date.parse(String(row.issuedAt || ''));
  const expiresAt = Date.parse(String(row.expiresAt || ''));
  const now = options.now ?? Date.now();
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt
    || expiresAt - issuedAt > MAX_LIFETIME_MS || issuedAt > now + CLOCK_SKEW_MS || expiresAt < now) throw new Error('OWNER_ENVELOPE_EXPIRED');
  validatePayload(row.kind as OwnerEnvelopeKind, row.payload);
  if (digestPayload(row.payload) !== row.payloadDigest) throw new Error('OWNER_DIGEST_MISMATCH');
  return row as unknown as OwnerEnvelope;
}

function parseOwnerWire(raw: string, options: { now?: number } = {}): OwnerEnvelope {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 8192) throw new Error('OWNER_WIRE_TOO_LARGE');
  const parsed = new StrictJsonParser(raw).parse();
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('OWNER_WIRE_INVALID');
  const wire = parsed as Record<string, unknown>;
  exactKeys(wire, new Set(['_voko']), 'OWNER_WIRE_ADDITIONAL_PROPERTY');
  const voko = wire._voko as Record<string, unknown>;
  if (!voko || typeof voko !== 'object' || Array.isArray(voko)) throw new Error('OWNER_WIRE_INVALID');
  exactKeys(voko, new Set(['owner']), 'OWNER_WIRE_ADDITIONAL_PROPERTY');
  return validateOwnerEnvelope(voko.owner, options);
}

function signOwnerEnvelope(envelope: Omit<OwnerEnvelope, 'signature'>, privateKey: crypto.KeyLike): OwnerEnvelope {
  const candidate = { ...envelope, signature: Buffer.alloc(64).toString('base64') } as OwnerEnvelope;
  validateOwnerEnvelope(candidate, { now: Date.parse(envelope.issuedAt) });
  const signature = crypto.sign(null, Buffer.from(canonicalJson(unsignedEnvelope(candidate)), 'utf8'), privateKey).toString('base64');
  return { ...envelope, signature };
}

function verifyOwnerEnvelope(
  envelope: OwnerEnvelope,
  resolvePublicKey: (keyId: string) => crypto.KeyLike | null,
  options: { now?: number } = {},
): boolean {
  validateOwnerEnvelope(envelope, options);
  const publicKey = resolvePublicKey(envelope.keyId);
  if (!publicKey) throw new Error('OWNER_KEY_UNKNOWN');
  return crypto.verify(null, Buffer.from(canonicalJson(unsignedEnvelope(envelope)), 'utf8'), publicKey,
    Buffer.from(envelope.signature || '', 'base64'));
}

export { OWNER_VERSION, canonicalJson, digestPayload, parseOwnerWire, signOwnerEnvelope, validateOwnerEnvelope, verifyOwnerEnvelope };
export type { OwnerEnvelope, OwnerEnvelopeKind, OwnerEnvelopePayload, OwnerWire };
