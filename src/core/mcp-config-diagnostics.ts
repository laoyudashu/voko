export {};

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function homeDir(options: any = {}): string {
  return String(options.homeDir || os.homedir());
}

function candidates(options: any = {}): any[] {
  if (Array.isArray(options.paths)) return options.paths.map((item: any) => (
    typeof item === 'string' ? { client: 'unknown', path: item } : item
  ));
  const home = homeDir(options);
  const platform = options.platform || process.platform;
  const appData = options.appData || process.env.APPDATA;
  const result: any[] = [
    { client: 'Claude Code', path: path.join(home, '.claude.json') },
    { client: 'Claude Code', path: path.join(home, '.claude', 'mcp.json') },
    { client: 'Cursor', path: path.join(home, '.cursor', 'mcp.json') },
    { client: 'Codex', path: path.join(home, '.codex', 'config.toml') },
    { client: 'WorkBuddy', path: path.join(home, '.workbuddy', 'mcp.json') },
    { client: 'OpenCode', path: path.join(home, '.config', 'opencode', 'opencode.json') },
    { client: 'Kiro', path: path.join(home, '.kiro', 'settings', 'mcp.json') },
  ];
  if (platform === 'win32' && appData) {
    result.push({ client: 'Goose', path: path.join(appData, 'Block', 'goose', 'config', 'config.yaml') });
    result.push({ client: 'Claude Desktop', path: path.join(appData, 'Claude', 'claude_desktop_config.json') });
    result.push({ client: 'Cursor', path: path.join(appData, 'Cursor', 'User', 'globalStorage', 'mcp.json') });
  } else if (platform === 'darwin') {
    result.push({ client: 'Goose', path: path.join(home, 'Library', 'Application Support', 'Block', 'goose', 'config', 'config.yaml') });
  } else {
    result.push({ client: 'Goose', path: path.join(home, '.config', 'goose', 'config.yaml') });
  }
  return result;
}

function inspectMcpConfigs(options: any = {}): any {
  const clients: any[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates(options)) {
    const filePath = path.resolve(String(candidate.path || ''));
    if (!filePath || seen.has(filePath) || !fs.existsSync(filePath)) continue;
    seen.add(filePath);
    let content = '';
    try { content = fs.readFileSync(filePath, 'utf8'); } catch (_) { continue; }
    const issues: any[] = [];
    if (/localhost:\s*3002\b/i.test(content) || /127\.0\.0\.1:\s*3002\b/i.test(content)) {
      issues.push({ code: 'STALE_MCP_PORT', message: '发现已废弃的 3002 MCP 端口', recommendation: '改用 command=voko、args=[mcp]，让 VOKO 自动发现当前端口' });
    }
    if (/(?:https?:\/\/)?(?:localhost|127\.0\.0\.1):\d+\/mcp\b/i.test(content)) {
      issues.push({ code: 'FIXED_MCP_URL', message: '配置使用固定本机 MCP URL', recommendation: '优先改用 voko mcp；如保留 HTTP，请确认端口来自当前 Lite status' });
    }
    if (/voko[-_]desktop|voko[\\/]desktop/i.test(content)) {
      issues.push({ code: 'LEGACY_VOKO_PATH', message: '发现旧 Desktop 运行路径', recommendation: '移除旧 Desktop 启动命令，改用当前 Lite 的 voko mcp' });
    }
    if (/\b(?:register_agent|verify_agent_email)\b/i.test(content)) {
      issues.push({ code: 'LEGACY_REGISTRATION_API', message: '发现已废弃的注册接口名称', recommendation: '改用 manage_agent_registration 状态机' });
    }
    clients.push({
      client: String(candidate.client || 'MCP client'),
      path: filePath,
      status: issues.length ? 'warn' : 'ok',
      issues,
      recommendation: issues.length ? '仅报告，不会自动修改；请按建议手动迁移' : '配置未发现 VOKO 旧端口或旧入口',
    });
  }
  return { clients, checked: candidates(options).length };
}

function isVokoServerName(value: unknown): boolean {
  return /^voko(?:[-_](?:desktop|lite))?$/i.test(String(value || '').trim());
}

function canonicalJsonEntry(existing: any): any {
  const next: any = { command: 'voko', args: ['mcp'] };
  if (existing && Object.prototype.hasOwnProperty.call(existing, 'disabled')) next.disabled = existing.disabled;
  if (existing && Object.prototype.hasOwnProperty.call(existing, 'enabled')) next.enabled = existing.enabled;
  return next;
}

function migrateJsonContent(content: string): string | null {
  let root: any;
  try { root = JSON.parse(content); } catch (_) { return null; }
  if (!root || typeof root !== 'object' || Array.isArray(root)) return null;
  const containerKey = ['mcpServers', 'mcp_servers', 'servers'].find((key) => root[key] && typeof root[key] === 'object' && !Array.isArray(root[key]));
  if (!containerKey) return null;
  const container = root[containerKey];
  const serverKey = Object.keys(container).find(isVokoServerName);
  if (!serverKey || !container[serverKey] || typeof container[serverKey] !== 'object') return null;
  const existing = container[serverKey];
  if (existing.command === 'voko'
    && Array.isArray(existing.args)
    && existing.args.length === 1
    && String(existing.args[0]) === 'mcp'
    && Object.keys(existing).every((key) => ['command', 'args', 'disabled', 'enabled'].includes(key))) return null;
  container[serverKey] = canonicalJsonEntry(existing);
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  return JSON.stringify(root, null, 2).replace(/\n/g, eol) + (content.endsWith('\n') ? '' : eol);
}

function migrateTomlContent(content: string): string | null {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => /^\s*\[mcp_servers\.(?:"?voko(?:[-_]desktop|[-_]lite)?"?)\]\s*$/i.test(line));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[.*\]\s*$/.test(lines[end])) end += 1;
  const body = lines.slice(start + 1, end).join('\n');
  if (/^\s*command\s*=\s*["']voko["']/mi.test(body)
    && /^\s*args\s*=\s*\[\s*["']mcp["']\s*\]/mi.test(body)
    && !/^\s*url\s*=|^\s*http_headers\s*=|^\s*bearer_token_env_var\s*=/mi.test(body)) return null;
  lines.splice(start, end - start, lines[start], 'command = "voko"', 'args = ["mcp"]');
  return lines.join(eol);
}

function migrateGooseYamlContent(content: string): string | null {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const extensionIndex = lines.findIndex((line) => /^extensions:\s*$/.test(line));
  if (extensionIndex < 0) return null;
  let start = -1;
  for (let index = extensionIndex + 1; index < lines.length; index += 1) {
    if (/^\S/.test(lines[index])) break;
    if (/^  voko(?:[-_]desktop|[-_]lite)?:\s*$/i.test(lines[index])) { start = index; break; }
  }
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !/^  \S/.test(lines[end])) end += 1;
  const body = lines.slice(start + 1, end).join('\n');
  if (/^\s{4}type:\s*stdio\s*$/mi.test(body)
    && /^\s{4}cmd:\s*voko\s*$/mi.test(body)
    && /^\s{4}args:\s*\[\s*mcp\s*\]\s*$/mi.test(body)
    && !/^\s{4}(?:url|uri):/mi.test(body)) return null;
  const name = lines[start].match(/^  (voko[^:]*):/i)?.[1] || 'voko';
  const replacement = [
    `  ${name}:`,
    '    enabled: true',
    '    name: voko',
    '    description: VOKO MCP',
    '    display_name: VOKO MCP',
    '    type: stdio',
    '    cmd: voko',
    '    args: [mcp]',
    '    timeout: 300',
  ];
  lines.splice(start, end - start, ...replacement);
  return lines.join(eol);
}

function backupBeforeWrite(filePath: string): string {
  let backupPath = `${filePath}.voko-mcp.bak`;
  if (fs.existsSync(backupPath)) backupPath = `${filePath}.voko-mcp.bak-${Date.now()}`;
  fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL);
  return backupPath;
}

function migrateMcpConfigs(options: any = {}): any {
  const inspected = inspectMcpConfigs(options);
  const clients: any[] = [];
  for (const item of inspected.clients || []) {
    if (item.status !== 'warn') continue;
    let content = '';
    try { content = fs.readFileSync(item.path, 'utf8'); } catch (error: any) {
      clients.push({ client: item.client, path: item.path, status: 'error', error: error.message });
      continue;
    }
    let migrated: string | null = null;
    const lower = String(item.path).toLowerCase();
    if (lower.endsWith('.json')) migrated = migrateJsonContent(content);
    else if (lower.endsWith('.toml')) migrated = migrateTomlContent(content);
    else if (lower.endsWith('.yaml') || lower.endsWith('.yml')) migrated = migrateGooseYamlContent(content);
    if (!migrated || migrated === content) {
      clients.push({ client: item.client, path: item.path, status: 'skipped', reason: 'no unambiguous VOKO stdio entry found' });
      continue;
    }
    try {
      const backupPath = backupBeforeWrite(item.path);
      const temporary = `${item.path}.voko-mcp.tmp-${process.pid}`;
      fs.writeFileSync(temporary, migrated, 'utf8');
      fs.renameSync(temporary, item.path);
      clients.push({ client: item.client, path: item.path, status: 'updated', backupPath });
    } catch (error: any) {
      try { fs.unlinkSync(`${item.path}.voko-mcp.tmp-${process.pid}`); } catch (_) {}
      clients.push({ client: item.client, path: item.path, status: 'error', error: error.message });
    }
  }
  return {
    changed: clients.filter((item) => item.status === 'updated').length,
    skipped: clients.filter((item) => item.status === 'skipped').length,
    errors: clients.filter((item) => item.status === 'error').length,
    clients,
  };
}

module.exports = { inspectMcpConfigs, migrateMcpConfigs, candidates };
