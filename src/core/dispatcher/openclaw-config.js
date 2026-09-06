'use strict';

/** Read old list and new keyed Agent config without rewriting either format. */
function openClawAgentEntries(config) {
  const entries = config?.agents?.entries;
  if (entries && typeof entries === 'object' && !Array.isArray(entries)) {
    return Object.entries(entries).filter(([, value]) => value && typeof value === 'object' && !Array.isArray(value))
      .map(([id, value]) => ({ ...value, id }));
  }
  return Array.isArray(config?.agents?.list) ? config.agents.list.filter(item => item && typeof item.id === 'string') : [];
}

module.exports = { openClawAgentEntries };
