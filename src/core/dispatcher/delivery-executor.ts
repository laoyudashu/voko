export type DeliveryOutcome = 'delivered' | 'not_delivered' | 'outcome_unknown' | 'rejected';

export interface DeliveryResult {
  outcome: DeliveryOutcome;
  providerId: string | null;
  providerType: string | null;
  deliveryMode: string | null;
  errorCode?: string;
  result?: unknown;
}

export interface DeliveryCandidate<T> {
  providerId: string;
  providerType: string;
  deliveryMode: string;
  target: T;
}

export class DeliveryExecutor {
  async execute<T>(input: {
    next(excluded: Set<T>): DeliveryCandidate<T> | null;
    invoke(candidate: DeliveryCandidate<T>): Promise<unknown>;
    classify(error: unknown): Exclude<DeliveryOutcome, 'delivered'>;
    onAttempt?(candidate: DeliveryCandidate<T>): void;
    onFailure?(candidate: DeliveryCandidate<T>, outcome: Exclude<DeliveryOutcome, 'delivered'>, error: unknown): void;
    onSuccess?(candidate: DeliveryCandidate<T>, result: unknown): void;
  }): Promise<DeliveryResult> {
    const excluded = new Set<T>();
    let attempts = 0;
    let lastFailure: DeliveryResult | null = null;
    while (attempts < 2) {
      const candidate = input.next(excluded);
      if (!candidate) return lastFailure || { outcome: 'not_delivered', providerId: null, providerType: null, deliveryMode: null };
      attempts += 1;
      try {
        input.onAttempt?.(candidate);
        const result = await input.invoke(candidate);
        input.onSuccess?.(candidate, result);
        return { outcome: 'delivered', providerId: candidate.providerId, providerType: candidate.providerType, deliveryMode: candidate.deliveryMode, result };
      } catch (error) {
        const outcome = input.classify(error);
        lastFailure = { outcome, providerId: candidate.providerId, providerType: candidate.providerType, deliveryMode: candidate.deliveryMode, errorCode: (error as any)?.code };
        excluded.add(candidate.target);
        input.onFailure?.(candidate, outcome, error);
        if (outcome !== 'not_delivered') {
          return { outcome, providerId: candidate.providerId, providerType: candidate.providerType, deliveryMode: candidate.deliveryMode, errorCode: (error as any)?.code };
        }
      }
    }
    return lastFailure || { outcome: 'not_delivered', providerId: null, providerType: null, deliveryMode: null };
  }
}

module.exports = { DeliveryExecutor };
