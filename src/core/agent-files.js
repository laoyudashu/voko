/**
 * agent-files.js — agent workspace 文件读写
 *
 * 从 ~/.openclaw/openclaw.json 解析 agent 的 workspace 路径，提供列文件 / 读 / 写
 * （含路径遍历防护）。供 lite HTTP 路由（/api/agent/files、/api/agent/file）使用，
 * 独立于 AgentManager（后者在 lite 内为死代码，且 global.__agentManager 实为 AgentWorkerManager）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const OPENCLAW_CONFIG = path.join(os.homedir(), '.openclaw', 'openclaw.json');

function readOpenclawConfig() {
  try {
    return JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, 'utf-8'));
  } catch (err) {
    console.error('[agent-files] 读取 openclaw.json 失败:', err.message);
    return { agents: { list: [] } };
  }
}

function expandPath(p) {
  if (p && p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return p;
}

function isPathInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}

function resolveContainedFile(workspacePath, filename, forWrite = false) {
  if (typeof filename !== 'string' || !filename || filename.includes('\0') || path.isAbsolute(filename)) {
    throw new Error('Invalid path');
  }
  const realWorkspace = fs.realpathSync(workspacePath);
  const candidate = path.resolve(realWorkspace, filename);
  if (!isPathInside(realWorkspace, candidate)) throw new Error('Invalid path');

  if (!forWrite) {
    const realFile = fs.realpathSync(candidate);
    if (!isPathInside(realWorkspace, realFile)) throw new Error('Invalid path');
    return realFile;
  }

  const realParent = fs.realpathSync(path.dirname(candidate));
  if (realParent !== realWorkspace && !isPathInside(realWorkspace, realParent)) throw new Error('Invalid path');
  // The resolved parent is confined to the real workspace; existing symlinks are rejected.
  if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink()) throw new Error('Invalid path');
  return path.join(realParent, path.basename(candidate));
}

/** 解析 agent workspace 绝对路径（找不到返回 null）。 */
function resolveWorkspace(agentId) {
  const config = readOpenclawConfig();
  const agent = (config.agents?.list || []).find(a => a.id === agentId);
  if (!agent || !agent.workspace) return null;
  return expandPath(agent.workspace);
}

/** 列出 agent workspace 下的核心文件 + skills/SKILL.md。失败返回空数组。 */
function getAgentFiles(agentId) {
  try {
    const workspacePath = resolveWorkspace(agentId);
    if (!workspacePath || !fs.existsSync(workspacePath)) return [];

    const coreFiles = ['AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'TOOLS.md', 'USER.md', 'knowledge.md'];
    const files = [];
    for (const file of coreFiles) {
      const filePath = path.join(workspacePath, file);
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        files.push({ name: file, path: filePath, size: stat.size, modified: stat.mtime });
      }
    }

    const skillsDir = path.join(workspacePath, 'skills');
    if (fs.existsSync(skillsDir)) {
      for (const d of fs.readdirSync(skillsDir)) {
        const sub = path.join(skillsDir, d);
        try { if (!fs.statSync(sub).isDirectory()) continue; } catch (_) { continue; }
        const skillFile = path.join(sub, 'SKILL.md');
        if (fs.existsSync(skillFile)) {
          const stat = fs.statSync(skillFile);
          files.push({ name: `skills/${d}/SKILL.md`, path: skillFile, size: stat.size, modified: stat.mtime });
        }
      }
    }
    return files;
  } catch (err) {
    console.error('[agent-files] 获取 agent 文件列表失败:', err.message);
    return [];
  }
}

/** 读单个文件（含路径遍历防护）。 */
function readFile(agentId, filename) {
  const workspacePath = resolveWorkspace(agentId);
  if (!workspacePath) throw new Error('Agent not found');
  const filePath = resolveContainedFile(workspacePath, filename);
  // resolveContainedFile verifies both candidate and real target remain inside the workspace.
  return fs.readFileSync(filePath, 'utf-8');
}

/** 写单个文件（含路径遍历防护）。 */
function writeFile(agentId, filename, content) {
  const workspacePath = resolveWorkspace(agentId);
  if (!workspacePath) throw new Error('Agent not found');
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024) {
    throw new Error('Invalid file content');
  }
  const filePath = resolveContainedFile(workspacePath, filename, true);
  // resolveContainedFile confines the real parent and rejects an existing symlink target.
  fs.writeFileSync(filePath, content, 'utf-8');
  return true;
}

module.exports = { getAgentFiles, readFile, writeFile, resolveWorkspace, resolveContainedFile };
