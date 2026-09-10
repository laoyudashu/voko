'use strict';
const fs = require('fs');
const crypto = require('crypto');
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

module.exports = { readHermesGatewayConfig, writeHermesGatewayConfig };
