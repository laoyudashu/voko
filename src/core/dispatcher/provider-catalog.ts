export type ProviderOperation = 'push' | 'steer';

export interface ProviderTransportDefinition {
  id: string;
  mode: string;
  priority: number;
  operations: ProviderOperation[];
  modulePath: string;
  exportName?: string;
  safetyProfile: string;
  factoryKind?: 'standard' | 'openclaw' | 'hermes';
  testOnly?: boolean;
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
  gooseBin?: string;
  hermesConfig?: { apiHost?: string; apiPort?: number; apiKey?: string; profiles?: Record<string, unknown> };
}

const cli = (id: string, modulePath: string, exportName?: string): ProviderTransportDefinition => ({
  id, mode: 'cli', priority: 1, operations: ['push', 'steer'], modulePath, exportName,
  safetyProfile: 'restricted-cli',
});
const acp = (id: string, modulePath: string, exportName?: string): ProviderTransportDefinition => ({
  id, mode: 'acp', priority: 10, operations: ['push', 'steer'], modulePath, exportName,
  safetyProfile: 'isolated-acp',
});

export const PROVIDER_CATALOG: ProviderFamilyDefinition[] = [
  { type: 'openclaw', aliases: [], label: 'OpenClaw', requiresInstance: true, defaultDeliveryModes: ['websocket', 'cli', 'pull'], transports: [
    { id: 'openclaw-ws', mode: 'websocket', priority: 10, operations: ['push', 'steer'], modulePath: './providers/openclaw-ws', safetyProfile: 'local-authenticated-websocket', factoryKind: 'openclaw' },
    cli('openclaw-cli', './providers/openclaw-cli'),
  ] },
  { type: 'hermes', aliases: [], label: 'Hermes', requiresInstance: true, defaultDeliveryModes: ['http', 'cli', 'pull'], transports: [
    { id: 'hermes-http', mode: 'http', priority: 10, operations: ['push', 'steer'], modulePath: './providers/hermes-http', safetyProfile: 'local-authenticated-http', factoryKind: 'hermes' },
    cli('hermes-cli', './providers/hermes-cli'),
  ] },
  { type: 'zeroclaw', aliases: [], label: 'ZeroClaw', requiresInstance: true, defaultDeliveryModes: ['acp_ws', 'acp', 'cli', 'pull'], transports: [
    { id: 'zeroclaw-ws', mode: 'acp_ws', priority: 20, operations: ['push', 'steer'], modulePath: './providers/zeroclaw-ws', exportName: 'ZeroClawWsProvider', safetyProfile: 'paired-acp-websocket' },
    acp('zeroclaw-acp', './providers/zeroclaw-acp', 'ZeroClawAcpProvider'),
    cli('zeroclaw-cli', './providers/zeroclaw-cli', 'ZeroClawCliProvider'),
  ] },
  { type: 'opencode', aliases: [], label: 'OpenCode', requiresInstance: false, defaultDeliveryModes: ['acp', 'attach', 'cli', 'pull'], transports: [
    acp('opencode-acp', './providers/opencode-acp', 'OpenCodeAcpProvider'),
    { id: 'opencode-attach', mode: 'attach', priority: 5, operations: ['push', 'steer'], modulePath: './providers/opencode-attach', exportName: 'OpenCodeAttachProvider', safetyProfile: 'local-authenticated-http' },
    cli('opencode-cli', './providers/opencode-cli', 'OpenCodeCliProvider'),
  ] },
  { type: 'github-copilot', aliases: [], label: 'GitHub Copilot CLI', requiresInstance: false, defaultDeliveryModes: ['acp', 'cli', 'pull'], transports: [
    acp('github-copilot-acp', './providers/github-copilot-acp', 'GitHubCopilotAcpProvider'),
    cli('github-copilot-cli', './providers/github-copilot-cli', 'GitHubCopilotCliProvider'),
  ] },
  { type: 'cursor', aliases: [], label: 'Cursor Agent', requiresInstance: false, defaultDeliveryModes: ['acp', 'cli', 'pull'], transports: [
    acp('cursor-acp', './providers/cursor-acp', 'CursorAcpProvider'), cli('cursor-cli', './providers/cursor-cli', 'CursorCliProvider'),
  ] },
  { type: 'cline', aliases: [], label: 'Cline', requiresInstance: false, defaultDeliveryModes: ['acp', 'cli', 'pull'], transports: [
    acp('cline-acp', './providers/cline-acp', 'ClineAcpProvider'), cli('cline-cli', './providers/cline-cli', 'ClineCliProvider'),
  ] },
  { type: 'goose', aliases: ['goose-ai', 'acp-goose'], label: 'Goose', requiresInstance: false, defaultDeliveryModes: ['acp', 'cli', 'pull'], transports: [
    acp('goose-acp', './providers/goose-acp', 'GooseAcpProvider'), cli('goose-cli', './providers/goose-cli'),
  ] },
  { type: 'claude-code', aliases: [], label: 'Claude Code', requiresInstance: false, defaultDeliveryModes: ['cli', 'pull'], transports: [cli('claude-cli', './providers/claude-cli', 'ClaudeCliProvider')] },
  { type: 'codex', aliases: [], label: 'Codex', requiresInstance: false, defaultDeliveryModes: ['cli', 'pull'], transports: [cli('codex-cli', './providers/codex-cli', 'CodexCliProvider')] },
  { type: 'gemini', aliases: [], label: 'Gemini CLI', requiresInstance: false, defaultDeliveryModes: ['cli', 'pull'], transports: [cli('gemini-cli', './providers/gemini-cli', 'GeminiCliProvider')] },
  { type: 'pi', aliases: [], label: 'Pi Coding Agent', requiresInstance: false, defaultDeliveryModes: ['cli', 'pull'], transports: [cli('pi-cli', './providers/pi-cli', 'PiCliProvider')] },
  { type: 'qwen-code', aliases: [], label: 'Qwen Code', requiresInstance: false, defaultDeliveryModes: ['cli', 'pull'], transports: [cli('qwen-cli', './providers/qwen-cli', 'QwenCliProvider')] },
  { type: 'kiro', aliases: [], label: 'Kiro', requiresInstance: false, defaultDeliveryModes: ['cli', 'pull'], transports: [cli('kiro-cli', './providers/kiro-cli', 'KiroCliProvider')] },
  { type: 'aider', aliases: [], label: 'Aider', requiresInstance: false, defaultDeliveryModes: ['cli', 'pull'], transports: [cli('aider-cli', './providers/aider-cli', 'AiderCliProvider')] },
  { type: 'grok', aliases: [], label: 'Grok', requiresInstance: false, defaultDeliveryModes: ['cli', 'pull'], transports: [cli('grok-cli', './providers/grok-cli', 'GrokCliProvider')] },
  { type: 'reasonix', aliases: [], label: 'Reasonix', requiresInstance: false, defaultDeliveryModes: ['cli', 'pull'], transports: [cli('reasonix-cli', './providers/reasonix-cli', 'ReasonixCliProvider')] },
  { type: 'openhands', aliases: [], label: 'OpenHands', requiresInstance: false, defaultDeliveryModes: ['pull'], transports: [] },
  { type: 'amazon-q', aliases: [], label: 'Amazon Q Developer CLI', requiresInstance: false, defaultDeliveryModes: ['pull'], transports: [] },
  { type: 'zcode', aliases: [], label: 'ZCode', requiresInstance: false, defaultDeliveryModes: ['pull'], transports: [] },
  { type: 'workbuddy', aliases: [], label: 'WorkBuddy', requiresInstance: false, defaultDeliveryModes: ['pull'], transports: [] },
  { type: 'doubao', aliases: [], label: '豆包', requiresInstance: false, defaultDeliveryModes: ['pull'], transports: [] },
  { type: 'others', aliases: [], label: 'Others', requiresInstance: false, defaultDeliveryModes: ['pull'], transports: [] },
  { type: 'mock', aliases: [], label: 'Mock Echo', requiresInstance: false, defaultDeliveryModes: ['mock', 'pull'], transports: [
    { id: 'mock-echo', mode: 'mock', priority: 99, operations: ['push', 'steer'], modulePath: './providers/mock-echo', exportName: 'MockEchoProvider', safetyProfile: 'test-only', testOnly: true },
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
    transport.preflight ||= async (provider: any, agentId: string) => provider.preflightDelivery?.(agentId)
      ?? { status: provider.isAvailable?.(agentId) ? 'preflight_passed' : 'unavailable' };
    transport.loopback ||= async (provider: any, agentId: string) => provider.runLoopbackTest?.(agentId)
      ?? { status: 'unavailable' };
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
      if (!transport.modulePath) errors.push(`${transport.id}: modulePath missing`);
      if (typeof transport.preflight !== 'function') errors.push(`${transport.id}: preflight missing`);
      if (typeof transport.loopback !== 'function') errors.push(`${transport.id}: loopback missing`);
    }
  }
  return errors;
}

export function instantiateProviderTransport(definition: ProviderTransportDefinition, context: ProviderFactoryContext): any {
  const loaded = require(definition.modulePath);
  const Ctor = definition.exportName ? loaded[definition.exportName] : loaded;
  if (typeof Ctor !== 'function') throw new Error(`Provider transport factory unavailable: ${definition.id}`);
  if (definition.factoryKind === 'openclaw') return new Ctor(context.db, null);
  if (definition.factoryKind === 'hermes') {
    const config = context.hermesConfig || {};
    return new Ctor(context.db, null, {
      host: config.apiHost || '127.0.0.1', port: config.apiPort || 8642,
      apiKey: config.apiKey || '', profiles: config.profiles || {},
    });
  }
  const args: Record<string, unknown> = { db: context.db, contextWindow: context.contextWindow ?? 20 };
  if (definition.id === 'goose-cli' || definition.id === 'goose-acp') args.binPath = context.gooseBin;
  return new Ctor(args);
}

module.exports = { PROVIDER_CATALOG, getProviderFamily, getProviderTransport, listProviderTransports, validateProviderCatalog, instantiateProviderTransport };
