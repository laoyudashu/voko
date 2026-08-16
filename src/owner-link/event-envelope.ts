import crypto from 'node:crypto';
import type { OwnerOperation, VokoOwnerEnvelope } from './contracts/voko-owner-v1';
import { signOwnerEnvelope } from './envelope';

interface OwnerCommandSnapshot {
  message_id: string;
  conversation_id: string;
  owner_identity_id: string;
  observed_im_uid: string;
  agent_id: string;
  ownership_epoch: number;
  conversation_epoch: number;
}

function createPrivateKey(value: string): crypto.KeyObject {
  const input = String(value || '').trim();
  if (!input) throw new Error('OWNER_AGENT_PRIVATE_KEY_UNAVAILABLE');
  try { return crypto.createPrivateKey(input); } catch (_) {}
  const compact = input.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  let raw = /^[a-f0-9]{64}$/i.test(compact) ? Buffer.from(compact, 'hex') : Buffer.from(compact, 'base64');
  if (raw.length > 32) raw = raw.subarray(raw.length - 32);
  if (raw.length !== 32) throw new Error('OWNER_AGENT_PRIVATE_KEY_INVALID');
  const prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
  return crypto.createPrivateKey({ key: Buffer.concat([prefix, raw]), format: 'der', type: 'pkcs8' });
}

function createOwnerEventEnvelope(input: {
  command: OwnerCommandSnapshot;
  operation: Extract<OwnerOperation, 'accepted'|'working'|'completed'|'failed'|'canceled'>;
  payload?: Record<string, unknown>;
  sequence: number;
  privateKey: string;
  keyId?: string;
  kind?: 'receipt'|'event';
  now?: number;
}): VokoOwnerEnvelope {
  const now = input.now || Date.now();
  const messageId = `owner_evt_${crypto.randomUUID()}`;
  return signOwnerEnvelope({
    version: 'voko.owner/1',
    kind: input.kind || (input.operation === 'accepted' ? 'receipt' : 'event'),
    messageId,
    ownerConversationId: input.command.conversation_id,
    ownerIdentityId: input.command.owner_identity_id,
    ownerImUid: input.command.observed_im_uid,
    agentId: input.command.agent_id,
    ownershipEpoch: Number(input.command.ownership_epoch),
    conversationEpoch: Number(input.command.conversation_epoch),
    sequence: input.sequence,
    operation: input.operation,
    payload: { commandMessageId: input.command.message_id, ...(input.payload || {}) },
    keyId: input.keyId || input.command.agent_id,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
  }, createPrivateKey(input.privateKey));
}

export { createOwnerEventEnvelope, createPrivateKey };
export type { OwnerCommandSnapshot };
