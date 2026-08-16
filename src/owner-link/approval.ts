import crypto from 'node:crypto';
import { canonicalJson } from './envelope';
import type { OwnerApprovedExecutePayload } from './contracts/voko-owner-approval-v1';

const APPROVAL_ID = /^owa_[A-Za-z0-9_-]{1,124}$/;
const SHA256 = /^[a-f0-9]{64}$/;

interface ApprovalBinding {
  providerType: string;
  providerInstanceId?: string | null;
  adapterType: string;
  deliveryMode: string;
  bindingVersion: number;
  nativeSessionId?: string | null;
}

function actionDigest(action: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(action), 'utf8').digest('hex');
}

function nativeSessionDigest(nativeSessionId?: string | null): string | null {
  const value = String(nativeSessionId || '');
  return value ? crypto.createHash('sha256').update(`voko:owner-native-session:v1\0${value}`, 'utf8').digest('hex') : null;
}

function parseApprovedExecutePayload(payload: unknown, now = Date.now(), commandExpiresAt?: number): OwnerApprovedExecutePayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('OWNER_APPROVAL_PAYLOAD_INVALID');
  const row = payload as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'action,approval') throw new Error('OWNER_APPROVAL_PAYLOAD_INVALID');
  const action = row.action as Record<string, unknown>;
  const approval = row.approval as Record<string, unknown>;
  if (!action || typeof action !== 'object' || Array.isArray(action)
      || Object.keys(action).sort().join(',') !== 'text,type'
      || action.type !== 'message' || typeof action.text !== 'string'
      || !action.text.trim() || action.text.length > 8000 || Buffer.byteLength(action.text, 'utf8') > 6144) {
    throw new Error('OWNER_ACTION_INVALID');
  }
  if (!approval || typeof approval !== 'object' || Array.isArray(approval)
      || Object.keys(approval).sort().join(',') !== 'actionDigest,approvalId,enforcement,expiresAt'
      || !APPROVAL_ID.test(String(approval.approvalId || ''))
      || !SHA256.test(String(approval.actionDigest || ''))
      || approval.enforcement !== 'required_before_execute') {
    throw new Error('OWNER_APPROVAL_INVALID');
  }
  if (actionDigest(action) !== approval.actionDigest) throw new Error('OWNER_APPROVAL_DIGEST_MISMATCH');
  const expiresAt = Date.parse(String(approval.expiresAt || ''));
  if (!Number.isFinite(expiresAt) || expiresAt <= now
      || (commandExpiresAt != null && expiresAt > commandExpiresAt)) throw new Error('OWNER_APPROVAL_EXPIRED');
  return { action: { type: 'message', text: action.text }, approval: {
    approvalId: String(approval.approvalId), actionDigest: String(approval.actionDigest),
    expiresAt: new Date(expiresAt).toISOString(), enforcement: 'required_before_execute',
  } };
}

export { actionDigest, nativeSessionDigest, parseApprovedExecutePayload };
export type { ApprovalBinding };
