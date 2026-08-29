#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { createReporter, loadEnv } = require('./real-test');
const { configFromEnv, resolveAgent } = require('./real-matrix');

const ROOT = path.join(__dirname, '..');
const ENV_FILE = path.resolve(process.env.VOKO_REAL_MATRIX_ENV || path.join(ROOT, '.env.real-matrix.local'));
const ARTIFACT_ROOT = path.join(ROOT, 'artifacts', 'real-tests');

function entries(result) { return Array.isArray(result?.data) ? result.data : []; }

function removeIfPresent(host, command, agentId, id) {
  if (!id) return;
  host.json([command, '--agentId', agentId, '--action', 'remove', '--id', id, '--json']);
}

function exercise(hostName, host, selector, reporter, marker) {
  const inventory = host.inventory();
  const agent = resolveAgent(inventory, selector);
  let whitelistId = null;
  let blacklistId = null;
  try {
    const addWhite = host.json(['manage_whitelist', '--agentId', agent.agentId, '--action', 'add',
      '--visitorId', marker, '--reason', 'automated-regression', '--json']);
    whitelistId = addWhite.id;
    const white = host.json(['list_access_lists', '--agentId', agent.agentId, '--listType', 'whitelist',
      '--keyword', marker, '--json']);
    reporter.check(`${hostName} whitelist add and query`, addWhite.success === true
      && entries(white).some(row => row.visitor_id === marker), `matches=${entries(white).length}`);
    removeIfPresent(host, 'manage_whitelist', agent.agentId, whitelistId);
    whitelistId = null;
    const whiteAfter = host.json(['list_access_lists', '--agentId', agent.agentId, '--listType', 'whitelist',
      '--keyword', marker, '--json']);
    reporter.check(`${hostName} whitelist cleanup`, entries(whiteAfter).length === 0);

    const addBlack = host.json(['manage_blacklist', '--agentId', agent.agentId, '--action', 'add',
      '--visitorId', marker, '--reason', 'automated-regression', '--json']);
    blacklistId = addBlack.id;
    const black = host.json(['list_access_lists', '--agentId', agent.agentId, '--listType', 'blacklist',
      '--keyword', marker, '--json']);
    reporter.check(`${hostName} blacklist add and query`, addBlack.success === true
      && entries(black).some(row => row.visitor_id === marker), `matches=${entries(black).length}`);
    removeIfPresent(host, 'manage_blacklist', agent.agentId, blacklistId);
    blacklistId = null;
    const blackAfter = host.json(['list_access_lists', '--agentId', agent.agentId, '--listType', 'blacklist',
      '--keyword', marker, '--json']);
    reporter.check(`${hostName} blacklist cleanup`, entries(blackAfter).length === 0);
  } finally {
    try { removeIfPresent(host, 'manage_whitelist', agent.agentId, whitelistId); } catch {}
    try { removeIfPresent(host, 'manage_blacklist', agent.agentId, blacklistId); } catch {}
  }
}

function main() {
  loadEnv(ENV_FILE);
  const config = configFromEnv();
  const reporter = createReporter('access-control', ARTIFACT_ROOT);
  const marker = `visitor_${reporter.runId.replace(/[^a-zA-Z0-9]/g, '_')}`;
  for (const [hostName, host] of Object.entries(config.hosts)) {
    try { exercise(hostName, host, config.senders[hostName], reporter, marker); }
    catch (error) { reporter.check(`${hostName} access-control scenario`, false, error.message); }
  }
  process.exitCode = reporter.finish() ? 0 : 1;
}

if (require.main === module) main();

module.exports = { entries };
