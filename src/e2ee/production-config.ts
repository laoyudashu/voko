type ConfigLoader = (type: string) => any;

function configuredValue(env: NodeJS.ProcessEnv, name: string, saved: Record<string, unknown>): string {
  if (Object.prototype.hasOwnProperty.call(env,name)) return String(env[name] || '').trim();
  return String(saved[name] || '').trim();
}

function loadProductionE2eeConfig(env: NodeJS.ProcessEnv, load: ConfigLoader) {
  const saved = load('e2ee_production_config') || {};
  return {
    enabled: configuredValue(env,'VOKO_E2EE_PRODUCTION_ENABLED',saved) === 'true',
    endpoint: configuredValue(env,'VOKO_E2EE_ENDPOINT',saved),
    manifestPath: configuredValue(env,'VOKO_E2EE_ENDPOINT_MANIFEST',saved),
    publicKeyPem: configuredValue(env,'VOKO_E2EE_RELEASE_PUBLIC_KEY_PEM',saved).replace(/\\n/g,'\n'),
    databasePath: configuredValue(env,'VOKO_E2EE_DB_PATH',saved),
    agentIds: configuredValue(env,'VOKO_E2EE_PRODUCTION_AGENT_IDS',saved),
    pollIntervalMs: Math.max(2_000,Number(configuredValue(env,'VOKO_E2EE_DIRECTORY_INTERVAL_MS',saved) || 2_000)),
  };
}

module.exports = { loadProductionE2eeConfig };
