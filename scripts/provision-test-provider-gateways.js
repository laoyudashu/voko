#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    out[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}

function defaultDbPath() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA, 'voko', 'voko.db');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'voko', 'voko.db');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'voko', 'voko.db');
}

function addMode(db, family, mode, prefix) {
  const rows = db.prepare('SELECT agent_id,agent_name,delivery_modes FROM agents WHERE backend_type=?').all(family);
  let changed = 0;
  for (const row of rows) {
    if (!String(row.agent_name || '').startsWith(prefix)) continue;
    let modes = [];
    try { modes = JSON.parse(row.delivery_modes || '[]'); } catch (_) {}
    if (!Array.isArray(modes)) modes = [];
    const next = [...new Set([mode, ...modes.map(String), 'pull'])];
    if (JSON.stringify(next) === JSON.stringify(modes)) continue;
    db.prepare('UPDATE agents SET delivery_modes=?,updated_at=? WHERE agent_id=?')
      .run(JSON.stringify(next), Date.now(), row.agent_id);
    changed += 1;
  }
  return changed;
}

function atomicWritePrivate(filePath, content) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  let fd;
  try {
    fd = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporaryPath); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function configureHermes(db, profile, port) {
  const windowsRoot = process.platform === 'win32' && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'hermes') : null;
  const hermesRoot = windowsRoot && fs.existsSync(windowsRoot)
    ? windowsRoot : path.join(os.homedir(), '.hermes');
  // VOKO binds Hermes Agents to an explicit profile identity, including the
  // profile named "default". Keep its API server config in that profile
  // directory; the root config is a separate legacy/default CLI context.
  const configPath = profile === 'default'
    ? path.join(hermesRoot, 'config.yaml')
    : path.join(hermesRoot, 'profiles', profile, 'config.yaml');
  let yaml = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  const backup = `${configPath}.voko-http-${Date.now()}.bak`;
  if (fs.existsSync(configPath)) fs.copyFileSync(configPath, backup, fs.constants.COPYFILE_EXCL);
  const crlf = yaml.includes('\r\n');
  yaml = yaml.replace(/\r\n/g, '\n');
  const key = crypto.randomBytes(32).toString('hex');
  const block = `  api_server:\n    enabled: true\n    extra:\n      port: ${port}\n      host: 127.0.0.1\n      key: ${key}\n`;
  yaml = yaml.replace(/^  api_server:\n(?:    .*\n)*/gm, '');
  if (/^platforms:\s*$/m.test(yaml)) yaml = yaml.replace(/^(platforms:\s*\n)/m, `$1${block}`);
  else yaml = `${yaml}${yaml.endsWith('\n') || !yaml ? '' : '\n'}platforms:\n${block}`;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  atomicWritePrivate(configPath, crlf ? yaml.replace(/\n/g, '\r\n') : yaml);

  let config = {};
  try {
    const row = db.prepare("SELECT data FROM config WHERE type='hermes_config'").get();
    if (row?.data) config = JSON.parse(row.data);
  } catch (_) {}
  config.profiles = { ...(config.profiles || {}), [profile]: {
    ...((config.profiles || {})[profile] || {}), port, apiKey: key,
  } };
  db.prepare('INSERT OR REPLACE INTO config(type,data,updated_at) VALUES(?,?,?)')
    .run('hermes_config', JSON.stringify(config), Date.now());
  return { profile, port, backup: Boolean(backup), configured: true };
}

function main() {
  const options = args(process.argv.slice(2));
  if (options.apply !== true) throw new Error('Refusing to modify Provider state without --apply');
  const dbPath = path.resolve(String(options.db || defaultDbPath()));
  const prefix = String(options['agent-prefix'] || 'TEST-');
  if (prefix !== 'TEST-') throw new Error('This helper is restricted to TEST- Agents');
  const dbBackup = `${dbPath}.gateway-${Date.now()}.bak`;
  fs.copyFileSync(dbPath, dbBackup, fs.constants.COPYFILE_EXCL);
  const db = new DatabaseSync(dbPath);
  try {
    const result = { dbBackup: true, hermes: null, modes: {} };
    if (options['bind-zeroclaw-agent']) {
      const sourceName = String(options['bind-zeroclaw-agent']);
      const targetName = String(options['zeroclaw-agent-name'] || sourceName);
      const alias = String(options['zeroclaw-alias'] || 'voko');
      if (!/^(?:TEST-|AUTO-REG-)/.test(sourceName) || !targetName.startsWith('TEST-')
        || !/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(alias)) {
        throw new Error('ZeroClaw binding is restricted to disposable test Agents and valid aliases');
      }
      const row = db.prepare('SELECT agent_id FROM agents WHERE agent_name=?').get(sourceName);
      if (!row?.agent_id) throw new Error(`Test Agent not found: ${sourceName}`);
      db.prepare('UPDATE agents SET agent_name=?,backend_type=?,backend_instance_id=?,delivery_modes=?,updated_at=? WHERE agent_id=?')
        .run(targetName, 'zeroclaw', alias, JSON.stringify(['acp_ws', 'acp', 'cli', 'pull']), Date.now(), row.agent_id);
      result.boundZeroClawAgent = { agentId: row.agent_id, alias, configured: true };
    }
    if (options.hermes === true) {
      result.hermes = configureHermes(db, String(options.profile || 'default'), Number(options.port || 8642));
      result.modes.hermes = addMode(db, 'hermes', 'http', prefix);
    }
    if (options.zeroclaw === true) result.modes.zeroclaw = addMode(db, 'zeroclaw', 'acp_ws', prefix);
    console.log(JSON.stringify(result));
  } finally {
    db.close();
  }
}

main();
