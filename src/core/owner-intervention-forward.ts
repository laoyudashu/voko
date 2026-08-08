export type OwnerForwardOutcome =
  | 'delivered'
  | 'not_delivered'
  | 'outcome_unknown'
  | 'rejected';

const OUTCOMES = new Set<OwnerForwardOutcome>([
  'delivered',
  'not_delivered',
  'outcome_unknown',
  'rejected',
]);

function explicitOutcome(value: unknown): OwnerForwardOutcome | null {
  const outcome = (value as { deliveryOutcome?: unknown } | null | undefined)?.deliveryOutcome;
  return typeof outcome === 'string' && OUTCOMES.has(outcome as OwnerForwardOutcome)
    ? outcome as OwnerForwardOutcome
    : null;
}

/**
 * Normalize a provider result or error without guessing that an unknown
 * result was delivered. A legacy successful promise remains delivered for
 * compatibility; a legacy failure is unknown and therefore Pull-only.
 */
export function normalizeOwnerForwardOutcome(value: unknown): OwnerForwardOutcome {
  const explicit = explicitOutcome(value);
  if (explicit) return explicit;

  if (value === false) return 'outcome_unknown';

  if (value && typeof value === 'object' && 'success' in value
    && (value as { success?: unknown }).success === false) {
    return 'outcome_unknown';
  }

  const isError = value instanceof Error;
  const message = isError ? value.message : String(value ?? '');
  if (/unavailable|not connected|disconnected|not running|not found|enoent|authentication|authorization|\b401\b|\b403\b/i.test(message)) {
    return 'not_delivered';
  }
  if (isError) return 'outcome_unknown';
  return 'delivered';
}

/**
 * Apply the terminal local state for an owner reply. Confirmed non-delivery
 * intentionally leaves the record retryable; unknown/rejected delivery is
 * marked Pull-readable and never retried automatically.
 */
export function settleOwnerForward(
  databaseAPI: {
    markAgentNotified(id: string): unknown;
    updateOwnerInterventionStatus(id: string, status: string, resolvedAt: number | null): unknown;
  },
  id: string,
  value: unknown,
): OwnerForwardOutcome {
  const outcome = normalizeOwnerForwardOutcome(value);
  if (outcome === 'delivered') {
    databaseAPI.markAgentNotified(id);
    databaseAPI.updateOwnerInterventionStatus(id, 'resolved', Date.now());
  } else if (outcome === 'outcome_unknown' || outcome === 'rejected') {
    databaseAPI.markAgentNotified(id);
    databaseAPI.updateOwnerInterventionStatus(id, 'unknown', null);
  }
  return outcome;
}

module.exports = { normalizeOwnerForwardOutcome, settleOwnerForward };
