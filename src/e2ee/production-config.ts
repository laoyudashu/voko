type ConfigLoader = (type: string) => any;

function configuredValue(env: NodeJS.ProcessEnv, name: string, saved: Record<string, unknown>): string {
  if (Object.prototype.hasOwnProperty.call(env,name)) return String(env[name] || '').trim();
  return String(saved[name] || '').trim();
}

function loadProductionE2eeConfig(env: NodeJS.ProcessEnv, load: ConfigLoader) {
  const saved = load('e2ee_production_config') || {};
  const savedReleaseComplete = ['VOKO_E2EE_ENDPOINT','VOKO_E2EE_ENDPOINT_MANIFEST','VOKO_E2EE_RELEASE_PUBLIC_KEY_PEM']
    .every(name => String(saved[name] || '').trim());
  // The executable, manifest and verification key form one activated release.
  // Once persisted, never mix that release with stale variables inherited
  // from a long-lived terminal during an ordinary restart.
  const releaseValue = (name: string) => savedReleaseComplete
    ? String(saved[name] || '').trim()
    : configuredValue(env,name,saved);
  return {
    enabled: configuredValue(env,'VOKO_E2EE_PRODUCTION_ENABLED',saved) === 'true',
    endpoint: releaseValue('VOKO_E2EE_ENDPOINT'),
    manifestPath: releaseValue('VOKO_E2EE_ENDPOINT_MANIFEST'),
    publicKeyPem: releaseValue('VOKO_E2EE_RELEASE_PUBLIC_KEY_PEM').replace(/\\n/g,'\n'),
    databasePath: configuredValue(env,'VOKO_E2EE_DB_PATH',saved),
    pollIntervalMs: Math.max(2_000,Number(configuredValue(env,'VOKO_E2EE_DIRECTORY_INTERVAL_MS',saved) || 2_000)),
  };
}

module.exports = { loadProductionE2eeConfig };
