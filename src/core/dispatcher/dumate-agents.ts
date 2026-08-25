const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

export interface DuMateAgentInstance {
  id: string;
  name: string;
  description: string;
  source: string;
  available: true;
  tags?: string[];
  category?: string;
}

export interface DuMateAgentTarget {
  instance: DuMateAgentInstance;
  pluginRoot: string;
  dataRoot: string;
}

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function dataRoots(options: { appData?: string; dataRoots?: string[] } = {}): string[] {
  if (options.dataRoots) return options.dataRoots.map((item) => path.resolve(item));
  const appData = path.resolve(options.appData || process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'));
  const xdgRoot = path.join(appData, 'qianfan-desktop-app', 'qianfan_desk_xdg');
  try {
    return fs.readdirSync(xdgRoot, { withFileTypes: true })
      .filter((entry: any) => entry.isDirectory())
      .map((entry: any) => path.join(xdgRoot, entry.name, 'data'));
  } catch (_) { return []; }
}

function discoverTargets(options: { appData?: string; dataRoots?: string[] } = {}): DuMateAgentTarget[] {
  const result: DuMateAgentTarget[] = [];
  const seen = new Set<string>();
  for (const dataRoot of dataRoots(options)) {
    const userRoot = path.join(dataRoot, 'plugins', 'user');
    let entries: any[] = [];
    try { entries = fs.readdirSync(userRoot, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue;
      const pluginRoot = path.resolve(userRoot, entry.name);
      if (!inside(userRoot, pluginRoot)) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8'));
        const id = text(manifest?.name);
        const agent = Array.isArray(manifest?.agents)
          ? manifest.agents.find((item: any) => text(item?.name) === id) : null;
        const prompt = path.resolve(pluginRoot, text(agent?.prompt));
        if (!ID_PATTERN.test(id) || id !== entry.name || !agent || !inside(pluginRoot, prompt)
          || path.extname(prompt).toLowerCase() !== '.md' || !fs.statSync(prompt).isFile() || seen.has(id)) continue;
        seen.add(id);
        const tags = Array.isArray(manifest?.keywords)
          ? [...new Set(manifest.keywords.map(text).filter(Boolean))].slice(0, 20) as string[] : [];
        const instance: DuMateAgentInstance = {
          id,
          name: text(manifest?.displayName) || text(agent?.displayName) || id,
          description: text(manifest?.description) || text(agent?.description),
          source: `dumate-plugin/${id}`,
          available: true,
          ...(tags.length ? { tags } : {}),
          ...(text(manifest?.category) ? { category: text(manifest.category) } : {}),
        };
        result.push({ instance, pluginRoot, dataRoot });
      } catch (_) {}
    }
  }
  return result.sort((left, right) => left.instance.name.localeCompare(right.instance.name));
}

export function discoverDuMateAgents(options: { appData?: string; dataRoots?: string[] } = {}): DuMateAgentInstance[] {
  return discoverTargets(options).map((target) => ({ ...target.instance }));
}

export function resolveDuMateAgentTarget(id: unknown, options: { appData?: string; dataRoots?: string[] } = {}): DuMateAgentTarget | null {
  const value = String(id || '').trim();
  if (!ID_PATTERN.test(value)) return null;
  return discoverTargets(options).find((target) => target.instance.id === value) || null;
}

module.exports = { discoverDuMateAgents, resolveDuMateAgentTarget };
