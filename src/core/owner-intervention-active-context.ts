export interface ActiveOwnerInterventionContext {
  agentId: string;
  channelId: string;
  protocolConversationId: string;
  sessionScopeId: string;
  sourceMessageId: string;
  registeredAt: number;
}

const activeByAgent = new Map<string, Map<string, ActiveOwnerInterventionContext>>();

export function registerActiveOwnerInterventionContext(
  input: Omit<ActiveOwnerInterventionContext, 'registeredAt'>,
): () => void {
  const context = { ...input, registeredAt: Date.now() };
  let contexts = activeByAgent.get(input.agentId);
  if (!contexts) {
    contexts = new Map();
    activeByAgent.set(input.agentId, contexts);
  }
  contexts.set(input.sourceMessageId, context);
  return () => {
    const current = activeByAgent.get(input.agentId);
    if (current?.get(input.sourceMessageId) === context) current.delete(input.sourceMessageId);
    if (current?.size === 0) activeByAgent.delete(input.agentId);
  };
}

export function resolveActiveOwnerInterventionContext(
  agentId: string,
  sourceMessageId?: string | null,
): { status: 'resolved'; context: ActiveOwnerInterventionContext }
  | { status: 'unavailable' }
  | { status: 'ambiguous' } {
  const contexts = activeByAgent.get(String(agentId || '').trim());
  if (!contexts?.size) return { status: 'unavailable' };
  if (sourceMessageId) {
    const exact = contexts.get(String(sourceMessageId));
    return exact ? { status: 'resolved', context: exact } : { status: 'unavailable' };
  }
  const candidates = [...contexts.values()];
  return candidates.length === 1
    ? { status: 'resolved', context: candidates[0] }
    : { status: 'ambiguous' };
}
