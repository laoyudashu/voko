'use strict';
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const YAML = require('yaml');

/** Read the same YAML values for setup and authenticated profile discovery. */
function readHermesGatewayConfig(configPath) {
  const source = fs.readFileSync(configPath, 'utf8');
  const document = YAML.parseDocument(source, { version: '1.1', prettyErrors: false });
  const prefix = ['platforms', 'api_server'];
  if (document.errors.length || document.warnings.length
    || (document.contents && !YAML.isMap(document.contents))) throw new Error('HERMES_CONFIG_INVALID');
  for (const keys of [['platforms'], prefix, [...prefix, 'extra']]) {
    const node = document.getIn(keys, true);
    if (node != null && !YAML.isMap(node)) throw new Error('HERMES_CONFIG_INVALID');
  }
  const apiKey = document.getIn([...prefix, 'extra', 'key']);
  const port = document.getIn([...prefix, 'extra', 'port']);
  const enabled = document.getIn([...prefix, 'enabled']);
  if ((apiKey != null && typeof apiKey !== 'string')
    || (port != null && (!Number.isSafeInteger(port) || port < 1 || port > 65535))
    || (enabled != null && typeof enabled !== 'boolean')) throw new Error('HERMES_CONFIG_INVALID');
  return { configPath, source, document, apiKey: apiKey || '', port: port || null, enabled: enabled === true };
}

/** Only collect API connection candidates; authentication decides which the runtime uses. */
function readHermesGatewayEnvironment(configPath, env = process.env) {
  let source = '';
  try { source = fs.readFileSync(path.join(path.dirname(configPath), '.env'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('HERMES_ENV_UNREADABLE'); }
  const local = {};
  // Consume whole quoted values, including unrelated multiline variables. Python-dotenv
  // treats an unquoted # as a comment only when whitespace precedes it, unlike Node parseEnv.
  const entries = /^[^\S\r\n]*(?:export[^\S\r\n]+)?(?:'([^'\r\n]+)'|([^=#\s]+))[^\S\r\n]*(?:=[^\S\r\n]*('(?:\\'|[^'])*'|"(?:\\"|[^"])*"|[^\r\n]*))?([^\r\n]*)/gm;
  const escapes = { '\\': '\\', "'": "'", '"': '"', a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
  for (const match of source.matchAll(entries)) {
    const key = match[1] || match[2];
    if (key !== 'API_SERVER_KEY' && key !== 'API_SERVER_PORT') continue;
    const raw = match[3];
    if ((match[4].trim() && !match[4].trim().startsWith('#'))
      || (raw && (raw[0] === "'" || raw[0] === '"') && (raw.length < 2 || raw.at(-1) !== raw[0]))) {
      throw new Error('HERMES_ENV_INVALID: API 连接变量格式无效');
    }
    if (raw === undefined) continue; // A bare variable does not override the process environment.
    if (raw[0] === "'" || raw[0] === '"') {
      const escaped = raw[0] === "'" ? /\\([\\'])/g : /\\([\\'"abfnrtv])/g;
      local[key] = raw.slice(1, -1).replace(escaped, (_all, char) => escapes[char]);
    } else local[key] = raw.replace(/\s+#.*/, '').trimEnd();
  }
  const values = { ...env, ...local };
  const apiKey = values.API_SERVER_KEY || '';
  const port = /^\d+$/.test(values.API_SERVER_PORT || '') ? Number(values.API_SERVER_PORT) : null;
  // Expressions and external secret sources require native resolution; never send an expression as a key.
  if (apiKey.includes('${') || String(values.API_SERVER_PORT || '').includes('${')) {
    throw new Error('HERMES_ENV_REFERENCE_UNSUPPORTED: API 连接变量包含表达式，请使用已解析的端口和 Key');
  }
  return { apiKey, port: Number.isSafeInteger(port) && port > 0 && port <= 65535 ? port : null,
    source: Object.hasOwn(local, 'API_SERVER_KEY') || Object.hasOwn(local, 'API_SERVER_PORT') ? 'profile_env' : 'process_env' };
}

function hermesGatewayConnections(config, environment = readHermesGatewayEnvironment(config.configPath)) {
  const yaml = { apiKey: config.apiKey, port: config.port || 8642, configPath: config.configPath, connectionSource: 'yaml' };
  const candidates = [];
  if (environment.apiKey || environment.port) {
    candidates.push({ ...yaml, apiKey: environment.apiKey || config.apiKey,
      port: environment.port || yaml.port, connectionSource: environment.source });
  }
  candidates.push(yaml);
  return candidates.filter((candidate, i, all) => all.findIndex(other => other.port === candidate.port && other.apiKey === candidate.apiKey) === i);
}

/** Preserve unrelated fields/comments and an exact backup before replacing the file. */
function writeHermesGatewayConfig(config, apiKey, port) {
  const { configPath, source, document } = config;
  if (!document.contents) document.contents = document.createNode({});
  // Create mappings explicitly: YAML 1.1 otherwise builds !!omap for missing setIn paths.
  for (const keys of [['platforms'], ['platforms', 'api_server'], ['platforms', 'api_server', 'extra']]) {
    if (!document.hasIn(keys)) document.setIn(keys, document.createNode({}));
  }
  document.setIn(['platforms', 'api_server', 'enabled'], true);
  document.setIn(['platforms', 'api_server', 'extra', 'key'], apiKey);
  document.setIn(['platforms', 'api_server', 'extra', 'port'], port);
  const output = document.toString({ lineWidth: 0 }).replace(/\n/g, source.includes('\r\n') ? '\r\n' : '\n');
  if (fs.readFileSync(configPath, 'utf8') !== source) throw new Error('HERMES_CONFIG_CHANGED: 配置已被其他程序修改，请重新检测');
  const backupPath = configPath + '.bak.' + crypto.randomBytes(6).toString('hex');
  fs.writeFileSync(backupPath, source, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  const temporaryPath = configPath + '.tmp.' + crypto.randomBytes(6).toString('hex');
  try {
    fs.writeFileSync(temporaryPath, output, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(temporaryPath, configPath);
  } finally {
    try { fs.unlinkSync(temporaryPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return backupPath;
}

module.exports = { readHermesGatewayConfig, writeHermesGatewayConfig, readHermesGatewayEnvironment, hermesGatewayConnections };
