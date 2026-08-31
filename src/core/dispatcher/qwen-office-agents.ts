const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

export interface QwenOfficeAgentInstance {
  id: string;
  name: string;
  description: string;
  source: string;
  available: true;
  tags?: string[];
  category?: string;
}

export interface QwenOfficeAgentTarget {
  instance: QwenOfficeAgentInstance;
  workspaceRoot: string;
  pluginRoot: string;
}

const WORKSPACE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/i;
const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function declaredSkillsAreValid(pluginRoot: string, skills: unknown): boolean {
  if (skills === undefined) return true;
  if (!Array.isArray(skills)) return false;
  return skills.every((entry) => {
    if (typeof entry !== 'string' || !entry.startsWith('./')) return false;
    const skillRoot = path.resolve(pluginRoot, entry);
    if (!inside(pluginRoot, skillRoot)) return false;
    try {
      return fs.statSync(skillRoot).isDirectory()
        && fs.statSync(path.join(skillRoot, 'SKILL.md')).isFile();
    } catch (_) { return false; }
  });
}

function discoverTargets(options: { home?: string; workspaceRoot?: string } = {}): QwenOfficeAgentTarget[] {
  const home = path.resolve(options.home || path.join(os.homedir(), '.qwenworkcn'));
  const workspaceBase = path.resolve(options.workspaceRoot || path.join(home, 'workspace'));
  const targets: QwenOfficeAgentTarget[] = [];
  const seen = new Set<string>();
  let workspaces: any[] = [];
  try { workspaces = fs.readdirSync(workspaceBase, { withFileTypes: true }); }
  catch (_) { return []; }

  for (const workspace of workspaces) {
    if (!workspace.isDirectory() || !WORKSPACE_ID_PATTERN.test(workspace.name)) continue;
    const workspaceRoot = path.resolve(workspaceBase, workspace.name);
    if (!inside(workspaceBase, workspaceRoot)) continue;
    let plugins: any[] = [];
    try { plugins = fs.readdirSync(workspaceRoot, { withFileTypes: true }); }
    catch (_) { continue; }
    for (const plugin of plugins) {
      if (!plugin.isDirectory() || plugin.name.startsWith('.')) continue;
      const pluginRoot = path.resolve(workspaceRoot, plugin.name);
      if (!inside(workspaceRoot, pluginRoot)) continue;
      const manifestPath = path.join(pluginRoot, '.qoder-plugin', 'plugin.json');
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const pluginId = text(manifest?.name);
        if (!PLUGIN_ID_PATTERN.test(pluginId) || !declaredSkillsAreValid(pluginRoot, manifest?.skills)) continue;
        const id = `${workspace.name}/${pluginId}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const tags = Array.isArray(manifest?.tags)
          ? [...new Set(manifest.tags.map(text).filter(Boolean))].slice(0, 20) as string[]
          : [];
        const instance: QwenOfficeAgentInstance = {
          id,
          name: text(manifest?.displayName) || pluginId,
          description: text(manifest?.descriptionZh) || text(manifest?.description),
          source: `qwenwork-workspace/${workspace.name}/${plugin.name}`,
          available: true,
          ...(tags.length ? { tags } : {}),
          ...(text(manifest?.category) ? { category: text(manifest.category) } : {}),
        };
        targets.push({ instance, workspaceRoot, pluginRoot });
      } catch (_) {}
    }
  }
  return targets.sort((left, right) => left.instance.name.localeCompare(right.instance.name));
}

export function discoverQwenOfficeAgents(options: { home?: string; workspaceRoot?: string } = {}): QwenOfficeAgentInstance[] {
  return discoverTargets(options).map((target) => ({ ...target.instance }));
}

export function resolveQwenOfficeAgentTarget(
  id: unknown,
  options: { home?: string; workspaceRoot?: string } = {},
): QwenOfficeAgentTarget | null {
  const value = String(id || '').trim();
  if (!value.includes('/') || value.length > 160) return null;
  return discoverTargets(options).find((target) => target.instance.id === value) || null;
}

module.exports = { discoverQwenOfficeAgents, resolveQwenOfficeAgentTarget };
