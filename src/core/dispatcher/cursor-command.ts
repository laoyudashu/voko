const { checkCliAvailable } = require('../adapters/cli-spawner');
export {};

let cachedCommand: string | null = null;

function resolveCursorCommand(): string {
  if (cachedCommand) return cachedCommand;
  if (checkCliAvailable('cursor-agent')) cachedCommand = 'cursor-agent';
  else if (checkCliAvailable('agent')) cachedCommand = 'agent';
  else cachedCommand = 'cursor-agent';
  return cachedCommand;
}

module.exports = { resolveCursorCommand };
