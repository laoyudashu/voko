const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

export interface WorkBuddyAgentInstance {
  id: string;
  name: string;
  description: string;
  source: string;
  available: true;
}

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function localized(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  const item = value as Record<string, unknown>;
  return String(item.zh || item.en || '').trim();
}

function frontmatterName(markdown: string): string {
  const match = markdown.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return match?.[1]?.match(/^name:\s*["']?([^\r\n"']+)["']?\s*$/m)?.[1]?.trim() || '';
}

function registeredMarketplaceRoot(root: string, workBuddyHome: string): boolean {
  try {
    const known = JSON.parse(fs.readFileSync(path.join(workBuddyHome, 'plugins', 'known_marketplaces.json'), 'utf8'));
    const registered = known?.['my-experts']?.installLocation || known?.['my-experts']?.source?.path;
    return registered && path.resolve(registered) === path.resolve(root);
  } catch (_) { return false; }
}

export function discoverWorkBuddyAgents(options: {
  root?: string;
  workBuddyHome?: string;
  requireRegisteredMarketplace?: boolean;
} = {}): WorkBuddyAgentInstance[] {
  const workBuddyHome = path.resolve(options.workBuddyHome || path.join(os.homedir(), '.workbuddy'));
  const root = path.resolve(options.root || path.join(workBuddyHome, 'plugins', 'marketplaces', 'my-experts'));
  if ((options.requireRegisteredMarketplace ?? !options.root) && !registeredMarketplaceRoot(root, workBuddyHome)) return [];
  const marketplaceFile = path.join(root, '.codebuddy-plugin', 'marketplace.json');
  if (!fs.existsSync(marketplaceFile)) return [];
  let marketplace: any;
  try { marketplace = JSON.parse(fs.readFileSync(marketplaceFile, 'utf8')); }
  catch (_) { throw new Error('WorkBuddy my-experts marketplace manifest is invalid'); }
  if (marketplace?.name !== 'my-experts' || !Array.isArray(marketplace.plugins)) {
    throw new Error('WorkBuddy my-experts marketplace contract is invalid');
  }

  const result: WorkBuddyAgentInstance[] = [];
  const seen = new Set<string>();
  for (const entry of marketplace.plugins) {
    try {
      if (!ID_PATTERN.test(String(entry?.name || '')) || typeof entry?.source !== 'string'
        || !entry.source.startsWith('./')) continue;
      const pluginRoot = path.resolve(root, entry.source);
      if (!inside(root, pluginRoot) || path.basename(pluginRoot) !== entry.name) continue;
      const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.codebuddy-plugin', 'plugin.json'), 'utf8'));
      if (manifest?.name !== entry.name || manifest?.plugin !== entry.name || manifest?.expertType !== 'agent'
        || !ID_PATTERN.test(String(manifest?.agentName || '')) || !Array.isArray(manifest?.agents)
        || manifest.agents.length !== 1 || typeof manifest.agents[0] !== 'string'
        || !manifest.agents[0].startsWith('./agents/')) continue;
      const agentFile = path.resolve(pluginRoot, manifest.agents[0]);
      if (!inside(pluginRoot, agentFile) || path.extname(agentFile).toLowerCase() !== '.md') continue;
      const id = String(manifest.agentName);
      if (path.basename(agentFile, '.md') !== id || frontmatterName(fs.readFileSync(agentFile, 'utf8')) !== id
        || seen.has(id)) continue;
      seen.add(id);
      result.push({
        id,
        name: localized(manifest.displayName) || id,
        description: localized(manifest.displayDescription) || String(manifest.description || entry.description || '').trim(),
        source: `my-experts/${entry.name}`,
        available: true,
      });
    } catch (_) {}
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

export function resolveWorkBuddyAgent(id: unknown, options: Parameters<typeof discoverWorkBuddyAgents>[0] = {}): WorkBuddyAgentInstance | null {
  const value = String(id || '').trim();
  if (!ID_PATTERN.test(value)) return null;
  return discoverWorkBuddyAgents(options).find((item) => item.id === value) || null;
}

export function resolveWorkBuddyAgentTarget(id: unknown, options: Parameters<typeof discoverWorkBuddyAgents>[0] = {}):
  { instance: WorkBuddyAgentInstance; pluginRoot: string } | null {
  const instance = resolveWorkBuddyAgent(id, options);
  if (!instance) return null;
  const workBuddyHome = path.resolve(options.workBuddyHome || path.join(os.homedir(), '.workbuddy'));
  const root = path.resolve(options.root || path.join(workBuddyHome, 'plugins', 'marketplaces', 'my-experts'));
  const pluginRoot = path.resolve(root, 'plugins', instance.id);
  return inside(root, pluginRoot) ? { instance, pluginRoot } : null;
}

module.exports = { discoverWorkBuddyAgents, resolveWorkBuddyAgent, resolveWorkBuddyAgentTarget };
