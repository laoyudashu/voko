import type { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

type StandardTaskState = 'SUBMITTED' | 'WORKING' | 'INPUT_REQUIRED' | 'AUTH_REQUIRED' | 'COMPLETED' | 'FAILED' | 'CANCELED' | 'REJECTED';
type DeliveryState = 'QUEUED_OFFLINE' | 'SENDING' | 'IM_ACCEPTED' | 'DELIVERED' | 'EXECUTING' | 'DELIVERY_UNKNOWN' | 'DEAD_LETTER';
const TERMINAL_STATES = new Set<StandardTaskState>(['COMPLETED', 'FAILED', 'CANCELED', 'REJECTED']);

interface CreateLocalTaskInput { gatewayTaskId: string; contextId: string; executionId: string; agentId: string; gatewayUid: string;
  principalScope: string; scopeVersion: number; scopeKeyId: string;
  bindingGeneration?: number; ownerEpoch?: number; policyRevision?: number }

class A2ALocalTaskStore {
  constructor(private readonly db: DatabaseSync) {}
  getTaskLogRoute(taskId: string): { agentId: string; peerLabel: string } | null {
    const row = this.db.prepare('SELECT agent_id,principal_scope FROM a2a_local_tasks WHERE gateway_task_id=?')
      .get(taskId) as { agent_id?: string; principal_scope?: string } | undefined;
    if (!row?.agent_id || !row.principal_scope) return null;
    return { agentId: row.agent_id, peerLabel: `A2A-${row.principal_scope.slice(0, 8)}` };
  }
  createTask(input: CreateLocalTaskInput): boolean {
    const now = Date.now();
    const result = this.db.prepare(`INSERT OR IGNORE INTO a2a_local_tasks
      (gateway_task_id,context_id,execution_id,agent_id,gateway_uid,principal_scope,scope_version,scope_key_id,
       standard_state,delivery_state,binding_generation,owner_epoch,policy_revision,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,'SUBMITTED','QUEUED_OFFLINE',?,?,?,?,?)`).run(
      input.gatewayTaskId, input.contextId, input.executionId, input.agentId, input.gatewayUid,
      input.principalScope, input.scopeVersion, input.scopeKeyId, input.bindingGeneration || 1,
      input.ownerEpoch || 1, input.policyRevision || 1, now, now);
    return Number(result.changes) === 1;
  }
  getContext(agentId: string, principalScope: string, contextId: string, scopeVersion: number, scopeKeyId: string,
    bindingGeneration?: number): Record<string, any> | null {
    if (!principalScope || !scopeKeyId) throw new Error('A2A_PRINCIPAL_SCOPE_REQUIRED');
    const row = (this.db.prepare(`SELECT * FROM a2a_local_contexts
      WHERE agent_id=? AND principal_scope=? AND context_id=? AND scope_version=? AND scope_key_id=? AND status='active'`)
      .get(agentId, principalScope, contextId, scopeVersion, scopeKeyId) as Record<string, any> | undefined) || null;
    if (row && bindingGeneration !== undefined && Number(row.binding_generation) !== bindingGeneration)
      throw new Error('A2A_BINDING_GENERATION_MISMATCH');
    return row;
  }
  saveContext(input: { agentId: string; principalScope: string; contextId: string; sessionScopeId: string;
    scopeVersion: number; scopeKeyId: string; bindingGeneration: number; providerFamily: string;
    providerInstanceId?: string | null; deliveryMode: string; adapterType: string; nativeSessionNamespace: string;
    restoreCompatibilityGroup: string; nativeSessionId: string }): void {
    const now = Date.now();
    this.db.prepare(`INSERT INTO a2a_local_contexts
      (agent_id,principal_scope,context_id,session_scope_id,scope_version,scope_key_id,binding_generation,
       provider_family,provider_instance_id,delivery_mode,adapter_type,native_session_namespace,
       restore_compatibility_group,native_session_id,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?) ON CONFLICT(agent_id,principal_scope,context_id) DO UPDATE SET
      provider_family=excluded.provider_family,provider_instance_id=excluded.provider_instance_id,
      delivery_mode=excluded.delivery_mode,adapter_type=excluded.adapter_type,native_session_id=excluded.native_session_id,
      native_session_namespace=excluded.native_session_namespace,restore_compatibility_group=excluded.restore_compatibility_group,
      binding_generation=excluded.binding_generation,
      status='active',updated_at=excluded.updated_at`).run(input.agentId, input.principalScope, input.contextId,
      input.sessionScopeId, input.scopeVersion, input.scopeKeyId, input.bindingGeneration,
      input.providerFamily, input.providerInstanceId || null, input.deliveryMode, input.adapterType,
      input.nativeSessionNamespace, input.restoreCompatibilityGroup, input.nativeSessionId, now, now);
  }
  markContextSessionLost(agentId: string, principalScope: string, contextId: string): void {
    this.db.prepare("UPDATE a2a_local_contexts SET status='session_lost',updated_at=? WHERE agent_id=? AND principal_scope=? AND context_id=?")
      .run(Date.now(), agentId, principalScope, contextId);
  }
  acquireSessionLease(sessionScopeId: string, taskId: string, leaseMs = 180_000): string | null {
    const now = Date.now(); const token = crypto.randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM a2a_session_leases WHERE session_scope_id=? AND lease_expires_at<=? AND accepted_by_provider=0')
        .run(sessionScopeId, now);
      const result = this.db.prepare(`INSERT OR IGNORE INTO a2a_session_leases
        (session_scope_id,task_id,lease_token,lease_expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?)`)
        .run(sessionScopeId, taskId, token, now + leaseMs, now, now);
      this.db.exec('COMMIT');
      return Number(result.changes) === 1 ? token : null;
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch (_) {} throw error; }
  }
  markLeaseAccepted(sessionScopeId: string, token: string): void {
    this.db.prepare('UPDATE a2a_session_leases SET accepted_by_provider=1,updated_at=? WHERE session_scope_id=? AND lease_token=?')
      .run(Date.now(), sessionScopeId, token);
  }
  releaseSessionLease(sessionScopeId: string, token: string, allowAccepted = false): void {
    this.db.prepare(`DELETE FROM a2a_session_leases WHERE session_scope_id=? AND lease_token=? ${allowAccepted ? '' : 'AND accepted_by_provider=0'}`)
      .run(sessionScopeId, token);
  }
  updateState(taskId: string, standardState: StandardTaskState, deliveryState: DeliveryState): boolean {
    const row = this.db.prepare('SELECT standard_state FROM a2a_local_tasks WHERE gateway_task_id=?').get(taskId) as { standard_state: StandardTaskState } | undefined;
    if (!row || (TERMINAL_STATES.has(row.standard_state) && row.standard_state !== standardState)) return false;
    return Number(this.db.prepare('UPDATE a2a_local_tasks SET standard_state=?,delivery_state=?,updated_at=? WHERE gateway_task_id=?')
      .run(standardState, deliveryState, Date.now(), taskId).changes) === 1;
  }
  getTaskState(taskId: string): StandardTaskState | null {
    const row = this.db.prepare('SELECT standard_state FROM a2a_local_tasks WHERE gateway_task_id=?')
      .get(taskId) as { standard_state: StandardTaskState } | undefined;
    return row?.standard_state || null;
  }
  acceptCommand(eventId: string, taskId: string, sequence: number, operation: string, envelope: unknown = {}): 'accepted' | 'duplicate' {
    const result = this.db.prepare(`INSERT OR IGNORE INTO a2a_local_inbox
      (event_id,gateway_task_id,command_sequence,operation,envelope_json,status,received_at) VALUES (?,?,?,?,?,'received',?)`)
      .run(eventId, taskId, sequence, operation, JSON.stringify(envelope), Date.now());
    return Number(result.changes) === 1 ? 'accepted' : 'duplicate';
  }
  markReceiptAcknowledged(eventId: string): void {
    this.db.prepare("UPDATE a2a_local_inbox SET receipt_state='acked' WHERE event_id=?").run(eventId);
  }
  commandStatus(eventId: string): string | null {
    const row = this.db.prepare('SELECT status FROM a2a_local_inbox WHERE event_id=?').get(eventId) as { status: string } | undefined;
    return row?.status || null;
  }
  beginCommand(eventId: string): boolean {
    return Number(this.db.prepare("UPDATE a2a_local_inbox SET status='processing',execution_state='processing',attempt_count=attempt_count+1 WHERE event_id=? AND status='received'").run(eventId).changes) === 1;
  }
  listProcessingCommands(): Array<{ event_id: string; gateway_task_id: string; envelope_json: string | null }> {
    return this.db.prepare("SELECT event_id,gateway_task_id,envelope_json FROM a2a_local_inbox WHERE status='processing' ORDER BY received_at")
      .all() as Array<{ event_id: string; gateway_task_id: string; envelope_json: string | null }>;
  }
  listReadyRetryCommands(limit = 10): Array<{ event_id: string; gateway_task_id: string; envelope_json: string | null }> {
    return this.db.prepare(`SELECT event_id,gateway_task_id,envelope_json FROM a2a_local_inbox
      WHERE status='received' AND execution_state='retry' AND next_attempt_at<=? ORDER BY received_at LIMIT ?`)
      .all(Date.now(), limit) as Array<{ event_id: string; gateway_task_id: string; envelope_json: string | null }>;
  }
  hasOperationEvent(taskId: string, operation: string): boolean {
    return !!this.db.prepare('SELECT 1 AS found FROM a2a_local_outbox WHERE gateway_task_id=? AND operation=? LIMIT 1')
      .get(taskId, operation);
  }
  hasTerminalEvent(taskId: string): boolean {
    const row = this.db.prepare("SELECT 1 AS found FROM a2a_local_outbox WHERE gateway_task_id=? AND operation IN ('completed','failed','rejected') LIMIT 1")
      .get(taskId) as { found?: number } | undefined;
    return row?.found === 1;
  }
  hasDeliveryUnknownEvent(taskId: string): boolean {
    const rows = this.db.prepare("SELECT envelope_json FROM a2a_local_outbox WHERE gateway_task_id=? AND operation='working'")
      .all(taskId) as Array<{ envelope_json?: string }>;
    return rows.some((row) => {
      try { return JSON.parse(String(row.envelope_json || '{}')).payload?.deliveryState === 'DELIVERY_UNKNOWN'; }
      catch (_) { return false; }
    });
  }
  finishCommand(eventId: string, status: 'processed' | 'outcome_unknown', errorCode?: string): void {
    this.db.prepare(`UPDATE a2a_local_inbox SET status=?,execution_state=?,processed_at=?,error_code=?,
      envelope_json=CASE WHEN ?='processed' THEN NULL ELSE envelope_json END WHERE event_id=?`)
      .run(status, status, Date.now(), errorCode || null, status, eventId);
  }
  retryCommand(eventId: string, errorCode: string, delayMs = 2_000): void {
    this.db.prepare("UPDATE a2a_local_inbox SET status='received',execution_state='retry',next_attempt_at=?,error_code=? WHERE event_id=?")
      .run(Date.now() + delayMs, errorCode, eventId);
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
  retryOutboxEvent(eventId: string, errorCode: string): void {
    const row = this.db.prepare('SELECT attempt_count FROM a2a_local_outbox WHERE event_id=?')
      .get(eventId) as { attempt_count?: number } | undefined;
    const attempt = Math.max(1, Number(row?.attempt_count || 1));
    const delay = Math.min(60_000, 1_000 * (2 ** Math.min(6, attempt - 1)));
    this.db.prepare(`UPDATE a2a_local_outbox SET status='pending',lease_owner=NULL,lease_expires_at=NULL,
      next_attempt_at=?,last_error_code=?,updated_at=? WHERE event_id=?`)
      .run(Date.now() + delay, errorCode, Date.now(), eventId);
  }
  saveOutboundResult(item: { taskId: string; sequence: number; payload: any }): boolean {
    const payload = item.payload || {}; const result = this.db.prepare(`INSERT INTO a2a_remote_task_results
      (gateway_task_id,result_sequence,standard_state,delivery_state,response_json,updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(gateway_task_id) DO UPDATE SET result_sequence=excluded.result_sequence,standard_state=excluded.standard_state,
      delivery_state=excluded.delivery_state,response_json=excluded.response_json,updated_at=excluded.updated_at
      WHERE excluded.result_sequence>a2a_remote_task_results.result_sequence`).run(item.taskId, item.sequence,
      String(payload.standardState || 'SUBMITTED'), String(payload.deliveryState || 'DELIVERY_UNKNOWN'), JSON.stringify(payload.response || {}), Date.now());
    return Number(result.changes) === 1;
  }
  getOutboundResult(taskId: string): Record<string, unknown> | null {
    return (this.db.prepare('SELECT * FROM a2a_remote_task_results WHERE gateway_task_id=?').get(taskId) as Record<string, unknown> | undefined) || null;
  }
}

export { A2ALocalTaskStore, TERMINAL_STATES };
export type { CreateLocalTaskInput, DeliveryState, StandardTaskState };
