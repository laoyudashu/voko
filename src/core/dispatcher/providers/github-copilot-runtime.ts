const copilotFs = require('fs');
const copilotPath = require('path');

const COPILOT_SAFETY_ARGS = [
  '--no-custom-instructions',
  '--disable-builtin-mcps',
  '--no-remote',
  '--no-remote-export',
  // An empty --available-tools value keeps default tools in Copilot 1.0.80.
  // Explicit kind-level deny rules are documented and verified fail-closed.
  '--deny-tool=read',
  '--deny-tool=write',
  '--deny-tool=shell',
  '--deny-tool=url',
  '--no-ask-user',
  '--no-auto-update',
];

function resolveGitHubCopilotRuntime() {
  if (process.platform !== 'win32') {
    return { command: 'copilot', prefixArgs: [] };
  }

  const roots = [
    process.env.APPDATA && copilotPath.join(process.env.APPDATA, 'npm'),
    copilotPath.dirname(process.execPath),
    process.env.LOCALAPPDATA && copilotPath.join(process.env.LOCALAPPDATA, 'Programs', 'nodejs'),
  ].filter(Boolean);
  const candidates = [...new Set(roots)].map((root) =>
    copilotPath.join(root, 'node_modules', '@github', 'copilot', 'npm-loader.js'));
  const loader = candidates.find((candidate) => copilotFs.existsSync(candidate));
  return loader
    ? { command: process.execPath, prefixArgs: [loader] }
    : null;
}

module.exports = { COPILOT_SAFETY_ARGS, resolveGitHubCopilotRuntime };
