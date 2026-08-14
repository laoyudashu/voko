import crypto from 'node:crypto';
import { StrictJsonParser, canonicalJson } from '../owner-link/envelope';

const OWNER_CHAT_VERSION = 'voko.owner.chat/1' as const;
const KEYS = new Set(['version','kind','messageId','clientMessageId','conversationId','ownerIdentityId','ownerImUid',
  'agentId','ownershipEpoch','conversationEpoch','sequence','operation','contentType','payload','payloadDigest','keyId',
  'algorithm','createdAt','expiresAt','signature']);
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const KINDS = new Set(['message','control','receipt','reply','event']);
const OPERATIONS = new Set(['message','approval','cancel','accepted','working','reply','failed']);

interface OwnerChatEnvelope {
  version: typeof OWNER_CHAT_VERSION; kind: 'message'|'control'|'receipt'|'reply'|'event'; messageId: string; clientMessageId: string;
  conversationId: string; ownerIdentityId: string; ownerImUid: string; agentId: string; ownershipEpoch: number;
  conversationEpoch: number; sequence: number; operation: 'message'|'approval'|'cancel'|'accepted'|'working'|'reply'|'failed'; contentType: 1|2|3;
  payload: Record<string, unknown>; payloadDigest: string; keyId: string; algorithm: 'Ed25519'; createdAt: string; expiresAt: string; signature: string;
}

function digest(value: unknown): string { return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex'); }
function unsigned(value: OwnerChatEnvelope): Omit<OwnerChatEnvelope,'signature'> { const { signature: _, ...rest } = value; return rest; }

function validateOwnerChatEnvelope(value: unknown, now = Date.now()): OwnerChatEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('OWNER_CHAT_ENVELOPE_INVALID');
  const row = value as Record<string, unknown>; const keys = Object.keys(row);
  if (keys.length !== KEYS.size || keys.some(key => !KEYS.has(key))) throw new Error('OWNER_CHAT_FIELDS_INVALID');
  if (row.version !== OWNER_CHAT_VERSION || row.algorithm !== 'Ed25519' || !KINDS.has(String(row.kind)) || !OPERATIONS.has(String(row.operation))) throw new Error('OWNER_CHAT_PROTOCOL_INVALID');
  if ((row.kind === 'message') !== (row.operation === 'message')) throw new Error('OWNER_CHAT_DIRECTION_INVALID');
  if ((row.kind === 'control') !== ['approval','cancel'].includes(String(row.operation))) throw new Error('OWNER_CHAT_DIRECTION_INVALID');
  for (const key of ['messageId','clientMessageId','conversationId','ownerIdentityId','ownerImUid','agentId','keyId']) if (!ID.test(String(row[key] || ''))) throw new Error('OWNER_CHAT_IDENTIFIER_INVALID');
  for (const key of ['ownershipEpoch','conversationEpoch','sequence']) if (!Number.isSafeInteger(row[key]) || Number(row[key]) < 1) throw new Error('OWNER_CHAT_SEQUENCE_INVALID');
  if (![1,2,3].includes(Number(row.contentType)) || !row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)) throw new Error('OWNER_CHAT_PAYLOAD_INVALID');
  if (row.operation === 'message' && Number(row.contentType) === 1 && (typeof (row.payload as any).text !== 'string' || !(row.payload as any).text.trim())) throw new Error('OWNER_CHAT_TEXT_INVALID');
  if (row.operation === 'message' && [2,3].includes(Number(row.contentType))) {
    const payload = row.payload as any;
    if (!ID.test(String(payload.attachmentId || '')) || typeof payload.name !== 'string' || !payload.name
      || !Number.isSafeInteger(payload.size) || payload.size < 1 || payload.size > 25*1024*1024
      || typeof payload.mimeType !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(payload.mimeType)
      || !/^[a-f0-9]{64}$/.test(String(payload.sha256 || '')) || typeof payload.downloadUrl !== 'string') throw new Error('OWNER_CHAT_ATTACHMENT_INVALID');
    const url = new URL(payload.downloadUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('OWNER_CHAT_ATTACHMENT_URL_INVALID');
  }
  if (row.operation === 'approval') {
    const payload = row.payload as any;
    if (!ID.test(String(payload.approvalId || '')) || !['accept','decline','cancel'].includes(String(payload.decision))) throw new Error('OWNER_CHAT_CONTROL_INVALID');
  }
  if (row.operation === 'cancel' && Object.keys(row.payload as any).some(key => !['turnId'].includes(key))) throw new Error('OWNER_CHAT_CONTROL_INVALID');
  if (digest(row.payload) !== row.payloadDigest) throw new Error('OWNER_CHAT_DIGEST_INVALID');
  const created = Date.parse(String(row.createdAt)); const expires = Date.parse(String(row.expiresAt));
  if (!Number.isFinite(created) || !Number.isFinite(expires) || expires <= created || expires-created > 86400000 || created > now+60000 || expires < now) throw new Error('OWNER_CHAT_EXPIRED');
  if (typeof row.signature !== 'string' || Buffer.from(row.signature, 'base64').length !== 64) throw new Error('OWNER_CHAT_SIGNATURE_INVALID');
  return row as unknown as OwnerChatEnvelope;
}

function parseOwnerChatEnvelope(raw: string, now = Date.now()): OwnerChatEnvelope {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 8192) throw new Error('OWNER_CHAT_WIRE_TOO_LARGE');
  return validateOwnerChatEnvelope(new StrictJsonParser(raw).parse(), now);
}

function verifyOwnerChatEnvelope(value: OwnerChatEnvelope, resolveKey: (keyId: string) => crypto.KeyLike | null, now = Date.now()): boolean {
  validateOwnerChatEnvelope(value, now); const key = resolveKey(value.keyId); if (!key) throw new Error('OWNER_CHAT_KEY_UNKNOWN');
  return crypto.verify(null, Buffer.from(canonicalJson(unsigned(value)), 'utf8'), key, Buffer.from(value.signature, 'base64'));
}

function signOwnerChatEnvelope(input: Omit<OwnerChatEnvelope,'payloadDigest'|'algorithm'|'signature'>, key: crypto.KeyLike): OwnerChatEnvelope {
  const value = { ...input, payloadDigest: digest(input.payload), algorithm: 'Ed25519', signature: Buffer.alloc(64).toString('base64') } as OwnerChatEnvelope;
  validateOwnerChatEnvelope(value, Date.parse(value.createdAt));
  return { ...value, signature: crypto.sign(null, Buffer.from(canonicalJson(unsigned(value)), 'utf8'), key).toString('base64') };
}

export { OWNER_CHAT_VERSION, parseOwnerChatEnvelope, signOwnerChatEnvelope, validateOwnerChatEnvelope, verifyOwnerChatEnvelope };
export type { OwnerChatEnvelope };
