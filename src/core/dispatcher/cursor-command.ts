const fs = require('fs');
const path = require('path');
const { checkCliAvailable } = require('../adapters/cli-spawner');
const { execFileSync } = require('child_process');
export {};

let cachedCommand: string | null = null;
let cachedPrefixArgs: string[] = [];
let cachedAvailable: boolean | null = null;

function windowsUserPath(): string {
  if (process.platform !== 'win32') return '';
  try {
    const output = String(execFileSync('reg.exe', ['query', 'HKCU\\Environment', '/v', 'Path'], {
      encoding: 'utf8', windowsHide: true, timeout: 3000,
    }));
    const match = output.match(/\bREG_(?:EXPAND_)?SZ\s+([^\r\n]+)/i);
    return match ? match[1].replace(/%([^%]+)%/g, (_: string, key: string) => process.env[key] || '').trim() : '';
  } catch (_) { return ''; }
}

function findWindowsBundle(searchPath: string): { command: string; prefixArgs: string[] } | null {
  for (const dir of searchPath.split(';').map((item: string) => item.trim().replace(/^"|"$/g, '')).filter(Boolean)) {
    const launcher = path.join(dir, 'cursor-agent.cmd');
    if (!fs.existsSync(launcher)) continue;
    const candidates = [dir];
    const versionsDir = path.join(dir, 'versions');
    try {
      candidates.push(...fs.readdirSync(versionsDir, { withFileTypes: true })
        .filter((entry: any) => entry.isDirectory() && /^\d{4}\.\d{1,2}\.\d{1,2}(?:-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/i.test(entry.name))
        .map((entry: any) => path.join(versionsDir, entry.name))
        .sort((a: string, b: string) => b.localeCompare(a, undefined, { numeric: true })));
    } catch (_) {}
    for (const candidate of candidates) {
      const node = path.join(candidate, 'node.exe');
      const entry = path.join(candidate, 'index.js');
      if (fs.existsSync(node) && fs.existsSync(entry)) return { command: node, prefixArgs: [entry] };
    }
  }
  return null;
}

function findBundledRuntime(): { command: string; prefixArgs: string[] } | null {
  if (process.platform !== 'win32') return null;
  const searchPath = [process.env.PATH || '', windowsUserPath()].filter(Boolean).join(';');
  return findWindowsBundle(searchPath);
}

function isCursorCommandAvailable(): boolean {
  if (cachedAvailable !== null) return cachedAvailable;
  const bundled = findBundledRuntime();
  if (bundled) {
    cachedCommand = bundled.command;
    cachedPrefixArgs = bundled.prefixArgs;
    cachedAvailable = true;
    return true;
  }
  if (checkCliAvailable('cursor-agent')) {
    cachedCommand = 'cursor-agent';
    cachedAvailable = true;
    return true;
  }
  if (checkCliAvailable('agent')) {
    try {
      const version = String(execFileSync('agent', ['--version'], {
        encoding: 'utf8', windowsHide: true, timeout: 3000,
      }));
      if (/\bcursor\b/i.test(version)) {
        cachedCommand = 'agent';
        cachedAvailable = true;
        return true;
      }
    } catch (_) {}
  }
  cachedAvailable = false;
  return false;
}

function resolveCursorCommand(): string {
  if (cachedCommand) return cachedCommand;
  isCursorCommandAvailable();
  if (!cachedCommand) cachedCommand = 'cursor-agent';
  return cachedCommand;
}

function resolveCursorRuntime(): { command: string; prefixArgs: string[] } {
  const command = resolveCursorCommand();
  return { command, prefixArgs: [...cachedPrefixArgs] };
}

module.exports = { findWindowsBundle, isCursorCommandAvailable, resolveCursorCommand, resolveCursorRuntime };
