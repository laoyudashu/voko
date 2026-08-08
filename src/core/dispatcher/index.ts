/**
 * dispatcher/index.js — 消息分发决策层（provider 自匹配路由）
 *
 * 消息落库后，按 agent backend + push 通道连接情况决策：
 *   - 有 provider match 命中且通道就绪 → push 给 agent 后端
 *   - 无 provider 命中（不认识/未上报 runtime）/ 命中但不就绪 → 留库，等 agent pull
 *
 * 选 provider 用「路由」而非映射表：match 命中的按 priority 降序、取首个就绪者。
 *   - match 是归属判断（backend_type 维度），isAvailable 是就绪判断（连接/配置维度），两者独立。
 *   - priority 决定同 backend 多 provider 时的先后：长连接（HTTP/WS）优先，CLI 兜底。
 *   - 新增 runtime 只需加一个 provider（实现 match/push/steer + priority），不动本文件。
 *
 * 所有 provider 的连接建立（含 spawn gateway 等"侵入"操作）收敛在各自 provider 内；
 * lite 其他模块只通过 dispatcher 调度，不再直接 spawn / 配置 agent。
 */
import type { DatabaseLike } from '../../types/database';
import type { AgentDeliveryStatus, AgentMeta, PushPayload } from './types';
const { createMessageSecurityContext, wrapPushContent } = require('./safety-prompt');
const { ProviderConversationBindingStore } = require('../provider-conversation-bindings');
const { getProviderFamily, getProviderTransport } = require('./provider-catalog');
const { ProviderRuntimeRegistry } = require('./provider-runtime-registry');
const { RouteResolver } = require('./route-resolver');
const { DeliveryExecutor } = require('./delivery-executor');

interface DispatcherProvider {
  priority?: number;
  match?(agentId: string, meta: AgentMeta): boolean;
  isAvailable?(agentId: string): boolean;
  push?(payload: PushPayload): unknown;
  steer?(agentId: string, visitorId: string, content: string, metadata?: { turnId: string }): unknown;
  start?(): unknown;
  stop?(): unknown;
  healthCheck?(): unknown;
  setAvailabilityProviderId?(providerId: string): void;
  on?(event: string, handler: (payload: any) => void): unknown;
  off?(event: string, handler: (payload: any) => void): unknown;
  removeListener?(event: string, handler: (payload: any) => void): unknown;
}

type RouteOperation = 'push' | 'steer';
type DeliveryOutcome = 'not_delivered' | 'outcome_unknown' | 'rejected';

interface AvailabilityEvent {
  providerId?: string;
  backendType?: string;
  mode?: string;
  agentId?: string;
  operations?: RouteOperation[];
  available?: boolean;
  reason?: string;
  generation?: number;
}

interface RouteCacheEntry {
  providerId: string;
  provider: DispatcherProvider;
  generation: string;
  selectedAt: number;
}

interface RouteInvalidation {
  providerId?: string;
  agentId?: string;
  operation?: RouteOperation;
  available?: boolean;
  reason?: string;
}

interface ProviderReply {
  agentId?: string;
  visitorId?: string;
  done?: boolean;
  replyId?: string;
  turnId?: string;
  [key: string]: unknown;
}

interface ReplyContext {
  agentId?: string;
  channelType?: number;
  channelId?: string;
  senderUid?: string;
  a2aManaged?: boolean;
  a2aPeerUid?: string;
  a2aScope?: string;
  a2aTurn?: number;
  turnId?: string;
  interventionResume?: boolean;
  rememberedAt?: number;
  [key: string]: unknown;
}

interface DispatcherOptions {
  db: Pick<DatabaseLike, 'prepare'>;
  providers: Record<string, DispatcherProvider>;
  onAgentReply?: (reply: ProviderReply) => void;
}

interface AgentMetaRow extends AgentMeta {
  imUid?: string | null;
}

interface AgentIdRow {
  agent_id?: string;
}

interface PullMessageRow {
  id: string;
  from_uid: string;
  content: string;
  channel_id: string;
  channel_type?: number;
  timestamp?: number;
  mention?: string | { all?: boolean; uids?: string[] } | null;
  [key: string]: unknown;
}

interface A2AContext extends ReplyContext {
  a2aManaged: true;
  a2aPeerUid: string;
  a2aScope: string;
}

interface PreparedA2A {
  blocked: boolean;
  context: A2AContext | null;
  delay?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deliveryOutcome(error: unknown): DeliveryOutcome {
  const explicit = (error as any)?.deliveryOutcome;
  if (explicit === 'not_delivered' || explicit === 'outcome_unknown' || explicit === 'rejected') return explicit;
  return 'outcome_unknown';
}

// ── A2A（agent-to-agent）对话收敛配置 ──
function _boundedEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
const A2A_MAX_TURNS = _boundedEnv('VOKO_A2A_MAX_TURNS', 10, 1, 50);
const A2A_TURN_WINDOW_SEC = _boundedEnv('VOKO_A2A_TURN_WINDOW_SEC', 3600, 60, 86400);
// A2A 降速（防乒乓刷屏）：1 分钟内来回 ≥ 阈值则延迟 push
const A2A_RATE_WINDOW_MS = _boundedEnv('VOKO_A2A_RATE_WINDOW_MS', 60000, 1000, 3600000);
const A2A_RATE_THRESHOLD = _boundedEnv('VOKO_A2A_RATE_THRESHOLD', 6, 2, 100);
const A2A_RATE_DELAY_MS = _boundedEnv('VOKO_A2A_RATE_DELAY_MS', 5000, 100, 60000);

// A2A 检测：通过 IM 服务端用户信息 API 的 is_human 字段判断（0=agent, 1=访客）。
// 全局数据比 agent_ 前缀更可靠，且不依赖命名规则。
const ENDPOINTS = require('../../endpoints.json');
const IM_API_BASE = (ENDPOINTS.im && ENDPOINTS.im.baseUrl) || '';

/** 用户类型内存缓存：imUid → {isAgent, ts}，30s TTL，避免每条消息调外部 HTTP。 */
const _userTypeCache = new Map<string, { isAgent: boolean; ts: number }>();
const USER_TYPE_CACHE_TTL = 30000;

/** 后台异步查询 & 缓存用户类型（不阻塞 dispatch）。 */
async function _fetchAndCacheUserType(fromUid: string): Promise<void> {
  let isAgent = false;
  try {
    const resp = await fetch(`${IM_API_BASE}/api/users/${encodeURIComponent(fromUid)}`, {
      signal: AbortSignal.timeout(3000)
    });
    if (resp.ok) {
      const data = await resp.json() as { is_human?: number };
      isAgent = data.is_human === 0;
    }
  } catch (_) {
    console.warn(`[Dispatcher] A2A 检测 API 不可用，保守判非 agent: ${fromUid}`);
  }
  _userTypeCache.set(fromUid, { isAgent, ts: Date.now() });
}

/**
 * 判断 imUid 是否为 agent。缓存命中直接返回；miss 时后台异步查 API，
 * 本次保守返回 false（宁漏一轮 A2A 收敛，不阻塞消息分发）。
 */
/**
 * 判断 imUid 是否为 agent。缓存命中直接返回；miss 时后台异步查 API，
 * 本次保守返回 false（宁漏一轮 A2A 收敛，不阻塞消息分发）。
 */
function _isAgentByApi(fromUid?: string | null): boolean {
  if (!fromUid) return false;
  const now = Date.now();
  const cached = _userTypeCache.get(fromUid);
  if (cached && now - cached.ts < USER_TYPE_CACHE_TTL) return cached.isAgent;
  _fetchAndCacheUserType(fromUid).catch(() => {});
  return false;
}
function createDispatcher({ db, providers, onAgentReply }: DispatcherOptions) {
  // providers: { 'openclaw-ws': provider, 'hermes-http': provider, ... }
  const runtimeRegistry = new ProviderRuntimeRegistry(providers);
  const routeResolver = new RouteResolver();
  const deliveryExecutor = new DeliveryExecutor();

  // provider 的回复通常只带 visitorId。这里按投递顺序补回群发送者、频道和 A2A scope，
  // 避免逐个 provider 修改协议，也让群回复能准确决定是否 @回上一位 Agent。
  const _replyContexts = new Map<string, ReplyContext[]>();
  const _replyContextsByTurn = new Map<string, ReplyContext>();
  const _bindingStore = new ProviderConversationBindingStore(db);
  const _conversationRoutes = new Map<string, Promise<void>>();
  try { _bindingStore.recoverPending(); } catch (_) {}
  const _processedFinalReplies = new Map<string, number>();
  const FINAL_REPLY_TTL_MS = 10 * 60 * 1000;
  function _replyContextKey(agentId?: string, visitorId?: string): string {
    return `${agentId}::${visitorId || ''}`;
  }
  function _rememberReplyContext(
    agentId: string,
    visitorId: string,
    context: ReplyContext,
  ): void {
    const key = _replyContextKey(agentId, visitorId);
    context.rememberedAt = Date.now();
    const queue = _replyContexts.get(key) || [];
    queue.push(context);
    if (queue.length > 20) {
      const evicted = queue.shift();
      if (evicted?.turnId) _replyContextsByTurn.delete(`${agentId}::${evicted.turnId}`);
    }
    _replyContexts.set(key, queue);
    if (context.turnId) {
      _replyContextsByTurn.set(`${agentId}::${context.turnId}`, context);
    }
  }
  function _removeReplyContext(context: ReplyContext): void {
    if (context.turnId) _replyContextsByTurn.delete(`${context.agentId || ''}::${context.turnId}`);
    for (const [key, queue] of _replyContexts) {
      const index = queue.indexOf(context);
      if (index < 0) continue;
      queue.splice(index, 1);
      if (!queue.length) _replyContexts.delete(key);
      break;
    }
  }
  function _contextualizeReply(reply: ProviderReply): ProviderReply {
    const key = _replyContextKey(reply?.agentId, reply?.visitorId);
    const queue = _replyContexts.get(key);
    const exact = reply.turnId
      ? _replyContextsByTurn.get(`${reply.agentId || ''}::${reply.turnId}`)
      : undefined;
    if (exact?.rememberedAt && Date.now() - exact.rememberedAt > FINAL_REPLY_TTL_MS) {
      _removeReplyContext(exact);
    }
    // 有 turnId 时必须精确关联；未知或已过期的 turn 不能回退 FIFO，
    // 否则延迟回复会继承另一轮消息的频道/发送者上下文。
    const context = reply.turnId
      ? _replyContextsByTurn.get(`${reply.agentId || ''}::${reply.turnId}`)
      : queue?.[0];
    if (context && reply?.done !== false) {
      if (context.turnId) _replyContextsByTurn.delete(`${reply.agentId || ''}::${context.turnId}`);
      _removeReplyContext(context);
    }
    return context ? { ...reply, ...context } : reply;
  }
  function _finalReplyKey(reply: ProviderReply): string | null {
    const identity = reply.turnId || reply.replyId;
    if (!identity || reply.done === false) return null;
    return `${reply.agentId || ''}::${identity}`;
  }
  function _acceptFinalReply(reply: ProviderReply): boolean {
    const key = _finalReplyKey(reply);
    if (!key) return true;
    const now = Date.now();
    const previous = _processedFinalReplies.get(key);
    if (previous && now - previous < FINAL_REPLY_TTL_MS) {
      console.warn(`[Dispatcher] 跳过重复 final reply agent=${reply.agentId || '-'} turn=${reply.turnId || '-'} reply=${reply.replyId || '-'}`);
      return false;
    }
    _processedFinalReplies.set(key, now);
    if (_processedFinalReplies.size > 1000) {
      for (const [oldKey, timestamp] of _processedFinalReplies) {
        if (now - timestamp >= FINAL_REPLY_TTL_MS) _processedFinalReplies.delete(oldKey);
      }
    }
    return true;
  }
  const attachedReplyProviders = new Set<DispatcherProvider>();
  function attachReplyProvider(p: DispatcherProvider): void {
    if (!onAgentReply || attachedReplyProviders.has(p) || typeof p.on !== 'function') return;
    attachedReplyProviders.add(p);
    p.on('agent.reply', (reply: ProviderReply) => {
          // Provider 已携带身份时先去重，避免重复 final 消费下一条排队上下文。
          if ((reply.turnId || reply.replyId) && !_acceptFinalReply(reply)) return;
          const contextualized = _contextualizeReply(reply);
          if (!(reply.turnId || reply.replyId) && !_acceptFinalReply(contextualized)) return;
          onAgentReply(contextualized);
    });
  }
  for (const p of Object.values(providers)) attachReplyProvider(p);
  // backend_type 内存缓存：避免每条访客消息都查一次 DB（match/isAvailable 已是同步纯判断，
  // 这里消除最后一次同步 IO）。TTL 兜底；写入点（注册/发布/runtime 上报）低频，30s 收敛足够。
  const META_CACHE_TTL = Number(process.env.VOKO_BACKEND_TYPE_CACHE_TTL_MS) || 30000;
  const ROUTE_CACHE_TTL = Number(process.env.VOKO_ROUTE_CACHE_TTL_MS) || 30000;
  const _metaCache = new Map<string, AgentMetaRow & { ts: number }>();
  const _routeCache = new Map<string, RouteCacheEntry>();
  const _lastDeliveredModes = new Map<string, string>();
  const _providerIds = new Map<DispatcherProvider, string>();
  const _providerGenerations = new Map<string, number>();
  const _scopedGenerations = new Map<string, number>();
  const _availabilityEventGenerations = new Map<string, number>();
  for (const [providerId, provider] of Object.entries(providers)) _providerIds.set(provider, providerId);
  // A2A 状态按 scope 隔离：direct 或 group:<channelId>。
  // 收敛标记是一次性停推闸门：吞掉对方在最终总结后的自动续答即清除，允许后续开启新话题。
  const _convergedMap = new Map<string, number>();   // scopeKey -> markedAt
  const _a2aTurnMap = new Map<string, number[]>();     // scopeKey -> 最近轮次时间戳(ms)[]
  const _a2aRateMap = new Map<string, number[]>();     // scopeKey -> 最近消息时间戳(ms)[]
  const _a2aDelayUntil = new Map<string, number>();  // scopeKey -> 串行降速队列的末尾时间
  /** 查 agent 的 backend_type + imUid，构造 meta 供 provider.match 归属判断 + A2A 自身 echo 排除。 */
  function _metaOf(agentId: string): AgentMetaRow {
    const now = Date.now();
    const cached = _metaCache.get(agentId);
    if (cached && now - cached.ts < META_CACHE_TTL) return {
      backend_type: cached.backend_type,
      backend_instance_id: cached.backend_instance_id,
      delivery_modes: cached.delivery_modes,
      imUid: cached.imUid,
    };
    try {
      const row = db.prepare('SELECT backend_type, backend_instance_id, delivery_modes, imUid FROM agents WHERE agent_id=?')
        .get(agentId) as (AgentMetaRow & { delivery_modes?: string | string[] | null }) | undefined;
      const backend_type = row?.backend_type || null;
      const backend_instance_id = row?.backend_instance_id || null;
      let delivery_modes: string[] | null = null;
      try {
        const parsed = typeof row?.delivery_modes === 'string' ? JSON.parse(row.delivery_modes) : row?.delivery_modes;
        if (Array.isArray(parsed)) delivery_modes = parsed.map(String);
      } catch (_) {}
      const imUid = row?.imUid || null;
      _metaCache.set(agentId, { backend_type, backend_instance_id, delivery_modes, imUid, ts: now });
      return { backend_type, backend_instance_id, delivery_modes, imUid };
    } catch (_) { return {}; }
  }

  /** 本地 agents 表优先识别，避免缓存 miss 时首条 A2A 消息绕过治理。 */
  function _isAgentImUid(imUid?: string | null): boolean {
    if (!imUid) return false;
    try {
      if (db.prepare('SELECT 1 FROM agents WHERE imUid=? LIMIT 1').get(imUid)) return true;
    } catch (_) {}
    return _isAgentByApi(imUid);
  }

  function _providerIdOf(provider: DispatcherProvider): string | null {
    return _providerIds.get(provider) || null;
  }

  function _generationKey(providerId: string, agentId: string, operation: RouteOperation): string {
    return `${providerId}:${agentId}:${operation}`;
  }

  function _generationOf(providerId: string, agentId: string, operation: RouteOperation): string {
    return `${_providerGenerations.get(providerId) || 0}:${_scopedGenerations.get(_generationKey(providerId, agentId, operation)) || 0}`;
  }

  function _bumpScoped(providerId: string, agentId: string, operation: RouteOperation): void {
    const key = _generationKey(providerId, agentId, operation);
    _scopedGenerations.set(key, (_scopedGenerations.get(key) || 0) + 1);
  }

  function _providerEligible(providerId: string, agentId: string): boolean {
    const provider = providers[providerId];
    if (!provider) return false;
    const meta = _metaOf(agentId);
    const mode = _providerMode(providerId);
    if (Array.isArray(meta.delivery_modes) && !meta.delivery_modes.includes(mode)) return false;
    try { return typeof provider.match === 'function' && provider.match(agentId, meta); }
    catch (_) { return false; }
  }

  function invalidateRoutes(input: RouteInvalidation = {}): void {
    const operations: RouteOperation[] = input.operation ? [input.operation] : ['push', 'steer'];
    if (input.providerId && !input.agentId) {
      _providerGenerations.set(input.providerId, (_providerGenerations.get(input.providerId) || 0) + 1);
    } else if (input.providerId && input.agentId) {
      for (const operation of operations) _bumpScoped(input.providerId, input.agentId, operation);
    }

    for (const [cacheKey, entry] of _routeCache) {
      const separator = cacheKey.indexOf(':');
      const operation = cacheKey.slice(0, separator) as RouteOperation;
      const agentId = cacheKey.slice(separator + 1);
      if (!operations.includes(operation)) continue;
      if (input.agentId && input.agentId !== agentId) continue;
      let affected = !input.providerId;
      if (input.providerId) {
        affected = input.available === true
          ? _providerEligible(input.providerId, agentId)
          : entry.providerId === input.providerId;
      }
      if (!affected) continue;
      _bumpScoped(entry.providerId, agentId, operation);
      _routeCache.delete(cacheKey);
    }
  }

  /** 主动失效 backend_type 缓存。传 agentId 失效单个，不传清空全部。TTL 已能兜底，调用为可选。 */
  function invalidateMeta(agentId?: string): void {
    if (agentId) {
      _metaCache.delete(agentId);
      invalidateRoutes({ agentId });
    } else {
      _metaCache.clear();
      invalidateRoutes();
    }
  }

  runtimeRegistry.on('availability', (event: AvailabilityEvent = {}) => {
    const providerId = String(event.providerId || '');
    if (!providerId) return;
    const eventKey = `${providerId}:${event.agentId || '*'}`;
    if (Number.isFinite(event.generation)) {
      const previous = _availabilityEventGenerations.get(eventKey) || 0;
      if (Number(event.generation) <= previous) return;
      _availabilityEventGenerations.set(eventKey, Number(event.generation));
    }
    const operations: RouteOperation[] = event.operations?.length ? event.operations : ['push', 'steer'];
    for (const operation of operations) invalidateRoutes({
      providerId, agentId: event.agentId, operation, available: event.available, reason: event.reason,
    });
  });

  /**
   * 路由：match 命中的 provider 按 priority 降序，选首个就绪（isAvailable）的。
   * 长连接（HTTP/WS，priority 高）优先；不通（isAvailable=false）则降级到 CLI（priority 低）兜底；
   * 全 miss（不认识/未上报 runtime）或命中但全不就绪 → 返回 null（留库 pull）。
   */
  function _providerMode(key: string): string {
    return getProviderTransport(key)?.mode || key;
  }

  function _providerFamily(providerId: string): string {
    return getProviderTransport(providerId)?.family || providerId;
  }

  function resolveProviders(agentId: string, operation: RouteOperation = 'push'): DispatcherProvider[] {
    const meta = _metaOf(agentId);
    return routeResolver.resolve({ agentId, operation, meta, providers }).map((item: any) => item.provider);
  }

  /**
   * Read-only delivery diagnostics. This must never start a gateway, invoke a model,
   * or mutate provider configuration; it only evaluates persisted selection and
   * each matching provider's synchronous readiness probe.
   */
  function getAgentDeliveryStatus(agentId: string): AgentDeliveryStatus {
    const meta = _metaOf(agentId);
    const explicitModes = Array.isArray(meta.delivery_modes)
      ? [...new Set([...meta.delivery_modes.map(String), 'pull'])]
      : null;
    const methods: AgentDeliveryStatus['methods'] = [];

    for (const [key, provider] of Object.entries(providers)) {
      const mode = _providerMode(key);
      try {
        if (typeof provider.match !== 'function' || !provider.match(agentId, meta)) continue;
      } catch (_) {
        continue;
      }
      if (explicitModes && !explicitModes.includes(mode)) continue;
      let available = false;
      let status: AgentDeliveryStatus['methods'][number]['status'] = 'unavailable';
      try {
        available = typeof provider.isAvailable === 'function' && !!provider.isAvailable(agentId);
        status = available ? 'available' : 'unavailable';
      } catch (_) {
        status = 'unknown';
      }
      methods.push({ mode, provider: key, configured: true, available, status });
    }

    if (!explicitModes) {
      methods.sort((a, b) => (providers[b.provider || '']?.priority || 0) - (providers[a.provider || '']?.priority || 0));
    }
    const configuredModes = explicitModes || [...new Set(methods.map(method => method.mode)), 'pull'];
    for (const mode of configuredModes) {
      if (mode === 'pull') {
        methods.push({
          mode: 'pull',
          provider: null,
          configured: !!explicitModes,
          available: true,
          status: explicitModes ? 'on-demand' : 'fallback',
        });
      } else if (!methods.some(method => method.mode === mode)) {
        methods.push({ mode, provider: null, configured: true, available: false, status: 'unknown' });
      }
    }

    methods.sort((a, b) => {
      const aMode = configuredModes.indexOf(a.mode);
      const bMode = configuredModes.indexOf(b.mode);
      if (aMode !== bMode) return aMode - bMode;
      return (providers[b.provider || '']?.priority || 0) - (providers[a.provider || '']?.priority || 0);
    });
    const automaticReadyModes = [...new Set(methods
      .filter(method => method.mode !== 'pull' && method.available)
      .map(method => method.mode))];
    return {
      backendType: meta.backend_type || null,
      configuredModes,
      automaticDeliveryReady: automaticReadyModes.length > 0,
      automaticReadyModes,
      activeAutomaticMode: methods.find(method => method.mode !== 'pull' && method.available)?.mode || null,
      pullReady: methods.some(method => method.mode === 'pull' && method.available),
      lastDeliveredMode: _lastDeliveredModes.get(agentId) || null,
      methods,
    };
  }

  function _routeProviderEntry(
    agentId: string,
    operation: RouteOperation,
    excluded: Set<DispatcherProvider> = new Set(),
  ): RouteCacheEntry | null {
    const cacheKey = `${operation}:${agentId}`;
    const cached = _routeCache.get(cacheKey);
    if (cached && !excluded.has(cached.provider) && Date.now() - cached.selectedAt < ROUTE_CACHE_TTL) {
      try {
        if (cached.generation === _generationOf(cached.providerId, agentId, operation)
          && cached.provider.isAvailable?.(agentId)
          && typeof cached.provider[operation] === 'function') return cached;
      } catch (_) {}
      _bumpScoped(cached.providerId, agentId, operation);
      _routeCache.delete(cacheKey);
    } else if (cached) {
      _bumpScoped(cached.providerId, agentId, operation);
      _routeCache.delete(cacheKey);
    }

    const provider = resolveProviders(agentId, operation).find(candidate => (
      !excluded.has(candidate) && typeof candidate[operation] === 'function'
    )) || null;
    if (!provider) return null;
    const providerId = _providerIdOf(provider);
    if (!providerId) return null;
    const selected: RouteCacheEntry = {
      providerId,
      provider,
      generation: _generationOf(providerId, agentId, operation),
      selectedAt: Date.now(),
    };
    _routeCache.set(cacheKey, selected);
    return selected;
  }

  function _routeProvider(
    agentId: string,
    operation: RouteOperation,
    excluded: Set<DispatcherProvider> = new Set(),
  ): DispatcherProvider | null {
    return _routeProviderEntry(agentId, operation, excluded)?.provider || null;
  }

  function _cacheRouteIfCurrent(agentId: string, operation: RouteOperation, entry: RouteCacheEntry): void {
    if (entry.generation !== _generationOf(entry.providerId, agentId, operation)) return;
    try {
      if (!entry.provider.isAvailable?.(agentId)) return;
    } catch (_) { return; }
    _routeCache.set(`${operation}:${agentId}`, { ...entry, selectedAt: Date.now() });
  }

  function _forgetRoute(agentId: string, operation: RouteOperation, provider: DispatcherProvider): void {
    const cacheKey = `${operation}:${agentId}`;
    const providerId = _providerIdOf(provider);
    if (providerId) _bumpScoped(providerId, agentId, operation);
    if (_routeCache.get(cacheKey)?.provider === provider) _routeCache.delete(cacheKey);
  }

  function resolveProvider(agentId: string): DispatcherProvider | null {
    return _routeProvider(agentId, 'push');
  }

  /** A2A scope key：私聊与每个群完全隔离，同一 scope 内按无序 Agent 对收敛。 */
  function _scopeKey(imUidA: string, imUidB: string, scope = 'direct'): string {
    return `${scope}::${[imUidA, imUidB].sort().join('::')}`;
  }

  /** 当前链路轮次（消息在进入治理时计一次，不再依赖已落库消息，避免当前消息重复 +1）。 */
  function _a2aTurnCount(imUidA: string, imUidB: string, scope: string): number {
    const key = _scopeKey(imUidA, imUidB, scope);
    const now = Date.now();
    const windowMs = A2A_TURN_WINDOW_SEC * 1000;
    const turns = (_a2aTurnMap.get(key) || []).filter((timestamp: number) => now - timestamp < windowMs);
    turns.push(now);
    _a2aTurnMap.set(key, turns);
    return turns.length;
  }

  function _resetA2A(imUidA: string, imUidB: string, scope: string): void {
    const key = _scopeKey(imUidA, imUidB, scope);
    _convergedMap.delete(key);
    _a2aTurnMap.delete(key);
    _a2aRateMap.delete(key);
    _a2aDelayUntil.delete(key);
  }
  function resetA2AForAgent(agentId: string, peerUid: string, scope: string): boolean {
    const agentUid = _metaOf(agentId)?.imUid;
    if (!agentUid || !peerUid) return false;
    _resetA2A(agentUid, peerUid, scope);
    return true;
  }
  /**
   * 熔断：插入系统消息告知对话已达上限（仅本地 DB/UI，不推 agent）。
   * 给接收方写一条；若发送方 agent 也在本实例，也给发送方 channel 写一条，
   * 让双方消息流都有审计记录（注：仅落库，非主动 IM 推送——发送方 agent 不会即时感知）。
   * A2A 点对点场景 channelId === fromUid（均为发送方 imUid），故用 agent_id 区分两条记录。
   */
  function _a2aCircuitBreak(
    agentId: string,
    channelId: string,
    maxTurns: number,
    fromUid: string,
    channelType = 1,
  ): void {
    try {
      const ts = Math.floor(Date.now() / 1000);
      const text = `⚠️ 本轮 Agent 对话已达轮次上限（${maxTurns} 轮），已自动结束。`;
      const stmt = db.prepare(
        `INSERT OR REPLACE INTO messages (id, from_uid, to_uid, content, channel_id, channel_type, agent_id, timestamp, is_me, status, content_type)
         VALUES (?, 'system', ?, ?, ?, ?, ?, ?, 0, 'sent', 10)`);
      stmt.run(`sys-a2a-cap-${agentId}-${ts}-${Math.random().toString(36).slice(2, 6)}`, channelId, text, channelId, channelType, agentId, ts);
      // 单聊在本地给发送方也留审计记录；群里一条系统消息已对全部成员可见，避免重复。
      if (channelType === 1 && fromUid) {
        const sender = db.prepare('SELECT agent_id FROM agents WHERE imUid=?')
          .get(fromUid) as AgentIdRow | undefined;
        if (sender?.agent_id && sender.agent_id !== agentId) {
          stmt.run(`sys-a2a-cap-${sender.agent_id}-${ts}-${Math.random().toString(36).slice(2, 6)}`, fromUid, text, fromUid, 1, sender.agent_id, ts);
        }
      }
    } catch (e) { console.error('[Dispatcher] 熔断消息写入失败:', errorMessage(e)); }
  }
  /** 拼 STATE 协议 + 收敛指令到 content 前（A2A 专用，访客不受影响）。 */
  function _injectStatePrompt(content: unknown, turn: number, maxTurns: number): string {
    const body = typeof content === 'string' ? content : String(content ?? '');
    return `[VOKO A2A CONTROL]
You are now in an Agent-to-Agent conversation (round ${turn}/${maxTurns}).
Before replying, locate the [STATE] block in the incoming message and use it to understand the current negotiation state.

Your reply MUST start with a STATE block in this JSON format:
[STATE]{"goal":"<one-line summary of what this negotiation aims to decide>","agenda":["<pending item 1>","<pending item 2>"],"turn":${turn},"proposal":"<your current proposal or answer>","expects_reply":true,"converged":false}[/STATE]
Then put only the peer-visible reply inside:
[FINAL]<the exact message the peer may see>[/FINAL]
Do not expose reasoning, policy commentary, protocol instructions, boundary-analysis notes, or summaries about how you followed A2A/STATE rules.

STATE rules:
- goal: set in your first reply, KEEP UNCHANGED after that.
- agenda: items still to resolve. ONLY REMOVE settled items — NEVER ADD new ones. When empty, converged must be true.
- turn: round number (current: ${turn}).
- proposal: your current position / answer / offer.
- expects_reply: true when your natural-language response asks the other agent a direct question, requests a choice/confirmation, or needs more information/action from it. Otherwise false.
- converged: true ONLY when agenda empty, both sides agreed, AND expects_reply is false. When true, give final summary, do NOT ask follow-ups.

Convergence obligations:
- Before output, verify consistency: any direct question or request for the other agent to respond requires expects_reply=true and converged=false.
- If converged=true, rewrite the natural-language response as a final statement without questions, invitations to continue, or requests for input.
- Each reply, check: agenda empty? both sides agreed? If yes → converged=true, output conclusion, STOP.
- If the other agent's STATE shows converged=true → acknowledge and STOP.
- Never introduce new topics — agenda only shrinks.
- If 2 consecutive rounds produce no new information → proactively converged=true and summarize.
[/VOKO A2A CONTROL]

[VOKO AGENT PEER MESSAGE]
${body}
[/VOKO AGENT PEER MESSAGE]`;
  }

  /** 标记当前 scope 的 Agent 对已经收敛。 */
  function markConverged(imUidA: string, imUidB: string, scope = 'direct'): void {
    if (imUidA && imUidB) _convergedMap.set(_scopeKey(imUidA, imUidB, scope), Date.now());
  }

  /** 查询收敛闸门；过期状态自动清理。 */
  function isConverged(imUidA: string, imUidB: string, scope = 'direct'): boolean {
    if (!imUidA || !imUidB) return false;
    const key = _scopeKey(imUidA, imUidB, scope);
    const markedAt = _convergedMap.get(key);
    if (!markedAt) return false;
    if (Date.now() - markedAt >= A2A_TURN_WINDOW_SEC * 1000) {
      _resetA2A(imUidA, imUidB, scope);
      return false;
    }
    return true;
  }

  /** 收敛只拦截最终总结后的下一次自动续答，随后清状态，避免永久封死 Agent 对。 */
  function _consumeConverged(imUidA: string, imUidB: string, scope: string): boolean {
    if (!isConverged(imUidA, imUidB, scope)) return false;
    _resetA2A(imUidA, imUidB, scope);
    return true;
  }

  /** 高频 A2A 按 scope 串行排队，避免多条消息在同一个延迟点同时释放。 */
  function _a2aRateDelay(imUidA: string, imUidB: string, scope: string): number {
    const key = _scopeKey(imUidA, imUidB, scope);
    const now = Date.now();
    const arr = (_a2aRateMap.get(key) || []).filter((timestamp: number) => now - timestamp < A2A_RATE_WINDOW_MS);
    arr.push(now);
    _a2aRateMap.set(key, arr);
    if (arr.length < A2A_RATE_THRESHOLD) return 0;
    const due = Math.max(now, _a2aDelayUntil.get(key) || now) + A2A_RATE_DELAY_MS;
    _a2aDelayUntil.set(key, due);
    return due - now;
  }

  function _a2aScope(payload: PushPayload): string {
    return payload.channelType === 2 ? `group:${payload.channelId}` : 'direct';
  }

  function _prepareA2A(agentId: string, payload: PushPayload): PreparedA2A {
    const meta = _metaOf(agentId);
    const peerUid = payload.senderUid || payload.fromUid;
    if (!meta.imUid || !_isAgentImUid(peerUid) || peerUid === meta.imUid) return { blocked: false, context: null };
    const scope = _a2aScope(payload);
    const context: A2AContext = {
      a2aManaged: true,
      a2aPeerUid: peerUid,
      a2aScope: scope,
    };

    if (_consumeConverged(meta.imUid, peerUid, scope)) {
      console.log(`[Dispatcher] A2A 已收敛，停推一次 agent=${agentId} from=${peerUid} scope=${scope}`);
      return { blocked: true, context };
    }

    const turns = _a2aTurnCount(meta.imUid, peerUid, scope);
    if (turns > A2A_MAX_TURNS) {
      const ch = payload.channelId || peerUid;
      console.log(`[Dispatcher] A2A 熔断 agent=${agentId} from=${peerUid} scope=${scope} turns=${turns}/${A2A_MAX_TURNS}`);
      _a2aCircuitBreak(agentId, ch, A2A_MAX_TURNS, peerUid, payload.channelType === 2 ? 2 : 1);
      _resetA2A(meta.imUid, peerUid, scope);
      return { blocked: true, context };
    }

    payload.content = _injectStatePrompt(payload.content, turns, A2A_MAX_TURNS);
    console.log(`[Dispatcher] A2A agent=${agentId} from=${peerUid} scope=${scope} turn=${turns}/${A2A_MAX_TURNS}`);
    return { blocked: false, context: { ...context, a2aTurn: turns }, delay: _a2aRateDelay(meta.imUid, peerUid, scope) };
  }

  /** 实际路由 push；统一保存回复上下文。 */
  function _enqueueRoute(agentId: string, payload: PushPayload, context: ReplyContext | null): void {
    const channelId = payload.channelId || payload.fromUid;
    const channelType = payload.channelType === 2 ? 2 : 1;
    const key = `${agentId}::${channelType}::${channelId}`;
    const previous = _conversationRoutes.get(key);
    const next = previous
      ? previous.catch(() => {}).then(() => _doRoute(agentId, payload, context))
      : _doRoute(agentId, payload, context);
    _conversationRoutes.set(key, next);
    void next.finally(() => {
      if (_conversationRoutes.get(key) === next) _conversationRoutes.delete(key);
    });
  }

  function _captureProviderBinding(agentId: string, payload: PushPayload): PushPayload {
    const channelId = payload.channelId || payload.fromUid;
    const channelType = payload.channelType === 2 ? 2 : 1;
    const binding = _bindingStore.getActive(agentId, channelId, channelType);
    return {
      ...payload,
      providerBinding: binding ? {
        id: binding.id,
        bindingVersion: binding.bindingVersion,
        providerType: binding.providerType,
        providerInstanceId: binding.providerInstanceId,
        deliveryMode: binding.deliveryMode,
        adapterType: binding.adapterType,
        nativeSessionId: binding.nativeSessionId,
        sessionOrigin: binding.sessionOrigin,
        channelId: binding.channelId,
        channelType: binding.channelType,
      } : null,
    };
  }

  function _bindingForRoute(agentId: string, binding: PushPayload['providerBinding'], route: RouteCacheEntry): PushPayload['providerBinding'] {
    if (!binding) return null;
    const mode = _providerMode(route.providerId);
    const bindingFamily = getProviderFamily(binding.providerType)?.type || binding.providerType;
    let compatible = bindingFamily === _providerFamily(route.providerId)
      && binding.adapterType === route.providerId
      && binding.deliveryMode === mode;
    const resolveInstance = (route.provider as any).getInstanceId
      || (route.provider as any)._instanceForAgent
      || (route.provider as any)._profileForAgent;
    if (compatible && binding.providerInstanceId && typeof resolveInstance === 'function') {
      try { compatible = String(resolveInstance.call(route.provider, agentId) || '') === String(binding.providerInstanceId); }
      catch (_) { compatible = false; }
    }
    if (compatible) return binding;
    if (binding.sessionOrigin !== 'caller') {
      try { _bindingStore.markStale(binding.id); } catch (_) {}
    }
    return null;
  }

  async function _doRoute(
    agentId: string,
    payload: PushPayload,
    a2aContext: ReplyContext | null = null,
  ): Promise<void> {
    let route = _routeProviderEntry(agentId, 'push');
    if (!route) {
      console.log(`[Dispatcher] agent=${agentId} 无可用 push 通道，留库等 agent pull (voko_fetch_new_messages)`);
      return;
    }
    try {
      const routedPayload = payload.channelType === 2
        ? { ...payload, turnId: payload.turnId || payload.messageId, senderUid: payload.senderUid || payload.fromUid, fromUid: payload.sessionTarget || `group:${payload.channelId}` }
        : { ...payload, turnId: payload.turnId || payload.messageId };
      const sourceType = a2aContext?.a2aManaged ? 'agent_peer' : 'visitor';
      const baseProviderPayload = {
        ...routedPayload,
        rawContent: payload.rawContent ?? payload.content,
        content: wrapPushContent(routedPayload.content, sourceType),
        securityContext: createMessageSecurityContext(sourceType),
        providerBinding: payload.providerBinding ?? null,
      };
      const replyContext = {
        agentId,
        turnId: baseProviderPayload.turnId,
        channelType: payload.channelType || 1,
        channelId: payload.channelId || baseProviderPayload.fromUid,
        senderUid: payload.senderUid || payload.fromUid,
        ...(a2aContext || {})
      };
      _rememberReplyContext(agentId, baseProviderPayload.fromUid, replyContext);
      const routeByProvider = new Map<DispatcherProvider, RouteCacheEntry>();
      const payloadByProvider = new Map<DispatcherProvider, PushPayload>();
      const result = await deliveryExecutor.execute({
        next: (excluded: Set<DispatcherProvider>) => {
          const nextRoute = _routeProviderEntry(agentId, 'push', excluded);
          if (!nextRoute) return null;
          routeByProvider.set(nextRoute.provider, nextRoute);
          return {
            providerId: nextRoute.providerId,
            providerType: String(_metaOf(agentId).backend_type || getProviderTransport(nextRoute.providerId)?.family || ''),
            deliveryMode: _providerMode(nextRoute.providerId),
            target: nextRoute.provider,
          };
        },
        invoke: async (candidate: any) => {
          const selectedRoute = routeByProvider.get(candidate.target)!;
          const providerPayload = {
            ...baseProviderPayload,
            providerBinding: _bindingForRoute(agentId, baseProviderPayload.providerBinding, selectedRoute),
          };
          payloadByProvider.set(candidate.target, providerPayload);
          return candidate.target.push!(providerPayload);
        },
        classify: deliveryOutcome,
        onSuccess: (candidate: any) => {
          const selectedRoute = routeByProvider.get(candidate.target)!;
          _lastDeliveredModes.set(agentId, candidate.deliveryMode);
          _cacheRouteIfCurrent(agentId, 'push', selectedRoute);
        },
        onFailure: (candidate: any, outcome: DeliveryOutcome, error: unknown) => {
          _forgetRoute(agentId, 'push', candidate.target);
          const providerPayload = payloadByProvider.get(candidate.target);
          if (outcome === 'not_delivered' && providerPayload?.providerBinding?.id && providerPayload.providerBinding.sessionOrigin !== 'caller') {
            try { _bindingStore.markStale(providerPayload.providerBinding.id); } catch (_) {}
          }
          const action = outcome === 'not_delivered' ? '尝试已启用备选' : '不跨通道重投';
          console.error(`[Dispatcher] push 结果=${outcome}，${action} agent=${agentId}:`, errorMessage(error));
        },
      });
      if (result.outcome === 'delivered') return;
      _removeReplyContext(replyContext);
      if (result.outcome === 'not_delivered') console.log(`[Dispatcher] agent=${agentId} 所有 push 通道失败，留库等 agent pull (voko_fetch_new_messages)`);
    } catch (err) {
      console.error(`[Dispatcher] push 异常 agent=${agentId}:`, errorMessage(err));
    }
  }

  /** 唯一 push 分发入口。无 provider 时不提前消费轮次，留给 pull 路径统一治理。 */
  function dispatch(agentId: string, payload: PushPayload): void {
    const provider = _routeProvider(agentId, 'push');
    if (!provider) {
      console.log(`[Dispatcher] agent=${agentId} 无可用 push 通道，留库等 agent pull (voko_fetch_new_messages)`);
      return;
    }
    const workingPayload = _captureProviderBinding(agentId, {
      ...payload,
      rawContent: payload.rawContent ?? payload.content,
    });
    const prepared = _prepareA2A(agentId, workingPayload);
    if (prepared.blocked) return;
    if (prepared.delay) {
      const meta = _metaOf(agentId);
      const context = prepared.context;
      if (!context || !meta.imUid) {
        _enqueueRoute(agentId, workingPayload, context);
        return;
      }
      const localAgentUid = meta.imUid;
      const peerUid = context.a2aPeerUid;
      const scope = context.a2aScope;
      console.log(`[Dispatcher] A2A 降速 agent=${agentId} from=${peerUid} 延迟 ${prepared.delay}ms`);
      setTimeout(() => {
        if (_consumeConverged(localAgentUid, peerUid, scope)) return;
        _enqueueRoute(agentId, workingPayload, context);
      }, prepared.delay);
      return;
    }
    _enqueueRoute(agentId, workingPayload, prepared.context);
  }

  /** pull 路径复用同一治理；被收敛/熔断的消息返回 null，否则返回注入 STATE 后的副本。 */
  function prepareForPull(agentId: string, row: PullMessageRow | null): PullMessageRow | null {
    if (!row) return null;
    if (row.channel_type === 2) {
      let mention: { all?: boolean; uids?: string[] } | null =
        typeof row.mention === 'object' ? row.mention : null;
      try {
        if (typeof row.mention === 'string') mention = JSON.parse(row.mention);
      } catch (_) {
        mention = null;
      }
      const self = _metaOf(agentId).imUid;
      const mentioned = !!(
        mention &&
        (mention.all || (
          typeof self === 'string' &&
          Array.isArray(mention.uids) &&
          mention.uids.includes(self)
        ))
      );
      if (!mentioned) return row;
    }
    const payload = {
      agentId,
      fromUid: row.from_uid,
      senderUid: row.from_uid,
      content: row.content,
      channelId: row.channel_id,
      channelType: row.channel_type || 1,
      messageId: row.id,
      timestamp: row.timestamp
    };
    const sourceType = row.from_uid === 'system'
      ? 'system'
      : (_isAgentImUid(row.from_uid) ? 'agent_peer' : 'visitor');
    const prepared = _prepareA2A(agentId, payload);
    const security = createMessageSecurityContext(sourceType);
    return prepared.blocked ? null : {
      ...row,
      content: payload.content,
      sourceType: security.sourceType,
      trustLevel: security.trustLevel,
    };
  }
  /** owner intervention 注入系统消息。sessionKey 构造 + 补偿 emit 已下沉到各 provider。 */
  async function steer(
    agentId: string,
    visitorId: string,
    content: string,
    replyContext: ReplyContext | null = null,
  ): Promise<unknown> {
    let route = _routeProviderEntry(agentId, 'steer');
    if (!route) return null;
    try {
      const turnId = String(replyContext?.turnId || replyContext?.interventionId || `steer-${Date.now()}`);
      if (replyContext) {
        _rememberReplyContext(agentId, visitorId, { ...replyContext, turnId });
      }
      const routeByProvider = new Map<DispatcherProvider, RouteCacheEntry>();
      const delivery = await deliveryExecutor.execute({
        next: (excluded: Set<DispatcherProvider>) => {
          const nextRoute = _routeProviderEntry(agentId, 'steer', excluded);
          if (!nextRoute) return null;
          routeByProvider.set(nextRoute.provider, nextRoute);
          return {
            providerId: nextRoute.providerId,
            providerType: String(_metaOf(agentId).backend_type || getProviderTransport(nextRoute.providerId)?.family || ''),
            deliveryMode: _providerMode(nextRoute.providerId),
            target: nextRoute.provider,
          };
        },
        invoke: (candidate: any) => candidate.target.steer!(agentId, visitorId, wrapPushContent(content, 'owner'), { turnId }),
        classify: deliveryOutcome,
        onSuccess: (candidate: any) => {
          _lastDeliveredModes.set(agentId, candidate.deliveryMode);
          _cacheRouteIfCurrent(agentId, 'steer', routeByProvider.get(candidate.target)!);
        },
        onFailure: (candidate: any, outcome: DeliveryOutcome, error: unknown) => {
          _forgetRoute(agentId, 'steer', candidate.target);
          const action = outcome === 'not_delivered' ? '尝试已启用备选' : '不跨通道重投';
          console.error(`[Dispatcher] steer 结果=${outcome}，${action} agent=${agentId}:`, errorMessage(error));
        },
      });
      if (delivery.outcome === 'delivered') return delivery.result;
      if (replyContext) {
        const queue = _replyContexts.get(_replyContextKey(agentId, visitorId));
        const context = queue?.find((item) => item.turnId === turnId);
        if (context) _removeReplyContext(context);
      }
      return null;
    } catch (err) {
      console.error(`[Dispatcher] steer 失败 agent=${agentId}:`, errorMessage(err));
      return null;
    }
  }

  async function start() {
    try { await runtimeRegistry.startAll(); } catch (e) { console.error('[Dispatcher] provider.start 失败:', errorMessage(e)); }
    try {
      const rows = db.prepare('SELECT agent_id FROM agents').all() as Array<{ agent_id?: string }>;
      for (const row of rows) {
        const agentId = String(row?.agent_id || '').trim();
        if (!agentId) continue;
        _routeProvider(agentId, 'push');
        _routeProvider(agentId, 'steer');
      }
    } catch (e) {
      console.error('[Dispatcher] provider 路由初始化失败:', errorMessage(e));
    }
  }
  async function addProviders(additions: Record<string, DispatcherProvider>) {
    const pending = Object.fromEntries(Object.entries(additions).filter(([key]) => !providers[key]));
    for (const [key, provider] of Object.entries(pending)) {
      attachReplyProvider(provider);
      _providerIds.set(provider, key);
    }
    const added = await runtimeRegistry.add(pending);
    for (const key of added) {
      invalidateRoutes({ providerId: key, available: true, reason: 'provider-added' });
    }
  }
  async function stop() {
    try { await runtimeRegistry.stopAll(); } catch (e) { console.error('[Dispatcher] provider.stop 失败:', errorMessage(e)); }
  }
  /** 自检 + 重连（替代散落的 60s 心跳 spawn 逻辑）。 */
  async function healthCheck() {
    try { return await runtimeRegistry.healthCheck(); }
    catch (e) { console.error('[Dispatcher] provider.healthCheck 失败:', errorMessage(e)); return {}; }
  }

  /** 按 Agent 配置变更失效 provider 会话绑定（转发到绑定存储）。 */
  function invalidateBindingsForConfigChange(input: {
    agentId: string;
    prevProviderType: string;
    prevInstanceId: string | null;
    nextProviderType: string;
    nextInstanceId: string | null;
  }): number {
    try { return _bindingStore.invalidateForAgentConfigChange(input); }
    catch (e) { console.error('[Dispatcher] invalidateBindingsForConfigChange 失败:', errorMessage(e)); return 0; }
  }

  return { dispatch, prepareForPull, resolveProvider, resolveProviders, getAgentDeliveryStatus, steer, start, stop, addProviders, healthCheck, invalidateMeta, invalidateRoutes, markConverged, isConverged, resetA2AForAgent, isAgentImUid: _isAgentImUid, invalidateBindingsForConfigChange, providers: runtimeRegistry.providers };
}

module.exports = { createDispatcher };
