import type { OwnerCancelPayload } from './contracts/voko-owner-v1';

const TARGET_MESSAGE_ID = /^owm_[A-Za-z0-9_-]{1,96}$/;

function parseOwnerCancelPayload(payload: unknown): OwnerCancelPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('OWNER_CANCEL_PAYLOAD_INVALID');
  const row = payload as Record<string, unknown>;
  if (Object.keys(row).join(',') !== 'targetMessageId' || !TARGET_MESSAGE_ID.test(String(row.targetMessageId || ''))) {
    throw new Error('OWNER_CANCEL_PAYLOAD_INVALID');
  }
  return { targetMessageId: String(row.targetMessageId) };
}

export { parseOwnerCancelPayload };
