import crypto from 'node:crypto';

export interface InboundTurnItem {
  messageId: string;
  content: string;
  timestamp: number;
  attachments?: ReadonlyArray<Readonly<{
    path: string;
    name: string;
    mediaType: string;
    size: number;
    sha256: string;
    sourceMessageId?: string;
  }>>;
}

export interface InboundTurnBatch<T extends InboundTurnItem> {
  turnId: string;
  scopeKey: string;
  sourceMessageIds: string[];
  items: T[];
  firstReceivedAt: number;
  lastReceivedAt: number;
}

export interface InboundTurnResult<R> {
  batch: InboundTurnBatch<any>;
  result: R;
  isReplyOwner: boolean;
}

interface PendingTurn<T extends InboundTurnItem, R> extends InboundTurnBatch<T> {
  timer: NodeJS.Timeout | null;
  hardDeadlineAt: number;
  waiters: Array<{
    item: T;
    resolve: (value: InboundTurnResult<R>) => void;
    reject: (reason: unknown) => void;
  }>;
}

export interface InboundTurnCoalescerOptions<T extends InboundTurnItem, R> {
  scopeKey: (item: T) => string;
  flush: (batch: InboundTurnBatch<T>) => R | Promise<R>;
  quietWindowMs?: number;
  hardWindowMs?: number;
  maxMessages?: number;
  maxCharacters?: number;
  maxAttachments?: number;
  turnIdPrefix?: string;
  now?: () => number;
}

function attachmentCount(item: InboundTurnItem): number {
  return Array.isArray(item.attachments) ? item.attachments.length : 0;
}

export function buildMergedTurn<T extends InboundTurnItem>(batch: InboundTurnBatch<T>): {
  content: string;
  attachments: NonNullable<InboundTurnItem['attachments']>;
  messageSegments: ReadonlyArray<Readonly<{ messageId: string; content: string; timestamp: number;
    attachmentIndexes: readonly number[] }>>;
} {
  const attachments: Array<NonNullable<InboundTurnItem['attachments']>[number]> = [];
  const messageSegments = batch.items.map(item => {
    const attachmentIndexes = (item.attachments || []).map(attachment => {
      attachments.push({ ...attachment, sourceMessageId: item.messageId });
      return attachments.length - 1;
    });
    return { messageId: item.messageId, content: item.content, timestamp: item.timestamp, attachmentIndexes };
  });
  if (batch.items.length === 1) return { content: batch.items[0].content, attachments, messageSegments };
  const content = `${batch.items.length} consecutive messages were received. Understand them as one turn:\n\n`
    + batch.items.map((item, index) => `[Message ${index + 1}]\n${item.content}`).join('\n\n');
  return { content, attachments, messageSegments };
}

export class InboundTurnCoalescer<T extends InboundTurnItem, R = void> {
  private readonly pending = new Map<string, PendingTurn<T, R>>();
  private readonly quietWindowMs: number;
  private readonly hardWindowMs: number;
  private readonly maxMessages: number;
  private readonly maxCharacters: number;
  private readonly maxAttachments: number;
  private readonly now: () => number;
  private readonly prefix: string;

  constructor(private readonly options: InboundTurnCoalescerOptions<T, R>) {
    this.quietWindowMs = options.quietWindowMs ?? 1200;
    this.hardWindowMs = options.hardWindowMs ?? 2000;
    this.maxMessages = options.maxMessages ?? 10;
    this.maxCharacters = options.maxCharacters ?? 20_000;
    this.maxAttachments = options.maxAttachments ?? 5;
    this.now = options.now || Date.now;
    this.prefix = options.turnIdPrefix || 'visitor';
  }

  enqueue(item: T): Promise<InboundTurnResult<R>> {
    const scopeKey = this.options.scopeKey(item);
    let turn = this.pending.get(scopeKey);
    if (turn && !this.canAppend(turn, item)) {
      void this.flushTurn(turn);
      turn = undefined;
    }
    if (!turn) {
      const now = this.now();
      turn = {
        turnId: `${this.prefix}-${crypto.randomUUID()}`,
        scopeKey,
        sourceMessageIds: [],
        items: [],
        firstReceivedAt: now,
        lastReceivedAt: now,
        hardDeadlineAt: now + this.hardWindowMs,
        timer: null,
        waiters: [],
      };
      this.pending.set(scopeKey, turn);
    }
    turn.items.push(item);
    turn.sourceMessageIds.push(item.messageId);
    turn.lastReceivedAt = this.now();
    const promise = new Promise<InboundTurnResult<R>>((resolve, reject) => {
      turn!.waiters.push({ item, resolve, reject });
    });
    if (this.atLimit(turn)) void this.flushTurn(turn);
    else this.schedule(turn);
    return promise;
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.pending.values()].map(turn => this.flushTurn(turn).then(() => undefined)));
  }

  async flushWhere(predicate: (scopeKey: string) => boolean): Promise<void> {
    await Promise.all([...this.pending.values()]
      .filter(turn => predicate(turn.scopeKey))
      .map(turn => this.flushTurn(turn).then(() => undefined)));
  }

  get pendingCount(): number { return this.pending.size; }

  private canAppend(turn: PendingTurn<T, R>, item: T): boolean {
    return turn.items.length < this.maxMessages
      && turn.items.reduce((sum, current) => sum + current.content.length, 0) + item.content.length <= this.maxCharacters
      && turn.items.reduce((sum, current) => sum + attachmentCount(current), 0) + attachmentCount(item) <= this.maxAttachments;
  }

  private atLimit(turn: PendingTurn<T, R>): boolean {
    return turn.items.length >= this.maxMessages
      || turn.items.reduce((sum, item) => sum + item.content.length, 0) >= this.maxCharacters
      || turn.items.reduce((sum, item) => sum + attachmentCount(item), 0) >= this.maxAttachments;
  }

  private schedule(turn: PendingTurn<T, R>): void {
    if (turn.timer) clearTimeout(turn.timer);
    const delay = Math.max(0, Math.min(this.quietWindowMs, turn.hardDeadlineAt - this.now()));
    turn.timer = setTimeout(() => void this.flushTurn(turn), delay);
  }

  private async flushTurn(turn: PendingTurn<T, R>): Promise<R | undefined> {
    if (this.pending.get(turn.scopeKey) !== turn) return undefined;
    this.pending.delete(turn.scopeKey);
    if (turn.timer) clearTimeout(turn.timer);
    turn.timer = null;
    const batch: InboundTurnBatch<T> = {
      turnId: turn.turnId,
      scopeKey: turn.scopeKey,
      sourceMessageIds: [...turn.sourceMessageIds],
      items: [...turn.items],
      firstReceivedAt: turn.firstReceivedAt,
      lastReceivedAt: turn.lastReceivedAt,
    };
    try {
      const result = await this.options.flush(batch);
      const replyOwner = turn.waiters[turn.waiters.length - 1]?.item;
      for (const waiter of turn.waiters) {
        waiter.resolve({ batch, result, isReplyOwner: waiter.item === replyOwner });
      }
      return result;
    } catch (error) {
      for (const waiter of turn.waiters) waiter.reject(error);
      return undefined;
    }
  }
}
