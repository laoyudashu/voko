import type { DatabaseSync } from 'node:sqlite';
import { transitionOwnerExecution } from './execution';

interface OwnerChatPolicy {
  ownerChatEnabled: boolean;
  remoteExecutionEnabled: boolean;
  hostFullAccessEnabled: boolean;
  policyEpoch: number;
}

function readOwnerChatPolicy(db: DatabaseSync): OwnerChatPolicy {
  const row = db.prepare(`SELECT owner_chat_enabled,remote_execution_enabled,host_full_access_enabled,policy_epoch
    FROM owner_chat_policy WHERE id=1`).get() as any;
  return { ownerChatEnabled: Number(row?.owner_chat_enabled) === 1,
    remoteExecutionEnabled: Number(row?.remote_execution_enabled) === 1,
    hostFullAccessEnabled: Number(row?.host_full_access_enabled) === 1,
    policyEpoch: Math.max(1, Number(row?.policy_epoch || 1)) };
}

function updateOwnerChatPolicy(db: DatabaseSync, patch: Partial<Omit<OwnerChatPolicy,'policyEpoch'>>): OwnerChatPolicy {
  const current = readOwnerChatPolicy(db); const next = { ...current, ...patch, policyEpoch: current.policyEpoch + 1 };
  db.prepare(`UPDATE owner_chat_policy SET owner_chat_enabled=?,remote_execution_enabled=?,host_full_access_enabled=0,
    policy_epoch=?,updated_at=? WHERE id=1`).run(next.ownerChatEnabled?1:0,next.remoteExecutionEnabled?1:0,next.policyEpoch,Date.now());
  if (!next.ownerChatEnabled) {
    const rows = db.prepare(`SELECT message_id,execution_state FROM owner_chat_messages
      WHERE execution_state IN ('PERSISTED','DISPATCH_RESERVED')`).all() as Array<{message_id:string;execution_state:'PERSISTED'|'DISPATCH_RESERVED'}>;
    for (const row of rows) transitionOwnerExecution(db, { messageId: row.message_id, from: row.execution_state,
      to: 'REVOKED', reasonCode: 'OWNER_CHAT_DISABLED' });
  }
  return readOwnerChatPolicy(db);
}

export { readOwnerChatPolicy, updateOwnerChatPolicy };
export type { OwnerChatPolicy };
