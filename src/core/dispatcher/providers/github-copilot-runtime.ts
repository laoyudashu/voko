const copilotFs = require('fs');
const copilotPath = require('path');

const COPILOT_SAFETY_ARGS = [
  '--no-custom-instructions',
  '--disable-builtin-mcps',
  '--no-remote',
  '--no-remote-export',
  '--available-tools=',
  '--no-ask-user',
  '--no-auto-update',
];

function resolveGitHubCopilotRuntime() {
  if (process.platform !== 'win32') {
    return { command: 'copilot', prefixArgs: [] };
  }

  const npmRoot = process.env.APPDATA && copilotPath.join(process.env.APPDATA, 'npm');
  const candidates = [
    npmRoot && copilotPath.join(npmRoot, 'node_modules', '@github', 'copilot', 'npm-loader.js'),
  ].filter(Boolean);
  const loader = candidates.find((candidate) => copilotFs.existsSync(candidate));
  return loader
    ? { command: process.execPath, prefixArgs: [loader] }
    : null;
}

module.exports = { COPILOT_SAFETY_ARGS, resolveGitHubCopilotRuntime };
