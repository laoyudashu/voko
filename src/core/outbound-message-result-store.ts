export type MessageExecutionState = 'SUBMITTED' | 'WORKING' | 'COMPLETED' | 'FAILED'
  | 'AUTH_REQUIRED' | 'DELIVERY_UNKNOWN';
export type MessageExecutionPhase = 'receiver' | 'provider' | 'reply';

export interface TurnReceipt {
  version: 1;
  sourceMessageIds: string[];
  turnId: string;
  sequence: number;
  state: MessageExecutionState;
  phase: MessageExecutionPhase;
  reasonCode?: string | null;
  occurredAt: number;
  replyMessageId?: string | null;
}

export interface OutboundMessageResult {
  agentId: string;
  sourceMessageId: string;
  peerUid: string;
  turnId: string | null;
  sequence: number;
  state: MessageExecutionState | 'UNCONFIRMED';
  phase: MessageExecutionPhase | null;
  reasonCode: string | null;
  replyMessageId: string | null;
  updatedAt: number;
}

const STATES = new Set<MessageExecutionState>([
  'SUBMITTED', 'WORKING', 'COMPLETED', 'FAILED', 'AUTH_REQUIRED', 'DELIVERY_UNKNOWN',
]);
const PHASES = new Set<MessageExecutionPhase>(['receiver', 'provider', 'reply']);
const TERMINAL = new Set<MessageExecutionState>(['COMPLETED', 'FAILED', 'AUTH_REQUIRED', 'DELIVERY_UNKNOWN']);
const ID = /^[A-Za-z0-9._:-]{1,256}$/;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export function normalizeTurnReceipt(value: unknown): TurnReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const sourceMessageIds = Array.isArray(row.sourceMessageIds)
    ? [...new Set(row.sourceMessageIds.map(String))] : [];
  if (row.version !== 1 || sourceMessageIds.length < 1 || sourceMessageIds.length > 10
      || sourceMessageIds.some((id) => !ID.test(id))) return null;
  const turnId = String(row.turnId || '');
  const sequence = Number(row.sequence);
  const state = String(row.state || '') as MessageExecutionState;
  const phase = String(row.phase || '') as MessageExecutionPhase;
  const occurredAt = Number(row.occurredAt);
  const reasonCode = row.reasonCode == null ? null : String(row.reasonCode);
  const replyMessageId = row.replyMessageId == null ? null : String(row.replyMessageId);
  if (!ID.test(turnId) || !Number.isSafeInteger(sequence) || sequence < 1
      || !STATES.has(state) || !PHASES.has(phase)
      || !Number.isFinite(occurredAt) || occurredAt < 0 || occurredAt > Date.now() + MAX_CLOCK_SKEW_MS
      || (reasonCode != null && (reasonCode.length > 128 || !/^[A-Z0-9_]+$/.test(reasonCode)))
      || (replyMessageId != null && !ID.test(replyMessageId))) return null;
  return { version: 1, sourceMessageIds, turnId, sequence, state, phase,
    reasonCode, occurredAt, replyMessageId };
}

export class OutboundMessageResultStore {
  private readonly entries = new Map<string, OutboundMessageResult>();
  constructor(private readonly perAgentLimit = 1000) {}

  private key(agentId: string, messageId: string): string { return `${agentId}\0${messageId}`; }

  register(agentId: string, sourceMessageId: string, peerUid: string): void {
    const key = this.key(agentId, sourceMessageId);
    if (!this.entries.has(key)) this.entries.set(key, { agentId, sourceMessageId, peerUid,
      turnId: null, sequence: 0, state: 'UNCONFIRMED', phase: null,
      reasonCode: 'NO_RECEIPT_RECEIVED', replyMessageId: null, updatedAt: Date.now() });
    this.prune(agentId);
  }

  apply(agentId: string, peerUid: string, receipt: TurnReceipt): number {
    let changed = 0;
    for (const sourceMessageId of receipt.sourceMessageIds) {
      const key = this.key(agentId, sourceMessageId);
      const current = this.entries.get(key);
      if (!current || current.peerUid !== peerUid || receipt.sequence <= current.sequence) continue;
      if (current.state !== 'UNCONFIRMED' && TERMINAL.has(current.state as MessageExecutionState)) {
        const resolvesUnknown = current.state === 'DELIVERY_UNKNOWN' && receipt.state === 'COMPLETED';
        if (!resolvesUnknown && receipt.state !== current.state) continue;
      }
      this.entries.set(key, { ...current, turnId: receipt.turnId, sequence: receipt.sequence,
        state: receipt.state, phase: receipt.phase, reasonCode: receipt.reasonCode || null,
        replyMessageId: receipt.replyMessageId || current.replyMessageId,
        updatedAt: receipt.occurredAt });
      changed += 1;
    }
    return changed;
  }

  observeReply(agentId: string, sourceMessageId: string, replyMessageId: string): boolean {
    const key = this.key(agentId, sourceMessageId);
    const current = this.entries.get(key);
    if (!current) return false;
    this.entries.set(key, { ...current, phase: 'reply', replyMessageId, updatedAt: Date.now() });
    return true;
  }

  get(agentId: string, sourceMessageId: string): OutboundMessageResult | null {
    return this.entries.get(this.key(agentId, sourceMessageId)) || null;
  }

  private prune(agentId: string): void {
    const rows = [...this.entries.entries()].filter(([, value]) => value.agentId === agentId);
    if (rows.length <= this.perAgentLimit) return;
    rows.sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    for (const [key] of rows.slice(0, rows.length - this.perAgentLimit)) this.entries.delete(key);
  }
}
