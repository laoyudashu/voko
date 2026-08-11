import type { ProviderCoreEvent } from './types';

/** In-memory idempotency and terminal-state guard for Provider lifecycle events. */
export class ProviderEventGate {
  private readonly seen = new Map<string, number>();
  private readonly terminal = new Map<string, number>();

  constructor(private readonly ttlMs = 10 * 60 * 1000, private readonly maxEntries = 4096) {}

  accept(event: ProviderCoreEvent): boolean {
    if (!event?.eventId || !event.providerId || !event.agentId || !event.type) return false;
    const now = Date.now();
    this.cleanup(now);
    if (this.seen.has(event.eventId)) return false;
    const turnId = event.turnId || event.messageId || '';
    const turnKey = turnId ? `${event.providerId}:${event.agentId}:${turnId}` : '';
    if (turnKey && this.terminal.has(turnKey) && event.type !== 'status') return false;
    this.seen.set(event.eventId, now);
    if (turnKey && (event.terminal || event.type === 'completed' || event.type === 'failed')) {
      this.terminal.set(turnKey, now);
    }
    return true;
  }

  private cleanup(now: number): void {
    if (this.seen.size < this.maxEntries && this.terminal.size < this.maxEntries) return;
    for (const [key, timestamp] of this.seen) if (now - timestamp >= this.ttlMs) this.seen.delete(key);
    for (const [key, timestamp] of this.terminal) if (now - timestamp >= this.ttlMs) this.terminal.delete(key);
    while (this.seen.size > this.maxEntries) this.seen.delete(this.seen.keys().next().value!);
    while (this.terminal.size > this.maxEntries) this.terminal.delete(this.terminal.keys().next().value!);
  }
}

module.exports = { ProviderEventGate };
