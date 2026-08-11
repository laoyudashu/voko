export {};

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { SCHEMA_VERSION } = require('./database');
const { normalizeBackendType } = require('./agent-backend-types');
const { readInstanceMetadata, isInstanceAlive } = require('./process-lifecycle');
const { AgentRuntimeResolver } = require('./runtime/agent-runtime-resolver');
const { getRoutingFeaturePolicy, isRoutingFeatureEnabled, PRECISE_ROUTING_GREY_PROVIDERS } = require('./provider-routing');
const { resolveHermesCommand } = require('./dispatcher/hermes-command');
const { getProviderFamily, getProviderVersionCommand } = require('./dispatcher/provider-catalog');
const { evaluateProviderSandbox, probeProviderVersion } = require('./provider-sandbox');
const { inspectMcpConfigs, migrateMcpConfigs } = require('./mcp-config-diagnostics');
const ENDPOINTS = require('../endpoints.json');

const MIN_NODE_VERSION = '22.5.0';
const CHECK_TIMEOUT_MS = 2500;

const CLI_RUNTIME_CANDIDATES: Record<string, any[]> = {
  hermes: [{ kind: 'native', command: resolveHermesCommand() }],
  goose: [{ kind: 'native', command: process.platform === 'win32' ? 'goose.exe' : 'goose' }],
  'acp-goose': [{ kind: 'native', command: process.platform === 'win32' ? 'goose.exe' : 'goose' }],
  cline: [
    { kind: 'node-package-bin', command: 'cline', packageName: 'cline' },
    { kind: 'native', command: 'cline' },
  ],
  codex: [{ kind: 'native', command: 'codex' }],
  gemini: [{ kind: 'native', command: 'gemini' }],
  cursor: [
    { kind: 'native', command: 'cursor-agent' },
    { kind: 'native', command: 'agent' },
    { kind: 'native', command: 'cursor' },
  ],
  opencode: [{ kind: 'native', command: 'opencode' }],
  'github-copilot': [{ kind: 'native', command: 'copilot' }],
  zeroclaw: [{ kind: 'native', command: 'zeroclaw' }],
  pi: [{ kind: 'native', command: 'pi' }],
  'qwen-code': [{ kind: 'native', command: 'qwen' }],
  kiro: [{ kind: 'native', command: 'kiro-cli' }],
  aider: [{ kind: 'native', command: 'aider' }],
  openhands: [{ kind: 'native', command: process.platform === 'win32' ? 'openhands.exe' : 'openhands' }],
  grok: [{ kind: 'native', command: 'grok' }],
};

function parseJson(value: unknown, fallback: any = null): any {
  if (typeof value !== 'string') return value ?? fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function versionParts(version: string): number[] {
  return String(version || '').split('.').slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
}

function versionAtLeast(version: string, minimum: string): boolean {
  const actual = versionParts(version);
  const expected = versionParts(minimum);
  for (let i = 0; i < 3; i += 1) {
    if (actual[i] !== expected[i]) return actual[i] > expected[i];
  }
  return true;
}

function addCheck(checks: any[], id: string, label: string, status: string, detail: string, data: any = undefined): void {
  const check: any = { id, label, status, detail };
  if (data !== undefined) check.data = data;
  checks.push(check);
}

function getConfigRow(db: any, type: string): any | null {
  try { return db.prepare('SELECT data, updated_at FROM config WHERE type=? LIMIT 1').get(type) || null; } catch { return null; }
}

function readAgents(db: any): any[] {
  try {
    return db.prepare(`
      SELECT agent_id, agent_name, backend_type, backend_instance_id,
             delivery_modes, publish_status, imUid
      FROM agents ORDER BY agent_id
    `).all();
  } catch { return []; }
}

function parseDeliveryModes(value: unknown): { modes: string[] | null; invalid: boolean } {
  if (value === null || value === undefined || value === '') return { modes: null, invalid: false };
  const parsed = parseJson(value, undefined);
  if (!Array.isArray(parsed)) return { modes: null, invalid: true };
  return { modes: parsed.map((mode) => String(mode).trim()).filter(Boolean), invalid: false };
}

function safePathInfo(dbPath: string): any {
  try {
    const stat = fs.statSync(dbPath);
    return { path: path.resolve(dbPath), sizeBytes: stat.size, modifiedAt: stat.mtimeMs };
  } catch {
    return { path: path.resolve(dbPath), sizeBytes: null, modifiedAt: null };
  }
}

function inspectDatabase(dbPath: string, checks: any[]): { db: any | null; agents: any[]; runtime: any; config: Record<string, any> } {
  const info = safePathInfo(dbPath);
  if (!fs.existsSync(dbPath)) {
    addCheck(checks, 'database', 'Database', 'error', `not found: ${info.path}`, info);
    return { db: null, agents: [], runtime: {}, config: {} };
  }

  let db: any = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row: any) => row.name);
    const schemaRow = getConfigRow(db, 'schema_version');
    const schemaFromConfig = Number(parseJson(schemaRow?.data, schemaRow?.data)) || 0;
    let schemaFromPragma = 0;
    try { schemaFromPragma = Number(db.prepare('PRAGMA user_version').get()?.user_version || 0); } catch {}
    const schemaVersion = Math.max(schemaFromConfig, schemaFromPragma);
    addCheck(checks, 'database', 'Database', 'ok', `readable: ${info.path}`, {
      ...info, tableCount: tables.length, schemaVersion,
    });

    if (schemaVersion > SCHEMA_VERSION) {
      addCheck(checks, 'schema', 'Schema', 'error', `database schema ${schemaVersion} is newer than supported ${SCHEMA_VERSION}`, { schemaVersion, supported: SCHEMA_VERSION });
    } else if (schemaVersion < SCHEMA_VERSION) {
      addCheck(checks, 'schema', 'Schema', 'warn', `migration pending: database ${schemaVersion || 'unknown'} → supported ${SCHEMA_VERSION}`, { schemaVersion, supported: SCHEMA_VERSION });
    } else {
      addCheck(checks, 'schema', 'Schema', 'ok', `schema ${SCHEMA_VERSION}`);
    }

    if (!tables.includes('agents') || !tables.includes('config')) {
      addCheck(checks, 'tables', 'Core tables', 'error', 'agents/config table is missing', { tables });
    } else {
      addCheck(checks, 'tables', 'Core tables', 'ok', 'agents and config are present');
    }

    if (tables.includes('provider_routing_conversations') && tables.includes('provider_message_routes')) {
      try {
        const conversations = Number(db.prepare('SELECT COUNT(*) AS c FROM provider_routing_conversations').get()?.c || 0);
        const activeRoutes = Number(db.prepare("SELECT COUNT(*) AS c FROM provider_message_routes WHERE status='active'").get()?.c || 0);
        const preciseEnabled = /^(1|true|yes|on)$/i.test(String(process.env.VOKO_PRECISE_REPLY_ROUTING_V1 || ''));
        addCheck(checks, 'provider-routing', 'Provider routing', 'ok',
          `${conversations} conversation(s), ${activeRoutes} active route(s), precise Push ${preciseEnabled ? 'enabled' : 'gated'}`,
          { conversations, activeRoutes, precisePushEnabled: preciseEnabled });
      } catch (error: any) {
        addCheck(checks, 'provider-routing', 'Provider routing', 'warn', `inspection unavailable: ${error.message}`);
      }
    }

    try {
      const quickCheck = db.prepare('PRAGMA quick_check').get()?.quick_check;
      addCheck(checks, 'integrity', 'SQLite integrity', quickCheck === 'ok' ? 'ok' : 'error', String(quickCheck || 'unknown'));
    } catch (error: any) {
      addCheck(checks, 'integrity', 'SQLite integrity', 'warn', `check unavailable: ${error.message}`);
    }

    const config: Record<string, any> = {};
    for (const type of ['current_user_email', 'user_access_token', 'hermes_config', 'oss_config', 'runtime', 'agent_access_sync_cursors']) {
      const row = getConfigRow(db, type);
      if (row) config[type] = { value: parseJson(row.data, row.data), updatedAt: row.updated_at || null };
    }
    const agents = readAgents(db);
    const runtime = parseJson(config.runtime?.value, {}) || {};
    return { db, agents, runtime, config };
  } catch (error: any) {
    addCheck(checks, 'database', 'Database', 'error', `cannot read: ${error.message}`, info);
    try { db?.close(); } catch {}
    return { db: null, agents: [], runtime: {}, config: {} };
  }
}

function inspectAuthentication(config: Record<string, any>, checks: any[]): void {
  const emailValue = config.current_user_email?.value;
  const email = typeof emailValue === 'string' ? emailValue.trim() : '';
  const tokenConfigured = config.user_access_token?.value !== undefined && config.user_access_token?.value !== null;
  if (email && tokenConfigured) {
    addCheck(checks, 'authentication', 'Authentication', 'ok', `configured for ${email}`);
  } else if (!email && !tokenConfigured) {
    addCheck(checks, 'authentication', 'Authentication', 'warn', 'not configured; run voko login');
  } else {
    addCheck(checks, 'authentication', 'Authentication', 'warn', 'partial credentials; run voko login again');
  }
}

function inspectAgents(agents: any[], runtime: any, config: Record<string, any>, checks: any[]): void {
  if (agents.length === 0) {
    addCheck(checks, 'agents', 'Agents', 'warn', 'no Agent is registered');
    addCheck(checks, 'delivery', 'Delivery modes', 'warn', 'no Agent delivery configuration to inspect');
    return;
  }

  const backends = new Set<string>();
  let invalidModes = 0;
  let pullOnly = 0;
  for (const agent of agents) {
    const backend = normalizeBackendType(agent.backend_type || 'others');
    backends.add(backend);
    const parsed = parseDeliveryModes(agent.delivery_modes);
    if (parsed.invalid) invalidModes += 1;
    if (parsed.modes?.length === 1 && parsed.modes[0] === 'pull') pullOnly += 1;
  }
  addCheck(checks, 'agents', 'Agents', 'ok', `${agents.length} registered (${[...backends].sort().join(', ') || 'unknown backend'})`, {
    count: agents.length,
    backends: [...backends].sort(),
  });
  if (invalidModes > 0) {
    addCheck(checks, 'delivery', 'Delivery modes', 'warn', `${invalidModes} Agent row(s) have invalid delivery_modes JSON`);
  } else if (pullOnly === agents.length) {
    addCheck(checks, 'delivery', 'Delivery modes', 'ok', `all ${agents.length} Agent(s) use MCP Pull/on-demand`);
  } else {
    addCheck(checks, 'delivery', 'Delivery modes', 'ok', `${agents.length - pullOnly}/${agents.length} Agent(s) have Push-capable configuration`);
  }

  const runtimeAgents = Array.isArray(runtime.agents) ? runtime.agents : [];
  if (runtimeAgents.length > 0) {
    const imConnected = runtimeAgents.filter((agent: any) => agent.imConnected).length;
    const automaticReady = runtimeAgents.filter((agent: any) => agent.automaticDeliveryReady || agent.deliveryStatus?.automaticDeliveryReady).length;
    const runtimePullOnly = runtimeAgents.filter((agent: any) => {
      const delivery = agent.deliveryStatus || agent;
      return delivery.pullReady === true && delivery.automaticDeliveryReady !== true;
    }).length;
    const status = imConnected === runtimeAgents.length ? 'ok' : 'warn';
    addCheck(checks, 'runtime-agents', 'Runtime Agent status', status, `IM ${imConnected}/${runtimeAgents.length}, automatic delivery ${automaticReady}/${runtimeAgents.length}, Pull-only ${runtimePullOnly}`, {
      imConnected, automaticReady, pullOnly: runtimePullOnly, agents: runtimeAgents.map((agent: any) => ({
        agentId: agent.agentId,
        imConnected: !!agent.imConnected,
        activeAutomaticMode: agent.activeAutomaticMode || agent.deliveryStatus?.activeAutomaticMode || null,
        automaticReadyModes: agent.automaticReadyModes || agent.deliveryStatus?.automaticReadyModes || [],
        pullReady: agent.pullReady ?? agent.deliveryStatus?.pullReady ?? true,
      })),
    });
  }

  if (config.agent_access_sync_cursors) {
    addCheck(checks, 'legacy-cursors', 'Legacy cursors', 'warn', 'legacy config cursor data is still present; sync_checkpoints is the active store');
  }
}

function inspectRuntime(dbPath: string, runtime: any, checks: any[], deps: any): { running: boolean; port: number | null } {
  let instance: any = null;
  try { instance = (deps.readInstanceMetadata || readInstanceMetadata)(dbPath); } catch {}
  let running = false;
  try { running = !!(instance && (deps.isInstanceAlive || isInstanceAlive)(instance)); } catch {}
  const port = Number(instance?.port || runtime?.port || 0) || null;
  if (running) {
    addCheck(checks, 'runtime', 'VOKO runtime', port ? 'ok' : 'warn', port ? `running (PID ${instance.pid}, port ${port})` : `running (PID ${instance.pid}), port unknown`, {
      running: true, pid: instance.pid, port, instanceId: instance.instanceId || null, version: require('../../package.json').version,
    });
  } else {
    addCheck(checks, 'runtime', 'VOKO runtime', 'warn', 'not running; start with voko start', { running: false, port: null, instanceId: null, version: null });
  }
  return { running, port };
}

async function fetchWithTimeout(fetchImpl: any, url: string, init: any = {}): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function inspectLocalHealth(port: number | null, checks: any[], fetchImpl: any): Promise<void> {
  if (!port) return;
  try {
    const response = await fetchWithTimeout(fetchImpl, `http://127.0.0.1:${port}/health`);
    if (response.ok) addCheck(checks, 'local-health', 'Local health endpoint', 'ok', `HTTP ${response.status}`);
    else addCheck(checks, 'local-health', 'Local health endpoint', 'warn', `HTTP ${response.status}`);
  } catch (error: any) {
    addCheck(checks, 'local-health', 'Local health endpoint', 'warn', `unreachable: ${error.message}`);
  }
}

async function inspectDeepNetwork(checks: any[], fetchImpl: any): Promise<void> {
  const targets = [
    ['remote-api', 'Remote API', ENDPOINTS.api?.baseUrl, 'GET'],
    ['im-api', 'IM service', ENDPOINTS.im?.baseUrl, 'GET'],
    ['oss', 'OSS public endpoint', ENDPOINTS.oss?.publicUrl, 'HEAD'],
  ];
  await Promise.all(targets.map(async ([id, label, baseUrl, method]) => {
    if (!baseUrl) {
      addCheck(checks, id, label, 'warn', 'endpoint is not configured');
      return;
    }
    try {
      const response = await fetchWithTimeout(fetchImpl, `${String(baseUrl).replace(/\/$/, '')}/health`, { method });
      const reachable = Number(response.status) < 500;
      addCheck(checks, id, label, reachable ? 'ok' : 'warn', `HTTP ${response.status}`, { url: baseUrl });
    } catch (error: any) {
      addCheck(checks, id, label, 'warn', `unreachable: ${error.message}`, { url: baseUrl });
    }
  }));
}

function inspectProviderRuntimes(agents: any[], checks: any[]): void {
  const configured = [...new Set(agents.map((agent: any) => normalizeBackendType(agent.backend_type || 'others')))]
    .filter((backend) => CLI_RUNTIME_CANDIDATES[backend]);
  if (configured.length === 0) {
    addCheck(checks, 'provider-runtime', 'Provider runtimes', 'skip', 'no CLI/ACP runtime requires local resolution');
    return;
  }
  const resolver = new AgentRuntimeResolver();
  const results = configured.map((backend) => {
    const resolved = resolver.resolve({
      providerId: `doctor-${backend}`,
      mode: 'cli',
      candidates: CLI_RUNTIME_CANDIDATES[backend],
    });
    return {
      backend,
      available: !!resolved.available,
      runtimeKind: resolved.runtimeKind || null,
      resolvedEntry: resolved.canonicalPath ? path.basename(resolved.canonicalPath) : null,
      spawnEnvironmentReady: !!resolved.available && (process.platform === 'win32' || resolved.pathEntries.length > 0),
      reason: resolved.reasonCode || null,
    };
  });
  const missing = results.filter((item) => !item.available);
  if (missing.length === 0) {
    addCheck(checks, 'provider-runtime', 'Provider runtimes', 'ok', `${results.length} configured CLI/ACP runtime(s) resolved`, { runtimes: results });
  } else {
    addCheck(checks, 'provider-runtime', 'Provider runtimes', 'warn', `${missing.map((item) => item.backend).join(', ')} not found on PATH; Push may fall back to Pull`, { runtimes: results });
  }
}

function inspectGooseDelivery(agents: any[], checks: any[]): void {
  const gooseAgents = agents.filter((agent: any) => ['goose', 'acp-goose'].includes(normalizeBackendType(agent.backend_type)));
  if (gooseAgents.length === 0) return;
  const resolver = new AgentRuntimeResolver();
  const runtimeAvailable = !!resolver.resolve({
    providerId: 'doctor-goose-delivery', mode: 'cli', candidates: CLI_RUNTIME_CANDIDATES.goose,
  }).available;
  const rows = gooseAgents.map((agent: any) => {
    const backend = normalizeBackendType(agent.backend_type);
    const parsed = parseDeliveryModes(agent.delivery_modes);
    const configuredModes = parsed.modes || (backend === 'acp-goose' ? ['acp', 'cli', 'pull'] : ['cli', 'pull']);
    const activePushMode = runtimeAvailable ? configuredModes.find((mode) => mode !== 'pull') || null : null;
    return { agentId: agent.agent_id, backend, configuredModes, runtimeAvailable, activePushMode };
  });
  const ready = rows.filter((row) => row.activePushMode).length;
  addCheck(checks, 'goose-delivery', 'Goose delivery', ready === rows.length ? 'ok' : 'warn',
    `${ready}/${rows.length} Goose Agent(s) have configured runtime and active Push`, { agents: rows });
}

function inspectProviderSandbox(agents: any[], db: any, checks: any[], options: any): void {
  const rows: any[] = [];
  let dockerAvailable: boolean | null = null;
  if (options.deep) {
    if (typeof options.deps?.sandboxRuntimeAvailable === 'function') {
      try { dockerAvailable = !!options.deps.sandboxRuntimeAvailable('docker_or_podman'); } catch { dockerAvailable = false; }
    } else {
      try {
        const { execFileSync } = require('node:child_process');
        execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
          stdio: 'ignore', windowsHide: true, timeout: CHECK_TIMEOUT_MS,
        });
        dockerAvailable = true;
      } catch { dockerAvailable = false; }
    }
  }
  for (const agent of agents) {
    const backend = normalizeBackendType(agent.backend_type || 'others');
    const family = getProviderFamily(backend);
    const configuredModes = parseDeliveryModes(agent.delivery_modes).modes || family?.defaultDeliveryModes || ['pull'];
    if (!family) {
      rows.push({ provider: backend, transport: null, platform: process.platform, effective: false,
        status: 'unknown', degradedReason: 'PROVIDER_NOT_IN_CATALOG' });
      continue;
    }
    for (const mode of configuredModes) {
      if (mode === 'pull') {
        rows.push({ provider: family.type, transport: 'pull', platform: process.platform, effective: false,
          status: 'not_applicable', dimensions: {
            filesystem: 'not_applicable', network: 'not_applicable', commandExecution: 'not_applicable',
            workingDirectory: 'not_applicable', humanApproval: 'not_applicable',
          }, verification: ['static'], degradedReason: null });
        continue;
      }
      const transports = family.transports.filter((transport: any) => transport.mode === mode);
      if (!transports.length) {
        rows.push({ provider: family.type, transport: mode, platform: process.platform, effective: false,
          status: 'unknown', degradedReason: 'TRANSPORT_NOT_IN_CATALOG' });
      }
      for (const transport of transports) {
        const versionProbe = options.deep && getProviderVersionCommand(transport.id)
          ? probeProviderVersion(getProviderVersionCommand(transport.id))
          : null;
        rows.push(evaluateProviderSandbox({ db, providerFamily: family.type, transportId: transport.id,
          policyId: transport.sandboxPolicyId, platform: process.platform,
          providerVersion: versionProbe?.version || null,
          providerVersionSource: versionProbe?.source || 'unknown',
          providerVersionObservedAt: versionProbe?.observedAt || null,
          providerVersionProbe: versionProbe,
          runtimeAvailable: transport.sandboxPolicyId === 'gemini-container' ? dockerAvailable : null }));
      }
    }
  }
  const unique = [...new Map(rows.map((row) => [`${row.provider}:${row.transport}:${row.platform}`, row])).values()];
  if (!unique.length) {
    addCheck(checks, 'provider-sandbox', 'Provider sandbox', 'skip', 'no configured Provider transport to inspect');
    return;
  }
  const applicable = unique.filter((row: any) => row.status !== 'not_applicable');
  const effective = applicable.filter((row: any) => row.effective).length;
  const degraded = applicable.filter((row: any) => !row.effective || !!row.degradedReason || row.versionState !== 'known');
  addCheck(checks, 'provider-sandbox', 'Provider sandbox', degraded.length ? 'warn' : 'ok',
    `${effective}/${applicable.length} automatic transport capability profile(s) active; ${degraded.length} partial, degraded or unverified`, {
      transports: unique,
    });
}

function inspectRoutingFeatures(db: any, checks: any[]): void {
  const defaults = { providerFamilies: [...PRECISE_ROUTING_GREY_PROVIDERS], channelTypes: [1], contentTypes: [1] };
  const precise = getRoutingFeaturePolicy(db, 'precise_reply_routing_v1', defaults);
  const pull = getRoutingFeaturePolicy(db, 'session_scoped_pull_v1', defaults);
  const shadow = isRoutingFeatureEnabled(db, 'routing_conversation_shadow_v1', true);
  const web = {
    privateConversations: isRoutingFeatureEnabled(db, 'web_private_conversations_v1', true),
    groupPreciseReply: isRoutingFeatureEnabled(db, 'web_group_precise_reply_v1', true),
    interventionPreciseRoute: isRoutingFeatureEnabled(db, 'web_intervention_precise_route_v1', true),
  };
  addCheck(checks, 'provider-routing-rollout', 'Provider message routing rollout', 'ok',
    `shadow=${shadow ? 'on' : 'off'}, precise=${precise.enabled ? 'grey' : 'off'}, sessionPull=${pull.enabled ? 'grey' : 'off'}, web=${Object.values(web).every(Boolean) ? 'on' : 'partial'}`, {
      shadow,
      precise: { enabled: precise.enabled, providerFamilies: precise.providerFamilies,
        channelTypes: precise.channelTypes, contentTypes: precise.contentTypes },
      sessionPull: { enabled: pull.enabled, providerFamilies: pull.providerFamilies },
      web,
    });
}

function inspectMcpConfigFiles(options: any, checks: any[]): any {
  const report = inspectMcpConfigs({
    paths: options.mcpConfigPaths,
    homeDir: options.homeDir,
    appData: options.appData,
    platform: options.platform,
  });
  if (report.clients.length === 0) {
    addCheck(checks, 'mcp-config', 'MCP client configuration', 'skip', 'no known MCP client configuration file was found', report);
  } else if (report.clients.some((client: any) => client.status === 'warn')) {
    const affected = report.clients.filter((client: any) => client.status === 'warn').map((client: any) => client.client);
    addCheck(checks, 'mcp-config', 'MCP client configuration', 'warn', `${affected.join(', ')} has VOKO configuration requiring review`, report);
  } else {
    addCheck(checks, 'mcp-config', 'MCP client configuration', 'ok', `${report.clients.length} known MCP configuration file(s) checked`, report);
  }
  return report;
}

function summarize(checks: any[], startedAt: number, options: any): any {
  const counts = checks.reduce((summary: any, check: any) => {
    summary[check.status] = (summary[check.status] || 0) + 1;
    return summary;
  }, {});
  const errors = counts.error || 0;
  const warnings = counts.warn || 0;
  return {
    success: errors === 0,
    healthy: errors === 0 && warnings === 0,
    exitCode: errors > 0 ? 2 : warnings > 0 ? 1 : 0,
    version: require('../../package.json').version,
    node: process.versions.node,
    platform: process.platform,
    deep: !!options.deep,
    durationMs: Date.now() - startedAt,
    summary: { passed: counts.ok || 0, warnings, errors, skipped: counts.skip || 0 },
    checks,
  };
}

async function runDoctor(options: any = {}): Promise<any> {
  const startedAt = Date.now();
  const checks: any[] = [];
  const dbPath = String(options.dbPath || process.env.VOKO_DB_PATH || '');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const deps = options.deps || {};
  const nodeVersion = String(options.nodeVersion || process.versions.node);

  addCheck(checks, 'node', 'Node.js', versionAtLeast(nodeVersion, MIN_NODE_VERSION) ? 'ok' : 'error', `${nodeVersion} (minimum ${MIN_NODE_VERSION})`, { version: nodeVersion, minimum: MIN_NODE_VERSION });
  let mcpMigration: any = null;
  if (options.fixMcp) {
    mcpMigration = migrateMcpConfigs({
      paths: options.mcpConfigPaths,
      homeDir: options.homeDir,
      appData: options.appData,
      platform: options.platform,
    });
    addCheck(
      checks,
      'mcp-migration',
      'MCP configuration migration',
      mcpMigration.errors > 0 ? 'warn' : 'ok',
      mcpMigration.changed > 0
        ? `updated ${mcpMigration.changed} configuration file(s); backups were created`
        : 'no unambiguous legacy VOKO configuration was changed',
      mcpMigration,
    );
  }
  inspectMcpConfigFiles(options, checks);
  const inspected = inspectDatabase(dbPath, checks);
  if (inspected.db) {
    inspectAuthentication(inspected.config, checks);
    inspectAgents(inspected.agents, inspected.runtime, inspected.config, checks);
    inspectRoutingFeatures(inspected.db, checks);
    inspectGooseDelivery(inspected.agents, checks);
    inspectProviderSandbox(inspected.agents, inspected.db, checks, options);
    const runtime = inspectRuntime(dbPath, inspected.runtime, checks, deps);
    if (runtime.running && typeof fetchImpl === 'function') await inspectLocalHealth(runtime.port, checks, fetchImpl);
    if (options.deep) {
      await inspectDeepNetwork(checks, fetchImpl);
      inspectProviderRuntimes(inspected.agents, checks);
    }
    try { inspected.db.close(); } catch {}
  } else if (options.deep) {
    addCheck(checks, 'deep', 'Deep checks', 'skip', 'database is unavailable; skipped Agent-dependent probes');
    if (typeof fetchImpl === 'function') await inspectDeepNetwork(checks, fetchImpl);
  }
  const result = summarize(checks, startedAt, options);
  result.dbPath = dbPath;
  if (mcpMigration) result.mcpMigration = mcpMigration;
  return result;
}

function statusIcon(status: string): string {
  return ({ ok: '✅', warn: '⚠️', error: '❌', skip: '⏭️' } as Record<string, string>)[status] || '•';
}

function formatDoctor(result: any): string {
  const lines = [
    'VOKO Doctor',
    `Version ${result.version} | Node ${result.node} | ${result.platform}${result.deep ? ' | deep' : ''}`,
    `Database: ${result.dbPath || '(default path unavailable)'}`,
    '',
  ];
  for (const check of result.checks || []) lines.push(`${statusIcon(check.status)} ${check.label}: ${check.detail}`);
  lines.push('', `Summary: ${result.summary.passed} passed, ${result.summary.warnings} warnings, ${result.summary.errors} errors, ${result.summary.skipped} skipped`);
  if (result.exitCode === 0) lines.push('Result: healthy');
  else if (result.exitCode === 1) lines.push('Result: degraded; review warnings above');
  else lines.push('Result: not ready; fix errors above');
  return lines.join('\n');
}

module.exports = {
  MIN_NODE_VERSION,
  runDoctor,
  formatDoctor,
  versionAtLeast,
};
