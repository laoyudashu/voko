const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_PROFILE_BYTES = 128 * 1024;

function readText(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_PROFILE_BYTES) return '';
    return fs.readFileSync(file, 'utf8');
  } catch (_) { return ''; }
}

function useful(value) {
  const text = String(value || '').trim().replace(/^['"]|['"]$/g, '');
  if (!text || /^[_（(].*[）)]_?$/.test(text) || /pick something|未设置|填写|your signature/i.test(text)) return '';
  return text;
}

function markdownField(markdown, labels) {
  const lines = String(markdown || '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^\s*-?\s*\*\*([^*：:]+)\s*[:：]?\*\*\s*[:：]?\s*(.*)$/);
    if (!match || !labels.includes(match[1].trim().toLowerCase())) continue;
    const inline = useful(match[2]);
    if (inline) return inline;
    for (let next = index + 1; next < Math.min(lines.length, index + 4); next++) {
      if (/^\s*-?\s*\*\*[^*]+\*\*/.test(lines[next])) break;
      const candidate = useful(lines[next].replace(/^\s*[-*]\s*/, ''));
      if (candidate) return candidate;
    }
  }
  return '';
}

function identityMetadata(markdown) {
  const name = markdownField(markdown, ['name', '名字', '名称']);
  const role = markdownField(markdown, ['creature', '角色', '身份', '定位']);
  const vibe = markdownField(markdown, ['vibe', '风格']);
  const tags = vibe ? vibe.split(/[、,，;/；]/).map(useful).filter(Boolean).slice(0, 20) : [];
  return {
    ...(name ? { name } : {}),
    ...([role, vibe].filter(Boolean).length ? { description: [role, vibe].filter(Boolean).join('；') } : {}),
    ...(tags.length ? { tags } : {}),
  };
}

function frontmatterMetadata(markdown) {
  const block = String(markdown || '').match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || '';
  const field = (name) => useful(block.match(new RegExp(`^${name}:\\s*(.+)$`, 'mi'))?.[1]);
  const tags = field('tags').replace(/^\[|\]$/g, '').split(/[,，]/).map(useful).filter(Boolean).slice(0, 20);
  const name = field('name');
  const description = field('description');
  return { ...(name ? { name } : {}), ...(description ? { description } : {}), ...(tags.length ? { tags } : {}) };
}

function openClawMetadata(instanceId, home) {
  const root = path.join(home, '.openclaw');
  try {
    const config = JSON.parse(readText(path.join(root, 'openclaw.json')) || '{}');
    const item = (config.agents?.list || []).find((agent) => String(agent.id) === String(instanceId));
    const workspace = item?.workspace || (instanceId === 'main' ? path.join(root, 'workspace') : '');
    if (!workspace) return {};
    return identityMetadata(readText(path.join(path.resolve(workspace), 'IDENTITY.md')));
  } catch (_) { return {}; }
}

function markdownAgentMetadata(providerType, instanceId, home) {
  const roots = {
    'claude-code': path.join(home, '.claude', 'agents'),
    'github-copilot': path.join(home, '.copilot', 'agents'),
    opencode: path.join(home, '.config', 'opencode', 'agents'),
  };
  const root = roots[providerType];
  if (!root || !/^[a-z0-9._-]+$/i.test(String(instanceId || ''))) return {};
  return frontmatterMetadata(readText(path.join(root, `${instanceId}.md`)));
}

function readProviderInstanceMetadata(providerType, instanceId, options = {}) {
  const type = String(providerType || '').trim();
  const id = String(instanceId || '').trim();
  if (!id) return {};
  const home = path.resolve(options.home || os.homedir());
  if (type === 'openclaw') return openClawMetadata(id, home);
  if (['claude-code', 'github-copilot', 'opencode'].includes(type)) return markdownAgentMetadata(type, id, home);
  return {};
}

module.exports = { readProviderInstanceMetadata, identityMetadata, frontmatterMetadata };
