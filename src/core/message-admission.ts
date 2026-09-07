import type { DatabaseLike } from '../types/database';

type Db = Pick<DatabaseLike, 'prepare'>;
export type AdmissionState = 'pending' | 'allowed' | 'denied';
export interface Admission { state: AdmissionState; reason: string }
export interface AdmissionMessage {
  id: string; agent_id?: string | null; from_uid: string; channel_id: string;
  channel_type: number | null; is_me?: number; content_type?: number | null; mention?: string | null;
}

/** One decision per recipient: group message bodies are shared across Agents. */
export function getAdmission(db: Db, agentId: string, messageId: string): Admission | undefined {
  return db.prepare('SELECT state,reason FROM agent_message_admissions WHERE agent_id=? AND message_id=?')
    .get(agentId, messageId) as Admission | undefined;
}

export function beginAdmission(db: Db, agentId: string, messageId: string): void {
  db.prepare(`INSERT OR IGNORE INTO agent_message_admissions
    (agent_id,message_id,state,reason,created_at,updated_at) VALUES (?,?,'pending','ADMISSION_CHECK_STARTED',?,?)`)
    .run(agentId, messageId, Date.now(), Date.now());
}

export function finishAdmission(db: Db, agentId: string, messageId: string, state: 'allowed' | 'denied', reason: string): void {
  // Terminal denials are not silently reopened when a list or rule changes.
  db.prepare(`INSERT INTO agent_message_admissions (agent_id,message_id,state,reason,created_at,updated_at)
    VALUES (?,?,?,?,?,?) ON CONFLICT(agent_id,message_id) DO UPDATE SET
    state=excluded.state,reason=excluded.reason,updated_at=excluded.updated_at
    WHERE agent_message_admissions.state='pending'`)
    .run(agentId, messageId, state, reason, Date.now(), Date.now());
}

export function parseMention(value: unknown): { all: boolean; uids: string[] } | null {
  if (value == null) return { all: false, uids: [] };
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch (_) { return null; } }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const m = value as { all?: unknown; uids?: unknown };
  if (m.all !== undefined && typeof m.all !== 'boolean') return null;
  if (m.uids !== undefined && (!Array.isArray(m.uids)
    || m.uids.some(uid => typeof uid !== 'string' || !uid.trim()))) return null;
  return { all: m.all === true, uids: [...new Set((m.uids || []) as string[])] };
}

export function currentAccessDenial(db: Db, agentId: string, fromUid: string, channelType: number | null): string | null {
  const agent = db.prepare('SELECT publish_status,access_mode FROM agents WHERE agent_id=?').get(agentId) as { publish_status?: string; access_mode?: string } | undefined;
  if (db.prepare(`SELECT 1 FROM agent_access_lists WHERE agent_id=? AND visitor_id=? AND list_type='blacklist'`)
    .get(agentId, fromUid)) return 'ACCESS_BLACKLIST_DENIED';
  if (!agent || !['published', 'private'].includes(agent.publish_status || '')) return 'AGENT_UNPUBLISHED';
  if (channelType !== 2 && agent.access_mode === 'private'
    && !db.prepare(`SELECT 1 FROM agent_access_lists WHERE agent_id=? AND visitor_id=?
      AND list_type='whitelist' AND auto_trust_disabled=0`).get(agentId, fromUid)) return 'ACCESS_WHITELIST_DENIED';
  return null;
}

export function isGroupTrigger(db: Db, agentId: string, row: AdmissionMessage): boolean {
  const m = parseMention(row.mention);
  const agent = db.prepare('SELECT imUid FROM agents WHERE agent_id=?').get(agentId) as { imUid?: string } | undefined;
  return !!(m && agent?.imUid && row.from_uid !== agent.imUid
    && (m.all || m.uids.includes(agent.imUid)) && ![11,12].includes(Number(row.content_type)));
}

/** Missing/legacy decisions are never interpreted as permission. */
export function messageReadState(db: Db, agentId: string, row: AdmissionMessage,
  purpose: 'context' | 'trigger' = 'context'): 'readable' | 'skip' | 'pending' {
  if ([11,12].includes(Number(row.content_type))) return 'skip';
  if (row.channel_type !== 2 && row.agent_id !== agentId) return 'skip';
  const uid = (db.prepare('SELECT imUid FROM agents WHERE agent_id=?').get(agentId) as { imUid?: string } | undefined)?.imUid;
  const own = row.from_uid === uid || (row.channel_type !== 2 && row.is_me === 1);
  if (currentAccessDenial(db, agentId, own && row.channel_type !== 2 ? row.channel_id : row.from_uid, row.channel_type)) return 'skip';
  if (own) return purpose === 'context' ? 'readable' : 'skip';
  if (purpose === 'trigger') {
    if (row.channel_type === 2 && !isGroupTrigger(db, agentId, row)) return 'skip';
    const conv = db.prepare('SELECT mode,session_status,session_expire_at FROM conversations WHERE agent_id=? AND channel_id=?')
      .get(agentId, row.channel_id) as { mode?: string; session_status?: string; session_expire_at?: number } | undefined;
    if (conv?.mode === 'MANUAL') return 'skip';
    if (row.channel_type !== 2 && db.prepare(`SELECT 1 FROM agent_pricing WHERE agent_id=? AND enabled=1 AND pricing_model='timed'`).get(agentId)
      && (conv?.session_status !== 'active' || !conv.session_expire_at || conv.session_expire_at <= Date.now())) return 'skip';
  }
  const admission = getAdmission(db, agentId, row.id);
  if (!admission || admission.state === 'denied') return 'skip';
  if (admission.state === 'pending') return 'pending';
  if (purpose === 'trigger' && admission.reason !== 'ALLOWED') return 'skip';
  return 'readable';
}

export function assertMessagesReadable(db: Db, agentId: string, ids: Iterable<string>, purpose: 'context' | 'trigger' = 'context'): void {
  for (const id of ids) {
    const row = db.prepare('SELECT * FROM messages WHERE id=?').get(id) as AdmissionMessage | undefined;
    if (!row || messageReadState(db, agentId, row, purpose) !== 'readable') {
      throw Object.assign(new Error('Message admission no longer permits Provider submission'), {
        code: 'MESSAGE_ADMISSION_REJECTED', deliveryOutcome: 'rejected',
      });
    }
  }
}

/** Call only after acquiring the database-scoped runtime instance lock. */
export function recoverInterruptedAdmissions(db: Db): void {
  db.prepare(`UPDATE agent_message_admissions SET state='denied',reason='ADMISSION_CHECK_INTERRUPTED',updated_at=?
    WHERE state='pending'`).run(Date.now());
}

/** SQL equivalent for history pagination. Arguments are internal SQL identifiers, never user input.
 * agentExpression='?' consumes exactly one parameter. */
export function readableMessageSql(alias = 'messages', agentExpression = '?'): string {
  const m = alias;
  const own = `(${m}.from_uid=ama.imUid OR (${m}.channel_type!=2 AND ${m}.is_me=1))`;
  const visitor = `(CASE WHEN ${own} AND ${m}.channel_type!=2 THEN ${m}.channel_id ELSE ${m}.from_uid END)`;
  return `EXISTS (SELECT 1 FROM agents ama WHERE ama.agent_id=${agentExpression}
    AND ama.publish_status IN ('published','private')
    AND (${m}.channel_type=2 OR ${m}.agent_id=ama.agent_id)
    AND COALESCE(${m}.content_type,1) NOT IN (11,12)
    AND NOT EXISTS (SELECT 1 FROM agent_access_lists aml WHERE aml.agent_id=ama.agent_id
      AND aml.visitor_id=${visitor} AND aml.list_type='blacklist')
    AND (${m}.channel_type=2 OR COALESCE(ama.access_mode,'public')!='private' OR EXISTS (
      SELECT 1 FROM agent_access_lists aml WHERE aml.agent_id=ama.agent_id
        AND aml.visitor_id=${visitor} AND aml.list_type='whitelist' AND aml.auto_trust_disabled=0))
    AND (${own} OR EXISTS (SELECT 1 FROM agent_message_admissions amd
      WHERE amd.agent_id=ama.agent_id AND amd.message_id=${m}.id AND amd.state='allowed')))`;
}
