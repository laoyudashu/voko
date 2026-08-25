const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

export interface DeepSeekHarnessRuntime {
  command: string | null;
  argsPrefix: string[];
  versionFile: string | null;
}

/** Resolve the installed DSH package bin without invoking a shell or downloading packages. */
export function resolveDeepSeekHarnessRuntime(env: NodeJS.ProcessEnv = process.env): DeepSeekHarnessRuntime {
  const dshHome = path.resolve(String(env.DSH_HOME || path.join(os.homedir(), '.dsh')));
  const bin = path.join(dshHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  const manifest = path.join(dshHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
  if (!fs.existsSync(bin) || !fs.existsSync(manifest)) return { command: null, argsPrefix: [], versionFile: null };
  return { command: process.execPath, argsPrefix: [bin], versionFile: manifest };
}

module.exports = { resolveDeepSeekHarnessRuntime };
