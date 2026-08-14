import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

type OwnerExecutionState =
  | 'RECEIVED' | 'VERIFIED' | 'PERSISTED' | 'DISPATCH_RESERVED'
  | 'PROVIDER_ACCEPTED' | 'COMPLETED' | 'FAILED' | 'FAILED_NOT_DELIVERED'
  | 'OUTCOME_UNKNOWN' | 'CANCELED' | 'REVOKED';

interface OwnerExecutionContext {
  sourceType: 'owner_chat';
  authority: 'verified_owner_conversation';
  executionScope: 'owner_chat';
  ownerConversationId: string;
  commandMessageId: string;
  ownershipEpoch: number;
  conversationEpoch: number;
  policyEpoch: number;
  configDigest: string;
  providerId?: string;
  providerInstanceId?: string | null;
  isolation?: 'voko_enforced' | 'provider_enforced';
}

const TERMINAL = new Set<OwnerExecutionState>([
  'COMPLETED', 'FAILED', 'FAILED_NOT_DELIVERED', 'OUTCOME_UNKNOWN', 'CANCELED', 'REVOKED',
]);

const ALLOWED: Record<OwnerExecutionState, OwnerExecutionState[]> = {
  RECEIVED: ['VERIFIED', 'REVOKED'],
  VERIFIED: ['PERSISTED', 'REVOKED'],
  PERSISTED: ['DISPATCH_RESERVED', 'FAILED_NOT_DELIVERED', 'REVOKED'],
  DISPATCH_RESERVED: ['PROVIDER_ACCEPTED', 'FAILED_NOT_DELIVERED', 'OUTCOME_UNKNOWN', 'CANCELED', 'REVOKED'],
  PROVIDER_ACCEPTED: ['COMPLETED', 'FAILED', 'OUTCOME_UNKNOWN', 'CANCELED'],
  COMPLETED: [], FAILED: [], FAILED_NOT_DELIVERED: [], OUTCOME_UNKNOWN: [], CANCELED: [], REVOKED: [],
};

function digestConfig(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value ?? null), 'utf8').digest('hex');
}

function createOwnerExecutionContext(input: {
  conversationId: string; messageId: string; ownershipEpoch: number; conversationEpoch: number;
  policyEpoch?: number; config: unknown; providerId?: string; providerInstanceId?: string|null;
  isolation?: 'voko_enforced'|'provider_enforced';
}): OwnerExecutionContext {
  return Object.freeze({
    sourceType: 'owner_chat', authority: 'verified_owner_conversation', executionScope: 'owner_chat',
    ownerConversationId: input.conversationId, commandMessageId: input.messageId,
    ownershipEpoch: input.ownershipEpoch, conversationEpoch: input.conversationEpoch,
    policyEpoch: Math.max(1, Number(input.policyEpoch || 1)), configDigest: digestConfig(input.config),
    ...(input.providerId ? { providerId: input.providerId } : {}),
    ...(input.providerInstanceId !== undefined ? { providerInstanceId: input.providerInstanceId } : {}),
    ...(input.isolation ? { isolation: input.isolation } : {}),
  });
}

function transitionOwnerExecution(db: DatabaseSync, input: {
  messageId: string; from: OwnerExecutionState; to: OwnerExecutionState; at?: number;
  leaseOwner?: string | null; leaseExpiresAt?: number | null; reasonCode?: string | null;
  afterTransition?: () => void;
}): boolean {
  if (!ALLOWED[input.from].includes(input.to)) throw new Error(`OWNER_EXECUTION_TRANSITION_INVALID:${input.from}:${input.to}`);
  const at = input.at ?? Date.now();
  const legacyState: Record<OwnerExecutionState, string> = {
    RECEIVED: 'received', VERIFIED: 'verified', PERSISTED: 'persisted', DISPATCH_RESERVED: 'leased',
    PROVIDER_ACCEPTED: 'provider_accepted', COMPLETED: 'replied', FAILED: 'failed', FAILED_NOT_DELIVERED: 'failed_not_delivered',
    OUTCOME_UNKNOWN: 'outcome_unknown', CANCELED: 'canceled', REVOKED: 'revoked',
  };
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = db.prepare(`UPDATE owner_chat_messages SET execution_state=?,state=?,lease_owner=?,lease_expires_at=?,updated_at=?
      WHERE message_id=? AND execution_state=?`).run(input.to, legacyState[input.to], input.leaseOwner ?? null,
        input.leaseExpiresAt ?? null, at, input.messageId, input.from) as any;
    if (Number(result.changes || 0) !== 1) { db.exec('ROLLBACK'); return false; }
    db.prepare(`INSERT INTO owner_chat_execution_events(event_id,message_id,from_state,to_state,reason_code,created_at)
      VALUES(?,?,?,?,?,?)`).run(`owexec_${crypto.randomUUID()}`, input.messageId, input.from, input.to,
        input.reasonCode || null, at);
    input.afterTransition?.();
    db.exec('COMMIT'); return true;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function isTerminalOwnerExecutionState(value: string): boolean { return TERMINAL.has(value as OwnerExecutionState); }

export { createOwnerExecutionContext, digestConfig, isTerminalOwnerExecutionState, transitionOwnerExecution };
export type { OwnerExecutionContext, OwnerExecutionState };
