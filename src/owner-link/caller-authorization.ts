import type { DatabaseLike } from '../types/database';
import type { ApprovalBinding } from './approval';

const { AgentIdentityBindingStore } = require('../core/provider-agent-identity');

interface OwnerPullCaller {
  providerType?: string;
  providerInstanceId?: string;
  instanceId?: string;
  nativeSessionId?: string;
  evidence?: string;
}

type OwnerPullAuthorization = ApprovalBinding & { evidence: string };

function createOwnerPullCallerAuthorizer(db: DatabaseLike, getCaller: () => OwnerPullCaller | null) {
  const bindings = new AgentIdentityBindingStore(db);
  return (agentId: string): OwnerPullAuthorization | null => {
    const caller = getCaller();
    if (!caller?.providerType || !caller.nativeSessionId || !caller.evidence) return null;
    const matches = bindings.resolve(caller.providerType,
      caller.providerInstanceId || caller.instanceId || '', caller.nativeSessionId);
    if (matches.length !== 1 || matches[0] !== agentId) return null;
    return {
      providerType: caller.providerType,
      providerInstanceId: caller.providerInstanceId || caller.instanceId || '',
      adapterType: 'owner-pull', deliveryMode: 'pull', bindingVersion: 0,
      nativeSessionId: caller.nativeSessionId, evidence: caller.evidence,
    };
  };
}

export { createOwnerPullCallerAuthorizer };
export type { OwnerPullAuthorization, OwnerPullCaller };
