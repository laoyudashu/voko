const { AsyncLocalStorage } = require('node:async_hooks');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
    goose: ['AGENT_SESSION_ID'],
    hermes: ['HERMES_SESSION_ID'],
  }[String(providerType || '').toLowerCase()] || [];
  const managedEvidence = String(env.VOKO_CALLER_EVIDENCE || '').trim() === 'voko_created';
  for (const name of [...(managedEvidence ? ['VOKO_CALLER_SESSION_ID'] : []), ...names]) {
    const value = String(env[name] || '').trim();
    if (value) return value.slice(0, 512);
  }
  return null;
}

function detectProviderCallerFromEnv(providerType, env = process.env) {
  const forwardedType = String(env.VOKO_CALLER_PROVIDER || '').trim().toLowerCase();
  const resolvedType = forwardedType || String(providerType || '').trim().toLowerCase();
  const nativeSessionId = detectProviderSessionFromEnv(resolvedType, env);
  const managedEvidence = String(env.VOKO_CALLER_EVIDENCE || '').trim() === 'voko_created';
  return {
    providerType: resolvedType || null,
    // An instance is a VOKO-managed adapter fact, not a free-form Provider
    // environment value. Without the explicit evidence marker, ignore it so
    // a manually set variable cannot select another Agent's binding.
    providerInstanceId: managedEvidence
      ? (String(env.VOKO_CALLER_INSTANCE || '').trim().slice(0, 192) || null)
      : null,
    nativeSessionId,
    evidence: nativeSessionId
      ? (String(env.VOKO_CALLER_EVIDENCE || '').trim() === 'voko_created' ? 'voko_created' : 'provider_env')
      : null,
  };
}

function detectProviderSessionFromProcess(providerType, options = {}) {
  if (String(providerType || '').toLowerCase() !== 'codex'
    || (options.platform || process.platform) !== 'linux') return null;
  const procRoot = options.procRoot || '/proc';
  const sessionRoot = path.resolve(options.home || os.homedir(), '.codex', 'sessions') + path.sep;
  let pid = Number(options.ppid || process.ppid);
  const matches = new Set();
  for (let depth = 0; depth < 8 && pid > 1; depth++) {
    const fdRoot = path.join(procRoot, String(pid), 'fd');
    let entries = [];
    try { entries = fs.readdirSync(fdRoot); } catch (_) {}
    for (const entry of entries) {
      try {
        const target = fs.realpathSync(path.join(fdRoot, entry));
        if (!target.startsWith(sessionRoot) || !/rollout-.*\.jsonl$/i.test(target)) continue;
        const firstLine = fs.readFileSync(target, 'utf8').split(/\r?\n/, 1)[0];
        const record = JSON.parse(firstLine);
        const sessionId = String(record?.payload?.session_id || record?.payload?.id || '').trim();
        if (/^[a-zA-Z0-9_-]{16,128}$/.test(sessionId)) matches.add(sessionId);
      } catch (_) {}
    }
    try {
      const stat = fs.readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8');
      const close = stat.lastIndexOf(')');
      pid = Number(stat.slice(close + 2).split(' ')[1]) || 0;
    } catch (_) { break; }
  }
  return matches.size === 1 ? [...matches][0] : null;
}

function detectProviderCaller(providerType, env = process.env, options = {}) {
  const caller = detectProviderCallerFromEnv(providerType, env);
  if (caller.nativeSessionId) return caller;
  const nativeSessionId = detectProviderSessionFromProcess(caller.providerType || providerType, options);
  return nativeSessionId
    ? { ...caller, nativeSessionId, evidence: 'provider_process' }
    : caller;
}

module.exports = {
  getProviderCaller,
  detectProviderCallerFromEnv,
  detectProviderCaller,
  detectProviderSessionFromProcess,
  detectProviderSessionFromEnv,
  runWithProviderCaller,
  getRegistrationCaller,
  runWithRegistrationCaller,
};
