export {};

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'];

function mergeNoProxy(value?: string): string {
  const entries = String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const host of LOOPBACK_HOSTS) {
    if (!entries.includes(host)) entries.push(host);
  }
  return entries.join(',');
}

function ensureLoopbackNoProxy(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const merged = mergeNoProxy(env.NO_PROXY || env.no_proxy);
  env.NO_PROXY = merged;
  env.no_proxy = merged;
  return env;
}

module.exports = { ensureLoopbackNoProxy, mergeNoProxy };
