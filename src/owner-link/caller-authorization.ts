import type { DatabaseLike } from '../types/database';

const { AgentIdentityBindingStore } = require('../core/provider-agent-identity');

interface OwnerPullCaller {
  providerType?: string;
  providerInstanceId?: string;
  instanceId?: string;
  nativeSessionId?: string;
  evidence?: string;
}

function createOwnerPullCallerAuthorizer(db: DatabaseLike, getCaller: () => OwnerPullCaller | null) {
  const bindings = new AgentIdentityBindingStore(db);
  return (agentId: string): boolean => {
    const caller = getCaller();
    if (!caller?.providerType || !caller.nativeSessionId || !caller.evidence) return false;
    const matches = bindings.resolve(caller.providerType,
      caller.providerInstanceId || caller.instanceId || '', caller.nativeSessionId);
    return matches.length === 1 && matches[0] === agentId;
  };
}

export { createOwnerPullCallerAuthorizer };
export type { OwnerPullCaller };
