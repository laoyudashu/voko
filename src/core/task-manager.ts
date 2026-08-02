export {};

type TaskStatus = 'starting' | 'running' | 'failed' | 'stopping' | 'stopped';
type StopTask = () => void | Promise<void>;
type StartTask = () => void | StopTask | Promise<void | StopTask>;

interface TaskRecord {
  name: string;
  status: TaskStatus;
  startedAt: number;
  startupDurationMs?: number;
  stoppedAt?: number;
  lastError?: string;
  stop?: StopTask;
  startPromise?: Promise<void>;
}

class TaskManager {
  private tasks = new Map<string, TaskRecord>();
  private listeners = new Set<(tasks: object[]) => void>();

  async start(name: string, starter: StartTask): Promise<void> {
    const existing = this.tasks.get(name);
    if (existing?.status === 'running') return;
    if (existing?.status === 'starting' && existing.startPromise) return existing.startPromise;

    const record: TaskRecord = { name, status: 'starting', startedAt: Date.now() };
    this.tasks.set(name, record);
    this.notify();
    record.startPromise = Promise.resolve()
      .then(starter)
      .then((stop) => {
        record.stop = typeof stop === 'function' ? stop : undefined;
        record.status = 'running';
        record.startupDurationMs = Date.now() - record.startedAt;
        this.notify();
      })
      .catch((error: unknown) => {
        record.status = 'failed';
        record.startupDurationMs = Date.now() - record.startedAt;
        record.lastError = error instanceof Error ? error.message : String(error);
        this.notify();
      });
    return record.startPromise;
  }

  async stop(name: string): Promise<void> {
    const record = this.tasks.get(name);
    if (!record || record.status === 'stopped') return;
    if (record.startPromise) await record.startPromise;
    if (record.status === 'failed' && !record.stop) return;
    record.status = 'stopping';
    this.notify();
    try {
      await record.stop?.();
      record.status = 'stopped';
      record.stoppedAt = Date.now();
    } catch (error) {
      record.status = 'failed';
      record.lastError = error instanceof Error ? error.message : String(error);
    }
    this.notify();
  }

  async stopAll(): Promise<void> {
    const names = Array.from(this.tasks.keys()).reverse();
    for (const name of names) await this.stop(name);
  }

  snapshot(): object[] {
    return Array.from(this.tasks.values()).map(({ startPromise, stop, ...record }) => ({ ...record }));
  }

  subscribe(listener: (tasks: object[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try { listener(snapshot); } catch (_) {}
    }
  }
}

module.exports = { TaskManager };
