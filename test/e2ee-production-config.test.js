const test = require('node:test');
const assert = require('node:assert/strict');

const { loadProductionE2eeConfig } = require('../build/e2ee/production-config');

test('production E2EE configuration survives a normal process restart', () => {
  const saved = {
    VOKO_E2EE_PRODUCTION_ENABLED:'true',
    VOKO_E2EE_ENDPOINT:'C:\\runtime\\endpoint.exe',
    VOKO_E2EE_PRODUCTION_AGENT_IDS:'legacy-test-only',
  };
  const config = loadProductionE2eeConfig({},() => saved);
  assert.equal(config.enabled,true);
  assert.equal(config.endpoint,saved.VOKO_E2EE_ENDPOINT);
  assert.equal(config.agentIds,undefined,'production must cover every published Agent owned by this Lite');
  assert.equal(config.pollIntervalMs,2_000);
});

test('explicit environment values override persisted E2EE configuration', () => {
  const config = loadProductionE2eeConfig({
    VOKO_E2EE_PRODUCTION_ENABLED:'false',
    VOKO_E2EE_DIRECTORY_INTERVAL_MS:'2500',
  },() => ({ VOKO_E2EE_PRODUCTION_ENABLED:'true' }));
  assert.equal(config.enabled,false);
  assert.equal(config.pollIntervalMs,2_500);
});
