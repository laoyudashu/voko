export type ProviderOperation = 'push' | 'steer';

export interface ProviderCapabilities {
  push: boolean;
  steer: boolean;
  streaming: boolean;
  asyncReply: boolean;
  sessionResume: boolean;
  cancel: boolean;
  pause: boolean;
  progress: boolean;
  toolCall: boolean;
  humanApproval: boolean;
}

export interface ProviderTransportDefinition {
  id: string;
  family?: string;
  mode: string;
  priority: number;
  operations: ProviderOperation[];
  modulePath: string;
  exportName?: string;
  safetyProfile: string;
  sandboxPolicyId: string;
  capabilities: ProviderCapabilities;
  exactSession?: {
    nativeSessionNamespace: string;
    restoreCompatibilityGroup: string;
  };
  owner?: {
    enabled: boolean;
    execution: 'chat_only' | 'workspace_write';
    isolation: 'voko_enforced' | 'provider_enforced' | 'advisory_only' | 'unsupported';
    platforms: Array<'win32' | 'linux' | 'darwin'>;
    exactSessionRecovery: boolean;
    safeCancellation: boolean;
    reliableNotDelivered: boolean;
    nativeIoBridge?: boolean;
  };
  create(context: ProviderFactoryContext): any;
  testOnly?: boolean;
  supportsLoopback?: boolean;
  preflight?: (provider: any, agentId: string) => Promise<unknown>;
  loopback?: (provider: any, agentId: string) => Promise<unknown>;
}

export interface ProviderFamilyDefinition {
  type: string;
  aliases: string[];
  label: string;
  requiresInstance: boolean;
  defaultDeliveryModes: string[];
  transports: ProviderTransportDefinition[];
  detect?: (context: { detectedTypes?: string[] }) => boolean;
  listInstances?: (context: { instances?: Record<string, Array<{ id: string; name?: string }>> }) => Array<{ id: string; name?: string }>;
  validateInstance?: (instanceId: string | null, instances: Array<{ id: string }>) => boolean;
}

export interface ProviderFactoryContext {
  db: unknown;
  contextWindow?: number;
  getProviderConfig?: (transportId: string) => Record<string, unknown> | null;
  /** Optional version supplied by a trusted runtime probe or a test fixture. */
  providerVersion?: string | null;
  providerVersionSource?: 'command' | 'runtime' | 'protocol' | 'config' | 'unknown';
  providerVersionObservedAt?: string | null;
  providerVersionVerified?: boolean;
  versionProbeCommand?: string | null;
}

// Version probes are read-only `--version` calls. Persistent transports without a
// stable local executable intentionally remain unknown until their protocol reports one.
const PROVIDER_VERSION_COMMANDS: Record<string, string> = {
  'goose-acp': 'goose', 'goose-cli': 'goose',
  'opencode-acp': 'opencode', 'opencode-attach': 'opencode', 'opencode-cli': 'opencode',
  'cursor-acp': 'cursor-agent', 'cursor-cli': 'cursor-agent',
  'cline-acp': 'cline', 'cline-cli': 'cline',
  'github-copilot-acp': 'copilot', 'github-copilot-cli': 'copilot',
  'zeroclaw-ws': 'zeroclaw', 'zeroclaw-acp': 'zeroclaw', 'zeroclaw-cli': 'zeroclaw',
  'claude-cli': 'claude', 'codex-cli': 'codex', 'gemini-cli': 'gemini',
  'pi-cli': 'pi', 'qwen-cli': 'qwen', 'kiro-cli': 'kiro-cli',
  'aider-cli': 'aider', 'grok-cli': 'grok', 'reasonix-cli': 'reasonix',
  'qwen-office-cli': 'qoderclicn', 'traecli-acp': 'traecli',
  'dumate-http': 'dumate-opencode',
  'workbuddy-http': 'codebuddy', 'codebuddy-acp': 'codebuddy',
  'deepseek-harness-cli': 'dsh',
};

export function getProviderVersionCommand(transportId: unknown): string | null {
  return PROVIDER_VERSION_COMMANDS[String(transportId || '').trim()] || null;
}

const capabilities = (input: Partial<ProviderCapabilities> = {}): ProviderCapabilities => ({
  push: true, steer: true, streaming: false, asyncReply: false, sessionResume: false,
  cancel: false, pause: false, progress: false, toolCall: false, humanApproval: false,
  ...input,
});

type TransportInput = Omit<ProviderTransportDefinition, 'capabilities' | 'create'> & {
  capabilities?: Partial<ProviderCapabilities>;
  create?: (context: ProviderFactoryContext) => any;
  options?: (context: ProviderFactoryContext) => Record<string, unknown>;
};

function transport(input: TransportInput): ProviderTransportDefinition {
  return {
    ...input,
    supportsLoopback: input.supportsLoopback === true,
    capabilities: capabilities(input.capabilities),
    create: input.create || ((context: ProviderFactoryContext) => {
      const loaded = require(input.modulePath);
      const Ctor = input.exportName ? loaded[input.exportName] : loaded;
      if (typeof Ctor !== 'function') throw new Error(`Provider transport factory unavailable: ${input.id}`);
      const scopedOptions = input.options?.(context) || {};
      const instance = new Ctor({ db: context.db, contextWindow: context.contextWindow ?? 20, ...scopedOptions });
      if (scopedOptions.sessionPersistence === 'dispatcher') instance.useDispatcherSessionPersistence?.();
      return instance;
    }),
  };
}

const cli = (id: string, modulePath: string, exportName?: string, sandboxPolicyId = 'cli-unverified'): ProviderTransportDefinition => transport({
  id, mode: 'cli', priority: 1, operations: ['push', 'steer'], modulePath, exportName,
  safetyProfile: 'restricted-cli', sandboxPolicyId, capabilities: { sessionResume: true },
  options: context => context.getProviderConfig?.(id) || {},
  supportsLoopback: true,
  exactSession: { nativeSessionNamespace: id, restoreCompatibilityGroup: id },
});
const acp = (id: string, modulePath: string, exportName?: string): ProviderTransportDefinition => transport({
  id, mode: 'acp', priority: 10, operations: ['push', 'steer'], modulePath, exportName,
  safetyProfile: 'isolated-acp', sandboxPolicyId: 'acp-deny-permission',
  capabilities: { streaming: true, sessionResume: true, cancel: true, progress: true, humanApproval: true },
  options: context => context.getProviderConfig?.(id) || {},
  supportsLoopback: true,
  exactSession: { nativeSessionNamespace: id, restoreCompatibilityGroup: id },
});

export const PROVIDER_CATALOG: ProviderFamilyDefinition[] = [
  { type: 'openclaw', aliases: [], label: 'OpenClaw', requiresInstance: true, defaultDeliveryModes: ['websocket', 'cli', 'pull'], transports: [
    transport({ id: 'openclaw-ws', mode: 'websocket', priority: 10, operations: ['push', 'steer'], modulePath: './providers/openclaw-ws', safetyProfile: 'local-authenticated-websocket', sandboxPolicyId: 'provider-managed-local', supportsLoopback: true, capabilities: { streaming: true, asyncReply: true, sessionResume: true }, exactSession: { nativeSessionNamespace: 'openclaw-ws', restoreCompatibilityGroup: 'openclaw-ws' }, create(context) { const Ctor = require('./providers/openclaw-ws'); return new Ctor(context.db, null); } }),
    { ...cli('openclaw-cli', './providers/openclaw-cli'), supportsLoopback: false },
  ] },
  { type: 'hermes', aliases: [], label: 'Hermes', requiresInstance: true, defaultDeliveryModes: ['http', 'cli', 'pull'], transports: [
    transport({ id: 'hermes-http', mode: 'http', priority: 10, operations: ['push', 'steer'], modulePath: './providers/hermes-http', safetyProfile: 'local-authenticated-http', sandboxPolicyId: 'provider-managed-local', supportsLoopback: true, capabilities: { asyncReply: true, sessionResume: true }, exactSession: { nativeSessionNamespace: 'hermes-http', restoreCompatibilityGroup: 'hermes-http' }, create(context) { const Ctor = require('./providers/hermes-http'); const config = context.getProviderConfig?.('hermes-http') || {}; return new Ctor(context.db, null, { host: config.apiHost || '127.0.0.1', port: config.apiPort || 8642, apiKey: config.apiKey || '', profiles: config.profiles || {} }); } }),
    { ...cli('hermes-cli', './providers/hermes-cli'), supportsLoopback: true, exactSession: undefined },
  ] },
  { type: 'zeroclaw', aliases: [], label: 'ZeroClaw', requiresInstance: true, defaultDeliveryModes: ['acp_ws', 'acp', 'cli', 'pull'], transports: [
    transport({ id: 'zeroclaw-ws', mode: 'acp_ws', priority: 20, operations: ['push', 'steer'], modulePath: './providers/zeroclaw-ws', exportName: 'ZeroClawWsProvider', safetyProfile: 'paired-acp-websocket', sandboxPolicyId: 'provider-managed-local', supportsLoopback: true, capabilities: { streaming: true, asyncReply: true, sessionResume: true, cancel: true, progress: true } }),
    acp('zeroclaw-acp', './providers/zeroclaw-acp', 'ZeroClawAcpProvider'),
    cli('zeroclaw-cli', './providers/zeroclaw-cli', 'ZeroClawCliProvider'),
  ] },
  { type: 'opencode', aliases: [], label: 'OpenCode', requiresInstance: false, defaultDeliveryModes: ['acp', 'attach', 'cli', 'pull'], transports: [
    acp('opencode-acp', './providers/opencode-acp', 'OpenCodeAcpProvider'),
    transport({ id: 'opencode-attach', mode: 'attach', priority: 5, operations: ['push', 'steer'], modulePath: './providers/opencode-attach', exportName: 'OpenCodeAttachProvider', safetyProfile: 'local-authenticated-http', sandboxPolicyId: 'provider-managed-local', capabilities: { streaming: true, sessionResume: true } }),
    cli('opencode-cli', './providers/opencode-cli', 'OpenCodeCliProvider'),
  ] },
  { type: 'github-copilot', aliases: [], label: 'GitHub Copilot CLI', requiresInstance: false, defaultDeliveryModes: ['acp', 'cli', 'pull'], transports: [
    acp('github-copilot-acp', './providers/github-copilot-acp', 'GitHubCopilotAcpProvider'),
    { ...cli('github-copilot-cli', './providers/github-copilot-cli', 'GitHubCopilotCliProvider', 'copilot-restricted'), exactSession: undefined },
  ] },
  { type: 'cursor', aliases: [], label: 'Cursor Agent', requiresInstance: false, defaultDeliveryModes: ['acp', 'cli', 'pull'], transports: [
    acp('cursor-acp', './providers/cursor-acp', 'CursorAcpProvider'), cli('cursor-cli', './providers/cursor-cli', 'CursorCliProvider', 'cursor-plan'),
  ] },
  { type: 'cline', aliases: [], label: 'Cline', requiresInstance: false, defaultDeliveryModes: ['acp', 'cli', 'pull'], transports: [
    acp('cline-acp', './providers/cline-acp', 'ClineAcpProvider'),
    { ...cli('cline-cli', './providers/cline-cli', 'ClineCliProvider', 'cline-command-deny'), exactSession: undefined },
  ] },
  { type: 'goose', aliases: ['goose-ai', 'acp-goose'], label: 'Goose', requiresInstance: false, defaultDeliveryModes: ['acp', 'cli', 'pull'], transports: [
    acp('goose-acp', './providers/goose-acp', 'GooseAcpProvider'), { ...cli('goose-cli', './providers/goose-cli'), supportsLoopback: false },
  ] },
  { type: 'claude-code', aliases: [], label: 'Claude Code', requiresInstance: false, defaultDeliveryModes: ['cli', 'pull'], transports: [cli('claude-cli', './providers/claude-cli', 'ClaudeCliProvider', 'claude-plan-no-tools')] },
  { type: 'codex', aliases: [], label: 'Codex', requiresInstance: false, defaultDeliveryModes: ['cli', 'pull'], transports: [
    cli('codex-cli', './providers/codex-cli', 'CodexCliProvider', 'codex-readonly'),
    transport({ id: 'codex-app-server', mode: 'owner_io', priority: 100, operations: ['push'],
      modulePath: './providers/codex-app-server', exportName: 'CodexAppServerProvider',
      safetyProfile: 'provider-native-control-plane', sandboxPolicyId: 'provider-managed-local',
      capabilities: { streaming: true, sessionResume: true, cancel: true, progress: true, toolCall: true, humanApproval: true },
      owner: { enabled: true, execution: 'workspace_write', isolation: 'provider_enforced', platforms: ['win32','linux','darwin'],
        exactSessionRecovery: true, safeCancellation: true, reliableNotDelivered: true, nativeIoBridge: true },
      options: context => context.getProviderConfig?.('codex-app-server') || {},
    }),
  ] },
  { type: 'gemini', aliases: [], label: 'Gemini CLI', requiresInstance: false, defaultDeliveryModes: ['cli', 'pull'], transports: [
    { ...cli('gemini-cli', './providers/gemini-cli', 'GeminiCliProvider', 'gemini-container'), exactSession: undefined },
  ] },
  { type: 'pi', aliases: [], label: 'Pi Coding Agent', requiresInstance: false, defaultDeliveryModes: ['cli', 'pull'], transports: [cli('pi-cli', './providers/pi-cli', 'PiCliProvider', 'pi-no-tools')] },
  { type: 'qwen-code', aliases: [], label: 'Qwen Code', requiresInstance: false, defaultDeliveryModes: ['cli', 'pull'], transports: [cli('qwen-cli', './providers/qwen-cli', 'QwenCliProvider', 'qwen-plan-no-tools')] },
  { type: 'qwen-office', aliases: ['qwenwork', 'qwen-work', 'qwenworkcn'], label: '千问办公 (QwenWork)', requiresInstance: false, defaultDeliveryModes: ['cli', 'pull'], transports: [
    { ...cli('qwen-office-cli', './providers/qwen-office-cli', 'QwenOfficeCliProvider', 'qwen-office-restricted'), supportsLoopback: true },
  ] },
  { type: 'dumate', aliases: ['baidu-dumate'], label: '百度搭子 (DuMate)', requiresInstance: true, defaultDeliveryModes: ['http', 'pull'], transports: [
    transport({ id: 'dumate-http', mode: 'http', priority: 10, operations: ['push', 'steer'],
      modulePath: './providers/dumate-http', exportName: 'DuMateHttpProvider',
      safetyProfile: 'loopback-provider-managed-http', sandboxPolicyId: 'provider-managed-local',
      supportsLoopback: false,
      capabilities: { streaming: true, sessionResume: true },
      exactSession: { nativeSessionNamespace: 'dumate-http', restoreCompatibilityGroup: 'dumate-http' },
      options: context => context.getProviderConfig?.('dumate-http') || {},
    }),
  ] },
  { type: 'kiro', aliases: [], label: 'Kiro', requiresInstance: false, defaultDeliveryModes: ['cli', 'pull'], transports: [cli('kiro-cli', './providers/kiro-cli', 'KiroCliProvider')] },
  { type: 'aider', aliases: [], label: 'Aider', requiresInstance: false, defaultDeliveryModes: ['cli', 'pull'], transports: [cli('aider-cli', './providers/aider-cli', 'AiderCliProvider', 'aider-dry-run')] },
  { type: 'grok', aliases: [], label: 'Grok', requiresInstance: false, defaultDeliveryModes: ['cli', 'pull'], transports: [cli('grok-cli', './providers/grok-cli', 'GrokCliProvider', 'grok-plan-no-tools')] },
  { type: 'reasonix', aliases: [], label: 'Reasonix', requiresInstance: false, defaultDeliveryModes: ['cli', 'pull'], transports: [cli('reasonix-cli', './providers/reasonix-cli', 'ReasonixCliProvider')] },
  { type: 'openhands', aliases: [], label: 'OpenHands', requiresInstance: false, defaultDeliveryModes: ['pull'], transports: [] },
  { type: 'amazon-q', aliases: [], label: 'Amazon Q Developer CLI', requiresInstance: false, defaultDeliveryModes: ['pull'], transports: [] },
  { type: 'zcode', aliases: [], label: 'ZCode', requiresInstance: false, defaultDeliveryModes: ['pull'], transports: [] },
  { type: 'workbuddy', aliases: [], label: 'WorkBuddy', requiresInstance: false, defaultDeliveryModes: ['http', 'pull'], transports: [
    transport({ id: 'workbuddy-http', mode: 'http', priority: 10, operations: ['push', 'steer'],
      modulePath: './providers/workbuddy-http', exportName: 'WorkBuddyHttpProvider',
      safetyProfile: 'loopback-provider-managed-http', sandboxPolicyId: 'provider-managed-local',
      supportsLoopback: true,
      capabilities: { streaming: true, asyncReply: true, sessionResume: true, cancel: true },
      exactSession: { nativeSessionNamespace: 'workbuddy-http', restoreCompatibilityGroup: 'workbuddy-http' },
      options: context => context.getProviderConfig?.('workbuddy-http') || {},
    }),
  ] },
  { type: 'deepseek-harness', aliases: ['dsh'], label: 'DeepSeek Harness', requiresInstance: true, defaultDeliveryModes: ['http', 'cli', 'pull'], transports: [
    transport({ id: 'deepseek-harness-http', mode: 'http', priority: 10, operations: ['push', 'steer'],
      modulePath: './providers/deepseek-harness-http', exportName: 'DeepSeekHarnessHttpProvider',
      safetyProfile: 'loopback-provider-managed-http', sandboxPolicyId: 'provider-managed-local',
      supportsLoopback: false,
      capabilities: { asyncReply: true, sessionResume: true, cancel: true },
      exactSession: { nativeSessionNamespace: 'deepseek-harness-web', restoreCompatibilityGroup: 'deepseek-harness-web-v1' },
      options: context => context.getProviderConfig?.('deepseek-harness-http') || {},
    }),
    transport({ id: 'deepseek-harness-cli', mode: 'cli', priority: 20, operations: ['push'],
      modulePath: './providers/deepseek-harness-cli', exportName: 'DeepSeekHarnessCliProvider',
      safetyProfile: 'provider-managed-cli-one-shot', sandboxPolicyId: 'provider-managed-local',
      supportsLoopback: false,
      capabilities: { steer: false, sessionResume: false, cancel: false },
      options: context => context.getProviderConfig?.('deepseek-harness-cli') || {},
    }),
  ] },
  { type: 'codebuddy', aliases: ['codebuddy-code', 'codebuddy-cli'], label: 'CodeBuddy', requiresInstance: false, defaultDeliveryModes: ['acp', 'pull'], transports: [
    acp('codebuddy-acp', './providers/codebuddy-acp', 'CodeBuddyAcpProvider'),
  ] },
  { type: 'doubao', aliases: [], label: '豆包', requiresInstance: false, defaultDeliveryModes: ['pull'], transports: [] },
  { type: 'trae', aliases: ['trae-ide', 'trae-work', 'trae-solo'], label: 'Trae', requiresInstance: false, defaultDeliveryModes: ['acp', 'pull'], transports: [
    acp('traecli-acp', './providers/trae-acp', 'TraeAcpProvider'),
  ] },
  { type: 'others', aliases: [], label: 'Others', requiresInstance: false, defaultDeliveryModes: ['pull'], transports: [] },
  { type: 'mock', aliases: [], label: 'Mock Echo', requiresInstance: false, defaultDeliveryModes: ['mock', 'pull'], transports: [
    transport({ id: 'mock-echo', mode: 'mock', priority: 99, operations: ['push', 'steer'], modulePath: './providers/mock-echo', exportName: 'MockEchoProvider', safetyProfile: 'test-only', sandboxPolicyId: 'provider-managed-local', testOnly: true }),
  ] },
];

const familiesByType = new Map<string, ProviderFamilyDefinition>();
const transportsById = new Map<string, ProviderTransportDefinition & { family: string }>();
for (const family of PROVIDER_CATALOG) {
  family.detect ||= context => !!context.detectedTypes?.some(type => getProviderFamily(type)?.type === family.type);
  family.listInstances ||= context => context.instances?.[family.type] || [];
  family.validateInstance ||= (instanceId, instances) => !family.requiresInstance
    || (!!instanceId && instances.some(instance => String(instance.id) === String(instanceId)));
  familiesByType.set(family.type, family);
  for (const alias of family.aliases) familiesByType.set(alias, family);
  for (const transport of family.transports) {
    transport.family = family.type;
    transport.preflight ||= async (provider: any, agentId: string) => {
      const readiness = await (provider.preflightDelivery?.(agentId)
        ?? { status: provider.isAvailable?.(agentId) ? 'preflight_passed' : 'unavailable' });
      const sandbox = provider.getSandboxStatus?.(agentId) || null;
      return readiness && typeof readiness === 'object' ? { ...readiness, sandbox } : { status: readiness, sandbox };
    };
    if (transport.supportsLoopback) {
      transport.loopback ||= async (provider: any, agentId: string) => provider.runLoopbackTest?.(agentId)
        ?? { status: 'unavailable' };
    }
    if (transportsById.has(transport.id)) {
      const existing = transportsById.get(transport.id)!;
      if (existing.mode !== transport.mode) throw new Error(`Provider transport mode conflict: ${transport.id}`);
      continue;
    }
    transportsById.set(transport.id, { ...transport, family: family.type });
  }
}

export function getProviderFamily(type: unknown): ProviderFamilyDefinition | null {
  return familiesByType.get(String(type || '').trim()) || null;
}

export function getProviderTransport(id: unknown): (ProviderTransportDefinition & { family: string }) | null {
  return transportsById.get(String(id || '').trim()) || null;
}

export function listProviderTransports(type?: unknown): Array<ProviderTransportDefinition & { family: string }> {
  if (type == null) return [...transportsById.values()];
  const family = getProviderFamily(type);
  return family ? family.transports.map(item => ({ ...item, family: family.type })) : [];
}

export function validateProviderCatalog(): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const family of PROVIDER_CATALOG) {
    if (!family.defaultDeliveryModes.includes('pull')) errors.push(`${family.type}: pull missing`);
    for (const mode of family.defaultDeliveryModes.filter(mode => mode !== 'pull')) {
      if (!family.transports.some(transport => transport.mode === mode)) errors.push(`${family.type}: no transport for ${mode}`);
    }
    for (const transport of family.transports) {
      if (ids.has(transport.id)) errors.push(`duplicate transport id: ${transport.id}`);
      ids.add(transport.id);
      if (!transport.operations.length) errors.push(`${transport.id}: operations missing`);
      if (!transport.safetyProfile) errors.push(`${transport.id}: safetyProfile missing`);
      if (!transport.sandboxPolicyId) errors.push(`${transport.id}: sandboxPolicyId missing`);
      if (!transport.modulePath) errors.push(`${transport.id}: modulePath missing`);
      if (typeof transport.create !== 'function') errors.push(`${transport.id}: create missing`);
      if (!transport.capabilities) errors.push(`${transport.id}: capabilities missing`);
      if (typeof transport.preflight !== 'function') errors.push(`${transport.id}: preflight missing`);
      if (transport.supportsLoopback && typeof transport.loopback !== 'function') errors.push(`${transport.id}: loopback missing`);
    }
  }
  return errors;
}

export function instantiateProviderTransport(definition: ProviderTransportDefinition, context: ProviderFactoryContext): any {
  const instance = definition.create(context);
  if (!instance) throw new Error(`Provider transport factory returned no instance: ${definition.id}`);
  const scopedConfig = context.getProviderConfig?.(definition.id) || {};
  if (scopedConfig.sessionPersistence === 'dispatcher') instance.useDispatcherSessionPersistence?.();
  const family = getProviderTransport(definition.id)?.family || '';
  let versionProbe: any = context.providerVersion !== undefined
    ? { version: context.providerVersion || null,
      source: context.providerVersion ? (context.providerVersionSource || 'config') : 'unknown',
      observedAt: context.providerVersionObservedAt || new Date().toISOString(),
      result: context.providerVersion ? 'known' : 'unknown' }
    : null;
  instance.getProviderVersion = () => {
    if (versionProbe) return { ...versionProbe };
    const { probeProviderVersion } = require('../provider-sandbox');
    let command = context.versionProbeCommand || getProviderVersionCommand(definition.id);
    let args: string[]|undefined;
    try {
      const runtime = typeof instance._resolveRuntime === 'function' ? instance._resolveRuntime() : null;
      if (runtime?.available && runtime.executable) { command=runtime.executable;args=[...(runtime.argvPrefix||[]),'--version']; }
    } catch (_) {}
    versionProbe = command ? probeProviderVersion(command,{args}) : {
      version: null, source: 'unknown', observedAt: new Date().toISOString(), result: 'unknown', errorCode: 'failed',
    };
    return { ...versionProbe };
  };
  Object.defineProperty(instance, 'sandboxPolicyId', { value: definition.sandboxPolicyId, enumerable: true });
  Object.defineProperty(instance, 'supportsLoopback', { value: definition.supportsLoopback === true, enumerable: true });
  Object.defineProperty(instance, 'providerCapabilities', { value: Object.freeze({ ...definition.capabilities }), enumerable: true });
  instance.getSandboxStatus = (agentId?: string) => {
    const { evaluateProviderSandbox } = require('../provider-sandbox');
    const version = instance.getProviderVersion();
    return evaluateProviderSandbox({ db: context.db as any, providerFamily: family,
      transportId: definition.id, policyId: definition.sandboxPolicyId,
      providerVersion: version.version, providerVersionSource: version.source,
      providerVersionObservedAt: version.observedAt, providerVersionProbe: version,
      providerVersionVerified: context.providerVersionVerified === true,
      runtimeAvailable: definition.sandboxPolicyId === 'gemini-container'
        ? !!instance.isAvailable?.(agentId || '') : null });
  };
  return instance;
}

module.exports = { PROVIDER_CATALOG, getProviderFamily, getProviderTransport, listProviderTransports,
  getProviderVersionCommand, validateProviderCatalog, instantiateProviderTransport };
