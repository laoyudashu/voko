import type { DatabaseLike } from '../../types/database';

export type ProviderModularMode = 'disabled' | 'shadow' | 'enabled';

export interface ProviderModularRollout {
  mode: ProviderModularMode;
  providerFamilies: string[];
}

const DEFAULT_ROLLOUT: ProviderModularRollout = { mode: 'enabled', providerFamilies: ['goose'] };

function normalizeMode(value: unknown): ProviderModularMode | null {
  const mode = String(value || '').trim().toLowerCase();
  return mode === 'disabled' || mode === 'shadow' || mode === 'enabled' ? mode : null;
}

function normalizeFamilies(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.map(item => String(item || '').trim()).filter(Boolean))]
    : [];
}

export function getProviderModularRollout(
  db?: Pick<DatabaseLike, 'prepare'> | null,
  env: NodeJS.ProcessEnv = process.env,
): ProviderModularRollout {
  const fromEnv = env.VOKO_PROVIDER_MODULAR_DISPATCH;
  if (fromEnv) {
    try {
      const parsed = JSON.parse(fromEnv);
      const mode = normalizeMode(parsed?.mode);
      if (mode) return { mode, providerFamilies: normalizeFamilies(parsed.providerFamilies) };
    } catch (_) {
      const mode = normalizeMode(fromEnv);
      if (mode) return { mode, providerFamilies: mode === 'disabled' ? [] : DEFAULT_ROLLOUT.providerFamilies };
    }
  }
  try {
    const row = db?.prepare('SELECT data FROM config WHERE type=? LIMIT 1')
      .get('feature:provider_modular_dispatch_v1') as { data?: string } | undefined;
    if (!row?.data) return { ...DEFAULT_ROLLOUT, providerFamilies: [...DEFAULT_ROLLOUT.providerFamilies] };
    const parsed = JSON.parse(row.data);
    const mode = normalizeMode(parsed?.mode);
    return mode ? { mode, providerFamilies: normalizeFamilies(parsed.providerFamilies) }
      : { ...DEFAULT_ROLLOUT, providerFamilies: [...DEFAULT_ROLLOUT.providerFamilies] };
  } catch (_) {
    return { ...DEFAULT_ROLLOUT, providerFamilies: [...DEFAULT_ROLLOUT.providerFamilies] };
  }
}

export function providerModularModeForFamily(policy: ProviderModularRollout, family: string): ProviderModularMode {
  return policy.providerFamilies.includes(String(family || '').trim()) ? policy.mode : 'disabled';
}

module.exports = { getProviderModularRollout, providerModularModeForFamily };
