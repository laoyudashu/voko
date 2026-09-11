'use strict';
const fs = require('fs');
const JSON5 = require('json5');

/** OpenClaw configuration is JSON5, including comments and trailing commas. */
function readOpenClawConfig(configPath) {
  return JSON5.parse(fs.readFileSync(configPath, 'utf8'));
}

/** Read old list and new keyed Agent config without rewriting either format. */
function openClawAgentEntries(config) {
  const entries = config?.agents?.entries;
  if (entries && typeof entries === 'object' && !Array.isArray(entries)) {
    return Object.entries(entries).filter(([, value]) => value && typeof value === 'object' && !Array.isArray(value))
      .map(([id, value]) => ({ ...value, id }));
  }
  return Array.isArray(config?.agents?.list) ? config.agents.list.filter(item => item && typeof item.id === 'string') : [];
}

module.exports = { openClawAgentEntries, readOpenClawConfig };
