import type { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

type StandardTaskState = 'SUBMITTED' | 'WORKING' | 'INPUT_REQUIRED' | 'AUTH_REQUIRED' | 'COMPLETED' | 'FAILED' | 'CANCELED' | 'REJECTED';
type DeliveryState = 'QUEUED_OFFLINE' | 'SENDING' | 'IM_ACCEPTED' | 'DELIVERED' | 'EXECUTING' | 'DELIVERY_UNKNOWN' | 'DEAD_LETTER';
const TERMINAL_STATES = new Set<StandardTaskState>(['COMPLETED', 'FAILED', 'CANCELED', 'REJECTED']);

interface CreateLocalTaskInput { gatewayTaskId: string; contextId: string; executionId: string; agentId: string; gatewayUid: string }

class A2ALocalTaskStore {
  constructor(private readonly db: DatabaseSync) {}
  createTask(input: CreateLocalTaskInput): boolean {
    const now = Date.now();
    const result = this.db.prepare(`INSERT OR IGNORE INTO a2a_local_tasks
      (gateway_task_id,context_id,execution_id,agent_id,gateway_uid,standard_state,delivery_state,created_at,updated_at)
      VALUES (?,?,?,?,?,'SUBMITTED','QUEUED_OFFLINE',?,?)`).run(
      input.gatewayTaskId, input.contextId, input.executionId, input.agentId, input.gatewayUid, now, now);
    return Number(result.changes) === 1;
  }
  getContext(agentId: string, contextId: string): Record<string, any> | null {
    return (this.db.prepare('SELECT * FROM a2a_local_contexts WHERE agent_id=? AND context_id=? AND status=\'active\'')
      .get(agentId, contextId) as Record<string, any> | undefined) || null;
  }
  saveContext(input: { agentId: string; contextId: string; providerFamily: string; providerInstanceId?: string | null;
    deliveryMode: string; adapterType: string; nativeSessionId: string }): void {
    const now = Date.now();
    this.db.prepare(`INSERT INTO a2a_local_contexts
      (agent_id,context_id,provider_family,provider_instance_id,delivery_mode,adapter_type,native_session_id,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,'active',?,?) ON CONFLICT(agent_id,context_id) DO UPDATE SET
      provider_family=excluded.provider_family,provider_instance_id=excluded.provider_instance_id,
      delivery_mode=excluded.delivery_mode,adapter_type=excluded.adapter_type,native_session_id=excluded.native_session_id,
      status='active',updated_at=excluded.updated_at`).run(input.agentId, input.contextId, input.providerFamily,
      input.providerInstanceId || null, input.deliveryMode, input.adapterType, input.nativeSessionId, now, now);
  }
  updateState(taskId: string, standardState: StandardTaskState, deliveryState: DeliveryState): boolean {
    const row = this.db.prepare('SELECT standard_state FROM a2a_local_tasks WHERE gateway_task_id=?').get(taskId) as { standard_state: StandardTaskState } | undefined;
    if (!row || (TERMINAL_STATES.has(row.standard_state) && row.standard_state !== standardState)) return false;
    return Number(this.db.prepare('UPDATE a2a_local_tasks SET standard_state=?,delivery_state=?,updated_at=? WHERE gateway_task_id=?')
      .run(standardState, deliveryState, Date.now(), taskId).changes) === 1;
  }
  acceptCommand(eventId: string, taskId: string, sequence: number, operation: string): 'accepted' | 'duplicate' {
    const result = this.db.prepare(`INSERT OR IGNORE INTO a2a_local_inbox
      (event_id,gateway_task_id,command_sequence,operation,status,received_at) VALUES (?,?,?,?,'received',?)`)
      .run(eventId, taskId, sequence, operation, Date.now());
    return Number(result.changes) === 1 ? 'accepted' : 'duplicate';
  }
  commandStatus(eventId: string): string | null {
    const row = this.db.prepare('SELECT status FROM a2a_local_inbox WHERE event_id=?').get(eventId) as { status: string } | undefined;
    return row?.status || null;
  }
  beginCommand(eventId: string): boolean {
    return Number(this.db.prepare("UPDATE a2a_local_inbox SET status='processing' WHERE event_id=? AND status='received'").run(eventId).changes) === 1;
  }
  finishCommand(eventId: string, status: 'processed' | 'outcome_unknown', errorCode?: string): void {
    this.db.prepare('UPDATE a2a_local_inbox SET status=?,processed_at=?,error_code=? WHERE event_id=?')
      .run(status, Date.now(), errorCode || null, eventId);
  }
  enqueueEvent(eventId: string, taskId: string, sequence: number, operation: string, envelope: unknown): boolean {
    const now = Date.now();
    const result = this.db.prepare(`INSERT OR IGNORE INTO a2a_local_outbox
      (event_id,gateway_task_id,producer_sequence,operation,envelope_json,status,next_attempt_at,created_at,updated_at)
      VALUES (?,?,?,?,?,'pending',?,?,?)`).run(eventId, taskId, sequence, operation, JSON.stringify(envelope), now, now, now);
    return Number(result.changes) === 1;
  }
  enqueueTaskEvent(taskId: string, operation: string, standardState: StandardTaskState,
    deliveryState: DeliveryState, build: (sequence: number, eventId: string) => unknown): unknown {
    const now = Date.now(); const eventId = crypto.randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT last_producer_sequence,standard_state FROM a2a_local_tasks WHERE gateway_task_id=?')
        .get(taskId) as { last_producer_sequence: number; standard_state: StandardTaskState } | undefined;
      if (!row || (TERMINAL_STATES.has(row.standard_state) && row.standard_state !== standardState)) throw new Error('Invalid local A2A task transition');
      const sequence = row.last_producer_sequence + 1; const envelope = build(sequence, eventId);
      this.db.prepare(`UPDATE a2a_local_tasks SET last_producer_sequence=?,standard_state=?,delivery_state=?,updated_at=? WHERE gateway_task_id=?`)
        .run(sequence, standardState, deliveryState, now, taskId);
      this.db.prepare(`INSERT INTO a2a_local_outbox
        (event_id,gateway_task_id,producer_sequence,operation,envelope_json,status,next_attempt_at,created_at,updated_at)
        VALUES (?,?,?,?,?,'pending',?,?,?)`).run(eventId, taskId, sequence, operation, JSON.stringify(envelope), now, now, now);
      this.db.exec('COMMIT'); return envelope;
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch (_) {} throw error; }
  }
  claimEvents(owner: string, limit = 10, leaseMs = 30_000): Array<Record<string, unknown>> {
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db.prepare(`SELECT event_id FROM a2a_local_outbox WHERE
        ((status='pending' AND next_attempt_at<=?) OR (status='leased' AND lease_expires_at<=?))
        AND NOT EXISTS (SELECT 1 FROM a2a_local_outbox previous
          WHERE previous.gateway_task_id=a2a_local_outbox.gateway_task_id
            AND previous.producer_sequence<a2a_local_outbox.producer_sequence
            AND previous.status<>'acked')
        ORDER BY created_at LIMIT ?`).all(now, now, limit) as Array<{ event_id: string }>;
      const update = this.db.prepare(`UPDATE a2a_local_outbox SET status='leased',lease_owner=?,lease_expires_at=?,attempt_count=attempt_count+1,updated_at=? WHERE event_id=?`);
      for (const row of rows) update.run(owner, now + leaseMs, now, row.event_id);
      this.db.exec('COMMIT');
      const select = this.db.prepare('SELECT * FROM a2a_local_outbox WHERE event_id=?');
      return rows.map((row) => select.get(row.event_id) as Record<string, unknown>);
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch (_) {} throw error; }
  }
  uncertainEvents(limit = 10): Array<Record<string, unknown>> {
    return this.db.prepare("SELECT * FROM a2a_local_outbox WHERE status='outcome_unknown' ORDER BY updated_at LIMIT ?")
      .all(limit) as Array<Record<string, unknown>>;
  }
  finishOutboxEvent(eventId: string, status: 'acked' | 'dead' | 'outcome_unknown', errorCode?: string): void {
    this.db.prepare(`UPDATE a2a_local_outbox SET status=?,lease_owner=NULL,lease_expires_at=NULL,last_error_code=?,updated_at=? WHERE event_id=?`)
      .run(status, errorCode || null, Date.now(), eventId);
  }
}

export { A2ALocalTaskStore, TERMINAL_STATES };
export type { CreateLocalTaskInput, DeliveryState, StandardTaskState };
