/**
 * Shared Agent registration orchestration for Web, local HTTP, MCP and CLI.
 *
 * Sessions contain only workflow metadata. Verification codes and access tokens
 * are never persisted here.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { discoverHermes } = require('../server/hermes-discovery');
const { getRegistrationCaller } = require('./registration-caller-context');
const { getBackendTypes, normalizeBackendType } = require('./agent-backend-types');
const { resolveZeroClawCommand } = require('./dispatcher/zeroclaw-command');
const { resolveCursorCommand, isCursorCommandAvailable } = require('./dispatcher/cursor-command');
const { isGeminiSandboxAvailable } = require('./dispatcher/providers/gemini-cli');
const { isGooseRuntimeAvailable } = require('./dispatcher/goose-command');

const SESSION_TTL_MS = 30 * 60 * 1000;
const SESSION_CONFIG_TYPE = 'agent_registration_sessions';
const services = new WeakMap();
const commandCache = new Map();
let installedApplicationCache = null;
const CLI_COMMANDS = {
  goose: 'goose',
  'claude-code': 'claude',
  codex: 'codex',
  gemini: 'gemini',
  cursor: 'cursor-agent',
  opencode: 'opencode',
  pi: 'pi',
  'qwen-code': 'qwen',
  kiro: 'kiro-cli',
  aider: 'aider',
  cline: 'cline',
  'github-copilot': 'copilot',
  grok: 'grok',
  reasonix: 'reasonix',
};
const PULL_ONLY_CLI_COMMANDS = {
  openhands: 'openhands',
  'amazon-q': 'q',
};
const DETECTABLE_CLI_COMMANDS = { ...CLI_COMMANDS, ...PULL_ONLY_CLI_COMMANDS };
const CLI_SESSION_ROOTS = {
  goose: () => process.platform === 'win32'
    ? [path.join(process.env.APPDATA || '', 'Block', 'goose', 'data', 'sessions')]
    : [path.join(os.homedir(), '.config', 'goose'), path.join(os.homedir(), '.local', 'share', 'goose', 'sessions')],
  'claude-code': () => [path.join(os.homedir(), '.claude', 'projects')],
  codex: () => [path.join(os.homedir(), '.codex', 'sessions')],
  gemini: () => [path.join(os.homedir(), '.gemini', 'tmp')],
  cursor: () => [path.join(os.homedir(), '.cursor')],
  opencode: () => [path.join(os.homedir(), '.local', 'share', 'opencode')],
  pi: () => [path.join(os.homedir(), '.pi', 'agent', 'sessions')],
  'qwen-code': () => [path.join(os.homedir(), '.qwen', 'projects')],
  kiro: () => [path.join(os.homedir(), '.kiro')],
  'github-copilot': () => [path.join(os.homedir(), '.copilot')],
  openhands: () => [path.join(os.homedir(), '.openhands', 'conversations')],
  aider: () => [path.join(os.homedir(), '.aider')],
  cline: () => [path.join(os.homedir(), '.cline')],
  zeroclaw: () => [path.join(os.homedir(), '.zeroclaw', 'data')],
  'amazon-q': () => [path.join(os.homedir(), '.aws', 'amazonq')],
};
const CLI_DELIVERY_METADATA = {
  'qwen-code': {
    label: 'Qwen Code 安全 CLI',
    description: 'VOKO 以 safe-mode、plan 模式和零工具预算调用 Qwen Code，仅允许文字回复。',
  },
  kiro: {
    label: 'Kiro 受限 CLI',
    description: 'VOKO 不为外部访客消息预授权任何 Kiro 工具，仅允许无工具的文字回复。',
  },
  aider: {
    label: 'Aider 只读问答',
    description: 'VOKO 以 ask、dry-run、no-git 模式调用 Aider，不允许编辑或提交文件。',
  },
  reasonix: {
    label: 'Reasonix 受限 CLI',
    description: 'VOKO 以 stream-json、dontAsk 和 stdin 调用 Reasonix，仅允许无人值守文字回复。',
  },
  cline: {
    label: 'Cline Plan CLI',
    description: 'VOKO 以 Plan 模式调用 Cline CLI，关闭工具自动批准并禁止 Shell 命令。',
  },
};
const DESKTOP_APPLICATIONS = [
  { type: 'zcode', label: 'ZCode', pattern: /\bzcode\b/i },
  { type: 'workbuddy', label: 'WorkBuddy', pattern: /\bworkbuddy\b/i },
  { type: 'doubao', label: '豆包', pattern: /豆包|\bdoubao\b/i },
];
const SESSION_EXTENSIONS = new Set(['.json', '.jsonl', '.db', '.sqlite', '.sqlite3']);

function now() { return Date.now(); }
function sessionId() { return 'reg_' + crypto.randomBytes(12).toString('hex'); }
function isRegistrationId(value) { return /^reg_[a-f0-9]{24}$/.test(String(value || '')); }
function cleanText(value, max = 200) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}
function currentAgentTypeFromText(value) {
  const text = String(value || '').toLowerCase();
  const patterns = [
    ['codex', /(?:^|[\\/\s])codex(?:\.exe)?(?:\s|$)|openai\.codex/],
    ['claude-code', /(?:^|[\\/\s])claude(?:\.exe)?(?:\s|$)|claude-code/],
    ['goose', /(?:^|[\\/\s])goose(?:\.exe)?(?:\s|$)/],
    ['openclaw', /(?:^|[\\/\s])openclaw(?:\.exe)?(?:\s|$)/],
    ['zeroclaw', /(?:^|[\\/\s])zeroclaw(?:\.exe)?(?:\s|$)/],
    ['hermes', /(?:^|[\\/\s])hermes(?:\.exe)?(?:\s|$)/],
    ['gemini', /(?:^|[\\/\s])gemini(?:\.exe)?(?:\s|$)/],
    ['qwen-code', /(?:^|[\\/\s])qwen(?:\.exe)?(?:\s|$)|qwen-code/],
    ['kiro', /(?:^|[\\/\s])kiro-cli(?:\.exe)?(?:\s|$)|(?:^|[\\/\s])kiro(?:\.exe)?(?:\s|$)/],
    ['github-copilot', /(?:^|[\\/\s])copilot(?:\.exe)?(?:\s|$)|github-copilot/],
    ['openhands', /(?:^|[\\/\s])openhands(?:\.exe)?(?:\s|$)/],
    ['aider', /(?:^|[\\/\s])aider(?:\.exe)?(?:\s|$)/],
    ['cline', /(?:^|[\\/\s])cline(?:\.exe)?(?:\s|$)/],
    ['amazon-q', /(?:^|[\\/\s])q(?:\.exe)?\s+(?:chat|agent)|amazon-q/],
    ['opencode', /(?:^|[\\/\s])opencode(?:\.exe)?(?:\s|$)/],
    ['zcode', /(?:^|[\\/\s])zcode(?:\.exe)?(?:\s|$)/],
    ['workbuddy', /(?:^|[\\/\s])workbuddy(?:\.exe)?(?:\s|$)/],
    ['doubao', /(?:^|[\\/\s])doubao(?:\.exe)?(?:\s|$)/],
    ['cursor', /(?:^|[\\/\s])cursor(?:\.exe)?(?:\s|$)/],
    ['pi', /(?:^|[\\/\s])pi(?:\.exe)?(?:\s|$)/],
  ];
  return patterns.find(([, pattern]) => pattern.test(text))?.[0] || null;
}
function currentAgentTypeFromProcessRows(rows) {
  for (const row of rows || []) {
    const type = currentAgentTypeFromText(row);
    if (type) return type;
  }
  return null;
}
function currentAgentTypeFromEnvironment(env = process.env, cwd = process.cwd()) {
  if (env.OPENCLAW_CLI === '1' || /[\\/]\.openclaw[\\/]workspace(?:-|[\\/]|$)/i.test(String(cwd || ''))) {
    return 'openclaw';
  }
  if (env.HERMES_INTERACTIVE === '1' || env.HERMES_SESSION_ID) return 'hermes';
  return null;
}
function detectCurrentAgentType() {
  const forwarded = getRegistrationCaller();
  if (forwarded?.providerType) return normalizeBackendType(forwarded.providerType);
  const environmentType = currentAgentTypeFromEnvironment();
  if (environmentType) return environmentType;
  try {
    if (process.platform === 'win32') {
      const script = [
        `$p=${process.ppid}`,
        '$rows=@()',
        '1..8|%{$x=Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue;if(!$x){return};$rows+=("$($x.Name) $($x.CommandLine)");$p=$x.ParentProcessId}',
        '$rows -join "`n"',
      ].join(';');
      const probe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8', timeout: 8000, windowsHide: true,
      });
      if (probe.status === 0) {
        const detected = currentAgentTypeFromProcessRows(probe.stdout.split(/\r?\n/).filter(Boolean));
        if (detected) return detected;
      }
      return null;
    }
    let pid = process.ppid;
    const rows = [];
    for (let depth = 0; depth < 8 && pid > 1; depth++) {
      const probe = spawnSync('ps', ['-o', 'ppid=,comm=,args=', '-p', String(pid)], { encoding: 'utf8', timeout: 800 });
      const line = probe.stdout.trim();
      if (!line) break;
      rows.push(line);
      const match = line.match(/^\s*(\d+)/);
      pid = match ? Number(match[1]) : 0;
    }
    return currentAgentTypeFromProcessRows(rows);
  } catch (_) {
    return null;
  }
}
function commandAvailable(command) {
  const cached = commandCache.get(command);
  if (cached && now() - cached.at < 60_000) return cached.available;
  try {
    const pathEntries = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
    const hasExtension = !!path.extname(command);
    const extensions = process.platform === 'win32' && !hasExtension
      ? String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
        .split(';').filter(Boolean).map((extension) => extension.toLowerCase())
      : [''];
    const available = pathEntries.some((directory) => extensions.some((extension) => {
      const candidate = path.join(directory, command + extension);
      try {
        return fs.statSync(candidate).isFile();
      } catch (_) {
        return false;
      }
    }));
    commandCache.set(command, { available, at: now() });
    return available;
  } catch (_) {
    commandCache.set(command, { available: false, at: now() });
    return false;
  }
}
function installedApplications() {
  if (process.platform !== 'win32') return [];
  if (installedApplicationCache && now() - installedApplicationCache.at < 60_000) {
    return installedApplicationCache.names;
  }
  try {
    const script = [
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
      "$p=@('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')",
      'Get-ItemProperty $p -ErrorAction SilentlyContinue | ForEach-Object DisplayName | Where-Object { $_ } | ConvertTo-Json -Compress',
    ].join(';');
    const probe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 2500, windowsHide: true,
    });
    const parsed = probe.status === 0 && probe.stdout.trim() ? JSON.parse(probe.stdout) : [];
    const names = (Array.isArray(parsed) ? parsed : [parsed]).map(String);
    installedApplicationCache = { names, at: now() };
    return names;
  } catch (_) {
    installedApplicationCache = { names: [], at: now() };
    return [];
  }
}
function sessionActivity(providerType) {
  const roots = CLI_SESSION_ROOTS[providerType]?.() || [];
  let sessionCount = 0;
  let lastActivityAt = 0;
  const pending = roots.filter((root) => root && fs.existsSync(root));
  while (pending.length && sessionCount < 5000) {
    const current = pending.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
      } else if (entry.isFile() && SESSION_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        sessionCount++;
        try { lastActivityAt = Math.max(lastActivityAt, fs.statSync(fullPath).mtimeMs); } catch (_) {}
      }
    }
  }
  const age = lastActivityAt ? now() - lastActivityAt : Infinity;
  return {
    sessionCount,
    lastActivityAt: lastActivityAt || null,
    activityState: age <= 10 * 60 * 1000 ? 'active' : age <= 24 * 60 * 60 * 1000 ? 'recent' : 'installed',
  };
}
function openclawInstances() {
  try {
    const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return (config.agents?.list || []).map((agent) => ({
      id: String(agent.id || ''),
      name: String(agent.name || agent.id || ''),
      isDefault: !!agent.default,
    })).filter((agent) => agent.id);
  } catch (_) {
    return [];
  }
}
function detectCurrentAgentInstance(providerType) {
  const type = normalizeBackendType(providerType);
  const forwarded = getRegistrationCaller();
  if (forwarded?.providerType === type && forwarded.instanceId) return cleanText(forwarded.instanceId, 160);
  if (type === 'openclaw') {
    try {
      const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const cwd = path.resolve(process.cwd());
      const normalizedCwd = process.platform === 'win32' ? cwd.toLowerCase() : cwd;
      for (const agent of config.agents?.list || []) {
        const workspace = agent.workspace
          ? path.resolve(agent.workspace)
          : path.join(os.homedir(), '.openclaw', 'workspace');
        const normalizedWorkspace = process.platform === 'win32' ? workspace.toLowerCase() : workspace;
        if (normalizedCwd === normalizedWorkspace || normalizedCwd.startsWith(normalizedWorkspace + path.sep)) {
          return String(agent.id || '') || null;
        }
      }
    } catch (_) {}
  }
  if (type === 'hermes' && (process.env.HERMES_INTERACTIVE === '1' || process.env.HERMES_SESSION_ID)) {
    const explicit = cleanText(process.env.HERMES_PROFILE, 160);
    if (explicit) return explicit;
    const defaultProfile = hermesInstances().find((profile) => profile.isDefault);
    return defaultProfile?.id || null;
  }
  return null;
}
function hermesInstances() {
  try {
    return (discoverHermes() || []).map((profile) => ({
      id: String(profile.name || ''),
      name: String(profile.name || ''),
      isDefault: !!profile.isDefault,
    })).filter((profile) => profile.id);
  } catch (_) {
    return [];
  }
}
function zeroclawInstances() {
  try {
    const command = resolveZeroClawCommand();
    const probe = spawnSync(command, ['agents', 'list'], {
      encoding: 'utf8', timeout: 5000, windowsHide: true,
    });
    if (probe.status !== 0) return [];
    return String(probe.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(line))
      .map((alias) => ({ id: alias, name: alias, isDefault: false }));
  } catch (_) {
    return [];
  }
}
function zeroclawReadiness(instanceId) {
  const alias = cleanText(instanceId, 160);
  if (!alias) return { ready: false, detail: '需要先选择 ZeroClaw Agent 实例' };
  try {
    const probe = spawnSync(resolveZeroClawCommand(), ['security', 'status', '--agent', alias, '--json'], {
      encoding: 'utf8', timeout: 5000, windowsHide: true,
    });
    return {
      ready: probe.status === 0,
      detail: probe.status === 0
        ? 'ZeroClaw Agent 与风险配置有效'
        : 'ZeroClaw Agent 尚未完成模型或风险配置',
    };
  } catch (_) {
    return { ready: false, detail: '无法检查 ZeroClaw Agent 配置' };
  }
}
function zeroclawWsReadiness(instanceId) {
  const base = zeroclawReadiness(instanceId);
  if (!base.ready) return base;
  const rawUrl = cleanText(process.env.ZEROCLAW_ACP_URL, 500) || 'ws://127.0.0.1:42617/acp';
  const token = cleanText(process.env.ZEROCLAW_ACP_TOKEN, 2000);
  try {
    const url = new URL(rawUrl);
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
    if (!loopback || !['ws:', 'wss:'].includes(url.protocol) || url.search || url.hash) {
      return { ready: false, detail: 'ZeroClaw ACP WebSocket 仅允许无查询参数的本机回环地址' };
    }
  } catch (_) {
    return { ready: false, detail: 'ZeroClaw ACP WebSocket 地址无效' };
  }
  return token
    ? { ready: true, detail: 'ZeroClaw ACP WebSocket 已配置，可执行连接检测' }
    : { ready: false, detail: '需要配置 ZeroClaw ACP pairing token' };
}

function dbConfigAdapter(db) {
  return {
    getConfigFromDb(type) {
      try {
        const row = db.prepare('SELECT data FROM config WHERE type=?').get(type);
        return row?.data ? JSON.parse(row.data) : {};
      } catch (_) { return {}; }
    },
    saveConfigToDb(data, type) {
      db.prepare('INSERT OR REPLACE INTO config (type,data,updated_at) VALUES (?,?,?)')
        .run(type, JSON.stringify(data || {}), now());
    },
  };
}

class RegistrationOrchestrator {
  constructor(options = {}) {
    this.db = options.db;
    this.options = {};
    this.sessions = new Map();
    this.configure(options);
    this._loadSessions();
  }

  configure(options = {}) {
    this.options = { ...this.options, ...options };
  }

  _loadSessions() {
    if (!this.db) return;
    try {
      const stored = this._readStoredSessions();
      for (const [id, session] of Object.entries(stored)) {
        if (isRegistrationId(id) && session && typeof session === 'object' && session.id === id && session.updatedAt >= now() - SESSION_TTL_MS) {
          this.sessions.set(id, session);
        }
      }
    } catch (_) {}
  }

  _readStoredSessions() {
    const row = this.db.prepare('SELECT data FROM config WHERE type=?').get(SESSION_CONFIG_TYPE);
    const stored = row?.data ? JSON.parse(row.data) : {};
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  }

  _persistSession(session) {
    if (!this.db) return;
    let transactionStarted = false;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      transactionStarted = true;
      const cutoff = now() - SESSION_TTL_MS;
      const stored = this._readStoredSessions();
      for (const [id, existing] of Object.entries(stored)) {
        if (!existing || typeof existing !== 'object' || existing.updatedAt < cutoff) delete stored[id];
      }
      stored[session.id] = session;
      this.db.prepare('INSERT OR REPLACE INTO config (type,data,updated_at) VALUES (?,?,?)')
        .run(SESSION_CONFIG_TYPE, JSON.stringify(stored), now());
      this.db.exec('COMMIT');
    } catch (_) {
      if (transactionStarted) {
        try { this.db.exec('ROLLBACK'); } catch (_) {}
      }
    }
  }

  _cleanup() {
    const cutoff = now() - SESSION_TTL_MS;
    for (const [id, session] of this.sessions) {
      if (session.updatedAt < cutoff) {
        this.sessions.delete(id);
      }
    }
  }

  _save(session) {
    session.updatedAt = now();
    this.sessions.set(session.id, session);
    this._persistSession(session);
    return this.view(session);
  }

  _get(id) {
    this._cleanup();
    const sessionId = String(id || '');
    if (!isRegistrationId(sessionId)) {
      const error = new Error('注册会话不存在或已过期');
      error.code = 'REGISTRATION_SESSION_NOT_FOUND';
      throw error;
    }
    if (this.db) {
      try {
        const stored = this._readStoredSessions();
        const persisted = stored[sessionId];
        if (persisted && typeof persisted === 'object' && persisted.updatedAt >= now() - SESSION_TTL_MS) {
          this.sessions.set(sessionId, persisted);
        }
      } catch (_) {}
    }
    const session = this.sessions.get(sessionId);
    if (!session) {
      const error = new Error('注册会话不存在或已过期');
      error.code = 'REGISTRATION_SESSION_NOT_FOUND';
      throw error;
    }
    if (session.ownerBound && this.db) {
      try {
        const row = this.db.prepare("SELECT data FROM config WHERE type='user_access_token'").get();
        const data = row?.data ? JSON.parse(row.data) : {};
        const currentEmail = String(Object.keys(data)[0] || '').trim().toLowerCase();
        if (currentEmail && currentEmail !== String(session.email || '').trim().toLowerCase()) {
          const error = new Error('当前登录用户与该注册会话不一致');
          error.code = 'REGISTRATION_OWNER_MISMATCH';
          throw error;
        }
      } catch (error) {
        if (error?.code === 'REGISTRATION_OWNER_MISMATCH') throw error;
      }
    }
    return session;
  }

  _nextAction(session) {
    const map = {
      email_verification_required: {
        type: 'submit_email_code',
        required: ['code'],
        requiresUserInput: true,
        mustPause: true,
        instruction: '验证码只能由主人提供。不得读取邮箱、猜测验证码或重复触发发送。',
      },
      basic_info_required: { type: 'submit_basic_info', required: ['agentName'], optional: ['description', 'category'] },
      provider_selection_required: session.providerLock
        ? { type: 'select_provider_instance', required: ['instanceId'], providerType: session.providerLock.type }
        : { type: 'select_provider', required: ['providerType'], optional: ['instanceId'] },
      delivery_selection_required: { type: 'select_delivery', required: ['deliveryModes'] },
      ready_to_create: { type: 'complete_registration', optional: ['accessMode'] },
      created: { type: 'open_agent', agentId: session.result?.agentId || null },
    };
    return map[session.status] || null;
  }

  view(sessionOrId) {
    const session = typeof sessionOrId === 'string' ? this._get(sessionOrId) : sessionOrId;
    return {
      success: true,
      registrationId: session.id,
      status: session.status,
      email: session.email || null,
      basicInfo: session.basicInfo || null,
      provider: session.provider || null,
      deliveryModes: session.deliveryModes || [],
      accessMode: session.accessMode || 'private',
      environment: session.environment || null,
      registrationMode: session.registrationMode || 'human',
      providerLock: session.providerLock || null,
      result: session.result || null,
      warnings: session.warnings || [],
      nextAction: this._nextAction(session),
      updatedAt: session.updatedAt,
    };
  }

  inspectEnvironment() {
    const gatewaySetup = this.options.gatewaySetup || require('./gateway-setup');
    const dbApi = this.db ? dbConfigAdapter(this.db) : null;
    const hasCommand = this.options.commandAvailable || commandAvailable;
    const openclaw = openclawInstances();
    const zeroclawCommand = resolveZeroClawCommand();
    const zeroclawInstalled = hasCommand('zeroclaw')
      || (path.isAbsolute(zeroclawCommand) && fs.existsSync(zeroclawCommand));
    const discoverZeroClawInstances = this.options.zeroclawInstances || zeroclawInstances;
    const zeroclaw = zeroclawInstalled ? discoverZeroClawInstances() : [];
    const hermesInstalled = hasCommand('hermes');
    const hermes = hermesInstalled ? hermesInstances() : [];
    const openclawGateway = gatewaySetup.checkGateway('openclaw', dbApi);
    const hermesGateway = gatewaySetup.checkGateway('hermes', dbApi);
    const detected = [];

    if (openclaw.length || hasCommand('openclaw')) {
      detected.push({
        type: 'openclaw',
        label: 'OpenClaw',
        instances: openclaw,
        supportsMultipleInstances: true,
        deliveryModes: this.deliveryCapabilities('openclaw', openclawGateway),
      });
    }
    if (zeroclaw.length || zeroclawInstalled) {
      const instanceId = zeroclaw.length === 1 ? zeroclaw[0].id : null;
      detected.push({
        type: 'zeroclaw',
        label: 'ZeroClaw',
        instances: zeroclaw,
        supportsMultipleInstances: true,
        activityState: 'installed',
        deliveryModes: this.deliveryCapabilities('zeroclaw', { ready: false, instanceId }),
      });
    }
    if (hermes.length || hermesInstalled) {
      detected.push({
        type: 'hermes',
        label: 'Hermes',
        instances: hermes,
        supportsMultipleInstances: true,
        deliveryModes: this.deliveryCapabilities('hermes', hermesGateway),
      });
    }

    const known = this.db ? getBackendTypes(this.db) : [];
    const knownLabels = new Map(known.map((item) => [item.value, item.label]));
    for (const [type, command] of Object.entries(DETECTABLE_CLI_COMMANDS)) {
      const available = type === 'cursor'
        ? (this.options.commandAvailable
          ? hasCommand('cursor-agent') || hasCommand('agent')
          : isCursorCommandAvailable())
        : hasCommand(command);
      if (type === 'openclaw' || type === 'hermes' || !available) continue;
      detected.push({
        type,
        label: knownLabels.get(type) || type,
        instances: [],
        supportsMultipleInstances: false,
        ...sessionActivity(type),
        deliveryModes: this.deliveryCapabilities(type),
      });
    }
    const applicationNames = (this.options.installedApplications || installedApplications)();
    for (const application of DESKTOP_APPLICATIONS) {
      if (!applicationNames.some((name) => application.pattern.test(name))) continue;
      detected.push({
        type: application.type,
        label: knownLabels.get(application.type) || application.label,
        instances: [],
        supportsMultipleInstances: false,
        activityState: 'installed',
        deliveryModes: this.deliveryCapabilities(application.type),
      });
    }

    const detectedTypes = new Set(detected.map((item) => item.type));
    const more = known
      .filter((item) => item.value !== 'others' && !detectedTypes.has(item.value))
      .map((item) => ({ type: item.value, label: item.label, detected: false }));

    // 当前进程被识别为某桌面应用类（zcode/workbuddy/doubao 等，靠 process_ancestry 命中），
    // 但 inspectEnvironment 的 instances 扫描（注册表卸载列表）无法枚举这些运行时实例，
    // 导致 detected:true 与 instances:[] 矛盾，下游按 instance 选择会误判"没有可用实例"。
    // 这里给被命中的类型注入一个合成 current instance，使 instances 非空、与 detected 一致。
    try {
      const detect = this.options.detectCurrentAgentType || detectCurrentAgentType;
      const currentType = detect();
      if (currentType) {
        const item = detected.find((d) => d.type === currentType);
        if (item && (!item.instances || item.instances.length === 0)) {
          item.instances = [{
            id: currentType,
            name: item.label || currentType,
            source: 'process_ancestry',
            isCurrent: true,
          }];
          item.detectedAsCurrent = true;
        }
      }
    } catch (_) { /* 检测失败不影响整体环境扫描 */ }

    const deliveryCount = new Set(detected.flatMap((item) => item.deliveryModes.map((mode) => mode.mode))).size;
    return {
      detected,
      more,
      fallback: {
        type: 'others',
        label: 'Others',
        deliveryModes: this.deliveryCapabilities('others'),
      },
      summary: {
        providerCount: detected.length,
        instanceCount: detected.reduce((sum, item) => sum + Math.max(item.instances.length, 1), 0),
        deliveryModeCount: deliveryCount,
      },
    };
  }

  inspectCurrentAgent(providerType, instanceId = null) {
    const type = normalizeBackendType(providerType);
    const known = this.db ? getBackendTypes(this.db) : [];
    const label = known.find((item) => item.value === type)?.label || type;
    const allInstances = type === 'openclaw'
      ? openclawInstances()
      : type === 'hermes'
        ? hermesInstances()
        : type === 'zeroclaw'
          ? zeroclawInstances()
          : [];
    const matchedInstance = instanceId ? allInstances.find((instance) => instance.id === instanceId) : null;
    const instances = matchedInstance ? [matchedInstance] : allInstances;
    const provider = {
      type,
      label,
      instances,
      supportsMultipleInstances: type === 'openclaw' || type === 'hermes' || type === 'zeroclaw',
      deliveryModes: this.deliveryCapabilities(
        type,
        type === 'zeroclaw'
          ? { ...zeroclawReadiness(matchedInstance?.id), instanceId: matchedInstance?.id }
          : undefined,
      ),
      detectedAsCurrent: true,
    };
    return {
      detected: [provider],
      more: [],
      fallback: { type: 'others', label: 'Others', deliveryModes: this.deliveryCapabilities('others') },
      currentAgent: {
        type,
        label,
        instanceId: matchedInstance?.id || null,
        source: 'process_ancestry',
        confidence: 'high',
      },
      summary: {
        providerCount: 1,
        instanceCount: Math.max(instances.length, 1),
        deliveryModeCount: new Set(provider.deliveryModes.map((mode) => mode.mode)).size,
      },
    };
  }

  deliveryCapabilities(providerType, gatewayStatus) {
    const type = normalizeBackendType(providerType);
    const hasCommand = this.options.commandAvailable || commandAvailable;
    const pull = {
      mode: 'pull',
      label: '主动获取',
      role: 'final_fallback',
      status: 'ready',
      required: true,
      selected: true,
      action: null,
      description: '消息始终保存在 VOKO；Agent 可通过 VOKO CLI、MCP 工具或接口主动读取。',
    };
    if (type === 'goose' || type === 'acp-goose') {
      const available = this.options.commandAvailable
        ? hasCommand('goose')
        : isGooseRuntimeAvailable(type === 'acp-goose' ? 'acp' : 'cli');
      const cli = {
        mode: 'cli', label: 'Goose CLI 自动交付', role: type === 'acp-goose' ? 'fallback' : 'primary',
        status: available ? 'ready' : 'unavailable',
        selected: available,
        action: available ? 'test' : null,
        description: available ? 'VOKO 使用 Goose 原生 session ID 自动投递并续接消息。' : '本机未检测到 Goose CLI。',
      };
      if (type === 'goose') return [cli, pull];
      return [
        {
          mode: 'acp', label: 'Goose ACP 实时会话', role: 'primary',
          status: available ? 'ready' : 'unavailable', selected: available, recommended: true,
          action: available ? 'test' : null,
          description: available ? 'VOKO 通过标准 ACP 会话投递，断线时降级到 Goose CLI。' : '本机未检测到 Goose ACP 运行入口。',
        },
        cli,
        pull,
      ];
    }
    if (type === 'openclaw') {
      const gateway = gatewayStatus || require('./gateway-setup').checkGateway('openclaw', this.db ? dbConfigAdapter(this.db) : null);
      return [
        {
          mode: 'websocket', label: 'WebSocket 实时推送', role: 'primary',
          status: gateway.ready ? 'ready' : 'configuration_required',
          selected: !!gateway.ready, recommended: true,
          action: gateway.ready ? 'test' : 'configure',
          description: 'VOKO 与 OpenClaw 保持实时连接，新消息可立即送达。',
        },
        {
          mode: 'cli', label: 'CLI 唤起', role: 'fallback',
          status: commandAvailable('openclaw') ? 'ready' : 'unavailable',
          selected: commandAvailable('openclaw'),
          action: commandAvailable('openclaw') ? 'test' : null,
          description: 'VOKO 为每条消息调用一次本机 OpenClaw 命令。',
        },
        pull,
      ];
    }
    if (type === 'hermes') {
      const gateway = gatewayStatus || require('./gateway-setup').checkGateway('hermes', this.db ? dbConfigAdapter(this.db) : null);
      return [
        {
          mode: 'http', label: 'HTTP API 推送', role: 'primary',
          status: gateway.ready ? 'ready' : 'configuration_required',
          selected: !!gateway.ready, recommended: true,
          action: gateway.ready ? 'test' : 'configure',
          description: 'VOKO 通过本机 HTTP API 将新消息直接交给 Hermes。',
        },
        {
          mode: 'cli', label: 'CLI 唤起', role: 'fallback',
          status: commandAvailable('hermes') ? 'ready' : 'unavailable',
          selected: commandAvailable('hermes'),
          action: commandAvailable('hermes') ? 'test' : null,
          description: 'VOKO 为每条消息调用一次 Hermes CLI。',
        },
        pull,
      ];
    }
    if (type === 'zeroclaw') {
      const command = resolveZeroClawCommand();
      const available = hasCommand('zeroclaw')
        || (path.isAbsolute(command) && fs.existsSync(command));
      const instanceId = gatewayStatus?.instanceId;
      const stdio = zeroclawReadiness(instanceId);
      const ws = zeroclawWsReadiness(instanceId);
      return [
        {
          mode: 'acp_ws', label: 'ACP WebSocket 实时连接', role: 'primary',
          status: !available ? 'unavailable' : ws.ready ? 'ready' : 'configuration_required',
          selected: available && ws.ready, recommended: true,
          action: !available ? null : ws.ready ? 'test' : null,
          description: '多个 ZeroClaw Agent 共享本机实时连接；工具权限默认拒绝，避免访客触发敏感操作。',
        },
        {
          mode: 'acp', label: 'ACP 独立进程', role: 'fallback',
          status: !available ? 'unavailable' : stdio.ready ? 'ready' : 'configuration_required',
          selected: available && stdio.ready,
          action: !available ? null : stdio.ready ? 'test' : null,
          description: 'WebSocket 不可用时，为该 Agent 启动独立 ACP 进程。',
        },
        {
          mode: 'cli', label: 'CLI 持久会话', role: 'fallback',
          status: available && instanceId ? 'ready' : 'configuration_required',
          selected: available && !!instanceId,
          action: available && instanceId ? 'test' : null,
          description: 'ACP 不可用时，使用已确认的 Agent 实例和独立会话状态文件继续接收消息。',
        },
        pull,
      ];
    }
    if (type === 'opencode') {
      const available = hasCommand('opencode');
      const status = available ? 'ready' : 'unavailable';
      const action = available ? 'test' : null;
      return [
        {
          mode: 'acp', label: 'ACP 实时会话', role: 'primary',
          status, selected: available, recommended: true, action,
          description: 'VOKO 通过标准 ACP 协议与 OpenCode 保持隔离的会话连接。',
        },
        {
          mode: 'attach', label: '本机服务复用', role: 'fallback',
          status, selected: available, action,
          description: 'ACP 不可用时，复用仅监听本机且需要鉴权的 OpenCode 后台服务。',
        },
        {
          mode: 'cli', label: 'CLI 单次唤起', role: 'fallback',
          status, selected: available, action,
          description: '后台服务不可用时，为每条新消息单独调用 OpenCode CLI。',
        },
        pull,
      ];
    }
    if (type === 'github-copilot') {
      const available = hasCommand('copilot');
      const status = available ? 'ready' : 'unavailable';
      const action = available ? 'test' : null;
      return [
        {
          mode: 'acp', label: 'ACP 实时会话', role: 'primary',
          status, selected: available, recommended: true, action,
          description: 'VOKO 通过标准 ACP 协议保持隔离会话，并拒绝外部访客触发工具授权。',
        },
        {
          mode: 'cli', label: 'CLI 单次唤起', role: 'fallback',
          status, selected: available, action,
          description: 'ACP 不可用时，以无工具、无 MCP、无远程操作模式调用 GitHub Copilot CLI。',
        },
        pull,
      ];
    }
    if (type === 'cline') {
      const available = hasCommand('cline');
      const status = available ? 'ready' : 'unavailable';
      const action = available ? 'test' : null;
      return [
        {
          mode: 'acp', label: 'ACP 实时会话', role: 'primary',
          status, selected: available, recommended: true, action,
          description: 'VOKO 通过 Cline ACP 创建隔离会话，并拒绝外部访客触发工具操作。',
        },
        {
          mode: 'cli', label: 'Cline Plan CLI', role: 'fallback',
          status, selected: available, action,
          description: 'ACP 不可用时，使用只读 Plan 模式调用 Cline CLI。',
        },
        pull,
      ];
    }
    if (type === 'cursor') {
      const available = this.options.commandAvailable
        ? hasCommand('cursor-agent') || hasCommand('agent')
        : isCursorCommandAvailable();
      const status = available ? 'ready' : 'unavailable';
      const action = available ? 'test' : null;
      return [
        {
          mode: 'acp', label: 'ACP 实时会话', role: 'primary',
          status, selected: available, recommended: true, action,
          description: 'VOKO 通过 Cursor ACP 复用隔离会话，并默认拒绝外部访客触发工具授权。',
        },
        {
          mode: 'cli', label: 'CLI 单次唤起', role: 'fallback',
          status, selected: available, action,
          description: 'ACP 不可用时，以只读 plan 模式调用 Cursor CLI。',
        },
        pull,
      ];
    }
    const cliCommand = CLI_COMMANDS[type];
    if (cliCommand) {
      const available = type === 'gemini' && !this.options.commandAvailable
        ? hasCommand(cliCommand) && isGeminiSandboxAvailable()
        : hasCommand(cliCommand);
      const metadata = CLI_DELIVERY_METADATA[type] || {};
      return [
        {
          mode: 'cli', label: metadata.label || 'CLI 自动交付', role: 'primary',
          status: available ? 'ready' : 'unavailable',
          selected: available,
          action: available ? 'test' : null,
          description: available
            ? (metadata.description || `VOKO 收到新消息后自动调用本机 ${cliCommand} 命令。`)
            : `本机未检测到 ${cliCommand} 命令；暂时不能自动交付。`,
        },
        pull,
      ];
    }
    return [pull];
  }

  async start(input = {}) {
    this._cleanup();
    // The caller mode is a security boundary, not a user-selectable field.
    // Only local Web registration or an explicit interactive TTY enters the trusted human context.
    const caller = getRegistrationCaller();
    const humanSource = caller?.source === 'web' || caller?.source === 'cli_interactive';
    const registrationSource = humanSource ? caller.source : 'agent';
    let email = cleanText(input.email, 320).toLowerCase();
    if (!email) {
      try { email = cleanText(await this.options.getLoggedEmail?.(), 320).toLowerCase(); } catch (_) {}
    }
    if (!email) {
      return {
        success: false,
        error: '未检测到本机登录状态，需要主人提供邮箱并完成验证',
        code: 'LOGIN_REQUIRED',
        nextAction: {
          type: 'request_owner_email',
          required: ['email'],
          requiresUserInput: true,
          mustPause: true,
          instruction: '请向主人索取其 VOKO 登录邮箱。不得猜测、编造邮箱或自行发送验证码。',
        },
      };
    }
    let authorizedEmail = '';
    try { authorizedEmail = cleanText(await this.options.getLoggedEmail?.(), 320).toLowerCase(); } catch (_) {}
    const loggedIn = !!authorizedEmail && authorizedEmail === email;
    const session = {
      id: sessionId(),
      email,
      status: loggedIn ? 'basic_info_required' : 'email_verification_required',
      environment: null,
      basicInfo: null,
      provider: null,
      deliveryModes: [],
      accessMode: 'private',
      registrationMode: humanSource ? 'human' : 'agent',
      registrationSource,
      ownerBound: loggedIn,
      providerLock: null,
      warnings: [],
      createdAt: now(),
      updatedAt: now(),
    };
    if (!loggedIn) {
      const sendCode = this.options.sendCode;
      if (typeof sendCode !== 'function') return { success: false, error: '验证码服务未就绪' };
      const sent = await sendCode({ email });
      if (!sent?.success) return { success: false, error: sent?.error || '发送验证码失败' };
    }
    return this._save(session);
  }

  async verifyEmail(id, code) {
    const session = this._get(id);
    if (session.status !== 'email_verification_required') return this.view(session);
    const loginByCode = this.options.loginByCode;
    if (typeof loginByCode !== 'function') return { success: false, error: '验证码验证服务未就绪' };
    const verified = await loginByCode({ email: session.email, code: cleanText(code, 12) });
    if (!verified?.success) return { success: false, error: verified?.error || '验证码错误或已过期' };
    session.status = 'basic_info_required';
    session.ownerBound = true;
    return this._save(session);
  }

  setBasicInfo(id, input = {}) {
    const session = this._get(id);
    const agentName = cleanText(input.agentName, 120);
    if (!agentName) return { success: false, error: 'agentName 为必填字段' };
    session.basicInfo = {
      agentName,
      description: cleanText(input.description, 1000),
      category: cleanText(input.category, 64) || 'general',
    };
    const currentType = session.registrationMode === 'agent'
      ? (this.options.detectCurrentAgentType || detectCurrentAgentType)()
      : null;
    const currentInstance = currentType
      ? (this.options.detectCurrentAgentInstance || detectCurrentAgentInstance)(currentType)
      : null;
    session.environment = currentType
      ? this.inspectCurrentAgent(currentType, currentInstance)
      : this.inspectEnvironment();
    if (session.registrationMode === 'agent' && session.environment.detected.length === 1) {
      const detected = session.environment.detected[0];
      session.providerLock = {
        type: detected.type,
        label: detected.label,
        source: currentType ? 'current_agent' : 'local_environment',
        confidence: 'high',
      };
    }
    const lockedProvider = session.providerLock
      ? session.environment.detected.find((item) => item.type === session.providerLock.type)
      : null;
    if (lockedProvider && (lockedProvider.instances || []).length <= 1) {
      const instance = lockedProvider.instances?.[0] || null;
      session.provider = {
        type: lockedProvider.type,
        instanceId: instance?.id || null,
        instanceName: instance?.name || null,
        detected: true,
      };
      session.deliveryModes = lockedProvider.deliveryModes || this.deliveryCapabilities(lockedProvider.type);
      session.status = 'delivery_selection_required';
      return this._save(session);
    }
    session.status = 'provider_selection_required';
    return this._save(session);
  }

  selectProvider(id, input = {}) {
    const session = this._get(id);
    const providerType = normalizeBackendType(input.providerType || session.providerLock?.type || 'others');
    if (session.providerLock && providerType !== session.providerLock.type) {
      return {
        success: false,
        error: `本机环境已将 Agent 类型锁定为 ${session.providerLock.label || session.providerLock.type}`,
        providerLock: session.providerLock,
      };
    }
    const known = new Set((this.db ? getBackendTypes(this.db) : []).map((item) => item.value));
    if (providerType !== 'others' && known.size && !known.has(providerType)) {
      return { success: false, error: '不支持自定义 Agent 类型；未匹配时请选择 Others' };
    }
    const environment = session.environment || this.inspectEnvironment();
    const detected = environment.detected.find((item) => item.type === providerType);
    const instances = detected?.instances || [];
    let instanceId = cleanText(input.instanceId, 160);
    if (instances.length > 1 && !instanceId) return { success: false, error: '该类型检测到多个实例，请选择 instanceId' };
    if (instances.length === 1 && !instanceId) instanceId = instances[0].id;
    if (instanceId && instances.length && !instances.some((item) => item.id === instanceId)) {
      return { success: false, error: '所选实例不存在' };
    }
    session.provider = {
      type: providerType,
      instanceId: instanceId || null,
      instanceName: instances.find((item) => item.id === instanceId)?.name || null,
      detected: !!detected,
    };
    delete session.pendingApproval;
    session.deliveryModes = this.deliveryCapabilities(
      providerType,
      providerType === 'zeroclaw'
        ? { ...zeroclawReadiness(instanceId), instanceId }
        : undefined,
    );
    session.status = 'delivery_selection_required';
    return this._save(session);
  }

  selectDelivery(id, input = {}) {
    const session = this._get(id);
    delete session.pendingApproval;
    const requested = Array.isArray(input.deliveryModes) ? input.deliveryModes.map(String) : [];
    const selectableStatuses = new Set(['ready', 'preflight_passed', 'loopback_verified']);
    session.deliveryModes = session.deliveryModes.map((mode) => ({
      ...mode,
      selected: mode.mode === 'pull' || (requested.includes(mode.mode) && selectableStatuses.has(mode.status)),
    }));
    session.status = 'ready_to_create';
    return this._save(session);
  }

  configureDelivery(id, input = {}) {
    const session = this._get(id);
    const mode = cleanText(input.mode, 40);
    const provider = session.provider?.type;
    const expected = provider === 'openclaw' ? 'websocket' : provider === 'hermes' ? 'http' : null;
    if (!expected || mode !== expected) return { success: false, error: '该 Provider 不支持配置此消息通道' };
    if (input.approved !== true) {
      const approvalToken = crypto.randomBytes(32).toString('base64url');
      session.pendingApproval = {
        tokenHash: crypto.createHash('sha256').update(approvalToken).digest('hex'),
        provider,
        mode,
        instanceId: session.provider?.instanceId || null,
        expiresAt: now() + 5 * 60 * 1000,
      };
      this._save(session);
      return {
        success: true,
        registrationId: session.id,
        status: 'approval_required',
        approvalToken,
        changePlan: {
          provider,
          instanceId: session.provider?.instanceId || null,
          mode,
          backup: true,
          rollback: true,
          message: '将备份并更新本机 Provider 配置；只有明确 approved=true 后才会执行。',
        },
        nextAction: { type: 'configure_delivery', required: ['registrationId', 'mode', 'approved', 'approvalToken'] },
      };
    }
    const approvalToken = cleanText(input.approvalToken, 200);
    const pending = session.pendingApproval;
    const tokenHash = approvalToken
      ? crypto.createHash('sha256').update(approvalToken).digest('hex')
      : '';
    const validApproval = pending
      && pending.provider === provider
      && pending.mode === mode
      && pending.instanceId === (session.provider?.instanceId || null)
      && pending.expiresAt >= now()
      && tokenHash.length === pending.tokenHash.length
      && crypto.timingSafeEqual(Buffer.from(tokenHash), Buffer.from(pending.tokenHash));
    if (!validApproval) {
      return { success: false, error: '配置确认已失效，请重新查看变更计划后确认' };
    }
    const caller = getRegistrationCaller();
    const trustedHuman = session.registrationSource === 'web'
      ? caller?.source === 'web'
      : session.registrationSource === 'cli_interactive' && caller?.source === 'cli_interactive';
    if (!trustedHuman) {
      return {
        success: false,
        code: 'HUMAN_CONFIGURATION_REQUIRED',
        error: 'Provider 配置必须由主人在 VOKO Web 注册页面中确认；Agent 接口不能代替主人批准配置变更。',
      };
    }
    delete session.pendingApproval;
    this._save(session);
    const gatewaySetup = this.options.gatewaySetup || require('./gateway-setup');
    const task = gatewaySetup.startSetup(provider, session.provider?.instanceId, this.db ? dbConfigAdapter(this.db) : null);
    session.configurationTaskId = task.taskId;
    this._save(session);
    return { success: true, registrationId: session.id, status: 'configuration_started', ...task };
  }

  configurationStatus(id, taskId) {
    const session = this._get(id);
    if (!taskId || taskId !== session.configurationTaskId) {
      return { success: false, error: '配置任务不属于当前注册会话' };
    }
    const gatewaySetup = this.options.gatewaySetup || require('./gateway-setup');
    const task = gatewaySetup.getTask(taskId);
    if (!task) return { success: false, error: '配置任务不存在或已过期' };
    if (task.done && task.ok) {
      const configuredMode = session.provider?.type === 'openclaw' ? 'websocket'
        : session.provider?.type === 'hermes' ? 'http' : null;
      if (configuredMode) {
        session.deliveryModes = session.deliveryModes.map((mode) => mode.mode === configuredMode
          ? { ...mode, status: 'ready', selected: true, action: 'test' }
          : mode);
        this._save(session);
      }
    }
    return { success: true, logs: task.logs, done: task.done, ok: task.ok, error: task.error || null };
  }

  preflightDelivery(id, input = {}) {
    const session = this._get(id);
    const mode = cleanText(input.mode, 40);
    const provider = session.provider?.type || 'others';
    const hasCommand = this.options.commandAvailable || commandAvailable;
    let ready = false;
    let detail = '';
    if (mode === 'pull') {
      ready = true;
      detail = '主动获取始终可用';
    } else if (mode === 'cli'
      || (provider === 'opencode' && (mode === 'acp' || mode === 'attach'))
      || ((provider === 'github-copilot' || provider === 'cursor') && mode === 'acp')
      || (provider === 'cline' && mode === 'acp')
      || (provider === 'zeroclaw' && (mode === 'acp' || mode === 'acp_ws'))) {
      const command = provider === 'openclaw'
        ? 'openclaw'
        : provider === 'hermes'
          ? 'hermes'
          : provider === 'zeroclaw'
            ? resolveZeroClawCommand()
            : provider === 'cursor'
              ? resolveCursorCommand()
              : (CLI_COMMANDS[provider] || provider);
      if (provider === 'zeroclaw') {
        const status = mode === 'acp_ws'
          ? zeroclawWsReadiness(session.provider?.instanceId)
          : zeroclawReadiness(session.provider?.instanceId);
        ready = status.ready;
        detail = status.detail;
      } else {
        ready = path.isAbsolute(command) ? fs.existsSync(command) : hasCommand(command);
        detail = ready ? `${command} CLI 可用` : `${command} CLI 不可用`;
      }
    } else if ((provider === 'openclaw' && mode === 'websocket') || (provider === 'hermes' && mode === 'http')) {
      const status = (this.options.gatewaySetup || require('./gateway-setup'))
        .checkGateway(provider, this.db ? dbConfigAdapter(this.db) : null);
      ready = !!status.ready;
      detail = status.detail || '';
    } else {
      return { success: false, error: '该 Provider 不支持此消息通道' };
    }
    const readinessStatus = mode === 'pull'
      ? 'ready'
      : ready
        ? 'preflight_passed'
        : (session.deliveryModes.find((item) => item.mode === mode)?.status === 'configuration_required'
          ? 'configuration_required'
          : 'unavailable');
    session.deliveryModes = session.deliveryModes.map((item) =>
      item.mode === mode ? { ...item, status: readinessStatus, lastPreflight: { ok: ready, detail, at: now() } } : item);
    this._save(session);
    return { success: true, registrationId: session.id, mode, ready, status: readinessStatus, detail, sideEffects: false };
  }

  async loopbackTest(id, input = {}) {
    const session = this._get(id);
    if (input.acknowledgeCost !== true) {
      return {
        success: false,
        code: 'LOOPBACK_CONFIRMATION_REQUIRED',
        error: '真实闭环测试可能产生模型费用和本地测试会话，必须明确 acknowledgeCost=true',
        nextAction: { type: 'confirm_loopback_test', required: ['registrationId', 'mode', 'acknowledgeCost'] },
      };
    }
    if (typeof this.options.runLoopbackTest !== 'function') {
      return { success: false, code: 'LOOPBACK_UNAVAILABLE', error: '当前 Provider 尚未提供安全的真实闭环测试' };
    }
    const mode = cleanText(input.mode, 40);
    const challenge = `voko-${crypto.randomBytes(12).toString('hex')}`;
    const tested = await this.options.runLoopbackTest({
      agentId: session.result?.agentId || null,
      provider: session.provider,
      mode,
      challenge,
      acknowledgeCost: true,
    });
    const verified = tested?.success === true && tested?.challengeMatched === true;
    session.deliveryModes = session.deliveryModes.map((item) => item.mode === mode
      ? { ...item, status: verified ? 'loopback_verified' : 'failed', lastLoopback: { ok: verified, at: now() } }
      : item);
    this._save(session);
    return {
      success: verified,
      registrationId: session.id,
      mode,
      status: verified ? 'loopback_verified' : 'failed',
      detail: cleanText(tested?.detail, 500),
      mayCreateModelCost: true,
    };
  }

  async cleanupLoopback(id, input = {}) {
    const session = this._get(id);
    if (typeof this.options.cleanupLoopbackSession !== 'function') {
      return { success: true, registrationId: session.id, cleaned: false };
    }
    const cleaned = await this.options.cleanupLoopbackSession({
      agentId: session.result?.agentId || null,
      provider: session.provider,
      mode: cleanText(input.mode, 40),
    });
    return { success: cleaned?.success !== false, registrationId: session.id, cleaned: cleaned?.cleaned === true };
  }

  async complete(id, input = {}) {
    const session = this._get(id);
    if (session.status === 'created') return this.view(session);
    if (!session.basicInfo || !session.provider) return { success: false, error: '注册信息不完整' };
    session.accessMode = input.accessMode === 'public' ? 'public' : 'private';
    const completeAgent = this.options.completeAgent;
    if (typeof completeAgent !== 'function') return { success: false, error: 'Agent 创建服务未就绪' };
    const result = await completeAgent({
      email: session.email,
      agentName: session.basicInfo.agentName,
      description: session.basicInfo.description,
      category: session.basicInfo.category,
      backendType: session.provider.type,
      instanceId: session.provider.instanceId,
      deliveryModes: session.deliveryModes.filter((mode) => mode.selected).map((mode) => mode.mode),
      accessMode: session.accessMode,
    });
    if (!result?.success) return result || { success: false, error: '创建 Agent 失败' };
    const selected = session.deliveryModes.filter((mode) => mode.selected);
    session.result = {
      creationStatus: 'created',
      agentId: result.agentId,
      agentName: result.agentName || session.basicInfo.agentName,
      description: session.basicInfo.description,
      category: session.basicInfo.category,
      ownerEmail: session.email,
      accessMode: result.accessMode || session.accessMode,
      provider: session.provider,
      deliveryOrder: selected.map((mode, index) => ({
        mode: mode.mode,
        label: mode.label,
        priority: index + 1,
        role: mode.mode === 'pull' ? (selected.length === 1 ? 'only' : 'final_fallback') : (index === 0 ? 'primary' : 'fallback'),
      })),
      deliveryReadiness: session.deliveryModes.map((mode) => ({
        mode: mode.mode,
        label: mode.label,
        selected: !!mode.selected,
        status: mode.status || 'unavailable',
        detail: mode.lastPreflight?.detail || null,
      })),
      unresolvedConfiguration: session.deliveryModes
        .filter((mode) => mode.mode !== 'pull' && ['configuration_required', 'unavailable', 'failed'].includes(mode.status))
        .map((mode) => ({ mode: mode.mode, status: mode.status || 'unavailable' })),
    };
    session.warnings = [{
      code: 'EXTERNAL_CHAT_SECURITY',
      message: '外部访客可以通过该 Agent 直接对话，请做好角色隔离、提示词攻击等安全防护。',
    }];
    session.status = 'created';
    return this._save(session);
  }

  async manage(input = {}) {
    const action = cleanText(input.action, 40) || 'status';
    try {
      if (action === 'start') return await this.start(input);
      // Explicit state-machine dispatch; verifyEmail still validates the server-issued registration ID and code.
      if (action === 'verify_email') return await this.verifyEmail(input.registrationId, input.code);
      if (action === 'set_basic_info') return this.setBasicInfo(input.registrationId, input);
      if (action === 'inspect_environment') {
        if (input.registrationId) {
          const session = this._get(input.registrationId);
          session.environment = this.inspectEnvironment();
          return this._save(session);
        }
        return { success: true, environment: this.inspectEnvironment() };
      }
      if (action === 'select_provider') return this.selectProvider(input.registrationId, input);
      if (action === 'select_delivery') return this.selectDelivery(input.registrationId, input);
      if (action === 'configure_delivery') return this.configureDelivery(input.registrationId, input);
      if (action === 'configuration_status') return this.configurationStatus(input.registrationId, input.taskId);
      if (action === 'preflight_delivery' || action === 'test_delivery') return this.preflightDelivery(input.registrationId, input);
      if (action === 'loopback_test') return await this.loopbackTest(input.registrationId, input);
      if (action === 'cleanup_loopback') return await this.cleanupLoopback(input.registrationId, input);
      if (action === 'complete') return await this.complete(input.registrationId, input);
      if (action === 'status') return this.view(input.registrationId);
      return { success: false, error: '不支持的注册 action' };
    } catch (error) {
      return { success: false, error: error.message, code: error.code || 'REGISTRATION_ERROR' };
    }
  }
}

function createRegistrationOrchestrator(options = {}) {
  if (!options.db || (typeof options.db !== 'object' && typeof options.db !== 'function')) {
    return new RegistrationOrchestrator(options);
  }
  let service = services.get(options.db);
  if (!service) {
    service = new RegistrationOrchestrator(options);
    services.set(options.db, service);
  } else {
    service.configure(options);
  }
  return service;
}

module.exports = {
  RegistrationOrchestrator,
  createRegistrationOrchestrator,
  detectCurrentAgentInstance,
  detectCurrentAgentType,
  currentAgentTypeFromEnvironment,
  currentAgentTypeFromProcessRows,
};
