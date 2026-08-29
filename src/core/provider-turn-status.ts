export type ProviderTurnFailureStatus = 'login_expired' | 'quota_exhausted' | 'timeout'
  | 'failed' | 'outcome_unknown' | 'automatic_delivery_disabled';

/** Convert internal Provider delivery evidence into the public status used by human chat surfaces. */
export function classifyProviderTurnFailure(value: any): ProviderTurnFailureStatus {
  const code = String(value?.code || value?.errorCode || '');
  const outcome = String(value?.deliveryOutcome || value?.outcome || '');
  const evidence = `${code} ${String(value?.message || value?.error || '')}`.toLowerCase();
  if (code === 'AUTOMATIC_DELIVERY_DISABLED') return 'automatic_delivery_disabled';
  if (/quota|credit|额度|配额/.test(evidence)) return 'quota_exhausted';
  if (/login|auth|unauthorized|未登录|登录/.test(evidence)) return 'login_expired';
  if (/timeout|timed out|etimedout|超时/.test(evidence)) return 'timeout';
  if (outcome === 'outcome_unknown') return 'outcome_unknown';
  return 'failed';
}
