export interface ActiveOwnerInterventionContext {
  agentId: string;
  channelId: string;
  protocolConversationId: string;
  sessionScopeId: string;
  sourceMessageId: string;
  visitorId: string;
  interventionCreated: Promise<void>;
  registeredAt: number;
}

const activeByAgent = new Map<string, Map<string, ActiveOwnerInterventionContext>>();

export function registerActiveOwnerInterventionContext(
  input: Omit<ActiveOwnerInterventionContext, 'registeredAt' | 'interventionCreated'>,
): () => void {
  let notifyInterventionCreated!: () => void;
  const interventionCreated = new Promise<void>((resolve) => { notifyInterventionCreated = resolve; });
  const context = { ...input, interventionCreated, registeredAt: Date.now() };
  Object.defineProperty(context, 'notifyInterventionCreated', { value: notifyInterventionCreated });
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
    if (exact) return { status: 'resolved', context: exact };
  }
  const candidates = [...contexts.values()];
  return candidates.length === 1
    ? { status: 'resolved', context: candidates[0] }
    : { status: 'ambiguous' };
}

export function notifyOwnerInterventionCreated(context: ActiveOwnerInterventionContext): void {
  (context as ActiveOwnerInterventionContext & { notifyInterventionCreated?: () => void })
    .notifyInterventionCreated?.();
}
