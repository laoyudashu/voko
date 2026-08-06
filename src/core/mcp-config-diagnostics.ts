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

module.exports = { inspectMcpConfigs, candidates };
