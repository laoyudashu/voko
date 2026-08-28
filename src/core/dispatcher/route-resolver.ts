import type { AgentMeta } from './types';
const { getProviderTransport } = require('./provider-catalog');

export type RouteOperation = 'push' | 'steer';

interface CandidateProvider {
  priority?: number;
  match?(agentId: string, meta: AgentMeta): boolean;
  isAvailable?(agentId: string): boolean;
  push?: unknown;
  steer?: unknown;
}

export interface ResolvedRouteCandidate {
  providerId: string;
  provider: CandidateProvider;
  mode: string;
  providerType: string;
}

export class RouteResolver {
  resolve(input: {
    agentId: string;
    operation: RouteOperation;
    meta: AgentMeta;
    providers: Record<string, CandidateProvider>;
  }): ResolvedRouteCandidate[] {
    const configuredModes = Array.isArray(input.meta.delivery_modes) ? input.meta.delivery_modes.map(String) : null;
    const candidates: ResolvedRouteCandidate[] = [];
    for (const [providerId, provider] of Object.entries(input.providers)) {
      const definition = getProviderTransport(providerId);
      if (!definition || !definition.operations.includes(input.operation)) continue;
      // Owner transports are a separate authenticated control plane. They must
      // never participate in visitor/Agent delivery, even when no modes were persisted.
      if (definition.owner?.enabled) continue;
      if (configuredModes && !configuredModes.includes(definition.mode)) continue;
      try {
        if (!provider.match?.(input.agentId, input.meta) || !provider.isAvailable?.(input.agentId)) continue;
      } catch (_) { continue; }
      candidates.push({ providerId, provider, mode: definition.mode, providerType: definition.family });
    }
    candidates.sort((a, b) => {
      if (configuredModes) {
        const order = configuredModes.indexOf(a.mode) - configuredModes.indexOf(b.mode);
        if (order) return order;
      }
      return (b.provider.priority ?? getProviderTransport(b.providerId)?.priority ?? 0)
        - (a.provider.priority ?? getProviderTransport(a.providerId)?.priority ?? 0);
    });
    return candidates;
  }
}

module.exports = { RouteResolver };
