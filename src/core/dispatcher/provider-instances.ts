const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { discoverHermes } = require('../../server/hermes-discovery');
const { getHermesProfilesDir } = require('../hermes-paths');
const { resolveZeroClawCommand } = require('./zeroclaw-command');
const { discoverWorkBuddyAgents } = require('./workbuddy-agents');

export interface ProviderInstance {
  id: string;
  name: string;
  isDefault?: boolean;
  source?: string;
}

const INSTANCE_PROVIDERS = new Set([
  'openclaw', 'hermes', 'zeroclaw', 'workbuddy',
  'opencode', 'github-copilot', 'claude-code', 'codex', 'kiro',
]);
const INSTANCE_TERMS: Record<string, string> = {
  openclaw: 'Agent', hermes: 'Profile', zeroclaw: 'Agent', workbuddy: 'Expert',
  opencode: 'Agent', 'github-copilot': 'Agent', 'claude-code': 'Agent',
  codex: 'Profile', kiro: 'Agent', goose: 'Recipe',
};
const discoveryCache = new Map<string, { at: number; instances: ProviderInstance[] }>();

function cleanInstances(items: any[], source: string): ProviderInstance[] {
  const seen = new Set<string>();
  return items.map((item: any) => ({
    id: String(item?.id ?? item?.name ?? '').trim(),
    name: String(item?.name ?? item?.description ?? item?.id ?? '').trim(),
    isDefault: item?.isDefault === true || item?.default === true,
    source,
  })).filter((item: ProviderInstance) => {
    if (!item.id || seen.has(item.id)) return false;
    seen.add(item.id);
    if (!item.name) item.name = item.id;
    return true;
  });
}

function run(command: string, args: string[], timeout = 3000): string {
  try {
    let executable = command;
    if (process.platform === 'win32' && !path.extname(executable)) {
      const located = spawnSync('where.exe', [executable], { encoding: 'utf8', timeout: 1000, windowsHide: true });
      executable = String(located.stdout || '').split(/\r?\n/)
        .find((candidate: string) => /\.(?:exe|cmd|bat)$/i.test(candidate.trim()))?.trim() || executable;
    }
    const isBatch = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable);
    const result = isBatch
      ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${executable}" ${args.join(' ')}"`], {
        cwd: os.tmpdir(), encoding: 'utf8', timeout, windowsHide: true,
      })
      : spawnSync(executable, args, {
        cwd: os.tmpdir(), encoding: 'utf8', timeout, windowsHide: true,
      });
    return result.status === 0 ? String(result.stdout || '') : '';
  } catch (_) {
    return '';
  }
}

function fileStemInstances(roots: string[], extensions: string[], source: string): ProviderInstance[] {
  const items: ProviderInstance[] = [];
  for (const root of roots) {
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isFile() || !extensions.includes(path.extname(entry.name).toLowerCase())) continue;
        const id = path.basename(entry.name, path.extname(entry.name));
        if (id && !/\.example$/i.test(id)) items.push({ id, name: id, source });
      }
    } catch (_) {}
  }
  return cleanInstances(items, source);
}

function openClawInstances(): ProviderInstance[] {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.openclaw', 'openclaw.json'), 'utf8'));
    return cleanInstances(config.agents?.list || [], 'openclaw_config');
  } catch (_) { return []; }
}

function hermesInstances(): ProviderInstance[] {
  try {
    const profiles = [{ id: 'default', name: 'default', isDefault: true }];
    for (const entry of fs.readdirSync(getHermesProfilesDir(), { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) profiles.push({ id: entry.name, name: entry.name, isDefault: false });
    }
    return cleanInstances(profiles, 'hermes_profiles');
  } catch (_) {
    try {
    return cleanInstances((discoverHermes() || []).map((profile: any) => ({
      id: profile.name, name: profile.name, isDefault: profile.isDefault,
    })), 'hermes_profiles');
    } catch (_) { return []; }
  }
}

function zeroClawInstances(): ProviderInstance[] {
  return cleanInstances(run(resolveZeroClawCommand(), ['agents', 'list'], 3000)
    .split(/\r?\n/).map((line: string) => line.trim())
    .filter((line: string) => /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/i.test(line))
    .map((id: string) => ({ id, name: id })), 'zeroclaw_cli');
}

function codexInstances(): ProviderInstance[] {
  return fileStemInstances([process.env.CODEX_HOME || path.join(os.homedir(), '.codex')], ['.toml'], 'codex_profiles')
    .filter((item) => item.id.endsWith('.config'))
    .map((item) => ({ ...item, id: item.id.slice(0, -'.config'.length), name: item.id.slice(0, -'.config'.length) }));
}

export function supportsProviderInstances(providerType: unknown): boolean {
  return INSTANCE_PROVIDERS.has(String(providerType || '').trim());
}

export function getProviderInstanceTerm(providerType: unknown): string {
  return INSTANCE_TERMS[String(providerType || '').trim()] || 'Instance';
}

export function discoverProviderInstances(providerType: unknown): ProviderInstance[] {
  const type = String(providerType || '').trim();
  const cached = discoveryCache.get(type);
  if (cached && Date.now() - cached.at < 30_000) return cached.instances.map((item) => ({ ...item }));
  let instances: ProviderInstance[] = [];
  if (type === 'openclaw') instances = openClawInstances();
  else if (type === 'hermes') instances = hermesInstances();
  else if (type === 'zeroclaw') instances = zeroClawInstances();
  else if (type === 'workbuddy') instances = discoverWorkBuddyAgents();
  else if (type === 'opencode') instances = fileStemInstances([
    path.join(os.homedir(), '.config', 'opencode', 'agents'),
  ], ['.md'], 'opencode_user_agents');
  else if (type === 'claude-code') instances = fileStemInstances([
    path.join(os.homedir(), '.claude', 'agents'),
  ], ['.md'], 'claude_user_agents');
  else if (type === 'github-copilot') instances = fileStemInstances([
    path.join(os.homedir(), '.copilot', 'agents'),
  ], ['.md'], 'copilot_user_agents');
  else if (type === 'codex') instances = codexInstances();
  else if (type === 'kiro') instances = fileStemInstances([
    path.join(os.homedir(), '.kiro', 'agents'),
  ], ['.json'], 'kiro_user_agents');
  if (supportsProviderInstances(type)) discoveryCache.set(type, { at: Date.now(), instances });
  return instances.map((item) => ({ ...item }));
}

module.exports = { discoverProviderInstances, getProviderInstanceTerm, supportsProviderInstances };
