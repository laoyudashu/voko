import type { DatabaseLike } from '../../types/database';

export type ProviderModularMode = 'disabled' | 'shadow' | 'enabled';

export interface ProviderModularRollout {
  mode: ProviderModularMode;
  providerFamilies: string[];
  familyModes: Record<string, ProviderModularMode>;
}

const DEFAULT_ROLLOUT: ProviderModularRollout = {
  mode: 'enabled',
  providerFamilies: ['goose'],
  familyModes: { cline: 'shadow', cursor: 'shadow', 'github-copilot': 'shadow' },
};

function normalizeMode(value: unknown): ProviderModularMode | null {
  const mode = String(value || '').trim().toLowerCase();
  return mode === 'disabled' || mode === 'shadow' || mode === 'enabled' ? mode : null;
}

function normalizeFamilies(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.map(item => String(item || '').trim()).filter(Boolean))]
    : [];
}

function normalizeFamilyModes(value: unknown): Record<string, ProviderModularMode> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const modes: Record<string, ProviderModularMode> = {};
  for (const [family, valueMode] of Object.entries(value)) {
    const name = String(family || '').trim();
    const mode = normalizeMode(valueMode);
    if (name && mode) modes[name] = mode;
  }
  return modes;
}

function defaultRollout(): ProviderModularRollout {
  return {
    mode: DEFAULT_ROLLOUT.mode,
    providerFamilies: [...DEFAULT_ROLLOUT.providerFamilies],
    familyModes: { ...DEFAULT_ROLLOUT.familyModes },
  };
}

function parseRollout(value: unknown): ProviderModularRollout | null {
  if (!value || typeof value !== 'object') return null;
  const parsed = value as Record<string, unknown>;
  const mode = normalizeMode(parsed.mode);
  if (!mode) return null;
  return {
    mode,
    providerFamilies: normalizeFamilies(parsed.providerFamilies),
    familyModes: normalizeFamilyModes(parsed.familyModes),
  };
}

export function getProviderModularRollout(
  db?: Pick<DatabaseLike, 'prepare'> | null,
  env: NodeJS.ProcessEnv = process.env,
): ProviderModularRollout {
  const fromEnv = env.VOKO_PROVIDER_MODULAR_DISPATCH;
  if (fromEnv) {
    try {
      const parsed = JSON.parse(fromEnv);
      const rollout = parseRollout(parsed);
      if (rollout) return rollout;
    } catch (_) {
      const mode = normalizeMode(fromEnv);
      if (mode) return {
        mode,
        providerFamilies: mode === 'disabled' ? [] : [...DEFAULT_ROLLOUT.providerFamilies],
        familyModes: mode === 'disabled' ? {} : { ...DEFAULT_ROLLOUT.familyModes },
      };
    }
  }
  try {
    const row = db?.prepare('SELECT data FROM config WHERE type=? LIMIT 1')
      .get('feature:provider_modular_dispatch_v1') as { data?: string } | undefined;
    if (!row?.data) return defaultRollout();
    const parsed = JSON.parse(row.data);
    return parseRollout(parsed) || defaultRollout();
  } catch (_) {
    return defaultRollout();
  }
}

export function providerModularModeForFamily(policy: ProviderModularRollout, family: string): ProviderModularMode {
  const name = String(family || '').trim();
  return policy.familyModes?.[name] || (policy.providerFamilies.includes(name) ? policy.mode : 'disabled');
}

module.exports = { getProviderModularRollout, providerModularModeForFamily };
