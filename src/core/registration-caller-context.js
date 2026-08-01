const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();

function runWithRegistrationCaller(caller, callback) {
  return storage.run(caller || null, callback);
}

function getRegistrationCaller() {
  return storage.getStore() || null;
}

function runWithProviderCaller(caller, callback) {
  return storage.run(caller || null, callback);
}

function getProviderCaller() {
  return storage.getStore() || null;
}

function detectProviderSessionFromEnv(providerType, env = process.env) {
  const names = {
    codex: ['CODEX_THREAD_ID'],
    'claude-code': ['CLAUDE_CODE_SESSION_ID'],
    kiro: ['KIRO_SESSION_ID', 'KIRO_CLI_SESSION_ID'],
    opencode: ['OPENCODE_SESSION_ID'],
  }[String(providerType || '').toLowerCase()] || [];
  for (const name of ['VOKO_CALLER_SESSION_ID', ...names]) {
    const value = String(env[name] || '').trim();
    if (value) return value.slice(0, 512);
  }
  return null;
}

module.exports = {
  getProviderCaller,
  detectProviderSessionFromEnv,
  runWithProviderCaller,
  getRegistrationCaller,
  runWithRegistrationCaller,
};
