export type ProviderDeliveryPresentationState =
  | 'verified'
  | 'pending_verification'
  | 'login_expired'
  | 'quota_exhausted'
  | 'timeout'
  | 'failed'
  | 'not_installed';

export interface ProviderDeliveryPresentation {
  state: ProviderDeliveryPresentationState;
  tone: 'success' | 'warning' | 'danger-warning' | 'danger' | 'muted';
  action: 'verify' | 'setup' | 'retry' | 'resolve' | null;
}

export function classifyProviderDeliveryPresentation(method: Record<string, unknown>): ProviderDeliveryPresentation {
  const status = String(method.status || '');
  const verification = String(method.verificationStatus || '');
  const authentication = String(method.authenticationStatus || '');
  const reason = String(method.reason || '');
  const detail = String(method.detail || '');
  const evidence = `${verification} ${authentication} ${reason} ${detail}`.toLowerCase();
  if (verification === 'loopback_verified' || status === 'loopback_verified') {
    return { state: 'verified', tone: 'success', action: null };
  }
  if (verification === 'quota_exhausted' || /quota|credit|额度|配额|resource.package/.test(evidence)) {
    return { state: 'quota_exhausted', tone: 'danger-warning', action: 'resolve' };
  }
  if (verification === 'login_failed' || authentication === 'logged_out'
      || /not.logged|login.*(?:failed|required|expired)|unauthorized|认证|登录.*(?:失效|失败|未登录)/.test(evidence)) {
    return { state: 'login_expired', tone: 'danger-warning', action: 'setup' };
  }
  if (verification === 'timeout' || /timed?.out|timeout|etimedout|超时/.test(evidence)) {
    return { state: 'timeout', tone: 'warning', action: 'retry' };
  }
  if (verification === 'failed' || verification === 'parse_failed' || status === 'failed') {
    return { state: 'failed', tone: 'danger', action: 'resolve' };
  }
  const explicitlyMissing = method.installed === false || status === 'unavailable'
    || /not_found|not.installed|cli_unavailable|runtime_unavailable|未安装|未检测到/.test(evidence);
  if (explicitlyMissing) return { state: 'not_installed', tone: 'muted', action: 'setup' };
  return { state: 'pending_verification', tone: 'warning', action: 'verify' };
}

