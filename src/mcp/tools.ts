export {};

/**
 * VOKO MCP — 工具处理器集合
 *
 * 工具数量随版本演进，以 server.ts 的 server.tool() 注册为准（可通过 getToolList() 枚举）。
 * 零 Electron 依赖，所有外部依赖通过 context (cx) 注入。
 * 全部通过 createToolHandlers(cx) 工厂函数创建。
 */

const ENDPOINTS = require('../endpoints.json');
const { createAgentInvitation } = require('../core/agent-invitations');
const groupClient = require('../core/group-client');
const { t } = require('../core/i18n');
const { normalizeBackendType } = require('../core/agent-backend-types');
const { createRegistrationOrchestrator } = require('../core/registration-orchestrator');
const { createPullSecurityContext } = require('../core/dispatcher/safety-prompt');
const { getProviderTransport } = require('../core/dispatcher/provider-catalog');
const { getProviderCaller } = require('../core/registration-caller-context');
const { ProviderSessionCoordinator } = require('../core/provider-session-coordinator');
const { AgentIdentityBindingStore } = require('../core/provider-agent-identity');
const { MessageRouteStore, RoutingConversationStore, fingerprintProviderSession,
  isRoutingPolicyEligible, normalizeProviderFamily } = require('../core/provider-routing');
const { AgentDeliveryPolicyStore } = require('../core/agent-delivery-policy');
const { AgentProviderBindingService } = require('../core/agent-provider-binding');
const { discoverWorkBuddyAgents } = require('../core/dispatcher/workbuddy-agents');
const { discoverProviderInstances } = require('../core/dispatcher/provider-instances');
const { resolveOwnerInterventionConversation } = require('../core/owner-intervention-routing');
const { ownerInterventionExpireTime } = require('../core/owner-intervention-expiry');
const { resolveActiveOwnerInterventionContext, notifyOwnerInterventionCreated } = require('../core/owner-intervention-active-context');
const { reservedVisitorPrefix } = require('../core/visitor-id-policy');
const { advanceCheckpoint, getCheckpoint, setCheckpoint } = require('../core/checkpoint-store');
// A2A 协议块剥离（入站 agent_peer 消息被 dispatcher 注入控制块，pull 时需剥掉）。
// 注意：入站剥离逻辑（_stripInboundControlBlock）与出站的 extractA2AVisibleReply 不同——
// 入站包装是 [VOKO A2A CONTROL]+[VOKO AGENT PEER MESSAGE]，出站回复才用 [STATE]/[FINAL]。
import type { LiteContext } from '../context';
import type { RoutingConversation } from '../core/provider-routing';

/**
 * 剥离入站 agent_peer 消息被 dispatcher 注入的协议包装，只保留对端可见正文。
 *
 * dispatcher._injectStatePrompt 会把入站 A2A 消息包装成：
 *   [VOKO A2A CONTROL]...指令...[/VOKO A2A CONTROL]\n\n[VOKO AGENT PEER MESSAGE]\n{body}\n[/VOKO AGENT PEER MESSAGE]
 * pull 路径要把这层包装剥掉，只暴露 {body}，避免把指令文本泄漏给 MCP 客户端。
 * 注意：与 extractA2AVisibleReply（出站取 [FINAL]）不同——入站要的是 AGENT PEER MESSAGE body。
 */
function _stripInboundControlBlock(content: string): string {
  if (!content || typeof content !== 'string') return content || '';
  // 优先提取 [VOKO AGENT PEER MESSAGE]...[/VOKO AGENT PEER MESSAGE] 之间的正文
  const peerMsg = content.match(/\[VOKO AGENT PEER MESSAGE\]([\s\S]*?)\[\/VOKO AGENT PEER MESSAGE\]/i);
  if (peerMsg) return peerMsg[1].trim();
  // 兜底：仅剥掉 [VOKO A2A CONTROL]...[/VOKO A2A CONTROL] 指令块（无 AGENT PEER MESSAGE 包装时）
  const stripped = content.replace(/\[VOKO A2A CONTROL\][\s\S]*?\[\/VOKO A2A CONTROL\]\s*/gi, '').trim();
  return stripped;
}

/** 把存储的时间戳规范化为毫秒，并判断是否疑似 A2A 控制块内容。 */
function _normalizeTimestamp(ts: number | null | undefined): { timestamp: number | null; timestampMs: number | null } {
  if (!ts || typeof ts !== 'number') return { timestamp: ts ?? null, timestampMs: null };
  // < 1e12 视为秒级（毫秒级时间戳至少 13 位），统一换算到毫秒
  const ms = ts < 1e12 ? ts * 1000 : ts;
  return { timestamp: ts, timestampMs: ms };
}
/** 探测 content 是否含 A2A 协议控制块（[STATE]/[FINAL]/[VOKO A2A CONTROL]）。 */
function _hasControlBlock(content: string): boolean {
  if (!content || typeof content !== 'string') return false;
  return /\[STATE\]|\[\/STATE\]|\[FINAL\]|\[\/FINAL\]|\[VOKO A2A CONTROL\]/i.test(content);
}
import type { DatabaseLike } from '../types/database';

// tools.ts 包含按条件拼接的动态 SQL；结果列随工具变化，暂时集中保留在这一处，
// 后续按消息、支付、群组三组 row 类型逐批替换，避免在每个 handler 扩散 any。
type DynamicRow = Record<string, any>;

interface MessageDbRow {
  id: string;
  channel_id: string;
  from_uid: string;
  to_uid: string;
  content: string;
  timestamp: number;
  message_seq: number | null;
  is_me: number;
  content_type: number | null;
  agent_id: string | null;
  channel_type: number | null;
  mention?: string | null;
  client_msg_no?: string | null;
  sourceType?: 'visitor' | 'agent_peer' | 'owner' | 'system';
  trustLevel?: 'untrusted' | 'untrusted_peer' | 'trusted_owner' | 'trusted_system';
  routing_conversation_id?: string | null;
}

interface AgentDbRow extends DynamicRow {
  agent_id: string;
  agent_name?: string | null;
  imUid?: string | null;
  owner_email?: string | null;
  visibility_type?: number | null;
}

interface ConversationDbRow extends DynamicRow {
  channel_id: string;
  channel_type: number;
  name?: string | null;
  avatar?: string | null;
  last_message?: string | null;
  last_timestamp?: number | null;
  unread_count?: number | null;
  agent_id?: string | null;
}

interface InterventionDbRow extends DynamicRow {
  id: string;
  ask_time: number;
  created_at: number;
}

interface PaymentOrderDbRow extends DynamicRow {
  id: string;
  amount: number;
  status: string;
  created_at: number;
}

interface PaymentAuthDbRow extends DynamicRow {
  id: string;
  owner_email?: string | null;
  name?: string | null;
  bank_card?: string | null;
  id_card?: string | null;
  phone?: string | null;
  request_no?: string | null;
  receiver_apply_status?: string | null;
}

interface PaymentAuthDetailRow extends PaymentAuthDbRow {
  receiver_type?: number | null;
  company_name?: string | null;
  unified_social_credit_code?: string | null;
  legal_name?: string | null;
  legal_licence_no?: string | null;
  bank_code?: string | null;
  status?: string | null;
  payment_user_uid?: string | null;
  request_no?: string | null;
  receiver_apply_status?: string | null;
  receiver_no?: string | null;
}

interface PaymentAgentRow {
  owner_email?: string | null;
  did?: string | null;
  private_key?: string | null;
}

interface PaymentFeeRow {
  payment_fee_rate?: number | null;
  agent_usage_fee_rate?: number | null;
}

interface PaymentApiResult {
  code: number;
  msg?: string;
  message?: string;
  data: Record<string, unknown>;
}

interface BankDbRow {
  code: string;
  name: string;
  short_name: string | null;
}

interface GroupMember {
  uid: string;
  role?: string | null;
  mute_until?: string | null;
}

interface AgentUidRow {
  imUid: string;
}

interface UserCacheRow {
  nickname: string | null;
}

interface GroupHistoryRow {
  id: string;
  from_uid: string;
  content: string;
  timestamp: number;
  content_type: number;
  message_seq: number | null;
  client_msg_no: string | null;
  mention: string | null;
}

interface ChannelRow {
  channel_id: string;
  channel_type: number;
}

interface MaxSequenceRow {
  max_seq: number | null;
}

interface PollController {
  aborted: boolean;
  abort?: () => void;
}

interface PullDispatcher {
  prepareForPull?(agentId: string | undefined, row: MessageDbRow): MessageDbRow | null | undefined;
}

interface GroupSummary {
  status?: string | null;
  dissolved_at?: number | string | null;
  [key: string]: unknown;
}

interface ConfigDataRow {
  data: string;
}

interface AgentRegistrationLike {
  sendCode(...args: unknown[]): Promise<RegistrationOperationResult>;
  loginByCode(...args: unknown[]): Promise<RegistrationOperationResult>;
  getOAuthProviders(...args: unknown[]): Promise<RegistrationOperationResult>;
  startOAuthSession(...args: unknown[]): Promise<RegistrationOperationResult>;
  getOAuthSession(...args: unknown[]): Promise<RegistrationOperationResult>;
  exchangeOAuthSession(...args: unknown[]): Promise<RegistrationOperationResult>;
  verifyCodePreview(...args: unknown[]): Promise<RegistrationOperationResult>;
  verifyCode(...args: unknown[]): Promise<RegistrationOperationResult>;
  registerAgentInDb(...args: unknown[]): Promise<RegistrationOperationResult>;
  updateAgentBinding(...args: unknown[]): Promise<RegistrationOperationResult>;
  createAgentByToken(...args: unknown[]): Promise<RegistrationOperationResult>;
}

interface RegistrationOperationResult {
  success?: boolean;
  error?: string;
  noToken?: boolean;
  userExists?: boolean;
  agents?: unknown;
  data?: unknown;
}

interface RegistrationAgentSummary extends Record<string, unknown> {
  agentId: string;
}

interface VerifiedRegistrationData extends Record<string, unknown> {
  agentId?: string;
  agents: RegistrationAgentSummary[];
  imUid: string;
  imToken: string;
  did: string;
  publicKey: string;
  privateKey: string;
  agentName?: string;
  imServerUrl?: string;
  loginToken?: string;
}

interface CreatedRegistrationData extends Record<string, unknown> {
  agentId: string;
  imUid: string;
  imToken: string;
  did: string;
  publicKey: string;
  privateKey: string;
  name?: string;
  agentName?: string;
}

type McpContext = Omit<LiteContext,
  | 'db' | 'query' | 'exec' | 'agentRegistration'
  | 'getAgentStatus' | 'startAgentWorker' | 'waitForAgentConnection' | 'stopAgentWorker'
  | 'registerCapabilities' | 'sendMessage' | 'checkReceiveChannel'
  | 'uploadFileToOSS' | 'getPaymentAuth' | 'getAgentImUid'
  | 'savePaymentOrder' | 'toggleWhitelistMode' | 'wukongim'
> & {
  db: DatabaseLike;
  query<T = DynamicRow>(sql: string, params?: unknown[]): T[];
  exec(sql: string, params?: unknown[]): { changes?: number | bigint };
  agentRegistration: AgentRegistrationLike;
  getAgentStatus?(agentId?: string): DynamicRow | null;
  startAgentWorker?(agentId?: string, config?: unknown, appPaths?: unknown): unknown;
  waitForAgentConnection?(agentId?: string, timeoutMs?: number): Promise<DynamicRow | undefined>;
  stopAgentWorker?(agentId?: string): Promise<unknown> | unknown;
  registerCapabilities?(agentId?: string, options?: DynamicRow): Promise<DynamicRow>;
  sendMessage(agentId?: string, toUid?: string, content?: string, fromUid?: string, messageType?: string, channelType?: number, mentions?: unknown, requestedMessageId?: string, metadata?: unknown): Promise<DynamicRow>;
  checkReceiveChannel?(agentId?: string): { ok: boolean; channel?: string; suggest?: string | null };
  uploadFileToOSS?(filePath?: string, objectName?: string, mimeType?: string, agentId?: string,
    uploadOptions?: { targetScopeType?: string; targetScopeId?: string }): Promise<unknown>;
  secureOutboundRouter?: { prepare(agentId:string,channelId:string,channelType?:number,metadata?:unknown,
    purpose?:'text'|'attachment'):Promise<{
    success:boolean;securityMode:'e2ee'|'plaintext';securityReason:string;error?:string;
    encryptedDeviceCount:number }> };
  getPaymentAuth?(agentId?: string): unknown;
  getAgentImUid?(agentId?: string): string;
  savePaymentOrder(order: DynamicRow): unknown;
  toggleWhitelistMode?(params: { agentId?: string; enabled?: boolean }): Promise<unknown>;
  getEnabledChannel?(): DynamicRow | null;
  enqueueOwnerIntervention?(record: DynamicRow): unknown;
  processPaymentOrder?(order: DynamicRow): Promise<unknown>;
  a2aMailboxClient?: {
    discoverRemote(localAgentId: string, cardUrl: string, credential?: string): Promise<DynamicRow>;
    sendOutbound(input: DynamicRow): Promise<DynamicRow>;
    getOutboundTask(taskId: string): Promise<DynamicRow>;
    cancelOutboundTask(localAgentId: string, taskId: string): Promise<DynamicRow>;
  };
  ownerPullService?: {
    fetch(agentId: string): DynamicRow;
    complete(agentId: string, messageId: string, claimId: string, content?: string): DynamicRow;
    fail(agentId: string, messageId: string, claimId: string, errorCode?: string): DynamicRow;
  };
  wukongim?: {
    getCurrentUid?(agentId?: string): string;
  };
};

interface MentionParams {
  all?: boolean;
  uids?: string[];
}

function toolErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toolErrorHasNoToken(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { noToken?: unknown }).noToken === true;
}

type WorkerConnectionStatus = {
  connected?: boolean;
  status?: string;
  error?: string;
  [key: string]: unknown;
};

async function waitForStartedAgentConnection(
  cx: Pick<McpContext, 'waitForAgentConnection'>,
  agentId: string,
  status: WorkerConnectionStatus | undefined,
): Promise<WorkerConnectionStatus | undefined> {
  if (status?.status === 'connecting' && cx.waitForAgentConnection) {
    const waited = await cx.waitForAgentConnection(agentId, 5000) as WorkerConnectionStatus | undefined;
    return waited || status;
  }
  return status;
}

function registrationRuntimeStatus(cx: any, agentId: string, imStatus?: WorkerConnectionStatus): any {
  const connected = imStatus?.connected === true || imStatus?.status === 'connected';
  const failed = !!imStatus?.error || imStatus?.status === 'connect_fail' || imStatus?.status === 'failed';
  const workerStatus = failed ? 'failed' : connected ? 'running' : imStatus ? 'starting' : 'not_started';
  let providerDelivery: any = null;
  try {
    const status = cx.getAgentDeliveryStatus?.(agentId);
    if (status && typeof status === 'object') {
      providerDelivery = {
        backendType: status.backendType || null,
        configuredModes: Array.isArray(status.configuredModes) ? status.configuredModes : [],
        automaticDeliveryReady: status.automaticDeliveryReady === true,
        automaticReadyModes: Array.isArray(status.automaticReadyModes) ? status.automaticReadyModes : [],
        activeAutomaticMode: status.activeAutomaticMode || null,
        pullReady: status.pullReady !== false,
        lastDeliveredMode: status.lastDeliveredMode || null,
        methods: Array.isArray(status.methods) ? status.methods : [],
      };
    }
  } catch (_) {}
  if (!providerDelivery) {
    try {
      const row = cx.query?.('SELECT backend_type, backend_instance_id, delivery_modes FROM agents WHERE agent_id=? LIMIT 1', [agentId])?.[0] || {};
      const parsed = typeof row.delivery_modes === 'string' ? JSON.parse(row.delivery_modes) : row.delivery_modes;
      const configuredModes = Array.isArray(parsed) ? parsed.map(String) : ['pull'];
      providerDelivery = {
        backendType: row.backend_type || 'others',
        instanceBound: !!row.backend_instance_id,
        configuredModes,
        automaticDeliveryReady: false,
        automaticReadyModes: [],
        activeAutomaticMode: null,
        pullReady: configuredModes.includes('pull'),
        lastDeliveredMode: null,
        methods: [],
      };
    } catch (_) {}
  }
  return {
    creationStatus: 'created',
    workerStatus,
    providerDelivery,
    ...(imStatus ? {
      imConnection: { connected, status: imStatus.status || (connected ? 'connected' : 'unknown') },
    } : {}),
    ...(!connected ? {
      recoveryAction: { action: 'start_worker', agentId, message: '可稍后通过 start_worker 重试 IM 连接' },
    } : {}),
  };
}

function isGroupSummary(value: unknown): value is GroupSummary {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function readPaymentApiResult(response: {
  ok?: boolean;
  status?: number;
  json(): Promise<unknown>;
}): Promise<PaymentApiResult> {
  let value: unknown;
  try {
    value = await response.json();
  } catch (error) {
    if (response.ok === false) throw new Error(`HTTP ${response.status || 500}`);
    throw error;
  }
  if (!isRecord(value) || typeof value.code !== 'number') {
    if (response.ok === false) throw new Error(`HTTP ${response.status || 500}`);
    throw new Error(t('mcp.payment.invalid_response'));
  }
  if (value.data !== undefined && !isRecord(value.data)) {
    throw new Error(t('mcp.payment.invalid_response'));
  }
  return {
    code: value.code,
    msg: typeof value.msg === 'string' ? value.msg : undefined,
    message: typeof value.message === 'string' ? value.message : undefined,
    data: isRecord(value.data) ? value.data : {},
  };
}

function optionalString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function optionalFeeRate(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : NaN;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function registrationAgentSummaries(value: unknown): RegistrationAgentSummary[] | null {
  if (!Array.isArray(value)) return null;
  const agents: RegistrationAgentSummary[] = [];
  for (const item of value) {
    if (!isRecord(item) || !nonEmptyString(item.agentId)) return null;
    agents.push(item as RegistrationAgentSummary);
  }
  return agents;
}

function verifiedRegistrationData(value: unknown): VerifiedRegistrationData | null {
  if (!isRecord(value)) return null;
  const agents = registrationAgentSummaries(value.agents);
  if (!agents || agents.length === 0
    || !nonEmptyString(value.imUid)
    || !nonEmptyString(value.imToken)
    || !nonEmptyString(value.did)
    || !nonEmptyString(value.publicKey)
    || !nonEmptyString(value.privateKey)) {
    return null;
  }
  if (value.imServerUrl !== undefined && !nonEmptyString(value.imServerUrl)) return null;
  return { ...value, agents } as VerifiedRegistrationData;
}

function selectedRegistrationAgentId(
  data: VerifiedRegistrationData,
  requestedAgentId: unknown,
  requestedAgentName: unknown,
): string | null {
  if (nonEmptyString(data.agentId)) return data.agentId;
  if (nonEmptyString(requestedAgentId)
    && data.agents.some(agent => agent.agentId === requestedAgentId)) {
    return requestedAgentId;
  }
  if (nonEmptyString(requestedAgentName)) {
    const match = data.agents.find(agent => agent.name === requestedAgentName);
    if (match) return match.agentId;
  }
  return data.agents.length === 1 ? data.agents[0].agentId : null;
}

function createdRegistrationData(value: unknown, fallbackAgentId: unknown): CreatedRegistrationData | null {
  if (!isRecord(value)) return null;
  const agentId = nonEmptyString(value.agentId)
    ? value.agentId
    : nonEmptyString(fallbackAgentId) ? fallbackAgentId : null;
  if (!agentId
    || !nonEmptyString(value.imUid)
    || !nonEmptyString(value.imToken)
    || !nonEmptyString(value.did)
    || !nonEmptyString(value.publicKey)
    || !nonEmptyString(value.privateKey)) {
    return null;
  }
  return { ...value, agentId } as CreatedRegistrationData;
}

interface McpToolParams {
  _e2eeAttachmentSource?: { filePath:string;fileName:string;mediaType:string };
  _requestedMessageId?: string;
  ability?: unknown;
  action?: string;
  actionType?: string;
  address?: string;
  agentId?: string;
  agentName?: string;
  amount?: number;
  applyId?: string;
  approve_mode?: string;
  approved?: boolean;
  approvalToken?: string;
  accessMode?: string;
  avatar?: string;
  bankCard?: string;
  bankCode?: string;
  bankName?: string;
  backendType?: string;
  backendInstanceId?: string;
  blockTimeout?: number;
  category?: string;
  challenge?: string;
  claimId?: string;
  channelId?: string;
  channelType?: number | 'all' | 'direct' | 'group';
  /** MCP 客户端自报身份（如 'zcode'/'codex'/'cursor'），用于游标隔离，避免多客户端互抢消息。 */
  clientId?: string;
  /** fetch_new_messages：起始游标（message_seq），覆盖自动游标。与 messageSeq 同义。 */
  cursor?: number;
  code?: string;
  contact_phone?: string;
  content?: string;
  cardUrl?: string;
  credential?: string;
  contentType?: number | string;
  description?: string;
  direction?: string;
  durationMinutes?: number;
  durationSeconds?: number;
  email?: string;
  enabled?: boolean;
  expiresInSeconds?: number;
  fileName?: string;
  filePath?: string;
  filter?: string;
  friendEmail?: string;
  iconUrl?: string;
  id?: string;
  idCard?: string;
  keyword?: string;
  limit?: number;
  listType?: string;
  maxUses?: number;
  members?: string[];
  mentions?: MentionParams;
  message?: string;
  messageId?: string;
  messageSeq?: number;
  mode?: string;
  muted?: boolean;
  name?: string;
  notice?: string;
  offset?: number;
  onlyReplies?: boolean;
  /** fetch_new_messages：true=首次拉取只设锚点不回吐历史（默认，避免吞历史→后续空等）。 */
  onlyNew?: boolean;
  /** get_chat_history：'desc'（默认，最新在前）| 'asc'（最旧在前）。 */
  order?: 'desc' | 'asc';
  orderId?: string;
  ownerEmail?: string;
  provider?: string;
  sessionId?: string;
  exchangeCode?: string;
  page?: number;
  page_size?: number;
  paymentAuthId?: string;
  phone?: string;
  price?: number;
  pricingModel?: 'free' | 'timed';
  problem?: string;
  providerType?: string;
  prompt?: string;
  reason?: string;
  registrationId?: string;
  registrationMode?: 'human' | 'agent';
  ruleId?: string;
  searchable?: number;
  short_description?: string;
  since?: number;
  status?: number | string;
  suggestion?: string;
  tags?: string;
  targetUid?: string;
  taskId?: string;
  toUid?: string;
  trialMinutes?: number;
  instanceId?: string;
  deliveryModes?: string[];
  conversationId?: string;
  replyToMessageId?: string;
  /** Web UI browser-only draft: create a logical Conversation with the first send. */
  webConversationStart?: boolean;
  /** Existing Conversation that the browser-only draft was started from. */
  parentConversationId?: string;
  remoteAgentKey?: string;
  idempotencyKey?: string;
  webRequest?: boolean;
  visibility?: number;
  visitorId?: string;
}

/**
 * 归一化文件消息 content。
 * 支持：JSON 字符串 / 普通对象 / 纯 URL 字符串。
 * 纯 URL 会自动提取文件名并补全 {url, name, size, type}。
 */
function normalizeFileContent(content?: unknown) {
  // 1. 如果是对象，先序列化
  if (content && typeof content === 'object') {
    return JSON.stringify(content);
  }
  if (typeof content !== 'string') {
    return JSON.stringify({ url: String(content || ''), name: '', size: 0, type: '' });
  }

  const trimmed = content.trim();

  // 2. 尝试解析 JSON
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const obj = JSON.parse(trimmed);
      const url = obj.url || obj.fileUrl || '';
      const name = obj.name || obj.fileName || extractFileNameFromUrl(url) || '';
      const size = typeof obj.size === 'number' ? obj.size : (typeof obj.fileSize === 'number' ? obj.fileSize : 0);
      const type = obj.type || obj.mimeType || '';
      return JSON.stringify({ url, name, size, type });
    } catch (_: any) {
      // 解析失败则按普通字符串/URL 处理
    }
  }

  // 3. 纯 URL 或普通文本：包装成文件 JSON
  const isUrl = /^https?:\/\//i.test(trimmed);
  const url = isUrl ? trimmed : '';
  const name = isUrl ? (extractFileNameFromUrl(trimmed) || '') : trimmed;
  return JSON.stringify({ url, name, size: 0, type: '' });
}

function extractFileNameFromUrl(url?: string) {
  if (!url) return '';
  try {
    const pathname = new URL(url).pathname;
    const parts = pathname.split('/');
    const last = parts[parts.length - 1];
    return decodeURIComponent(last) || '';
  } catch (_: any) {
    return '';
  }
}

/**
 * 通过 HEAD 请求探测远程文件的 size 和 MIME type。
 * 失败时返回 { size: 0, type: '' }，不影响发送。
 */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const ATTACHMENT_MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.mp4': 'video/mp4', '.pdf': 'application/pdf',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip', '.mp3': 'audio/mpeg', '.txt': 'text/plain', '.json': 'application/json',
};
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);

function inspectAttachment(p: McpToolParams) {
  const fs = require('fs');
  const path = require('path');
  if (!p.filePath) return { success: false, error: '缺少 filePath' };
  if (!fs.existsSync(p.filePath)) return { success: false, error: '文件不存在: ' + p.filePath };
  const stat = fs.statSync(p.filePath);
  if (!stat.isFile()) return { success: false, error: 'filePath 不是文件' };
  if (stat.size > MAX_ATTACHMENT_BYTES) return { success: false, error: '文件超过 25 MB 限制' };
  const fileName = p.fileName || path.basename(p.filePath);
  const ext = path.extname(fileName).toLowerCase();
  const mimeType = typeof p.contentType === 'string' ? p.contentType : (ATTACHMENT_MIME_TYPES[ext] || 'application/octet-stream');
  return { success: true, filePath: p.filePath, fileName, fileSize: stat.size, mimeType,
    contentType: IMAGE_EXTENSIONS.has(ext) ? 2 : 8, ext };
}

async function uploadAttachment(cx: McpContext, p: McpToolParams) {
  if (!cx.uploadFileToOSS) return { success: false, error: '上传服务不可用' };
  const inspected = inspectAttachment(p);
  if (!inspected.success) return inspected;
  const { filePath, fileName, fileSize, mimeType, contentType, ext } = inspected as any;
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_') || 'attachment';
  const dir = IMAGE_EXTENSIONS.has(ext) ? 'chat/images' : 'chat/files';
  const objectName = `${dir}/${Date.now()}-${require('crypto').randomUUID()}-${safeName}`;
  try {
    const channelType = Number(p.channelType) === 2 ? 2 : 1;
    const targetScopeType = channelType === 2 ? 'group' : 'private';
    const targetScopeId = String(p.toUid || p.channelId || '').trim();
    const uploadedUrl = await cx.uploadFileToOSS(filePath, objectName, mimeType, p.agentId,
      { targetScopeType, targetScopeId });
    const url = String(uploadedUrl || '').startsWith('/api/uploads/')
      ? `${uploadedUrl}?channelType=${channelType}&channelId=${encodeURIComponent(targetScopeId)}`
      : String(uploadedUrl || '');
    return {
      success: true,
      url,
      fileName,
      fileSize,
      mimeType,
      contentType,
    };
  } catch (e: any) {
    return { success: false, error: '上传失败: ' + e.message };
  }
}

function createToolHandlers(cx: McpContext) {
  const providerBindings = new ProviderSessionCoordinator(cx.db);
  const identityBindings = new AgentIdentityBindingStore(cx.db);
  const routingConversations = new RoutingConversationStore(cx.db);
  const messageRoutes = new MessageRouteStore(cx.db);
  const featureEnabled = (name: string, defaultValue = false): boolean => {
    const envName = `VOKO_${name.toUpperCase()}`;
    const envValue = process.env[envName];
    if (envValue != null) return /^(1|true|yes|on)$/i.test(envValue);
    try {
      const row = cx.query<{ data?: string }>('SELECT data FROM config WHERE type=? LIMIT 1', [`feature:${name}`])[0];
      if (!row?.data) return defaultValue;
      const parsed = JSON.parse(row.data);
      return parsed === true || parsed?.enabled === true;
    } catch (_) { return defaultValue; }
  };
  // These tools can change identity, access, external delivery or payment
  // state. MCP definitions mark mutations as destructive; retain a minimal
  // local audit trail without persisting arguments, credentials or content.
  const highRiskTools = new Set([
    'create_agent_by_token', 'manage_whitelist', 'manage_blacklist', 'set_private_mode',
    'send_email', 'reply_email', 'add_payment_auth', 'delete_payment_auth',
    'apply_payment_auth', 'bind_agent_payment_auth', 'invite_friend',
  ]);
  const recordHighRiskTool = (toolName: string, params: McpToolParams, success: boolean) => {
    if (!highRiskTools.has(toolName)) return;
    try {
      cx.exec(
        'INSERT INTO mcp_security_events (id, tool_name, agent_id, success, created_at) VALUES (?, ?, ?, ?, ?)',
        [`mcpsec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, toolName, params?.agentId || null, success ? 1 : 0, Date.now()],
      );
    } catch (_) { /* Auditing must not turn a completed user action into a failure. */ }
  };
  const prepareRegisteredAgentBackend = async (agentId: string, backendType: string) => {
    const dispatcher = (global as any).__dispatcher;
    if (!dispatcher) return;
    try {
      await dispatcher.ensureBackend?.(backendType);
      dispatcher.invalidateMeta?.(agentId);
    } catch (error: any) {
      // Agent creation remains successful with Pull as the safe fallback.
      console.error(`[AgentRegistration] Provider runtime load failed agent=${agentId}:`, error?.message || String(error));
    }
  };
  const syncRegisteredAgentProfile = async (agentId: string, p: McpToolParams, name: string, backendType: string) => {
    const result = await cx.updateAgentProfile({
      agentId,
      name,
      description: p.description ?? '',
      category: p.category || 'general',
      tags: Array.isArray(p.tags) ? p.tags : [],
      icon_url: p.iconUrl || '',
      contact_phone: p.contact_phone || '',
      address: p.address || '',
      backendType,
    });
    if (result?.success === false) {
      return {
        success: false,
        creationStatus: 'created',
        agentId,
        error: `Agent 已创建，但资料同步到服务端失败：${result.error || result.message || '未知错误'}`,
      };
    }
    return null;
  };
  const inferChannelType = (params: McpToolParams): number => {
    if (params.channelType !== undefined && params.channelType !== null) {
      return Number(params.channelType) === 2 ? 2 : 1;
    }
    const channelId = String(params.toUid || params.channelId || '').trim();
    if (!channelId) return 1;
    if (/^group[_-]/i.test(channelId)) return 2;
    try {
      if (cx.query("SELECT 1 AS found FROM conversations WHERE channel_id=? AND channel_type=2 LIMIT 1", [channelId]).length > 0) return 2;
      if (cx.query("SELECT 1 AS found FROM messages WHERE channel_id=? AND channel_type=2 LIMIT 1", [channelId]).length > 0) return 2;
    } catch (_) { /* inference is best-effort; direct chat remains the safe fallback */ }
    return 1;
  };
  const resolveStatusNotificationRoute = (p: McpToolParams) => {
    const resolution = resolveOwnerInterventionConversation(cx.db, {
      agentId: p.agentId,
      channelId: p.visitorId,
      channelType: 1,
      caller: getProviderCaller(),
      sourceMessageId: p.replyToMessageId || null,
      conversationId: p.conversationId || null,
    });
    return resolution.status === 'resolved'
      ? { route: { conversationId: resolution.conversationId }, resolution }
      : { route: null, resolution };
  };
  // cx: { db, query, exec, sendMessage, sendSystemMessage, startAgentWorker, stopAgentWorker,
  //        getAgentStatus, registerCapabilities, searchCapabilities, updateAgentProfile, setAgentStatus,
  //        publishAgent, unpublishAgent,
  //        generateOSSSignature, agentRegistration,
  //        getPaymentAuth, savePaymentOrder, getAgentImUid,
  //        getOpenclawHandler, processPaymentOrder,
  //        enqueueOwnerIntervention }

  /** 格式化消息行 */
  // 游标持久化到 DB（config 表），跨重启保留。注意：多客户端共享同一游标，需精确控制请显式传 since/messageSeq
  function _getCursorDb(db: DatabaseLike, key: string) {
    const separator = key.indexOf(':');
    const name = separator < 0 ? key : key.slice(0, separator);
    const scopeKey = separator < 0 ? '' : key.slice(separator + 1);
    try {
      const checkpoint = getCheckpoint(db, `mcp.${name}`, scopeKey);
      if (checkpoint) return Number(checkpoint.committedValue) || 0;
      const row = db.prepare("SELECT data FROM config WHERE type=?").get<ConfigDataRow>('cursor:' + key);
      const legacy = row ? (Number(JSON.parse(row.data)) || 0) : 0;
      if (row) setCheckpoint(db, `mcp.${name}`, scopeKey, 'sequence', legacy);
      return legacy;
    } catch (_: any) { return 0; }
  }
  function _setCursorDb(db: DatabaseLike, key: string, val: number) {
    const separator = key.indexOf(':');
    const name = separator < 0 ? key : key.slice(0, separator);
    const scopeKey = separator < 0 ? '' : key.slice(separator + 1);
    try {
      const committed = advanceCheckpoint(db, `mcp.${name}`, scopeKey, val);
      db.prepare("INSERT OR REPLACE INTO config (type, data, updated_at) VALUES (?, ?, ?)").run('cursor:' + key, JSON.stringify(committed), Date.now());
    } catch (_: any) {}
  }
  function _getTimestampIdCursorDb(db: DatabaseLike, key: string): { timestamp: number; id: string } {
    const separator = key.indexOf(':');
    const name = separator < 0 ? key : key.slice(0, separator);
    const scopeKey = separator < 0 ? '' : key.slice(separator + 1);
    try {
      const checkpoint = getCheckpoint(db, `mcp.${name}`, scopeKey);
      if (checkpoint?.committedValue) {
        try {
          const parsed = JSON.parse(checkpoint.committedValue);
          if (parsed && typeof parsed === 'object') {
            return { timestamp: Number(parsed.timestamp) || 0, id: String(parsed.id || '') };
          }
          return { timestamp: Number(parsed) || 0, id: '' };
        } catch (_) {
          return { timestamp: Number(checkpoint.committedValue) || 0, id: '' };
        }
      }
      const row = db.prepare('SELECT data FROM config WHERE type=?').get<ConfigDataRow>('cursor:' + key);
      const timestamp = row ? (Number(JSON.parse(row.data)) || 0) : 0;
      if (row) setCheckpoint(db, `mcp.${name}`, scopeKey, 'timestamp_id', JSON.stringify({ timestamp, id: '' }));
      return { timestamp, id: '' };
    } catch (_) {
      return { timestamp: 0, id: '' };
    }
  }
  function _setTimestampIdCursorDb(db: DatabaseLike, key: string, timestamp: number, id: string): void {
    const separator = key.indexOf(':');
    const name = separator < 0 ? key : key.slice(0, separator);
    const scopeKey = separator < 0 ? '' : key.slice(separator + 1);
    try {
      setCheckpoint(db, `mcp.${name}`, scopeKey, 'timestamp_id', JSON.stringify({ timestamp, id }));
      db.prepare('INSERT OR REPLACE INTO config (type, data, updated_at) VALUES (?, ?, ?)')
        .run('cursor:' + key, JSON.stringify(timestamp), Date.now());
    } catch (_) {}
  }
  function _currentOwnerEmail(): string {
    try {
      const selected = cx.query<ConfigDataRow>("SELECT data FROM config WHERE type='current_user_email'")[0];
      const email = String(selected?.data ? JSON.parse(selected.data) : '').trim().toLowerCase();
      if (email) return email;
      const rows = cx.query<ConfigDataRow>("SELECT data FROM config WHERE type='user_access_token'");
      const data = rows[0]?.data ? JSON.parse(rows[0].data) : {};
      return Object.entries(data).sort((a: any, b: any) => (b[1]?.updated_at || 0) - (a[1]?.updated_at || 0))[0]?.[0]?.trim().toLowerCase() || '';
    } catch (_) { return ''; }
  }
  /** 从 provider caller 上下文解析 MCP 客户端身份，用作游标隔离的 clientId。 */
  function _sessionPullEligible(agentId: string, caller: any): boolean {
    if (!caller?.providerType || !caller?.nativeSessionId || !caller?.evidence) return false;
    const agent = cx.query<{ backend_type?: string }>('SELECT backend_type FROM agents WHERE agent_id=? LIMIT 1', [agentId])[0];
    const callerFamily = normalizeProviderFamily(caller.providerType);
    if (!agent?.backend_type || normalizeProviderFamily(agent.backend_type) !== callerFamily) return false;
    return isRoutingPolicyEligible(cx.db, 'session_scoped_pull_v1', { providerFamily: callerFamily });
  }
  function _resolveClientId(agentId?: string, suffix?: string): string | undefined {
    try {
      const caller = getProviderCaller();
      if (agentId && _sessionPullEligible(agentId, caller)) {
        const fp = fingerprintProviderSession(cx.db, caller.providerType, caller.nativeSessionId);
        return `session:${agentId}:${fp}${suffix ? `:${String(suffix).slice(0, 64)}` : ''}`;
      }
      const id = suffix || caller?.providerType || caller?.providerInstanceId;
      return id ? String(id).slice(0, 64) : undefined;
    } catch (_: unknown) { return undefined; }
  }
  function _publicClientId(clientId?: string): string | null {
    return clientId?.startsWith('session:') ? 'session-scoped' : clientId || null;
  }
  function _filterPullRowsForCaller(agentId: string | undefined, rows: MessageDbRow[]): MessageDbRow[] {
    if (!agentId || rows.length === 0) return rows;
    const self = cx.query<{ imUid?: string }>('SELECT imUid FROM agents WHERE agent_id=? LIMIT 1', [agentId])[0]?.imUid;
    rows = rows.filter((row) => {
      if (Number(row.channel_type) !== 2) return true;
      let mention: { all?: boolean; uids?: string[] } | null = null;
      try { mention = typeof row.mention === 'string' ? JSON.parse(row.mention) : (row.mention as any); } catch (_) {}
      if (!mention?.all && (!self || !Array.isArray(mention?.uids) || !mention.uids.includes(self))) return false;
      const invalid = cx.query<{ status?: string }>(`SELECT status FROM provider_message_routes
        WHERE message_id=? AND agent_id=? AND direction='inbound' ORDER BY created_at DESC LIMIT 1`,
      [row.id, agentId])[0];
      return invalid?.status !== 'invalid';
    });
    if (rows.length === 0) return rows;
    const caller = getProviderCaller();
    if (!_sessionPullEligible(agentId, caller)) return rows;
    try {
      const fp = fingerprintProviderSession(cx.db, caller.providerType, caller.nativeSessionId);
      const family = normalizeProviderFamily(caller.providerType);
      const routes = new MessageRouteStore(cx.db);
      for (const row of rows) {
        if (Number(row.channel_type) !== 2) continue;
        const existing = cx.query<{ conversation_id?: string | null; status?: string }>(`SELECT conversation_id,status
          FROM provider_message_routes WHERE message_id=? AND agent_id=? AND direction='inbound' LIMIT 1`,
        [row.id, agentId])[0];
        if (existing?.status === 'invalid' || existing?.conversation_id) continue;
        const instance = caller.providerInstanceId ? String(caller.providerInstanceId) : null;
        const candidates = cx.query<{ id: string }>(`SELECT id FROM provider_routing_conversations
          WHERE agent_id=? AND provider_family=? AND native_session_fingerprint=?
            AND channel_type=2 AND channel_id=? AND status='active'
            ${instance ? 'AND provider_instance_key=?' : ''} ORDER BY id LIMIT 2`,
        [agentId, family, fp, row.channel_id, ...(instance ? [instance] : [])]);
        if (candidates.length !== 1) continue;
        routes.claimInbound({ messageId: row.id, conversationId: candidates[0].id, agentId,
          peerUid: row.from_uid, channelId: row.channel_id, channelType: 2 });
      }
      const ids = rows.map((row) => row.id);
      const placeholders = ids.map(() => '?').join(',');
      const allowed = new Set(cx.query<{ message_id: string }>(`SELECT r.message_id FROM provider_message_routes r
        JOIN provider_routing_conversations c ON c.id=r.conversation_id
        WHERE r.agent_id=? AND r.direction='inbound' AND r.status='active'
          AND c.native_session_fingerprint=? AND r.message_id IN (${placeholders})`, [agentId, fp, ...ids])
        .map((row) => row.message_id));
      return rows.filter((row) => allowed.has(row.id));
    } catch (_) { return []; }
  }
  function _agentOwnershipError(agentId?: string): string | null {
    if (!agentId) return null;
    const row = cx.query<{ owner_email?: string | null }>(
      'SELECT owner_email FROM agents WHERE agent_id=? LIMIT 1',
      [agentId],
    )[0];
    if (!row || !row.owner_email) return null;
    const current = _currentOwnerEmail();
    return current && current === String(row.owner_email).trim().toLowerCase()
      ? null
      : '当前登录用户无权访问该 Agent';
  }
  function _listOwnedAgents(options: { keyword?: string; limit?: number; offset?: number } = {}) {
    const currentOwner = _currentOwnerEmail();
    const conditions = [currentOwner ? 'owner_email=?' : "(owner_email IS NULL OR TRIM(owner_email)='')"];
    const params: unknown[] = currentOwner ? [currentOwner] : [];
    const keyword = String(options.keyword || '').trim();
    if (keyword) {
      conditions.push('(LOWER(agent_name) LIKE ? OR LOWER(agent_id) LIKE ?)');
      const pattern = `%${keyword.toLowerCase()}%`;
      params.push(pattern, pattern);
    }
    const limit = Math.min(500, Math.max(1, Number(options.limit) || 200));
    const offset = Math.max(0, Number(options.offset) || 0);
    const where = ` WHERE ${conditions.join(' AND ')}`;
    const total = Number(cx.query<{ total: number }>(`SELECT COUNT(*) AS total FROM agents${where}`, params)[0]?.total || 0);
    const rows = cx.query<AgentDbRow & { backend_instance_id?: string | null; delivery_modes?: string | null }>(
      `SELECT agent_id,agent_name,description,short_description,category,backend_type,backend_instance_id,imUid,
       delivery_modes,publish_status,access_mode,visibility_type,owner_email,created_at FROM agents${where}
       ORDER BY created_at ASC LIMIT ? OFFSET ?`, [...params, limit, offset],
    );
    const agents = rows.map((r) => {
      let deliveryModes: string[] = [];
      try { deliveryModes = JSON.parse(r.delivery_modes || '[]'); } catch (_) {}
      return {
        agentId: r.agent_id, agentName: r.agent_name, imUid: r.imUid, description: r.description,
        shortDescription: r.short_description, category: r.category, backendType: r.backend_type,
        backendInstanceId: r.backend_instance_id || null, deliveryModes,
        publishStatus: r.publish_status, accessMode: r.access_mode,
        visibilityType: [0, 1, 2].includes(Number(r.visibility_type)) ? Number(r.visibility_type) : 0,
        ownerEmail: r.owner_email, createdAt: r.created_at,
      };
    });
    return { agents, total, limit, offset, hasMore: offset + agents.length < total };
  }
  function fmtMsg(r: MessageDbRow) {
    let mention = null;
    if (r.mention) {
      try { mention = typeof r.mention === 'string' ? JSON.parse(r.mention) : r.mention; } catch (_: any) { mention = null; }
    }
    const { timestamp, timestampMs } = _normalizeTimestamp(r.timestamp);
    return {
      id: r.id,
      channelId: r.channel_id,
      fromUid: r.from_uid,
      toUid: r.to_uid,
      content: r.content,
      timestamp,
      timestampMs,
      messageSeq: r.message_seq,
      isMe: r.is_me >= 1,
      contentType: r.content_type || 1,
      agentId: r.agent_id || null,
      channelType: r.channel_type || 1,
      conversationId: r.routing_conversation_id || null,
      mention,
    };
  }
  function attachConversationIds(rows: MessageDbRow[], agentId?: string): MessageDbRow[] {
    if (!rows.length || !agentId) return rows;
    const ids = [...new Set(rows.map((row) => String(row.id || '')).filter(Boolean))];
    if (!ids.length) return rows;
    const placeholders = ids.map(() => '?').join(',');
    const routeRows = cx.query<{ message_id: string; conversation_id?: string | null }>(
      `SELECT message_id,conversation_id FROM provider_message_routes
       WHERE agent_id=? AND message_id IN (${placeholders}) AND conversation_id IS NOT NULL
       ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END,created_at DESC`,
      [agentId, ...ids],
    );
    const byMessage = new Map<string, string>();
    for (const route of routeRows) {
      if (route.conversation_id && !byMessage.has(route.message_id)) byMessage.set(route.message_id, route.conversation_id);
    }
    for (const row of rows) row.routing_conversation_id = byMessage.get(row.id) || null;
    return rows;
  }
  function fmtPullMsg(r: MessageDbRow, opts: { stripControl?: boolean } = {}) {
    const base = fmtMsg(r);
    const sourceType = r.sourceType || (r.from_uid === 'system' ? 'system' : 'visitor');
    // agent_peer 入站消息会被 dispatcher 注入 [VOKO A2A CONTROL] 协议包装，
    // pull 路径需剥掉这层包装，只暴露对端可见正文；visitor/system 消息不含协议块，原样返回。
    const stripControl = opts.stripControl !== false;
    const hasControlBlock = stripControl && sourceType === 'agent_peer' && _hasControlBlock(base.content);
    let content = base.content;
    let contentStripped = false;
    if (hasControlBlock) {
      const visible = _stripInboundControlBlock(content);
      if (visible && visible !== content) {
        content = visible;
        contentStripped = true;
      }
    }
    return {
      ...base,
      content,
      contentStripped,
      hasControlBlock,
      sourceType,
      trustLevel: r.trustLevel || (r.from_uid === 'system' ? 'trusted_system' : 'untrusted'),
    };
  }
  function fmtPullResult(rows: MessageDbRow[], hasMore: boolean, extra: Record<string, unknown> = {}) {
    const formattingAgentId = typeof extra._agentId === 'string' ? extra._agentId : undefined;
    const publicExtra = { ...extra };
    delete publicExtra._agentId;
    attachConversationIds(rows, formattingAgentId);
    return {
      success: true,
      securityContext: createPullSecurityContext(),
      // 默认剥离 A2A 控制块；调用方可通过 extra.stripControl=false 关闭
      messages: rows.map((r) => fmtPullMsg(r, { stripControl: extra.stripControl !== false })),
      hasMore,
      count: rows.length,
      ...publicExtra,
    };
  }

  const handlers: any = {

    // ─── 1 & 2. 注册 ───

    async request_login_code(p: McpToolParams = {}) {
      // Step 1：调后端发送邮箱验证码
      const r = await cx.agentRegistration.sendCode({ email: p.email });
      if (!r.success) {
        const responseData = isRecord(r.data) ? r.data : null;
        return { success: false, error: r.error || optionalString(responseData?.message) || '发送验证码失败' };
      }
      return { success: true, message: '验证码已发送到邮箱' };
    },

    async register_agent() {
      return {
        success: false,
        code: 'REGISTRATION_API_REMOVED',
        error: 'register_agent 已移除，请使用 manage_agent_registration --action=start',
        nextAction: { type: 'start_registration', tool: 'voko_manage_agent_registration', action: 'start' },
      };
    },

    async login_by_code(p: McpToolParams = {}) {
      const r = await cx.agentRegistration.loginByCode({ email: p.email, code: p.code });
      return r;
    },

    async login_for_owner_switch(p: McpToolParams = {}) {
      return cx.agentRegistration.loginByCode({ email: p.email, code: p.code, persistMode: 'pending' });
    },

    async reauth_by_code(p: McpToolParams = {}) {
      return cx.agentRegistration.loginByCode({ email: p.email, code: p.code, persistMode: 'none' });
    },

    async oauth_providers() {
      return cx.agentRegistration.getOAuthProviders();
    },

    async oauth_start(p: McpToolParams = {}) {
      return cx.agentRegistration.startOAuthSession({ provider: p.provider });
    },

    async oauth_status(p: McpToolParams = {}) {
      return cx.agentRegistration.getOAuthSession({ sessionId: p.sessionId });
    },

    async oauth_exchange(p: McpToolParams = {}) {
      return cx.agentRegistration.exchangeOAuthSession({
        sessionId: p.sessionId,
        exchangeCode: p.exchangeCode,
      });
    },

    async oauth_exchange_for_owner_switch(p: McpToolParams = {}) {
      return cx.agentRegistration.exchangeOAuthSession({
        sessionId: p.sessionId,
        exchangeCode: p.exchangeCode,
        persistMode: 'pending',
      });
    },

    async verify_agent_email(p: McpToolParams = {}) {
      // 预览模式：不传 agentId 也不传 agentName，只验码展示 Agent 列表
      if (!p.agentId && !p.agentName) {
        const r = await cx.agentRegistration.verifyCodePreview({ email: p.email, code: p.code });
        if (!r.success) {
          return { success: false, error: r.error || '验证码错误或已过期' };
        }
        const agents = registrationAgentSummaries(r.agents);
        if (!agents) return { success: false, error: t('mcp.registration.invalid_response') };
        const needChoice = r.userExists && agents.length > 0;
        const result: any = { success: true, needChoice, userExists: r.userExists };
        if (needChoice) {
          result.agents = agents;
          result.message = '该邮箱有如下Agent，请选择某个Agent或提供新的AgentName注册新Agent';
        } else {
          result.message = '该邮箱尚未注册VOKO，请为该Agent命名';
        }
        return result;
      }

      // 完整注册：backendType 必填；category 可选，默认 general（通用助手）
      if (!p.backendType) {
        return {
          success: false,
          error: '注册时 backendType 为必填字段（可选预定义类型或自定义任意字符串如 workbuddy）',
        };
      }

      // 完整注册：调后端验证验证码
      const v = await cx.agentRegistration.verifyCode({
        email: p.email, code: p.code,
        agentName: p.agentName,
        agentId: p.agentId,
      });
      if (!v.success) {
        const failureData = isRecord(v.data) ? v.data : null;
        return { success: false, error: v.error || optionalString(failureData?.message) || '验证码无效或已过期' };
      }

      const data = verifiedRegistrationData(v.data);
      if (!data) return { success: false, error: t('mcp.registration.invalid_response') };
      console.error('[verify_agent_email] 服务端返回有效注册信息:', {
        agentId: data.agentId || null,
        agentCount: data.agents.length,
      });
      const agentId = selectedRegistrationAgentId(data, p.agentId, p.agentName);
      if (!agentId) return { success: false, error: t('mcp.registration.ambiguous_agent') };

      const serverUrl = data.imServerUrl || ENDPOINTS.im.wsUrl;
      const backendType = normalizeBackendType(p.backendType);
      const accessMode = p.accessMode === 'public' ? 'public' : 'private';
      const category = p.category || 'general';

      const selectedAgent = data.agents.find(agent => agent.agentId === agentId);
      if (!selectedAgent) return { success: false, error: t('mcp.registration.invalid_response') };
      const paymentFeeRate = optionalFeeRate(selectedAgent.payment_fee_rate);
      const agentUsageFeeRate = optionalFeeRate(selectedAgent.agent_usage_fee_rate);
      if (Number.isNaN(paymentFeeRate) || Number.isNaN(agentUsageFeeRate)) {
        return { success: false, error: t('mcp.registration.invalid_response') };
      }

      // Step 2：写入 agents 表（注册，published，不启动 worker）
      const regRes = await cx.agentRegistration.registerAgentInDb({
        agentId,
        uid: data.imUid,
        token: data.imToken,
        serverUrl,
        ownerEmail: p.email,
        backendType,
        instanceId: p.instanceId,
        deliveryModes: p.deliveryModes,
        agentName: data.agentName,
        category,
        description: p.description,
        tags: p.tags,
        iconUrl: p.iconUrl,
        contactPhone: p.contact_phone,
        address: p.address,
        did: data.did,
        publicKey: data.publicKey,
        privateKey: data.privateKey,
        loginToken: data.loginToken,
        paymentFeeRate,
        agentUsageFeeRate,
        accessMode,
      });
      if (!regRes.success) {
        return { success: false, error: regRes.error || '写入 agents 表失败' };
      }

      // Step 3：更新绑定字段
      const upRes = await cx.agentRegistration.updateAgentBinding({
        agentId,
        updates: {
          did: data.did,
          imUid: data.imUid,
          imToken: data.imToken,
          public_key: data.publicKey,
          private_key: data.privateKey,
          login_token: data.loginToken,
          im_server_url: serverUrl,
        },
      });
      if (upRes && !upRes.success) {
        return { success: false, error: upRes.error || '更新绑定失败' };
      }

      const profileSyncFailure = await syncRegisteredAgentProfile(agentId, p, data.agentName || p.agentName || agentId, backendType);
      if (profileSyncFailure) return profileSyncFailure;

      if (cx.setAgentStatus) {
        await cx.setAgentStatus({
          agentId,
          status: 1,
          // Registration accessMode controls the local visitor whitelist;
          // external Agent visibility starts private unless explicitly changed
          // later with set_agent_status visibility=0/1/2.
          visibility: 0,
        });
      }

      // Step 4：先加载新 Agent 的 Provider，再启动 IM，避免首条消息只能 Pull。
      await prepareRegisteredAgentBackend(agentId, backendType);
      if (cx.startAgentWorker) {
        let imStatus: WorkerConnectionStatus | undefined;
        try {
          imStatus = await cx.startAgentWorker(agentId, { uid: data.imUid, token: data.imToken, serverUrl, backendType }) as WorkerConnectionStatus | undefined;
        } catch (_) {
          imStatus = { status: 'connect_fail' };
        }
        try {
          imStatus = await waitForStartedAgentConnection(cx, agentId, imStatus);
        } catch (_) {
          imStatus = { status: 'failed' };
        }
        if (imStatus?.error || imStatus?.status === 'connect_fail') imStatus = { status: 'failed' };
        if (imStatus && typeof imStatus === 'object') {
          const connected = imStatus.connected === true || imStatus.status === 'connected';
          return {
            success: true,
            message: '注册成功',
            agentId,
            agentName: data.agentName,
            ...registrationRuntimeStatus(cx, agentId, imStatus),
            imConnection: { connected, status: imStatus.status || (connected ? 'connected' : 'unknown') },
            ...(connected ? {} : { warning: imStatus.status === 'failed' ? 'Agent 已创建，但 IM Worker 启动失败，可稍后通过 start_worker 重试' : 'Agent 已创建，IM 连接仍在建立，可稍后通过 start_worker 重试' }),
          };
        }
      }

      return {
        success: true,
        message: '注册成功',
        agentId,
        agentName: data.agentName,
        ...registrationRuntimeStatus(cx, agentId),
      };
    },

    // ─── 2b. 用 access-token 创建 Agent（已登录用户，无需验证码）───
    // 与 verify_agent_email 同结构，仅把 step1 的 verifyCode 换成 createAgentByToken。
    async create_agent_by_token(p: McpToolParams = {}) {
      const requestedEmail = String(p.email || '').trim().toLowerCase();
      const email = _currentOwnerEmail()
        || (requestedEmail && cx.getUserAccessToken?.(requestedEmail) ? requestedEmail : '');
      if (!email) return { success: false, error: '未登录（缺少 user_access_token）', noToken: true };
      if (requestedEmail && requestedEmail !== email) {
        return { success: false, error: '请求邮箱与当前登录用户不一致', code: 'CURRENT_USER_MISMATCH' };
      }
      // backendType 必填；category 可选，默认 general（与 verify_agent_email 保持一致）
      if (!p.backendType) {
        return { success: false, error: 'backendType 为必填字段' };
      }

      const backendType = normalizeBackendType(p.backendType);
      const accessMode = p.accessMode === 'public' ? 'public' : 'private';
      const serverUrl = ENDPOINTS.im.wsUrl;

      // Step 1：用本地 token 调后端 /agent/create（无需验证码）
      const tokenResult = await cx.agentRegistration.createAgentByToken({ agentId: p.agentName });
      if (!tokenResult.success) return { success: false, error: tokenResult.error || '云端创建失败', noToken: !!tokenResult.noToken };
      const data = createdRegistrationData(tokenResult.data, p.agentName);
      if (!data) return { success: false, error: t('mcp.registration.invalid_response') };
      const agentId = data.agentId;
      const paymentFeeRate = optionalFeeRate(data.payment_fee_rate);
      const agentUsageFeeRate = optionalFeeRate(data.agent_usage_fee_rate);
      if (Number.isNaN(paymentFeeRate) || Number.isNaN(agentUsageFeeRate)) {
        return { success: false, error: t('mcp.registration.invalid_response') };
      }

      // Step 2：写入 agents 表（旧服务端未返回费率时由落库层使用默认值）
      const regRes = await cx.agentRegistration.registerAgentInDb({
        agentId,
        uid: data.imUid,
        token: data.imToken,
        serverUrl,
        ownerEmail: email,
        backendType,
        instanceId: p.instanceId,
        deliveryModes: p.deliveryModes,
        agentName: data.name || data.agentName || p.agentName,
        did: data.did,
        publicKey: data.publicKey,
        privateKey: data.privateKey,
        paymentFeeRate,
        agentUsageFeeRate,
        category: p.category || 'general',
        description: p.description,
        tags: p.tags,
        iconUrl: p.iconUrl,
        contactPhone: p.contact_phone,
        address: p.address,
        accessMode,
      });
      if (!regRes.success) return { success: false, error: regRes.error || '写入 agents 表失败' };

      // Step 3：更新绑定字段
      const registrationCaller = getProviderCaller();
      if (featureEnabled('provider_identity_v1', true)
        && registrationCaller?.providerType && registrationCaller?.nativeSessionId && registrationCaller?.evidence
        && normalizeProviderFamily(registrationCaller.providerType) === normalizeProviderFamily(backendType)) {
        try {
          identityBindings.bind({
            agentId, providerFamily: backendType,
            providerInstanceKey: registrationCaller.providerInstanceId || registrationCaller.instanceId || p.instanceId || '',
            nativeSessionId: registrationCaller.nativeSessionId,
            evidenceType: registrationCaller.evidence,
          });
        } catch (_) { /* identity binding must not roll back a completed registration */ }
      }

      const binding = await cx.agentRegistration.updateAgentBinding({
        agentId,
        updates: {
          did: data.did, imUid: data.imUid, imToken: data.imToken,
          public_key: data.publicKey, private_key: data.privateKey,
          im_server_url: serverUrl,
        },
      });
      if (binding?.success === false) {
        return { success: false, error: binding.error || '更新绑定失败' };
      }

      const profileName = data.name || data.agentName || p.agentName || agentId;
      const profileSyncFailure = await syncRegisteredAgentProfile(agentId, p, profileName, backendType);
      if (profileSyncFailure) return profileSyncFailure;

      let accessModeSynced = false;
      if (cx.setAgentStatus) {
        const statusResult = await cx.setAgentStatus({
          agentId,
          status: 1,
          // Keep local visitor access separate from external discoverability.
          visibility: 0,
        });
        accessModeSynced = statusResult?.success !== false;
      }

      // Step 4：先加载新 Agent 的 Provider，再启动 IM，避免首条消息只能 Pull。
      await prepareRegisteredAgentBackend(agentId, backendType);
      if (cx.startAgentWorker) {
        let imStatus: WorkerConnectionStatus | undefined;
        try {
          imStatus = await cx.startAgentWorker(agentId, { uid: data.imUid, token: data.imToken, serverUrl, backendType }) as WorkerConnectionStatus | undefined;
        } catch (_) {
          imStatus = { status: 'connect_fail' };
        }
        try {
          imStatus = await waitForStartedAgentConnection(cx, agentId, imStatus);
        } catch (_) {
          imStatus = { status: 'failed' };
        }
        if (imStatus?.error || imStatus?.status === 'connect_fail') imStatus = { status: 'failed' };
        const imConnection = imStatus && typeof imStatus === 'object'
          ? { connected: imStatus.connected === true || imStatus.status === 'connected', status: imStatus.status || 'unknown' }
          : undefined;
        return {
          success: true,
          message: '创建成功',
          agentId,
          agentName: data.name || p.agentName,
          ...registrationRuntimeStatus(cx, agentId, imStatus),
          accessMode,
          accessModeSynced,
          ...(imConnection ? {
            imConnection,
            ...(imConnection.connected ? {} : { warning: imStatus?.status === 'failed' ? 'Agent 已创建，但 IM Worker 启动失败，可稍后通过 start_worker 重试' : 'Agent 已创建，IM 连接仍在建立，可稍后通过 start_worker 重试' }),
          } : {}),
        };
      }

      return {
        success: true,
        message: '创建成功',
        agentId,
        agentName: data.name || p.agentName,
        ...registrationRuntimeStatus(cx, agentId),
        accessMode,
        accessModeSynced,
      };
    },

    // ─── 3. 编辑 Agent 基础信息 ───

    async bind_agent_instance_once(p: McpToolParams = {}) {
      const row = cx.query(
        `SELECT backend_type, backend_instance_id, delivery_modes, imUid, imToken, im_server_url FROM agents WHERE agent_id = ?`,
        [p.agentId],
      )[0];
      if (!row) return { success: false, error: 'Agent 不存在', code: 'AGENT_NOT_FOUND' };
      let instances: any[] = [];
      try {
        instances = discoverProviderInstances(row.backend_type);
      } catch (error: any) {
        return { success: false, error: error.message || '本机实例发现失败', code: 'INSTANCE_DISCOVERY_FAILED' };
      }
      if (!instances.length) return { success: false, error: '本机未发现可绑定实例', code: 'NO_PROVIDER_INSTANCES' };
      try {
        const result = await new AgentProviderBindingService(cx.db).bindInstanceOnce(p.agentId, {
          backendInstanceId: p.backendInstanceId,
          availableInstances: instances,
          rebind: async ({ previous, next }: any) => {
            const rebind = (global as any).__rebindAgentRuntime;
            if (!rebind) {
              try { (global as any).__dispatcher?.invalidateMeta?.(p.agentId); } catch (_) {}
              return undefined;
            }
            return rebind({
              db: cx.db, agentId: p.agentId,
              previous: { ...previous, deliveryModes: row.delivery_modes, imUid: row.imUid, imToken: row.imToken, imServerUrl: row.im_server_url },
              next: { ...next, deliveryModes: row.delivery_modes, imUid: row.imUid, imToken: row.imToken, imServerUrl: row.im_server_url },
            });
          },
        });
        return { success: true, message: '实例绑定成功', binding: result.next, runtimeRebind: result.runtimeRebind };
      } catch (error: any) {
        return { success: false, error: error.message, code: error.code || 'INSTANCE_BIND_FAILED' };
      }
    },

    async update_agent_profile(p: McpToolParams = {}) {
      if (!cx.updateAgentProfile) {
        return { success: false, error: '当前环境不支持更新 Agent 资料' };
      }
      // backendType 仅本地更新，不同步服务端
      const currentRow = cx.query(
        `SELECT backend_type, backend_instance_id, delivery_modes, imUid, imToken, im_server_url FROM agents WHERE agent_id = ?`,
        [p.agentId],
      )[0] || {};
      // 运行时重绑定：DB 已更新后，统一加载 Provider / 失效旧绑定 / 清缓存 / 必要时重启 IM Worker。
      // 缺失 rebind（旧环境/测试）时退化为原 invalidateMeta 行为。
      const rebind = (global as any).__rebindAgentRuntime;
      const runRebind = async (previousSnap: any) => {
        if (rebind) {
          const nextRow = cx.query(
            `SELECT backend_type, backend_instance_id, delivery_modes, imUid, imToken, im_server_url FROM agents WHERE agent_id = ?`,
            [p.agentId],
          )[0] || {};
          try {
            return await rebind({
              db: cx.db, agentId: p.agentId,
              previous: {
                backendType: previousSnap.backend_type,
                backendInstanceId: previousSnap.backend_instance_id ?? null,
                deliveryModes: previousSnap.delivery_modes,
                imUid: previousSnap.imUid, imToken: previousSnap.imToken, imServerUrl: previousSnap.im_server_url,
              },
              next: {
                backendType: nextRow.backend_type,
                backendInstanceId: nextRow.backend_instance_id ?? null,
                deliveryModes: nextRow.delivery_modes,
                imUid: nextRow.imUid, imToken: nextRow.imToken, imServerUrl: nextRow.im_server_url,
              },
            });
          } catch (_: any) { /* rebind 内部已 catch，此处兜底 */ }
        } else {
          try { (global as any).__dispatcher?.invalidateMeta?.(p.agentId); } catch (_: any) {}
        }
        return undefined;
      };
      const requestedInstanceId = p.backendInstanceId === undefined
        ? undefined
        : String(p.backendInstanceId || '').trim();
      const targetBackendType = normalizeBackendType(p.backendType || currentRow.backend_type || 'others');
      try {
        new AgentProviderBindingService(cx.db).assertLockedUpdate(p.agentId, {
          backendType: p.backendType,
          backendInstanceId: p.backendInstanceId,
        });
      } catch (error: any) {
        return { success: false, error: error.message, code: error.code || 'BACKEND_BINDING_LOCKED' };
      }
      const backendRebindResult: any[] = [];
      const backendChanged = p.backendType !== undefined
        && normalizeBackendType(currentRow.backend_type) !== targetBackendType;
      const hasRoutingUpdate = p.backendType !== undefined
        || p.backendInstanceId !== undefined
        || p.deliveryModes !== undefined;
      if (hasRoutingUpdate) {
        new AgentDeliveryPolicyStore(cx.db).update(p.agentId, {
          backendType: p.backendType === undefined ? undefined : targetBackendType,
          backendInstanceId: p.backendInstanceId !== undefined
            ? (requestedInstanceId || null)
            : (backendChanged ? null : undefined),
          deliveryModes: p.deliveryModes !== undefined
            ? p.deliveryModes
            : (backendChanged ? ['pull'] : undefined),
        });
        backendRebindResult.push(await runRebind(currentRow)); // 失效 dispatcher 缓存 + 加载 Provider + 失效旧绑定
      }

      // 检查是否有需要同步服务端的字段
      const serverFields = [p.name, p.description, p.short_description, p.category, p.tags, p.iconUrl, p.address, p.contact_phone, p.backendType];
      if (serverFields.some((v?: any) => v !== undefined)) {
        const result = await cx.updateAgentProfile({
          db: cx.db,
          agentId: p.agentId,
          name: p.name,
          description: p.description,
          short_description: p.short_description,
          category: p.category,
          tags: p.tags,
          icon_url: p.iconUrl,
          address: p.address,
          contact_phone: p.contact_phone,
          backendType: p.backendType === undefined ? undefined : targetBackendType,
        });
        // 资料同步不影响运行时绑定；如有 backend/instance 变更已在上文触发 rebind
        if (backendRebindResult.length) (result as any).runtimeRebind = backendRebindResult[backendRebindResult.length - 1];
        return result;
      }

      const okResult: any = { success: true, message: '本地更新成功' };
      if (backendRebindResult.length) okResult.runtimeRebind = backendRebindResult[backendRebindResult.length - 1];
      return okResult;
    },

    // ─── 4. 设置 Agent 上下架 / 外部展现范围 ───

    async set_agent_status(p: McpToolParams = {}) {
      const hasVisibility = p.visibility === 0 || p.visibility === 1 || p.visibility === 2;
      const hasStatus = p.status === 0 || p.status === 1;

      // 仅切换外部展现范围（不改变上下架，也不改变本地访客白名单模式）
      if (hasVisibility && !hasStatus) {
        if (!cx.setAgentStatus) {
          return { success: false, error: '当前环境不支持同步 Agent 状态' };
        }
        const row = cx.query(`SELECT publish_status FROM agents WHERE agent_id = ?`, [p.agentId])[0];
        if (!row) return { success: false, error: 'Agent 不存在' };
        const published = row.publish_status === 'published';
        return cx.setAgentStatus({
          agentId: p.agentId,
          status: published ? 1 : 0,
          visibility: p.visibility,
        });
      }

      if (hasVisibility && (p.status === 0 || p.status === 1)) {
        cx.exec(`UPDATE agents SET visibility_type = ?, updated_at = ? WHERE agent_id = ?`, [p.visibility, Date.now(), p.agentId]);
      }
      if (p.status === 1) {
        if (!cx.publishAgent) {
          return { success: false, error: '当前环境不支持发布 Agent' };
        }
        return cx.publishAgent({ agentId: p.agentId });
      }
      if (p.status === 0) {
        if (!cx.unpublishAgent) {
          return { success: false, error: '当前环境不支持下架 Agent' };
        }
        return cx.unpublishAgent({ agentId: p.agentId });
      }
      return { success: false, error: 'status 必须为 0（下架）或 1（上架），或使用 visibility 单独切换 0（私密）、1（公开）、2（隐藏）' };
    },

    // ─── 5. 状态 ───

    async get_status(p: McpToolParams = {}) {
      const agentStatus = cx.getAgentStatus ? cx.getAgentStatus(p.agentId) : null;
      const warnings = (global as any).__latestWarnings || [];
      const uptime = process.uptime();
      const version = cx.version || 'unknown';
      return { success: true, agent: agentStatus, warnings, uptime, version };
    },

    // ─── 5b. 启动/停止 Worker ───

    async start_worker(p: McpToolParams = {}) {
      if (!cx.startAgentWorker) return { success: false, error: '当前环境不支持启动 IM 连接' };
      const agent = cx.query(`SELECT imUid, imToken, im_server_url, backend_type FROM agents WHERE agent_id=?`, [p.agentId])[0];
      if (!agent || !agent.imUid || !agent.imToken) {
        return { success: false, error: 'Agent IM 身份或凭证缺失' };
      }
      let status = await cx.startAgentWorker(p.agentId, {
        uid: agent.imUid,
        token: agent.imToken,
        serverUrl: agent.im_server_url || ENDPOINTS.im.wsUrl,
        backendType: agent.backend_type || 'openclaw',
      }) as { error?: string; status?: string; connected?: boolean } | undefined;
      if (status?.error || status?.status === 'connect_fail') {
        return { success: false, error: status.error || 'Agent IM 连接失败' };
      }
      if (status?.status === 'connecting' && cx.waitForAgentConnection) {
        status = await cx.waitForAgentConnection(p.agentId, 5000);
      }
      return {
        success: true,
        connected: status?.status === 'connected' || status?.connected === true,
        state: status?.status || 'unknown',
        status,
      };
    },

    async stop_worker(p: McpToolParams = {}) {
      if (!cx.stopAgentWorker) return { success: false, error: '当前环境不支持停止 Worker' };
      await cx.stopAgentWorker(p.agentId);
      return { success: true };
    },

    // ─── 5c. 查询 Agent 资料 ───

    async get_agent_profile(p: McpToolParams = {}) {
      const row = cx.query(`SELECT * FROM agents WHERE agent_id=?`, [p.agentId]);
      if (!row || row.length === 0) {
        return { success: false, error: 'Agent 不存在' };
      }
      const a = row[0];
      let tags = null;
      try { if (a.tags) tags = JSON.parse(a.tags); } catch { tags = a.tags; }
      let ability = null;
      try { if (a.ability) ability = JSON.parse(a.ability); } catch { ability = a.ability; }

      // 计费模式
      let pricing = { pricingModel: 'free', price: null, durationMinutes: null, enabled: true };
      try {
        const pricingRow = cx.query(`SELECT pricing_model, price, duration_minutes, enabled FROM agent_pricing WHERE agent_id=?`, [p.agentId])[0];
        if (pricingRow) pricing = { pricingModel: pricingRow.pricing_model, price: pricingRow.price, durationMinutes: pricingRow.duration_minutes, enabled: pricingRow.enabled === 1 };
      } catch (_: any) {}

      // 支付认证（是否已配置）
      let paymentAuthId = null;
      let paymentConfigured = false;
      try {
        const auth = cx.query(`SELECT id FROM payment_auth WHERE id=?`, [a.payment_auth_id])[0];
        paymentAuthId = a.payment_auth_id || null;
        paymentConfigured = !!auth;
      } catch (_: any) {}

      return {
        success: true,
        data: {
          agentId: a.agent_id,
          agentName: a.agent_name,
          description: a.description,
          shortDescription: a.short_description,
          category: a.category,
          categoryLabel: a.category_label || (() => { if (!a.category) return null; try { const k = 'db.agent.category.' + a.category; const v = require('../core/i18n').t(k); return v !== k ? v : null; } catch (_: any) { return null; } })(),
          tags,
          iconUrl: a.icon_url,
          address: a.address,
          contactPhone: a.contact_phone,
          backendType: a.backend_type,
          backendInstanceId: a.backend_instance_id || null,
          publishStatus: a.publish_status,
          accessMode: a.access_mode,
          visibilityType: [0, 1, 2].includes(Number(a.visibility_type)) ? Number(a.visibility_type) : 0,
          did: a.did,
          imUid: a.imUid,
          ownerEmail: a.owner_email,
          createdAt: a.created_at,
          updatedAt: a.updated_at,
          ability,
          paymentFeeRate: a.payment_fee_rate,
          agentUsageFeeRate: a.agent_usage_fee_rate,
          paymentConfigured,
          pricing,
        },
        fieldDescriptions: {
          agentId: 'Agent 唯一标识',
          agentName: 'Agent 显示名称（可修改）',
          description: 'Agent详细描述',
          shortDescription: 'Agent一句话简短介绍',
          category: '分类标识（默认 general，如 education/finance/travel/entertainment/medical/other 等）',
          categoryLabel: '分类中文名称',
          tags: '标签列表',
          iconUrl: '头像图片链接',
          backendType: 'Agent 类型（预定义：openclaw/hermes/goose 等，也可为自定义类型）',
          publishStatus: '发布状态（published=已上架, unpublished=未上架）',
          visibilityType: '服务端外部展现范围：0=私密（可搜索、不进黄页），1=公开，2=隐藏（不可搜索）',
          paymentFeeRate: '支付手续费率（如 0.006 = 0.6%）',
          agentUsageFeeRate: '按时计费模式下，平台抽取的佣金比例',
          paymentConfigured: '是否已配置支付认证',
          pricing: '订阅方式：pricingModel=free免费/timed按时订阅，price=价格，durationMinutes=时长（分钟），enabled=是否启用',
          accessMode: '访问模式（public=公开, private=私密/白名单）',
          address: '地址',
          contactPhone: '联系电话',
          did: 'DID标识',
          imUid: 'IM 系统用户 ID',
          ownerEmail: '主人邮箱',
          createdAt: '注册时间（毫秒时间戳）',
          updatedAt: '最后更新时间（毫秒时间戳）',
          ability: '普通模式能力列表（JSON 数组）',
        },
      };
    },

    // ─── 6. 能力发现 ───

    async search_capabilities(p: McpToolParams = {}) {
      return cx.searchCapabilities ? await cx.searchCapabilities(p) : { success: false, error: '未实现' };
    },

    async declare_capabilities(p: McpToolParams = {}) {
      const abilities = p.ability;

      if (!Array.isArray(abilities)) {
        return { success: false, error: 'ability 必须为数组格式，如 [{"name":"...","fields":[...]}]' };
      }

      // 读取旧值，用于服务端同步失败时回滚
      const oldRow = cx.query(`SELECT ability FROM agents WHERE agent_id=?`, [p.agentId]);
      const oldValue = oldRow?.[0]?.ability || null;

      const jsonStr = JSON.stringify(abilities);
      cx.exec(`UPDATE agents SET ability=?, updated_at=? WHERE agent_id=?`, [jsonStr, Date.now(), p.agentId]);

      if (cx.registerCapabilities) {
        const result = await cx.registerCapabilities(p.agentId);
        if (!result.success) {
          // 服务端同步失败，回滚本地 DB
          cx.exec(`UPDATE agents SET ability=?, updated_at=? WHERE agent_id=?`, [oldValue, Date.now(), p.agentId]);
        }
        return result;
      }
      return { success: true };
    },

    async a2a_discover_agent(p: McpToolParams = {}) {
      const ownershipError = _agentOwnershipError(p.agentId); if (ownershipError) return { success: false, code: 'AGENT_OWNER_MISMATCH', error: ownershipError };
      if (!cx.a2aMailboxClient) return { success: false, code: 'A2A_UNAVAILABLE', error: 'A2A Mailbox is not enabled' };
      if (!p.agentId || !p.cardUrl) return { success: false, code: 'A2A_DISCOVERY_FAILED', error: 'agentId and cardUrl are required' };
      try { return { success: true, ...(await cx.a2aMailboxClient.discoverRemote(p.agentId, p.cardUrl, p.credential)) }; }
      catch (error: any) { return { success: false, code: 'A2A_DISCOVERY_FAILED', error: error.message }; }
    },
    async a2a_send_message(p: McpToolParams = {}) {
      const ownershipError = _agentOwnershipError(p.agentId); if (ownershipError) return { success: false, code: 'AGENT_OWNER_MISMATCH', error: ownershipError };
      if (!cx.a2aMailboxClient) return { success: false, code: 'A2A_UNAVAILABLE', error: 'A2A Mailbox is not enabled' };
      if (!p.content) return { success: false, code: 'A2A_SEND_FAILED', error: 'content is required' };
      try { const { A2ASafetyGate } = require('../a2a'); await new A2ASafetyGate(cx.db).assertAllowed(p.content, 'outbound');
        return { success: true, task: await cx.a2aMailboxClient.sendOutbound({ localAgentId: p.agentId,
        remoteAgentKey: p.remoteAgentKey, text: p.content, messageId: p.messageId, idempotencyKey: p.idempotencyKey }) }; }
      catch (error: any) { return { success: false, code: error?.reasonCode ? 'A2A_SAFETY_REJECTED' : 'A2A_SEND_FAILED', error: error?.reasonCode || error.message }; }
    },
    async a2a_get_task(p: McpToolParams = {}) {
      const ownershipError = _agentOwnershipError(p.agentId); if (ownershipError) return { success: false, code: 'AGENT_OWNER_MISMATCH', error: ownershipError };
      if (!cx.a2aMailboxClient) return { success: false, code: 'A2A_UNAVAILABLE', error: 'A2A Mailbox is not enabled' };
      if (!p.agentId || !p.taskId) return { success: false, code: 'A2A_TASK_QUERY_FAILED', error: 'agentId and taskId are required' };
      try { const task = await cx.a2aMailboxClient.getOutboundTask(p.taskId);
        if (task.local_agent_id !== p.agentId) return { success: false, code: 'A2A_TASK_NOT_FOUND', error: 'Task not found' };
        return { success: true, task }; } catch (error: any) { return { success: false, code: 'A2A_TASK_QUERY_FAILED', error: error.message }; }
    },
    async a2a_cancel_task(p: McpToolParams = {}) {
      const ownershipError = _agentOwnershipError(p.agentId); if (ownershipError) return { success: false, code: 'AGENT_OWNER_MISMATCH', error: ownershipError };
      if (!cx.a2aMailboxClient) return { success: false, code: 'A2A_UNAVAILABLE', error: 'A2A Mailbox is not enabled' };
      if (!p.agentId || !p.taskId) return { success: false, code: 'A2A_CANCEL_FAILED', error: 'agentId and taskId are required' };
      try { const result = await cx.a2aMailboxClient.cancelOutboundTask(p.agentId, p.taskId);
        if (result?.task?.local_agent_id !== p.agentId) return { success: false, code: 'A2A_TASK_NOT_FOUND', error: 'Task not found' };
        return { success: true, ...result }; } catch (error: any) { return { success: false, code: 'A2A_CANCEL_FAILED', error: error.message }; }
    },

    // ─── 8. 消息 ───

    async send_message(p: McpToolParams = {}) {
      const ownershipError = _agentOwnershipError(p.agentId);
      if (ownershipError) return { success: false, error: ownershipError, code: 'AGENT_OWNER_MISMATCH' };
      const fromUid = cx.wukongim?.getCurrentUid?.(p.agentId);
      if (!fromUid) return { success: false, error: 'Agent IM 身份缺失' };
      const channelType = inferChannelType(p);
      if (channelType === 2) {
        try {
          const group = await groupClient.getInfo(cx, { agentId: p.agentId, channelId: p.toUid });
          if ((group.status || 'active') === 'dissolved') {
            return { success: false, error: t('web.group.dissolved.send_disabled'), code: 'GROUP_DISSOLVED' };
          }
          // @所有人 仅群主(owner)/管理员(admin)可用；复用已查到的 group.members，零额外开销。
          if (p.mentions && p.mentions.all === true) {
            const members = (group.members || []) as GroupMember[];
            const me = members.find((member) => String(member.uid) === String(fromUid));
            if (!me || (me.role !== 'owner' && me.role !== 'admin')) {
              return { success: false, error: t('web.group.mention.all_forbidden'), code: 'MENTION_ALL_FORBIDDEN' };
            }
          }
        } catch (e: any) {
          return { success: false, error: e.message };
        }
      }
      // 新文件消息统一使用 8；3/4 仅兼容 VOKO 历史调用。
      let messageType = 'text';
      if (p.contentType === 2 || p.contentType === '2' || p.contentType === 'image') messageType = 'image';
      else if ([3, 4, 8, '3', '4', '8', 'file'].includes(p.contentType as any)) messageType = 'file';
      else if (typeof p.contentType === 'string') messageType = p.contentType;

      // 文件消息 content 归一化：支持 JSON 字符串 / 对象 / 纯 URL
      let content = p.content;
      if (messageType === 'file') {
        content = normalizeFileContent(content);
        // 不对调用方提供的 URL 发起元数据请求；远程大小和类型由调用方显式提供。
      }

      const mentions = channelType === 2 ? (p.mentions || null) : null;
      let pendingBinding: { id: string } | null = null;
      let isolateWithManagedSession = false;
      const outboundMessageId = p._requestedMessageId
        && /^[A-Za-z0-9._-]{8,256}$/.test(p._requestedMessageId) ? p._requestedMessageId
        : `msg-${p.agentId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const caller = getProviderCaller();
      let routingConversation: any = null;
      let outboundRouteId: string | null = null;
      let replyToRouteId: string | null = null;
      const routingShadowEnabled = featureEnabled('routing_conversation_shadow_v1', true);
      const agentForRoute = cx.query<{ backend_type?: string; backend_instance_id?: string; imUid?: string }>(
        'SELECT backend_type, backend_instance_id, imUid FROM agents WHERE agent_id=? LIMIT 1', [p.agentId],
      )[0];
      if (routingShadowEnabled) {
        try {
          if (p.replyToMessageId) {
            const priorRoute = messageRoutes.getByMessage(p.replyToMessageId, p.agentId);
            if (!priorRoute || priorRoute.agent_id !== p.agentId || priorRoute.channel_id !== p.toUid
              || Number(priorRoute.channel_type) !== channelType || priorRoute.status !== 'active'
              || (priorRoute.expires_at && Number(priorRoute.expires_at) <= Date.now())) {
              throw new Error('Reply target is unavailable or outside the current Agent and channel');
            }
            replyToRouteId = priorRoute.direction === 'inbound'
              ? priorRoute.reply_to_route_id : priorRoute.route_id;
            if (priorRoute.conversation_id) routingConversation = routingConversations.getForScope(
              priorRoute.conversation_id, p.agentId, p.toUid, channelType);
            if (!routingConversation) throw new Error('Reply target conversation is unavailable');
          }
          if (!routingConversation && p.conversationId) {
            routingConversation = routingConversations.getForScope(p.conversationId, p.agentId, p.toUid, channelType);
            if (!routingConversation) throw new Error('Conversation does not belong to the current Agent and channel');
          }
          if (routingConversation && !replyToRouteId) {
            const latestInbound = messageRoutes.latestInboundForConversation(routingConversation.id);
            if (latestInbound?.reply_to_route_id) replyToRouteId = latestInbound.reply_to_route_id;
          }
          if (!routingConversation && caller?.providerType && caller?.nativeSessionId && caller?.evidence) {
            const callerFamily = normalizeProviderFamily(caller.providerType);
            if (callerFamily === normalizeProviderFamily(agentForRoute?.backend_type || '')) {
              routingConversation = routingConversations.resolveOrCreate({
                agentId: p.agentId, providerFamily: callerFamily,
                providerInstanceKey: caller.providerInstanceId || caller.instanceId || agentForRoute?.backend_instance_id || '',
                nativeSessionId: caller.nativeSessionId, channelId: p.toUid, channelType, origin: 'caller',
              });
            }
          }
          if (!routingConversation && p.webRequest === true) {
            const current = routingConversations.listForScope(p.agentId, p.toUid, channelType);
            if (p.webConversationStart === true) {
              const parent = p.parentConversationId
                ? routingConversations.getForScope(p.parentConversationId, p.agentId, p.toUid, channelType)
                : null;
              if (p.parentConversationId && (!parent || parent.status !== 'active')) {
                throw new Error('Parent conversation is unavailable or outside the current Agent and channel');
              }
              routingConversation = current.find((item: RoutingConversation) => item.status === 'pending')
                || routingConversations.createPending({ agentId: p.agentId, channelId: p.toUid, channelType,
                  parentConversationId: parent?.id || null });
            } else {
              routingConversation = current.length === 1
                ? current[0]
                : routingConversations.createPending({ agentId: p.agentId, channelId: p.toUid, channelType });
            }
          }
          if (routingConversation) {
            outboundRouteId = messageRoutes.createPending({
              messageId: outboundMessageId, conversationId: routingConversation.id, replyToRouteId,
              agentId: p.agentId, peerUid: p.toUid, channelId: p.toUid, channelType, direction: 'outbound',
            });
          }
        } catch (error: any) {
          return { success: false, code: 'ROUTING_CONVERSATION_INVALID', error: error?.message || String(error) };
        }
      }
      if (caller?.providerType && caller?.nativeSessionId && caller?.evidence) {
        try {
          const agent = cx.query<{ backend_type?: string; backend_instance_id?: string }>(
            'SELECT backend_type, backend_instance_id FROM agents WHERE agent_id=? LIMIT 1',
            [p.agentId],
          )[0];
          const agentProvider = normalizeBackendType(agent?.backend_type || '');
          if (agentProvider && agentProvider === normalizeBackendType(caller.providerType)) {
            isolateWithManagedSession = providerBindings.isActiveElsewhere({
              agentId: p.agentId,
              channelId: p.toUid,
              channelType,
              providerType: agentProvider,
              providerInstanceId: caller.providerInstanceId || caller.instanceId || agent?.backend_instance_id || null,
              nativeSessionId: caller.nativeSessionId,
            });
            pendingBinding = providerBindings.beginCallerBinding({
              agentId: p.agentId,
              channelId: p.toUid,
              channelType,
              providerType: agentProvider,
              providerInstanceId: caller.providerInstanceId || caller.instanceId || agent?.backend_instance_id || null,
              nativeSessionId: caller.nativeSessionId,
              deliveryMode: caller.source === 'cli' ? 'cli' : 'mcp',
              adapterType: `${agentProvider}-${caller.source === 'cli' ? 'cli' : 'mcp'}`,
              pendingMessageId: outboundMessageId,
            });
          }
        } catch (_) {
          pendingBinding = null;
        }
      }

      const routingConversationWasPending = routingConversation?.status === 'pending';
      const routeMetadata = outboundRouteId ? { _voko: { protocolVersion: 1, routeId: outboundRouteId,
        ...(replyToRouteId ? { replyToRouteId } : {}),
        ...(routingConversation?.wireConversationKey ? { conversationKey: routingConversation.wireConversationKey } : {}),
        ...(routingConversation?.status === 'pending' ? { conversationStart: true } : {}) },
        ...(p._e2eeAttachmentSource ? { _e2eeAttachment: p._e2eeAttachmentSource } : {}) } :
        (p._e2eeAttachmentSource ? { _e2eeAttachment: p._e2eeAttachmentSource } : undefined);
      const result = await cx.sendMessage(
        p.agentId, p.toUid, content, fromUid, messageType, channelType, mentions, outboundMessageId,
        routeMetadata,
      );
      if (outboundRouteId) {
        try {
          if (result?.success !== false) messageRoutes.setStatus(outboundRouteId, 'active');
          else if (!result?.outcomeUnknown) messageRoutes.setStatus(outboundRouteId, 'failed');
        } catch (_) {}
      }
      if (pendingBinding) {
        try {
          if (result?.success !== false) providerBindings.activatePending(pendingBinding.id);
          else providerBindings.discardPending(pendingBinding.id);
        } catch (_) {
          try { providerBindings.discardPending(pendingBinding.id); } catch (_) {}
        }
      } else if (isolateWithManagedSession && result?.success !== false) {
        try { providerBindings.markConversationStale(p.agentId, p.toUid, channelType); } catch (_) {}
      }
      // A Web-created Conversation is a logical VOKO conversation. Once its
      // first outbound message is accepted it is usable even when the peer is
      // a human and will never expose a Provider-native Session.
      if (p.webRequest === true && routingConversationWasPending && result?.success !== false) {
        try {
          routingConversations.activate(routingConversation.id);
          routingConversation = { ...routingConversation, status: 'active', updatedAt: Date.now(), lastUsedAt: Date.now() };
        } catch (_) {}
      }
      // 检测收消息通道是否畅通
      if (cx.checkReceiveChannel) {
        const ch = cx.checkReceiveChannel(p.agentId);
        result.receiveReadiness = {
          status: ch?.ok ? 'ready' : 'pull_only',
          automaticDelivery: !!ch?.ok,
          fallback: 'voko_fetch_new_messages',
        };
      }
      result.messageAccepted = result?.success !== false;
      if (routingConversation) {
        result.conversationId = routingConversation.id;
        result.conversationStatus = routingConversation.status;
        result.conversationDisposition = routingConversationWasPending ? 'created' : 'reused';
      } else {
        result.conversationId = null;
        result.conversationStatus = null;
        result.conversationDisposition = null;
      }
      result.recipientDelivery = result.messageAccepted
        ? { status: result?.connected === false ? 'queued' : 'accepted', message: result?.connected === false ? '发送成功，等待对方上线' : '消息已接受' }
        : { status: 'failed' };
      return result;
    },

    // ─── 9. 聊天历史 ───

    async get_chat_history(p: McpToolParams = {}) {
      const ownershipError = _agentOwnershipError(p.agentId);
      if (ownershipError) return { success: false, error: ownershipError, code: 'AGENT_OWNER_MISMATCH' };
      const limit = Math.min(p.limit || 20, 200);
      const offset = p.offset || 0;
      // order：'desc'（默认，最新在前）| 'asc'（最旧在前，按时间正序阅读）
      const ascending = p.order === 'asc';
      const channelType = inferChannelType(p);
      const channelId = String(p.channelId || (channelType === 1 ? p.visitorId || '' : '')).trim();
      if (!channelId) {
        return { success: false, error: channelType === 2 ? '群聊查询必须提供 channelId' : '必须提供 channelId', code: 'CHANNEL_ID_REQUIRED' };
      }

      let requestedConversation: RoutingConversation | null = null;
      if (p.conversationId) {
        requestedConversation = routingConversations.getForScope(p.conversationId, p.agentId, channelId, channelType);
        if (!requestedConversation) {
          return { success: false, error: 'Conversation is outside the current Agent and channel', code: 'ROUTING_CONVERSATION_INVALID' };
        }
      }

      if (channelType === 2) {
        // 群聊：共享消息表按 message id 只存一份；兼容历史重复数据，仍先去重再分页
        let gsql = `SELECT messages.* FROM messages WHERE channel_id=? AND channel_type=2`;
        const gparams: unknown[] = [channelId];
        if (requestedConversation) {
          gsql += ` AND EXISTS (SELECT 1 FROM provider_message_routes pmr
            WHERE pmr.message_id=messages.id AND pmr.agent_id=? AND pmr.conversation_id=?)`;
          gparams.push(p.agentId, requestedConversation.id);
        }
        if (p.keyword) { gsql += ` AND content LIKE ?`; gparams.push(`%${p.keyword}%`); }
        gsql += ascending
          ? ` ORDER BY timestamp ASC, message_seq ASC, id ASC`
          : ` ORDER BY timestamp DESC, message_seq DESC, id DESC`;
        const all = cx.query<MessageDbRow>(gsql, gparams);
        const seen = new Set();
        const dedup = [];
        for (const r of all) {
          const key = r.client_msg_no || (r.message_seq != null ? 'seq:' + r.message_seq : '') || r.id;
          if (seen.has(key)) continue;
          seen.add(key);
          dedup.push(r);
        }
        const rows = dedup.slice(offset, offset + limit + 1);
        const hasMore = rows.length > limit;
        if (hasMore) rows.pop();
        attachConversationIds(rows, p.agentId);
        return { success: true, messages: rows.map(fmtMsg), hasMore, count: rows.length, offset,
          conversationId: requestedConversation?.id || null };
      }

      // 单聊：保留 agent_id 过滤，排除群聊消息防 channel_id 碰撞串数据
      let sql = `SELECT * FROM messages WHERE channel_id=? AND agent_id=? AND channel_type!=2`;
      const params: unknown[] = [channelId, p.agentId];
      if (requestedConversation) {
        sql += ` AND EXISTS (SELECT 1 FROM provider_message_routes pmr
          WHERE pmr.message_id=messages.id AND pmr.agent_id=? AND pmr.conversation_id=?)`;
        params.push(p.agentId, requestedConversation.id);
      }
      if (p.keyword) { sql += ` AND content LIKE ?`; params.push(`%${p.keyword}%`); }
      sql += ascending
        ? ` ORDER BY timestamp ASC, message_seq ASC, id ASC LIMIT ? OFFSET ?`
        : ` ORDER BY timestamp DESC, message_seq DESC, id DESC LIMIT ? OFFSET ?`;
      params.push(limit + 1, offset);
      const rows = cx.query<MessageDbRow>(sql, params);
      const hasMore = rows.length > limit;
      if (hasMore) rows.pop();
      attachConversationIds(rows, p.agentId);
      return { success: true, messages: rows.map(fmtMsg), hasMore, count: rows.length, offset,
        conversationId: requestedConversation?.id || null };
    },

    // ─── 10. 访客信息 ───

    async get_visitor_profile(p: McpToolParams = {}) {
      const { visitorId, agentId } = p;
      if (!agentId) return { success: false, error: 'agentId is required' };
      const ownershipError = _agentOwnershipError(agentId);
      if (ownershipError) return { success: false, error: ownershipError };
      const msgLimit = p.limit || 10;
      const msgOffset = p.offset || 0;
      const cache = cx.query(`SELECT uid, nickname, avatar_url FROM user_cache WHERE uid=? LIMIT 1`, [visitorId]);
      const profile = cache && cache[0] ? cache[0] : { uid: visitorId };

      // 消息统计
      const statsSql = `SELECT COUNT(*) as total, MIN(timestamp) as firstAt, MAX(timestamp) as lastAt FROM messages WHERE from_uid=? AND agent_id=?`;
      const msgStats = cx.query(statsSql, [visitorId, agentId]);
      const totalMessages = msgStats[0]?.total || 0;
      const firstMessageAt = msgStats[0]?.firstAt || null;
      const lastMessageAt = msgStats[0]?.lastAt || null;

      // 黑白名单状态（需要 agentId）
      let isWhitelisted = false, isBlacklisted = false;
      if (agentId) {
        isWhitelisted = !!cx.query(`SELECT 1 FROM agent_access_lists WHERE agent_id=? AND list_type='whitelist' AND visitor_id=?`, [agentId, visitorId]).length;
        isBlacklisted = !!cx.query(`SELECT 1 FROM agent_access_lists WHERE agent_id=? AND list_type='blacklist' AND visitor_id=?`, [agentId, visitorId]).length;
      }

      // 最近对话（可配置条数、可翻页）
      const recentSql = `SELECT content, timestamp, is_me FROM messages WHERE channel_id=? AND agent_id=? AND content_type!=11 ORDER BY timestamp DESC LIMIT ? OFFSET ?`;
      const recentMulti = msgLimit + 1; // 多取 1 条用来算 hasMore
      const recentParams = [visitorId, agentId, recentMulti, msgOffset];
      const recentRows = cx.query<MessageDbRow>(recentSql, recentParams);
      const hasMore = recentRows.length > msgLimit;
      if (hasMore) recentRows.pop();
      const recentMessages = recentRows.reverse().map((row) => ({
        content: row.content,
        timestamp: row.timestamp,
        isMe: row.is_me >= 1,
      }));

      // 入站审核统计（只算访客触发的拦截，按 agent 隔离）
      const auditSql = `SELECT is_me, content, timestamp FROM messages WHERE from_uid=? AND agent_id=? AND content_type=11 ORDER BY timestamp DESC LIMIT 50`;
      const auditParams = [visitorId, agentId];
      const auditRows = cx.query(auditSql, auditParams);
      let audit = { totalHits: 0, hardDenyCount: 0, softDenyCount: 0, lastHitAt: null, lastKeyword: null };
      for (const r of auditRows) {
        if (r.is_me !== 0) continue; // 只计入站
        audit.totalHits++;
        try {
          const parsed = JSON.parse(r.content);
          if (parsed.action === 'hard_deny') audit.hardDenyCount++;
          else if (parsed.action === 'soft_deny') audit.softDenyCount++;
          if (!audit.lastHitAt || r.timestamp > audit.lastHitAt) {
            audit.lastHitAt = r.timestamp;
            audit.lastKeyword = parsed.keyword || null;
          }
        } catch (_: any) {}
      }

      // 支付记录
      const paidSql = `SELECT 1 FROM payment_orders WHERE visitor_id=? AND agent_id=? AND status='paid' LIMIT 1`;
      const paidRows = cx.query(paidSql, [visitorId, agentId]);
      const hasPaid = paidRows.length > 0;

      return {
        success: true,
        visitorId,
        nickname: profile.nickname || null,
        avatarUrl: profile.avatar_url || null,
        totalMessages,
        firstMessageAt,
        lastMessageAt,
        isWhitelisted,
        isBlacklisted,
        recentMessages,
        hasMore,
        audit,
        hasPaid,
      };
    },

    // ─── 11. 会话列表 ───

    async list_conversations(p: McpToolParams = {}) {
      const limit = Math.min(p.limit || 20, 100);
      const offset = p.offset || 0;
      const filter = p.filter || 'unreplied';
      const chatType = p.channelType || 'all'; // direct | group | all
      const keyword = p.keyword || '';
      let whereClause = `WHERE agent_id=?`;
      const whereParams: unknown[] = [p.agentId];
      if (chatType === 'direct') { whereClause += ` AND channel_type=1`; }
      else if (chatType === 'group') { whereClause += ` AND channel_type=2`; }
      if (keyword) { const kw='%'+keyword+'%'; whereClause += ` AND (name LIKE ? OR user_uid LIKE ?)`; whereParams.push(kw, kw); }
      // 总数
      const countRow = cx.query(`SELECT COUNT(*) as cnt FROM conversations ${whereClause}`, whereParams);
      const total = countRow[0]?.cnt || 0;
      // 数据
      const dataParams = [...whereParams, limit, offset];
      const rows = cx.query<ConversationDbRow>(`SELECT * FROM conversations ${whereClause} ORDER BY last_timestamp DESC LIMIT ? OFFSET ?`, dataParams);
      return {
        success: true,
        total,
        conversations: rows.map((r) => {
          const isGroup = r.channel_type === 2;
          // 群聊按 @触发，不显示"待回复"红点
          if (isGroup) {
            return {
              channelId: r.channel_id,
              name: r.name,
              lastMessage: r.last_message,
              lastTimestamp: r.last_timestamp,
              unreadCount: r.unread_count || 0,
              needsReply: false,
              channelType: 2,
            };
          }
          // 单聊：查最后一条消息是谁发的
          const lastMsg = cx.query(`SELECT is_me, content_type FROM messages WHERE channel_id=? AND agent_id=? ORDER BY timestamp DESC LIMIT 1`, [r.channel_id, p.agentId]);
          const lastIsMeRow = lastMsg?.[0]?.is_me;
          const lastCtRow = lastMsg?.[0]?.content_type || 1;
          // needsReply：最后一条是真实访客消息（is_me=0 且非拦截/系统）
          const needsReply = lastIsMeRow === 0 && lastCtRow !== 11;
          // 计算未回复的访客消息数：最后一条 agent 回复之后，还有多少条访客消息
          let unreadCount = 0;
          if (needsReply) {
            const lastAgentReply = cx.query(`SELECT timestamp FROM messages WHERE channel_id=? AND agent_id=? AND is_me=1 AND (content_type IS NULL OR content_type<10) ORDER BY timestamp DESC LIMIT 1`, [r.channel_id, p.agentId]);
            const since = lastAgentReply?.[0]?.timestamp || 0;
            unreadCount = cx.query(`SELECT COUNT(*) as cnt FROM messages WHERE channel_id=? AND agent_id=? AND is_me=0 AND timestamp > ?`, [r.channel_id, p.agentId, since])[0]?.cnt || 0;
          }
          return {
            channelId: r.channel_id,
            name: r.name,
            lastMessage: r.last_message,
            lastTimestamp: r.last_timestamp,
            unreadCount,
            needsReply,
            lastContentType: lastMsg?.[0]?.content_type || 1,
            lastIsMe: lastMsg?.[0]?.is_me,
            channelType: 1,
          };
        })
        .filter((c?: any) => filter === 'all' || c.needsReply),
      };
    },

    // ─── 12. 标记会话已读 ───

    async mark_conversation_read(p: McpToolParams = {}) {
      const { agentId, channelId } = p;
      if (!agentId || !channelId) return { success: false, error: '缺少 agentId 或 channelId' };
      try {
        cx.db.prepare(`UPDATE conversations SET unread_count = 0 WHERE channel_id = ? AND agent_id = ?`).run(channelId, agentId);
        return { success: true };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    },

    // ─── 13. 上传并发送附件 ───

    async list_routing_conversations(p: McpToolParams = {}) {
      const ownershipError = _agentOwnershipError(p.agentId);
      if (ownershipError) return { success: false, error: ownershipError, code: 'AGENT_OWNER_MISMATCH' };
      const channelType = inferChannelType(p);
      const channelId = String(p.channelId || p.visitorId || '').trim();
      if (!channelId) return { success: false, error: 'channelId is required', code: 'CHANNEL_ID_REQUIRED' };
      const limit = Math.min(Math.max(Number(p.limit) || 20, 1), 100);
      const offset = Math.max(Number(p.offset) || 0, 0);
      const rows = routingConversations.listForScope(p.agentId, channelId, channelType);
      const page = rows.slice(offset, offset + limit);
      return {
        success: true, channelId, channelType, total: rows.length,
        hasMore: offset + page.length < rows.length,
        conversations: page.map((conversation: RoutingConversation) => ({
          conversationId: conversation.id,
          status: conversation.status,
          origin: conversation.origin,
          createdAt: conversation.createdAt,
          updatedAt: conversation.updatedAt,
          lastUsedAt: conversation.lastUsedAt,
        })),
      };
    },

    async upload_and_send_file(p: McpToolParams = {}) {
      const ownershipError = _agentOwnershipError(p.agentId);
      if (ownershipError) return { success: false, error: ownershipError, code: 'AGENT_OWNER_MISMATCH' };
      if (!p.agentId || !p.toUid) return { success: false, error: '缺少 agentId 或 toUid' };
      const channelType = inferChannelType(p);
      const inspection = inspectAttachment(p);
      if (!inspection.success) return inspection;
      const inspected = inspection as { success:true;filePath:string;fileName:string;fileSize:number;
        mimeType:string;contentType:number;ext:string };
      const safeAttachmentInfo = { fileName: inspected.fileName, fileSize: inspected.fileSize,
        mimeType: inspected.mimeType, contentType: inspected.contentType };
      let effectiveConversationId = p.conversationId;
      if (channelType === 1 && cx.secureOutboundRouter) {
        let scopedConversation: RoutingConversation | null = null;
        try {
          if (p.conversationId) scopedConversation = routingConversations.getForScope(
            p.conversationId, p.agentId, p.toUid, 1);
          else if (p.replyToMessageId) {
            const prior = messageRoutes.getByMessage(p.replyToMessageId, p.agentId);
            if (prior?.conversation_id) scopedConversation = routingConversations.getForScope(
              prior.conversation_id, p.agentId, p.toUid, 1);
          }
          if ((p.conversationId || p.replyToMessageId) && !scopedConversation) {
            return { success: false, code: 'ROUTING_CONVERSATION_INVALID',
              error: 'Conversation does not belong to the current Agent and channel' };
          }
          if (!scopedConversation) {
            const caller = getProviderCaller();
            if (caller?.providerType && caller?.nativeSessionId && caller?.evidence) {
              const agent = cx.query<{ backend_type?: string; backend_instance_id?: string }>(
                'SELECT backend_type,backend_instance_id FROM agents WHERE agent_id=? LIMIT 1', [p.agentId],
              )[0];
              const callerFamily = normalizeProviderFamily(caller.providerType);
              if (callerFamily === normalizeProviderFamily(agent?.backend_type || '')) {
                scopedConversation = routingConversations.resolveOrCreate({ agentId: p.agentId,
                  providerFamily: callerFamily,
                  providerInstanceKey: caller.providerInstanceId || caller.instanceId
                    || agent?.backend_instance_id || '',
                  nativeSessionId: caller.nativeSessionId, channelId: p.toUid, channelType: 1, origin: 'caller' });
              }
            }
          }
          if (!scopedConversation && p.webRequest === true) {
            const current = routingConversations.listForScope(p.agentId, p.toUid, 1);
            scopedConversation = current.length === 1
              ? current[0]
              : current.find((item: RoutingConversation) => item.status === 'pending')
                || routingConversations.createPending({ agentId: p.agentId, channelId: p.toUid, channelType: 1 });
          }
          if (scopedConversation) effectiveConversationId = scopedConversation.id;
        } catch (error: any) {
          return { success: false, code: 'ROUTING_CONVERSATION_INVALID', error: error?.message || String(error) };
        }
        const preflightMetadata = scopedConversation?.wireConversationKey
          ? { _voko: { protocolVersion: 1, conversationKey: scopedConversation.wireConversationKey } } : undefined;
        const security = await cx.secureOutboundRouter.prepare(p.agentId, p.toUid, 1, preflightMetadata, 'attachment');
        if (!security.success) return { ...safeAttachmentInfo, ...security, success: false };
        if (security.securityMode === 'e2ee') {
          const message = String(p.message || '').trim();
          let textMessageId: string | undefined;
          if (message) {
            const textResult = await handlers.send_message({ agentId: p.agentId, toUid: p.toUid,
              channelType, content: message, conversationId: effectiveConversationId,
              replyToMessageId: p.replyToMessageId, webRequest: p.webRequest });
            if (textResult?.success === false) return { ...safeAttachmentInfo, ...security, success: false, error: textResult.error };
            textMessageId = textResult?.messageId;
          }
          const attachmentMessageId = `msg-${p.agentId}-${Date.now()}-${require('crypto').randomUUID()}`;
          const localUrl = `/api/e2ee-v2/attachments/${encodeURIComponent(attachmentMessageId)}`
            + `?agentId=${encodeURIComponent(p.agentId)}`;
          const attachment = { url: localUrl, name: inspected.fileName, size: inspected.fileSize, type: inspected.mimeType };
          const fileResult = await handlers.send_message({ agentId: p.agentId, toUid: p.toUid, channelType,
            contentType: inspected.contentType,
            content: inspected.contentType === 2 ? localUrl : attachment,
            conversationId: effectiveConversationId, replyToMessageId: p.replyToMessageId, webRequest: p.webRequest,
            _requestedMessageId: attachmentMessageId,
            _e2eeAttachmentSource: { filePath: inspected.filePath, fileName: inspected.fileName,
              mediaType: inspected.mimeType } });
          return { ...safeAttachmentInfo, url: localUrl, textMessageId, messageId: fileResult?.messageId,
            success: fileResult?.success !== false, ...(fileResult?.error ? { error: fileResult.error } : {}),
            securityMode: fileResult?.securityMode, securityReason: fileResult?.securityReason,
            encryptedDeviceCount: fileResult?.encryptedDeviceCount, deliveryState: fileResult?.deliveryState,
            conversationId: fileResult?.conversationId ?? null, conversationStatus: fileResult?.conversationStatus ?? null,
            conversationDisposition: fileResult?.conversationDisposition ?? null };
        }
      }

      const uploadResult = await uploadAttachment(cx, p);
      if (!uploadResult.success) return uploadResult;
      const uploaded = uploadResult as { success:true;url:string;fileName:string;fileSize:number;
        mimeType:string;contentType:number };
      const message = String(p.message || '').trim();
      let textMessageId: string | undefined;
      if (message) {
        const textResult = await handlers.send_message({
          agentId: p.agentId,
          toUid: p.toUid,
          channelType,
          content: message,
          mentions: p.mentions,
          conversationId: effectiveConversationId,
          replyToMessageId: p.replyToMessageId,
          webRequest: p.webRequest,
        });
        if (textResult?.success === false) return { ...uploaded, success: false, error: textResult.error };
        textMessageId = textResult?.messageId;
      }

      const attachment = {
        url: uploaded.url,
        name: uploaded.fileName,
        size: uploaded.fileSize,
        type: uploaded.mimeType,
      };
      const fileResult = await handlers.send_message({
        agentId: p.agentId,
        toUid: p.toUid,
        channelType,
        contentType: uploaded.contentType,
        content: uploaded.contentType === 2 ? uploaded.url : attachment,
        mentions: p.mentions,
        conversationId: effectiveConversationId,
        replyToMessageId: p.replyToMessageId,
        webRequest: p.webRequest,
      });
      if (fileResult?.success === false) {
        return { ...uploaded, success: false, error: fileResult.error, textMessageId };
      }
      return {
        ...uploaded,
        messageId: fileResult?.messageId,
        textMessageId,
        conversationId: fileResult?.conversationId ?? null,
        conversationStatus: fileResult?.conversationStatus ?? null,
        conversationDisposition: fileResult?.conversationDisposition ?? null,
      };
    },

    // ─── 13. whoami ───

    async list_agents(p: McpToolParams = {}) {
      return { success: true, ..._listOwnedAgents(p) };
    },

    async whoami(p: McpToolParams = {}) {
      const explicitOwnershipError = _agentOwnershipError(p.agentId);
      if (explicitOwnershipError) return { success: false, error: explicitOwnershipError, code: 'AGENT_OWNER_MISMATCH' };
      const agents = _listOwnedAgents({ limit: 500 }).agents;
      const compact = (agent: any) => agent ? ({
        agentId: agent.agentId,
        agentName: agent.agentName,
        backendType: agent.backendType,
        backendInstanceId: agent.backendInstanceId,
        deliveryModes: agent.deliveryModes,
        publishStatus: agent.publishStatus,
        accessMode: agent.accessMode,
      }) : null;
      const candidate = (agent: any) => ({
        agentId: agent.agentId,
        agentName: agent.agentName,
        backendType: agent.backendType,
        backendInstanceId: agent.backendInstanceId,
      });
      const caller = getProviderCaller();
      let callerProviderFamily = '';
      try { callerProviderFamily = caller?.providerType ? normalizeProviderFamily(caller.providerType) : ''; } catch (_) {}
      const providerCandidates = callerProviderFamily
        ? agents.filter((agent: any) => normalizeProviderFamily(agent.backendType) === callerProviderFamily)
        : [];
      let identity: any = { status: 'unavailable', method: 'none', reason: 'no_agents', requiresAgentId: false };
      let currentAgent: any = null;
      if (p.agentId) {
        currentAgent = agents.find((agent: any) => agent.agentId === p.agentId) || null;
        identity = currentAgent
          ? { status: 'resolved', method: 'explicit_agent_id', requiresAgentId: false }
          : { status: 'unavailable', method: 'explicit_agent_id', reason: 'agent_not_found', requiresAgentId: false };
      } else if (agents.length === 1) {
        currentAgent = agents[0];
        identity = { status: 'resolved', method: 'sole_registered_agent', requiresAgentId: false };
      } else if (featureEnabled('provider_identity_v1', true) && caller?.providerType && providerCandidates.length > 0) {
        if (providerCandidates.length === 1) {
          currentAgent = providerCandidates[0];
          identity = { status: 'resolved', method: 'sole_provider_agent', requiresAgentId: false };
        } else if (caller.nativeSessionId && caller.evidence) {
          try {
            const providerCandidateIds = new Set(providerCandidates.map((agent: any) => agent.agentId));
            const candidateIds = identityBindings.resolve(
              caller.providerType, caller.providerInstanceId || caller.instanceId || '', caller.nativeSessionId,
            ).filter((id: string) => providerCandidateIds.has(id));
            identity = candidateIds.length === 1
              ? { status: 'resolved', method: 'provider_binding', requiresAgentId: false }
              : { status: 'selection_required', method: 'none', reason: candidateIds.length > 1 ? 'ambiguous_binding' : 'unbound_session', requiresAgentId: true };
            if (candidateIds.length === 1) {
              currentAgent = providerCandidates.find((agent: any) => agent.agentId === candidateIds[0]) || null;
            }
          } catch (_) {
            identity = { status: 'selection_required', method: 'none', reason: 'identity_lookup_failed', requiresAgentId: true };
          }
        } else {
          identity = { status: 'selection_required', method: 'none', reason: 'multiple_provider_agents', requiresAgentId: true };
        }
      } else if (agents.length > 1) {
        identity = { status: 'selection_required', method: 'none', reason: 'multiple_agents', requiresAgentId: true };
      }
      return {
        success: true,
        currentAgent: compact(currentAgent),
        identity,
        ...(identity.status === 'selection_required'
          ? { candidates: (callerProviderFamily && providerCandidates.length > 0 ? providerCandidates : agents).map(candidate) }
          : {}),
        ...(identity.status === 'selection_required'
          ? { nextAction: {
              type: 'select_agent',
              tool: 'voko_list_agents',
              instructions: 'Choose one candidate and retry voko_whoami with its agentId. VOKO will verify ownership; it will not create or modify an identity binding.',
            } }
          : {}),
      };
    },

    // ─── 14-16. 人工介入 ───

    async ask_human_for_help(p: McpToolParams = {}) {
      const reservedPrefix = reservedVisitorPrefix(p.visitorId);
      if (reservedPrefix) return { success: false, code: 'VISITOR_ID_RESERVED',
        error: `visitorId 使用 VOKO 保留命名空间：${reservedPrefix}` };
      const now = Date.now();
      const id = `mcp_${now}_${Math.random().toString(36).substr(2, 6)}`;
      const ownerChannelType = cx.getEnabledChannel?.()?.name || null;
      const targetChannelType = Number(p.channelType) === 2 ? 2 : 1;
      if (targetChannelType === 2 && !p.channelId) {
        return { success: false, error: t('mcp.tool.ask_human_for_help.error.channelIdRequired') };
      }
      const requestedSourceMessageId = p.replyToMessageId || p.messageId || null;
      const activeE2ee = targetChannelType === 1
        ? resolveActiveOwnerInterventionContext(p.agentId, requestedSourceMessageId)
        : { status: 'unavailable' };
      if (activeE2ee.status === 'ambiguous') return { success: false, code: 'CONVERSATION_REQUIRED',
        error: 'Multiple active E2EE conversations are available; provide the source message ID' };
      const e2eeContext = activeE2ee.status === 'resolved' ? activeE2ee.context : null;
      const visitorId = e2eeContext?.visitorId || p.visitorId;
      const targetChannelId = targetChannelType === 2 ? p.channelId : (e2eeContext?.channelId || p.visitorId);
      const sessionTarget = targetChannelType === 2 ? `group:${targetChannelId}` : visitorId;
      const sourceMessageId = e2eeContext?.sourceMessageId || requestedSourceMessageId;
      const resolution = resolveOwnerInterventionConversation(cx.db, { agentId: p.agentId,
        channelId: targetChannelId, channelType: targetChannelType, caller: getProviderCaller(),
        sourceMessageId, conversationId: p.conversationId || null });
      if (resolution.status === 'selection_required') return { success: false, code: 'CONVERSATION_REQUIRED',
        error: 'Multiple Provider conversations are available; select conversationId',
        candidateConversationIds: resolution.candidateConversationIds };
      if (resolution.status === 'unavailable' && p.conversationId) return { success: false,
        code: 'ROUTING_CONVERSATION_INVALID', error: 'The source message or Conversation cannot be routed in this channel' };
      const routingConversationId = resolution.status === 'resolved' ? resolution.conversationId : null;

      // 根据 backend 类型决定 session_key 前缀
      const backendRow = cx.query ? cx.query(`SELECT backend_type FROM agents WHERE agent_id=?`, [p.agentId]) : [];
      const backendType = backendRow?.[0]?.backend_type || 'openclaw';
      const prefix = backendType === 'hermes' ? 'hermes' : 'agent';
      cx.exec(`
        INSERT INTO owner_interventions (id, agent_id, visitor_id, session_key, problem, agent_suggestion, ask_time, expire_time, status, channel_type, created_at, updated_at, source_sender_uid, target_channel_id, target_channel_type, source_message_id, routing_conversation_id, route_security_mode, e2ee_protocol_conversation_id, e2ee_session_scope_id)
        VALUES (?,?,?,?,?,?,?,?,'pending',?,?,?,?,?,?,?,?,?,?,?)
      `, [id, p.agentId, visitorId, `${prefix}:${p.agentId}:${sessionTarget}`, p.problem, p.suggestion || null,
        now, ownerInterventionExpireTime(now), ownerChannelType, now, now, visitorId, targetChannelId,
        targetChannelType, sourceMessageId, routingConversationId, e2eeContext ? 'e2ee_v2' : 'standard',
        e2eeContext?.protocolConversationId || null, e2eeContext?.sessionScopeId || null]);
      // 事件驱动：立即通知主人，不等轮询
      if (cx.enqueueOwnerIntervention) {
        cx.enqueueOwnerIntervention({
          id, visitorId, agentId: p.agentId,
          sessionKey: `${prefix}:${p.agentId}:${sessionTarget}`,
          problem: p.problem, agentSuggestion: p.suggestion || '',
          askTime: now, expireTime: ownerInterventionExpireTime(now), skipReply: 0, sourceSenderUid: visitorId,
          routingConversationId,
          targetChannelId, targetChannelType, sourceMessageId,
          routeSecurityMode: e2eeContext ? 'e2ee_v2' : 'standard',
          e2eeProtocolConversationId: e2eeContext?.protocolConversationId || null,
          e2eeSessionScopeId: e2eeContext?.sessionScopeId || null,
        });
      }
      if (e2eeContext) notifyOwnerInterventionCreated(e2eeContext);
      return { success: true, interventionId: id, conversationId: routingConversationId };
    },

    async check_human_replies(p: McpToolParams = {}) {
      const now = Date.now();
      cx.exec(`UPDATE owner_interventions
        SET status='expired',resolved_at=?,updated_at=?
        WHERE agent_id=? AND status IN ('pending','awaiting')
        AND expire_time IS NOT NULL AND expire_time<=?`, [now, now, p.agentId, now]);
      // 按 id 查单条
      if (p.id) {
        const r = cx.query(`SELECT * FROM owner_interventions
          WHERE id=? AND agent_id=? AND status NOT IN ('expired','resolved','cancelled')`, [p.id, p.agentId])[0];
        return {
          success: true,
          interventions: r ? [{
            id: r.id,
            visitorId: r.visitor_id,
            problem: r.problem,
            suggestion: r.agent_suggestion,
            askTime: r.ask_time,
            ownerReply: r.owner_reply,
            replyTime: r.reply_time,
            status: r.status,
            sourceSenderUid: r.source_sender_uid || r.visitor_id,
            channelId: r.target_channel_id || r.visitor_id,
            channelType: r.target_channel_type || 1,
            messageId: r.source_message_id || null,
            conversationId: r.routing_conversation_id || null,
          }] : [],
          hasMore: false,
        };
      }

      const limit = Math.min(p.limit || 20, 50);
      const offset = p.offset || 0;
      const multi = limit + 1;

      // 自动游标：不传 since 时自动记录上次查询的最大 askTime
      const cursorKey = `check_human_replies:${p.agentId}`;
      const automaticCursor = p.since === undefined;
      const checkpoint = automaticCursor ? _getTimestampIdCursorDb(cx.db, cursorKey) : null;
      const since = automaticCursor ? checkpoint!.timestamp : p.since;

      // 构造 SQL
      const conditions = [`agent_id=?`, `status NOT IN ('expired','resolved','cancelled')`];
      const params: unknown[] = [p.agentId];
      if (p.visitorId) {
        conditions.push(`visitor_id=?`);
        params.push(p.visitorId);
      }
      if (since) {
        if (automaticCursor) {
          conditions.push(`(ask_time>? OR (ask_time=? AND id>?))`);
          params.push(since, since, checkpoint!.id);
        } else {
          conditions.push(`ask_time>?`);
          params.push(since);
        }
      }
      params.push(multi, automaticCursor ? 0 : offset);

      const rows = cx.query<InterventionDbRow>(
        `SELECT * FROM owner_interventions WHERE ${conditions.join(' AND ')} ORDER BY ask_time ${automaticCursor ? 'ASC, id ASC' : 'DESC'} LIMIT ? OFFSET ?`,
        params
      );

      const hasMore = rows.length > limit;
      if (hasMore) rows.pop();
      if (automaticCursor && rows.length > 0) {
        const last = rows[rows.length - 1];
        _setTimestampIdCursorDb(cx.db, cursorKey, last.ask_time, last.id);
      }
      return {
        success: true,
        interventions: rows.map((r) => ({
          id: r.id,
          visitorId: r.visitor_id,
          problem: r.problem,
          suggestion: r.agent_suggestion,
          askTime: r.ask_time,
          ownerReply: r.owner_reply,
          replyTime: r.reply_time,
          status: r.status,
          sourceSenderUid: r.source_sender_uid || r.visitor_id,
          channelId: r.target_channel_id || r.visitor_id,
          channelType: r.target_channel_type || 1,
          messageId: r.source_message_id || null,
          conversationId: r.routing_conversation_id || null,
        })),
        hasMore,
      };
    },

    async close_human_request(p: McpToolParams = {}) {
      const now = Date.now();
      const result = cx.exec(`UPDATE owner_interventions SET status='resolved', resolved_at=?, updated_at=?
        WHERE id=? AND agent_id=? AND status NOT IN ('expired','resolved','cancelled')`, [now, now, p.id, p.agentId]);
      return { success: true, closed: (result?.changes || 0) > 0 };
    },

    // ─── 16. 收款 ───

    async create_payment(p: McpToolParams = {}) {
      const hasAuth = cx.getPaymentAuth ? cx.getPaymentAuth(p.agentId) as PaymentAuthDetailRow | null : null;
      if (!hasAuth) return { success: false, error: '该 Agent 未配置支付认证，请通知主人配置' };
      const amount = Number(p.amount);
      const cents = Math.round(amount * 100);
      if (!Number.isFinite(amount) || cents < 1 || cents > 99999999999999 || Math.abs(amount * 100 - cents) > 1e-8) {
        return { success: false, error: t('mcp.payment.invalid_amount') };
      }
      const completedAuth = cx.query<PaymentAuthDetailRow>(
        `SELECT receiver_apply_status FROM payment_auth WHERE id = ?`,
        [hasAuth.id]
      )[0];
      if (String(completedAuth?.receiver_apply_status || '').trim().toUpperCase() !== 'COMPLETED') {
        return { success: false, error: t('mcp.payment.auth_incomplete') };
      }
      // 前置检查：Agent 必须已注册 DID 和私钥，否则后续无法完成 DID 签名
      const agentKey = cx.query ? cx.query(`SELECT did, private_key FROM agents WHERE agent_id=? AND did IS NOT NULL AND private_key IS NOT NULL`, [p.agentId]) : [];
      if (!agentKey || agentKey.length === 0) {
        return { success: false, error: '该 Agent 未注册 DID 或未配置私钥，无法创建支付订单，请通知主人配置' };
      }
      const now = Date.now();
      const orderId = `po_${now}_${Math.random().toString(36).substr(2, 8)}`;
      const fromUid = cx.getAgentImUid ? cx.getAgentImUid(p.agentId) : '';
      let paymentConversation: RoutingConversation | null = null;
      try {
        if (p.conversationId) {
          paymentConversation = routingConversations.getForScope(p.conversationId, p.agentId, p.visitorId, 1);
          if (!paymentConversation) return { success: false, code: 'ROUTING_CONVERSATION_INVALID', error: 'Conversation does not belong to the current Agent and visitor' };
        } else {
          const caller = getProviderCaller();
          const agent = cx.query<{ backend_type?: string; backend_instance_id?: string }>(
            'SELECT backend_type,backend_instance_id FROM agents WHERE agent_id=? LIMIT 1', [p.agentId])[0];
          if (caller?.providerType && caller?.nativeSessionId && caller?.evidence
            && normalizeProviderFamily(caller.providerType) === normalizeProviderFamily(agent?.backend_type || '')) {
            paymentConversation = routingConversations.resolveOrCreate({ agentId: p.agentId,
              providerFamily: normalizeProviderFamily(caller.providerType),
              providerInstanceKey: caller.providerInstanceId || caller.instanceId || agent?.backend_instance_id || '',
              nativeSessionId: caller.nativeSessionId, channelId: p.visitorId, channelType: 1, origin: 'caller' });
          }
        }
      } catch (error: any) {
        return { success: false, code: 'ROUTING_CONVERSATION_INVALID', error: error?.message || String(error) };
      }
      const paymentOrder = { id: orderId, agent_id: p.agentId, visitor_id: p.visitorId,
        from_uid: fromUid, amount, description: p.description || '', type: 'service', status: 'pending',
        created_at: now, updated_at: now, routing_conversation_id: paymentConversation?.id || null };
      cx.savePaymentOrder(paymentOrder);
      // 同步处理 pending 订单（DID 签名 → 调支付 API → 生成二维码 → 通知访客）
      // 注意：必须等待处理完成，否则 MCP 返回成功但访客收不到支付链接
      let paymentResult: DynamicRow | null = null;
      let processingError = '';
      if (cx.processPaymentOrder) {
        try {
          paymentResult = await cx.processPaymentOrder(paymentOrder) as DynamicRow;
        } catch (err: any) {
          console.error('[MCP] 处理支付订单失败:', err.message);
          processingError = err?.message || String(err);
        }
      }
      // 确认订单是否真的处理成功（不再为 pending）
      const processedOrder = cx.query ? cx.query(`SELECT status, order_no, pay_url, result FROM payment_orders WHERE id=?`, [orderId]) : [];
      const finalStatus = processedOrder?.[0]?.status || 'unknown';
      if (!['created', 'paid'].includes(finalStatus)) {
        console.error('[MCP] 支付订单处理异常，状态未变更:', orderId);
        return { success: false, orderCreated: false, sentToVisitor: false, deliveryStatus: 'not_attempted',
          error: processedOrder?.[0]?.result || processingError || '支付订单处理失败', orderId, status: finalStatus };
      }
      const reportedDeliveryStatus = String(paymentResult?.deliveryStatus || '');
      const deliveryStatus = ['delivered', 'pending', 'failed'].includes(reportedDeliveryStatus)
        ? reportedDeliveryStatus : processedOrder?.[0]?.result || processingError ? 'failed' : 'unknown';
      const deliveryError = deliveryStatus === 'failed'
        ? String(paymentResult?.error || processedOrder?.[0]?.result || processingError || '访客消息投递失败')
        : undefined;
      return { success: true, orderCreated: true, sentToVisitor: deliveryStatus === 'delivered',
        deliveryStatus, deliveryError, visitorId: p.visitorId, orderId,
        orderNo: processedOrder?.[0]?.order_no, payUrl: processedOrder?.[0]?.pay_url,
        messageId: paymentResult?.messageId, status: finalStatus };
    },

    // ─── 18. 查询支付 ───

    async check_payments(p: McpToolParams = {}) {
      const currentOwner = _currentOwnerEmail();
      if (!currentOwner) return { success: false, error: '未登录，无法查询支付订单' };
      // 按 orderId 查单条
      if (p.orderId) {
        const orderScope = p.agentId && p.agentId !== 'all' ? ` AND po.agent_id=?` : '';
        const orderParams = p.agentId && p.agentId !== 'all'
          ? [p.orderId, p.orderId, currentOwner, p.agentId]
          : [p.orderId, p.orderId, currentOwner];
        const r = cx.query(`SELECT po.id, po.agent_id, po.visitor_id, po.amount, po.description, po.order_no, po.status, po.created_at, po.updated_at FROM payment_orders po JOIN agents a ON a.agent_id=po.agent_id WHERE (po.id=? OR po.order_no=?) AND LOWER(TRIM(a.owner_email))=?${orderScope}`, orderParams)[0];
        return {
          success: true,
          orders: r ? [{
            orderId: r.id,
            visitorId: r.visitor_id,
            amount: r.amount,
            description: r.description,
            orderNo: r.order_no,
            status: r.status,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
          }] : [],
          hasMore: false,
        };
      }

      const limit = Math.min(p.limit || 20, 50);
      const offset = p.offset || 0;
      const multi = limit + 1;

      // 自动游标
      const cursorKey = `check_payments:${p.agentId || 'all'}`;
      const automaticCursor = p.since === undefined;
      const checkpoint = automaticCursor ? _getTimestampIdCursorDb(cx.db, cursorKey) : null;
      const since = automaticCursor ? checkpoint!.timestamp : p.since;

      const conditions = [`LOWER(TRIM(a.owner_email))=?`];
      const params: unknown[] = [currentOwner];
      if (p.agentId && p.agentId !== 'all') { conditions.push(`po.agent_id=?`); params.push(p.agentId); }
      if (p.visitorId) { conditions.push(`po.visitor_id=?`); params.push(p.visitorId); }
      if (p.status) { conditions.push(`po.status=?`); params.push(p.status); }
      if (since) {
        if (automaticCursor) {
          conditions.push(`(po.created_at>? OR (po.created_at=? AND po.id>?))`);
          params.push(since, since, checkpoint!.id);
        } else {
          conditions.push(`po.created_at>?`);
          params.push(since);
        }
      }
      params.push(multi, automaticCursor ? 0 : offset);

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const rows = cx.query<PaymentOrderDbRow>(
        `SELECT po.id, po.agent_id, po.visitor_id, po.amount, po.description, po.order_no, po.status, po.created_at, po.updated_at FROM payment_orders po JOIN agents a ON a.agent_id=po.agent_id ${whereClause} ORDER BY po.created_at ${automaticCursor ? 'ASC, po.id ASC' : 'DESC'} LIMIT ? OFFSET ?`,
        params
      );

      const hasMore = rows.length > limit;
      if (hasMore) rows.pop();
      if (automaticCursor && rows.length > 0) {
        const last = rows[rows.length - 1];
        _setTimestampIdCursorDb(cx.db, cursorKey, last.created_at, last.id);
      }
      return {
        success: true,
        orders: rows.map((r) => ({
          orderId: r.id,
          visitorId: r.visitor_id,
          amount: r.amount,
          description: r.description,
          orderNo: r.order_no,
          status: r.status,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        })),
        hasMore,
      };
    },

    // ─── 18b. 支付认证（入账银行卡）───

    async add_payment_auth(p: McpToolParams = {}) {
      const { name, idCard, bankCard, phone, bankCode, bankName } = p;
      const now = Date.now();
      const currentOwner = _currentOwnerEmail();
      if (!currentOwner) return { success: false, error: '未登录，无法添加支付认证' };

      if (!bankCode) return { success: false, error: 'bankCode 不能为空，请先通过 voko_search_banks 选择银行' };
      if (!bankCard) return { success: false, error: 'bankCard 不能为空' };
      const cleanBankCard = String(bankCard).replace(/\s/g, '');
      if (!/^\d{13,19}$/.test(cleanBankCard)) return { success: false, error: '银行卡号格式不正确，应为13-19位数字' };
      if (!phone || !/^1\d{10}$/.test(String(phone).trim())) return { success: false, error: '手机号格式不正确' };
      if (!name) return { success: false, error: '姓名不能为空' };
      if (!idCard) return { success: false, error: '身份证号不能为空' };
      if (!/^\d{17}[\dXx]$/.test(String(idCard).trim())) return { success: false, error: '身份证号格式不正确，应为18位' };

      const newId = 'pid_' + now + '_' + Math.random().toString(36).substr(2, 6);
      cx.exec(`INSERT INTO payment_auth (id, owner_email, name, id_card, bank_card, phone, receiver_type, bank_code, bank_name, company_name, unified_social_credit_code, legal_name, legal_licence_no, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [newId, currentOwner, name, idCard || '', cleanBankCard || '', phone || '', 1, bankCode || '', bankName || '', '', '', '', '', 'unverified', now, now]);
      return { success: true, id: newId };
    },

    // ─── 18c. 查看入账银行卡列表 ───

    async list_payment_auth(p: McpToolParams = {}) {
      const currentOwner = _currentOwnerEmail();
      if (!currentOwner) return { success: false, error: '未登录，无法查看支付认证', data: [] };
      const keyword = (p.keyword || '').trim();
      let sql = `SELECT * FROM payment_auth WHERE LOWER(TRIM(owner_email))=? ORDER BY updated_at DESC`;
      let params: unknown[] = [currentOwner];
      if (keyword) {
        const kw = `%${keyword}%`;
        sql = `SELECT * FROM payment_auth WHERE LOWER(TRIM(owner_email))=? AND (name LIKE ? OR bank_card LIKE ? OR phone LIKE ?) ORDER BY updated_at DESC`;
        params = [currentOwner, kw, kw, kw];
      }
      const rows = cx.query<PaymentAuthDbRow>(sql, params);
      const receiverStatusLabel: Record<string, string> = {
        'none': '未申请', PROCESSING: '申请中', AGREEMENT_SIGNING: '待签署',
        COMPLETED: '已完成', APPLY_REJECTED: '已拒绝'
      };
      const masked = rows.map((r) => ({
        id: r.id,
        name: r.name,
        nameMask: r.name ? r.name[0] + '*'.repeat(r.name.length - 1) : '',
        idCardMask: r.id_card ? r.id_card.substring(0, 4) + '**********' : '',
        bankCardMask: r.bank_card ? r.bank_card.substring(0, 4) + '****' + r.bank_card.slice(-4) : '',
        phoneMask: r.phone ? r.phone.substring(0, 3) + '****' + r.phone.slice(-4) : '',
        receiverType: r.receiver_type,
        receiverTypeLabel: r.receiver_type === 2 ? '对公' : '对私',
        receiverApplyStatus: r.receiver_apply_status,
        requestNo: r.request_no,
        receiverApplyStatusLabel: receiverStatusLabel[String(r.receiver_apply_status || '')] || r.status || '未知',
        bankCode: r.bank_code,
        bankName: r.bank_name,
        companyName: r.company_name,
        status: r.status,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
      return { success: true, data: masked };
    },

    // ─── 18d. 删除入账银行卡 ───

    async delete_payment_auth(p: McpToolParams = {}) {
      if (!p.id) return { success: false, error: '缺少 id' };
      const currentOwner = _currentOwnerEmail();
      if (!currentOwner) return { success: false, error: '未登录，无法删除支付认证' };
      const owned = cx.query(`SELECT id FROM payment_auth WHERE id=? AND LOWER(TRIM(owner_email))=?`, [p.id, currentOwner])[0];
      if (!owned) return { success: false, error: '未找到支付认证信息' };
      // 若该银行卡已被 Agent 绑定，先解除绑定
      cx.exec(`UPDATE agents SET payment_auth_id = NULL, updated_at = ? WHERE payment_auth_id = ? AND LOWER(TRIM(owner_email))=?`, [Date.now(), p.id, currentOwner]);
      cx.exec(`DELETE FROM payment_auth WHERE id = ? AND LOWER(TRIM(owner_email))=?`, [p.id, currentOwner]);
      return { success: true };
    },

    // ─── 18e. 申请认证 ───

    async apply_payment_auth(p: McpToolParams = {}) {
      const { paymentAuthId, email: explicitEmail } = p;
      if (!paymentAuthId) return { success: false, error: '缺少 paymentAuthId' };

      const currentOwner = _currentOwnerEmail();
      if (!currentOwner) return { success: false, error: '未登录，无法申请支付认证' };
      const auth = cx.query<PaymentAuthDetailRow>(`SELECT * FROM payment_auth WHERE id = ? AND LOWER(TRIM(owner_email))=?`, [paymentAuthId, currentOwner])[0];
      if (!auth) return { success: false, error: '未找到支付认证信息' };

      let email = explicitEmail ? String(explicitEmail).trim().toLowerCase() : currentOwner;
      if (email !== currentOwner) return { success: false, error: '支付认证邮箱必须与当前登录用户一致' };
      if (!email) {
        const boundAgent = cx.query<PaymentAgentRow>(`SELECT owner_email FROM agents WHERE payment_auth_id = ? AND owner_email IS NOT NULL LIMIT 1`, [paymentAuthId])[0];
        email = boundAgent?.owner_email || '';
      }
      if (!email) {
        const owners = cx.query<PaymentAgentRow>(`SELECT DISTINCT owner_email FROM agents WHERE owner_email IS NOT NULL LIMIT 2`);
        if (owners.length === 1) email = owners[0].owner_email || '';
      }
      if (!email) return { success: false, error: '无法获取用户邮箱，请先通过邮箱验证码登录/注册，或显式传入 email' };

      if (!cx.getUserAccessToken || !cx.VOKO_API_URL) {
        return { success: false, error: 'MCP 上下文未提供 getUserAccessToken 或 VOKO_API_URL' };
      }
      const userToken = cx.getUserAccessToken(email);
      if (!userToken) return { success: false, error: '缺少 User Access Token，请先通过邮箱验证码登录/注册以获取' };

      const type = auth.receiver_type || 1;
      const body: Record<string, string | number> = {
        email,
        type,
        receiverName: type === 2 ? optionalString(auth.company_name || auth.name) : optionalString(auth.name),
        licenceNo: type === 2 ? optionalString(auth.unified_social_credit_code || auth.id_card) : optionalString(auth.id_card),
        bankCardNo: optionalString(auth.bank_card),
        bankCode: auth.bank_code || '',
        mobile: optionalString(auth.phone),
      };
      if (type === 2) {
        if (auth.legal_name) body.legalName = auth.legal_name;
        if (auth.legal_licence_no) body.legalLicenceNo = auth.legal_licence_no;
      }

      let result: PaymentApiResult;
      try {
        const resp = await fetch(`${cx.VOKO_API_URL}/api/external/v1/payment/receiver/apply`, {
          method: 'POST',
          redirect: 'error',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${userToken}` },
          body: JSON.stringify(body)
        });
        result = await readPaymentApiResult(resp);
      } catch (error: unknown) {
        return { success: false, error: toolErrorMessage(error) };
      }
      const data = result.data;
      const failMsg = result.msg || result.message || '';

      if (result.code !== 200) return { success: false, error: failMsg || '申请认证失败', code: result.code, data };
      const requestNo = optionalString(data.requestNo);
      const receiverNo = optionalString(data.receiverNo);
      const paymentUserUid = optionalString(data.paymentUserUid);
      if (!requestNo && !receiverNo && !paymentUserUid) {
        return { success: false, error: t('mcp.payment.invalid_response') };
      }

      const now = Date.now();
      let applyStatus = optionalString(data.receiverApplyStatus) || 'PROCESSING';
      if (data.alreadyRegistered === true) applyStatus = 'COMPLETED';
      let statusUpdate = auth.status || 'unverified';
      const upstreamMsg = optionalString(data.upstreamMsg) || optionalString(data.hint) || failMsg;
      if (applyStatus === 'APPLY_REJECTED' && upstreamMsg) statusUpdate = '拒绝: ' + upstreamMsg.substring(0, 100);

      cx.exec(`UPDATE payment_auth SET request_no = ?, receiver_no = ?, receiver_apply_status = ?, receiver_sign_status = ?, receiver_sign_url = ?, merchant_sign_url = ?, payment_user_uid = ?, status = ?, updated_at = ? WHERE id = ?`,
        [requestNo, receiverNo, applyStatus, optionalString(data.receiverSignStatus), optionalString(data.receiverSignUrl), optionalString(data.merchantSignUrl), paymentUserUid, statusUpdate, now, paymentAuthId]);
      return { success: true, data };
    },

    async refresh_payment_auth(p: McpToolParams = {}) {
      const { paymentAuthId, email: explicitEmail } = p;
      if (!paymentAuthId) return { success: false, error: t('mcp.payment.missing_auth_id') };
      const currentOwner = _currentOwnerEmail();
      if (!currentOwner) return { success: false, error: t('mcp.payment.refresh_identity_missing') };
      const auth = cx.query<PaymentAuthDetailRow>(`SELECT * FROM payment_auth WHERE id = ? AND LOWER(TRIM(owner_email))=?`, [paymentAuthId, currentOwner])[0];
      if (!auth) return { success: false, error: t('mcp.payment.auth_not_found') };
      if (!auth.request_no) return { success: false, error: t('mcp.payment.auth_not_applied') };

      let email = explicitEmail ? String(explicitEmail).trim().toLowerCase() : currentOwner;
      if (email !== currentOwner) return { success: false, error: t('mcp.payment.refresh_identity_missing') };
      if (!email) {
        const boundAgent = cx.query<PaymentAgentRow>(`SELECT owner_email FROM agents WHERE payment_auth_id = ? AND owner_email IS NOT NULL LIMIT 1`, [paymentAuthId])[0];
        email = boundAgent?.owner_email || '';
      }
      if (!email) {
        const owners = cx.query<PaymentAgentRow>(`SELECT DISTINCT owner_email FROM agents WHERE owner_email IS NOT NULL LIMIT 2`);
        if (owners.length === 1) email = owners[0].owner_email || '';
      }
      if (!email || !cx.getUserAccessToken || !cx.VOKO_API_URL) {
        return { success: false, error: t('mcp.payment.refresh_identity_missing') };
      }
      const userToken = cx.getUserAccessToken(email);
      if (!userToken) return { success: false, error: t('mcp.payment.refresh_token_missing') };

      let result: PaymentApiResult;
      try {
        const response = await fetch(`${cx.VOKO_API_URL}/api/external/v1/payment/receiver/query`, {
          method: 'POST',
          redirect: 'error',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${userToken}` },
          body: JSON.stringify({ requestNo: auth.request_no })
        });
        result = await readPaymentApiResult(response);
      } catch (error: unknown) {
        return { success: false, error: toolErrorMessage(error) };
      }
      if (result.code !== 200) {
        return { success: false, error: result.msg || result.message || t('mcp.payment.refresh_failed'), code: result.code };
      }
      const data = result.data;
      const status = optionalString(data.status) || optionalString(data.receiverApplyStatus);
      if (!status) return { success: false, error: t('mcp.payment.invalid_response') };
      cx.exec(
        `UPDATE payment_auth SET receiver_no = ?, receiver_apply_status = ?, receiver_sign_status = ?, receiver_sign_url = ?, merchant_sign_url = ?, status = ?, updated_at = ? WHERE id = ?`,
        [
          optionalString(data.receiverNo) || auth.receiver_no || '',
          status,
          optionalString(data.receiverSignStatus),
          optionalString(data.receiverSignUrl),
          optionalString(data.merchantSignUrl),
          status === 'COMPLETED' ? 'verified' : (auth.status || 'unverified'),
          Date.now(),
          paymentAuthId
        ]
      );
      return { success: true, data: { ...data, receiverApplyStatus: status } };
    },

    // ─── 18f. 搜索银行总行 ───

    async search_banks(p: McpToolParams = {}) {
      const keyword = (p.keyword || '').trim();
      let rows: BankDbRow[];
      if (!keyword) {
        rows = cx.query<BankDbRow>(`SELECT * FROM bank_head_offices ORDER BY id LIMIT 50`);
      } else {
        const kw = `%${keyword}%`;
        rows = cx.query<BankDbRow>(`SELECT * FROM bank_head_offices WHERE code LIKE ? OR name LIKE ? OR short_name LIKE ? ORDER BY id LIMIT 50`, [kw, kw, kw]);
      }
      return { success: true, data: rows.map((r) => ({ code: r.code, name: r.name, shortName: r.short_name })) };
    },

    // ─── 18f. Agent 绑定入账银行卡 ───

    async bind_agent_payment_auth(p: McpToolParams = {}) {
      const { agentId, paymentAuthId } = p;
      if (!agentId || !paymentAuthId) return { success: false, error: '缺少 agentId 或 paymentAuthId' };

      const currentOwner = _currentOwnerEmail();
      if (!currentOwner) return { success: false, error: '未登录，无法绑定支付认证' };
      const auth = cx.query<PaymentAuthDetailRow>(`SELECT payment_user_uid, request_no, id_card, unified_social_credit_code, receiver_type, receiver_apply_status FROM payment_auth WHERE id = ? AND LOWER(TRIM(owner_email))=?`, [paymentAuthId, currentOwner])[0];
      if (!auth) return { success: false, error: '未找到支付认证信息' };
      if (String(auth.receiver_apply_status || '').trim().toUpperCase() !== 'COMPLETED') {
        return { success: false, error: '该银行卡尚未申请认证，请先调用 voko_apply_payment_auth 完成认证（receiverApplyStatus=COMPLETED 后再绑定）' };
      }

      const agent = cx.query<PaymentAgentRow>(`SELECT owner_email, did, private_key FROM agents WHERE agent_id = ?`, [agentId])[0];
      if (!agent) return { success: false, error: '未找到 Agent' };
      if (String(agent.owner_email || '').trim().toLowerCase() !== currentOwner) return { success: false, error: 'Agent 不属于当前登录用户' };
      if (!agent.did) return { success: false, error: 'Agent 未注册 DID' };
      if (!agent.private_key) return { success: false, error: 'Agent 未配置私钥' };

      if (!cx.signDidRequest) {
        return { success: false, error: 'MCP 上下文未提供 signDidRequest，未执行绑定' };
      }

      try {
        const bizFields: Record<string, string | number> = { email: agent.owner_email || '', agentDid: agent.did || '' };
        if (auth.payment_user_uid) {
          bizFields.paymentUserUid = auth.payment_user_uid;
        } else if (auth.request_no) {
          bizFields.requestNo = auth.request_no;
        } else {
          bizFields.licenceNo = auth.receiver_type === 2
            ? optionalString(auth.unified_social_credit_code || auth.id_card)
            : optionalString(auth.id_card);
          if (auth.receiver_type) bizFields.type = auth.receiver_type;
        }

        const authFields = await cx.signDidRequest(agent.did, agent.private_key, bizFields);
        const body = { ...authFields, ...bizFields };

        const resp = await fetch(ENDPOINTS.payment.baseUrl + '/payment/receiver/link-agent', {
          method: 'POST',
          redirect: 'error',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const result = await readPaymentApiResult(resp);
        if (result.code === 200) {
          const data = result.data;
          const feeRate = optionalFeeRate(data.paymentFeeRate);
          const usageRate = optionalFeeRate(data.agentUsageFeeRate);
          if (Number.isNaN(feeRate) || Number.isNaN(usageRate)) {
            return { success: false, error: t('mcp.payment.invalid_response') };
          }
          cx.exec(`UPDATE agents SET payment_auth_id = ? WHERE agent_id = ?`, [paymentAuthId, agentId]);
          const bound = cx.query<PaymentFeeRow>(`SELECT payment_fee_rate, agent_usage_fee_rate FROM agents WHERE payment_auth_id = ? AND agent_id != ? LIMIT 1`, [paymentAuthId, agentId])[0];
          if (bound) {
            cx.exec(`UPDATE agents SET payment_fee_rate = ?, agent_usage_fee_rate = ? WHERE agent_id = ?`, [bound.payment_fee_rate, bound.agent_usage_fee_rate, agentId]);
          }
          if (feeRate != null || usageRate != null) {
            const s: string[] = []; const v: unknown[] = [];
            if (feeRate != null) { s.push('payment_fee_rate = ?'); v.push(feeRate); }
            if (usageRate != null) { s.push('agent_usage_fee_rate = ?'); v.push(usageRate); }
            v.push(agentId);
            cx.exec(`UPDATE agents SET ${s.join(', ')} WHERE agent_id = ?`, v);
          }
          return { success: true, data };
        }
        return { success: false, error: result.msg || '绑定失败', code: result.code };
      } catch (e: any) {
        console.error('[MCP] bind_agent_payment_auth link-agent 失败:', e.message);
        return { success: false, error: e.message };
      }
    },

    // ─── 19. 计费模式 ───

    async agent_pricing(p: McpToolParams = {}) {
      // 设置了 pricingModel 则为写操作
      if (p.pricingModel) {
        if (p.pricingModel !== 'free' && p.pricingModel !== 'timed') {
          return { success: false, error: 'pricingModel 必须为 free 或 timed' };
        }
        const now = Date.now();
        const isFree = p.pricingModel === 'free';
        const finalTrial = isFree ? null : (p.trialMinutes ?? 3);
        const existing = cx.query(`SELECT id FROM agent_pricing WHERE agent_id=?`, [p.agentId]);
        if (existing && existing.length > 0) {
          cx.exec(`UPDATE agent_pricing SET pricing_model=?, price=?, duration_minutes=?, trial_minutes=?, enabled=1, updated_at=? WHERE agent_id=?`,
            [p.pricingModel, isFree ? null : (p.price || null), isFree ? null : (p.durationMinutes || null), finalTrial, now, p.agentId]);
        } else {
          const id = 'ap_' + now + '_' + Math.random().toString(36).substr(2, 6);
          cx.exec(`INSERT INTO agent_pricing (id, agent_id, pricing_model, price, duration_minutes, trial_minutes, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,1,?,?)`,
            [id, p.agentId, p.pricingModel, isFree ? null : (p.price || null), isFree ? null : (p.durationMinutes || null), finalTrial, now, now]);
        }
        return { success: true };
      }

      // 不传 pricingModel 则为查询
      const row = cx.query(`SELECT * FROM agent_pricing WHERE agent_id=?`, [p.agentId])[0] || null;
      return {
        success: true,
        agentId: p.agentId,
        pricingModel: row?.pricing_model || 'free',
        price: row?.price || null,
        durationMinutes: row?.duration_minutes || null,
        trialMinutes: row?.trial_minutes ?? 3,
        enabled: row?.enabled !== 0,
      };
    },

    // ─── 20. 轮询新消息 ───

    _fetchBlocks: new Map<string, PollController>(),

    /**
     * 游标 key 构造。
     * - 基础格式 `${agentId}:${channelType}:${channelId}`（name=agentId, scopeKey=channelType:channelId）。
     * - 多客户端隔离：传入 clientId 时追加 `@clientId` 后缀到 scopeKey，使不同 MCP 客户端
     *   （如 zcode / codex / cursor）各自维护独立游标，互不抢消息。无 clientId 则用共享游标（向后兼容）。
     */
    _channelCursorKey(agentId?: string, channelId?: string, channelType = 1, clientId?: string) {
      const base = `${agentId}:${channelType}:${channelId}`;
      return clientId ? `${base}@${clientId}` : base;
    },

    _legacyChannelCursorKey(agentId?: string, channelId?: string) {
      return `${agentId}:${channelId}`;
    },

    _getChannelCursor(agentId?: string, channelId?: string, channelType = 1, clientId?: string) {
      const current = _getCursorDb(cx.db, this._channelCursorKey(agentId, channelId, channelType, clientId));
      // 有 clientId 的独立游标空间直接返回（不回退到 legacy/共享 key，否则就失去隔离意义）。
      if (clientId) return current;
      // Direct-chat cursors written by older Lite versions remain readable.
      // Never apply that legacy key to groups: the old key did not encode type
      // and could otherwise skip the first group messages after an upgrade.
      if (current > 0 || channelType === 2) return current;
      return _getCursorDb(cx.db, this._legacyChannelCursorKey(agentId, channelId));
    },

    _setChannelCursor(agentId: string | undefined, channelId: string, seq: number, channelType = 1, clientId?: string) {
      const key = this._channelCursorKey(agentId, channelId, channelType, clientId);
      if (seq > this._getChannelCursor(agentId, channelId, channelType, clientId)) _setCursorDb(cx.db, key, seq);
    },

    async fetch_new_messages(p: McpToolParams = {}) {
      const ownershipError = _agentOwnershipError(p.agentId);
      if (ownershipError) return { success: false, error: ownershipError, code: 'AGENT_OWNER_MISMATCH' };
      const blockTimeout = p.blockTimeout || 0;
      const limit = Math.min(p.limit || 50, 200);
      const onlyReplies = p.onlyReplies !== false;
      // onlyNew（默认 false=向后兼容）：首次拉取（自动游标为 0）时是否只设锚点、不回吐历史。
      // 传 onlyNew:true 可避免"首次吞掉50条历史并推进游标→后续空等→误判对方没回复"，
      // 适合只关心新消息的轮询客户端；需要首屏回放历史的客户端保持默认 false。
      const onlyNew = p.onlyNew === true;
      // clientId：多客户端游标隔离。未传时走共享游标（向后兼容）。
      // 优先用显式入参，其次从 provider caller 上下文取（如 'zcode'/'codex'）。
      const clientId = _resolveClientId(p.agentId, p.clientId);

      // 指定频道模式：channelId 优先；visitorId 保持原有单聊兼容。
      // 只有两者都未传时才进入下面的全量模式。
      const targetChannelId = p.channelId || p.visitorId;
      if (p.channelType !== undefined && Number(p.channelType) === 2 && !p.channelId) {
        return { success: false, error: '群聊查询必须提供 channelId', code: 'CHANNEL_ID_REQUIRED' };
      }
      if (targetChannelId) {
        const targetChannelType = inferChannelType({ ...p, toUid: targetChannelId });
        const key = this._channelCursorKey(p.agentId, targetChannelId, targetChannelType, clientId);
        const autoCursor = this._getChannelCursor(p.agentId, targetChannelId, targetChannelType, clientId);
        // messageSeq（旧名）与 cursor（新名）同义，显式传入覆盖自动游标
        const explicitSeq = p.cursor ?? p.messageSeq;
        const seq = explicitSeq != null ? explicitSeq : autoCursor;
        // onlyNew 首次锚定：自动游标为 0、且未显式传起始游标 → 不回吐历史，只把游标设到当前 maxSeq。
        const isFirstAnchor = onlyNew && autoCursor === 0 && explicitSeq == null;
        if (isFirstAnchor) {
          const maxRow = cx.query<MaxSequenceRow>(
            targetChannelType === 2
              ? `SELECT MAX(message_seq) as max_seq FROM messages WHERE channel_id=? AND channel_type=2`
              : `SELECT MAX(message_seq) as max_seq FROM messages WHERE agent_id=? AND channel_id=?`,
            targetChannelType === 2 ? [targetChannelId] : [p.agentId, targetChannelId]
          );
          const currentMax = maxRow[0]?.max_seq || 0;
          if (currentMax > 0) this._setChannelCursor(p.agentId, targetChannelId, currentMax, targetChannelType, clientId);
          return fmtPullResult([], false, { _agentId: p.agentId,
            cursor: currentMax,
            nextMessageSeq: currentMax,
            clientId: _publicClientId(clientId),
            anchored: true,
            message: '首次拉取已设定锚点，未回吐历史消息；后续调用将只返回此锚点之后的新消息。',
          });
        }

        if (blockTimeout > 0) {
          const prev = this._fetchBlocks.get(key);
          if (prev) prev.aborted = true;
          const ctrl = { aborted: false };
          this._fetchBlocks.set(key, ctrl);
          try {
            const rows = await this._pollSingleChannel(
              p.agentId, targetChannelId, seq, limit, onlyReplies, blockTimeout, ctrl, targetChannelType
            );
            const hasMore = rows.length > limit;
            if (hasMore) rows.pop();
            // 分页时只推进到本页最后一条，避免把尚未返回的消息跳过；没有下一页时
            // 再按全量 maxSeq 推进，以免 onlyReplies 过滤掉自己发送的消息后反复扫描。
            const cursorSeq = hasMore
              ? Number(rows.at(-1)?.message_seq || seq)
              : this._maxSeqAll(p.agentId, targetChannelId, targetChannelType);
            if (cursorSeq > seq) this._setChannelCursor(p.agentId, targetChannelId, cursorSeq, targetChannelType, clientId);
            const filtered = this._a2aPreparePull(p.agentId, rows);
            return fmtPullResult(filtered, hasMore, { _agentId: p.agentId, cursor: cursorSeq, nextMessageSeq: cursorSeq, clientId: _publicClientId(clientId) });
          } finally {
            if (this._fetchBlocks.get(key) === ctrl) this._fetchBlocks.delete(key);
          }
        }

        const rows = this._queryMessages(
          p.agentId, targetChannelId, seq, onlyReplies, limit, targetChannelType
        );
        const hasMore = rows.length > limit;
        if (hasMore) rows.pop();
        // 有下一页时保留未返回消息的序号；最后一页才跳过已过滤的自发消息。
        const cursorSeq = hasMore
          ? Number(rows.at(-1)?.message_seq || seq)
          : this._maxSeqAll(p.agentId, targetChannelId, targetChannelType);
        if (cursorSeq > seq) this._setChannelCursor(p.agentId, targetChannelId, cursorSeq, targetChannelType, clientId);
        const filtered = this._a2aPreparePull(p.agentId, rows);
        return fmtPullResult(filtered, hasMore, { _agentId: p.agentId, cursor: cursorSeq, nextMessageSeq: cursorSeq, clientId: _publicClientId(clientId) });
      }

      // ─── 全量模式（不指定 visitorId）：按 channel 分别维护游标 ───
      // 因为 WuKongIM 的 message_seq 是按 channel 独立的，用单一全局游标
      // 会导致低 seq channel 的新消息被漏掉。
      // channels 包含：单聊（messages 中 agent_id=self）+ 群聊（conversations 中本 agent 参与的 channel_type=2 会话）
      let selfImUid = '';
      try { selfImUid = cx.query<AgentUidRow>('SELECT imUid FROM agents WHERE agent_id=?', [p.agentId])[0]?.imUid || ''; } catch (_: unknown) {}
      const channels = cx.query<ChannelRow>(
        `SELECT channel_id, 1 AS channel_type FROM messages WHERE agent_id=? AND channel_type!=2 GROUP BY channel_id
         UNION
         SELECT channel_id, 2 AS channel_type FROM conversations WHERE user_uid=? AND channel_type=2`,
        [p.agentId, selfImUid]
      );

      const allRows: MessageDbRow[] = [];
      const cursorByChannel: Record<string, number> = {};
      for (const ch of channels) {
        const channelId = ch.channel_id;
        const isGroup = ch.channel_type === 2;
        const chType = isGroup ? 2 : 1;
        const autoCursor = this._getChannelCursor(p.agentId, channelId, chType, clientId);
        const explicitSeq = p.cursor ?? p.messageSeq;
        let seq = autoCursor;
        // 该 channel 首次拉取且用户传了全局 messageSeq/cursor 时：
        // 仅当该 channel 的最大 seq 大于全局阈值，才把它作为起始点；
        // 否则从 0 开始，避免低 seq channel 的新消息被全局高 seq 漏掉。
        if (seq === 0 && explicitSeq != null) {
          const channelMaxSeq = this._maxSeqAll(p.agentId, channelId, chType);
          if (channelMaxSeq >= explicitSeq) {
            seq = explicitSeq;
          }
        }
        // onlyNew 首次锚定：自动游标为 0 且未显式传游标 → 推进到该 channel maxSeq，不回吐历史
        if (onlyNew && autoCursor === 0 && explicitSeq == null) {
          const channelMaxSeq = this._maxSeqAll(p.agentId, channelId, chType);
          if (channelMaxSeq > 0) this._setChannelCursor(p.agentId, channelId, channelMaxSeq, chType, clientId);
          cursorByChannel[`${chType}:${channelId}`] = channelMaxSeq;
          continue;
        }
        const rows = this._queryMessages(p.agentId, channelId, seq, onlyReplies, limit, chType);
        allRows.push(...rows);
        // 游标推进基于全量 maxSeq（解耦 onlyReplies）
        const channelMaxSeq = this._maxSeqAll(p.agentId, channelId, chType);
        if (channelMaxSeq > 0) this._setChannelCursor(p.agentId, channelId, channelMaxSeq, chType, clientId);
        cursorByChannel[`${chType}:${channelId}`] = channelMaxSeq;
      }

      // 合并后按 message_seq 升序，保证分页稳定
      allRows.sort((a, b) => (a.message_seq || 0) - (b.message_seq || 0));

      const hasMore = allRows.length > limit;
      if (hasMore) allRows.length = limit;

      const filtered = this._a2aPreparePull(p.agentId, allRows);
      return fmtPullResult(filtered, hasMore, { _agentId: p.agentId, cursorByChannel, clientId: _publicClientId(clientId) });
    },

    async owner_command(p: McpToolParams = {}) {
      if (!cx.ownerPullService) return { success: false, code: 'OWNER_LINK_UNAVAILABLE' };
      const agentId = String(p.agentId || '');
      if (!agentId) return { success: false, code: 'AGENT_ID_REQUIRED' };
      if (p.action === 'fetch') return cx.ownerPullService.fetch(agentId);
      if (!p.messageId || !p.claimId) return { success: false, code: 'OWNER_PULL_CLAIM_REQUIRED' };
      if (p.action === 'complete') {
        return cx.ownerPullService.complete(agentId, p.messageId, p.claimId, String(p.content || ''));
      }
      if (p.action === 'fail') {
        return cx.ownerPullService.fail(agentId, p.messageId, p.claimId, String(p.reason || 'OWNER_PULL_EXECUTION_FAILED'));
      }
      return { success: false, code: 'OWNER_COMMAND_ACTION_INVALID' };
    },

    /**
     * 取某 channel 全量消息（不分 is_me）的最大 message_seq，用于游标推进。
     * 与 onlyReplies 过滤解耦：即使本次只返回了回复（is_me!=1），游标也按全量 maxSeq 推进，
     * 避免自己发出的消息（is_me=1）被漏掉导致下次重复推进。
     */
    _maxSeqAll(agentId: string | undefined, channelId: string, channelType: number = 1): number {
      try {
        const row = cx.query<MaxSequenceRow>(
          channelType === 2
            ? `SELECT MAX(message_seq) as max_seq FROM messages WHERE channel_id=? AND channel_type=2`
            : `SELECT MAX(message_seq) as max_seq FROM messages WHERE agent_id=? AND channel_id=?`,
          channelType === 2 ? [channelId] : [agentId, channelId]
        )[0];
        return row?.max_seq || 0;
      } catch (_: unknown) { return 0; }
    },

    _queryMessages(
      agentId: string | undefined,
      channelId: string,
      seq: number,
      onlyReplies: boolean,
      limit: number,
      channelType: number = 1,
    ): MessageDbRow[] {
      // 群聊（channel_type=2）一条消息多 agent 共享，不按 agent_id 过滤
      let sql, params;
      if (channelType === 2) {
        sql = `SELECT * FROM messages WHERE channel_id=? AND channel_type=2 AND message_seq > ?`;
        params = [channelId, seq];
      } else {
        sql = `SELECT * FROM messages WHERE agent_id=? AND channel_id=? AND channel_type!=2 AND message_seq > ?`;
        params = [agentId, channelId, seq];
      }
      if (onlyReplies) sql += ` AND is_me!=1`;
      sql += ` ORDER BY message_seq ASC LIMIT ?`;
      params.push(limit + 1);
      return _filterPullRowsForCaller(agentId, cx.query<MessageDbRow>(sql, params));
    },

    /** push 不可用时，pull 复用 dispatcher 的 A2A 身份识别、STATE、收敛和熔断治理。 */
    _a2aPreparePull(agentId: string | undefined, rows: MessageDbRow[]): MessageDbRow[] {
      const dispatcher = (global as typeof globalThis & { __dispatcher?: PullDispatcher }).__dispatcher;
      if (!dispatcher?.prepareForPull || !rows.length) return rows;
      return rows
        .map((row) => dispatcher.prepareForPull?.(agentId, row))
        .filter((row): row is MessageDbRow => !!row);
    },
    // 阻塞轮询单 channel：被取消时返回空数组
    async _pollSingleChannel(
      agentId: string | undefined,
      channelId: string,
      seq: number,
      limit: number,
      onlyReplies: boolean,
      timeoutSec: number,
      ctrl: PollController,
      channelType: number = 1,
    ): Promise<MessageDbRow[]> {
      const start = Date.now();
      while (!ctrl.aborted) {
        const rows = this._queryMessages(agentId, channelId, seq, onlyReplies, limit, channelType);
        if (rows.length > 0) return rows;
        if (Date.now() - start >= timeoutSec * 1000) return [];
        await new Promise<void>((resolve) => setTimeout(resolve, 1000));
      }
      return [];
    },

    // ─── 18. 白名单管理 ───

    async manage_whitelist(p: McpToolParams = {}) {
      const ac = require('../core/access-control-api');
      if (p.action === 'remove') {
        if (p.id) return ac.removeEntry(cx.db, p.id);
        if (!p.agentId || !p.visitorId) return { success: false, error: 'remove 需要 id 或 agentId+visitorId' };
        return ac.removeEntryByVisitor(cx.db, p.agentId, p.visitorId, 'whitelist');
      }
      if (!p.agentId || !p.visitorId) return { success: false, error: 'add 需要 agentId+visitorId' };
      const result = ac.addEntry(cx.db, { agentId: p.agentId, listType: 'whitelist', visitorId: p.visitorId, reason: p.reason });
      if (!result.success) return result;
      const statusRoute = resolveStatusNotificationRoute(p);
      if (!statusRoute.route && statusRoute.resolution.status === 'selection_required') {
        return { ...result, notificationStatus: 'skipped', notificationReason: 'conversation_required',
          candidateConversationIds: statusRoute.resolution.candidateConversationIds };
      }
      const notification = cx.sendSystemMessage
        ? await cx.sendSystemMessage(p.agentId, p.visitorId, 'whitelist_enabled', {}, Math.floor(Date.now() / 1000), statusRoute.route || undefined)
        : { notificationStatus: 'skipped', notificationReason: 'delivery_unavailable' };
      return { ...result, ...notification };
    },

    // ─── 19. 黑名单管理 ───

    async manage_blacklist(p: McpToolParams = {}) {
      const ac = require('../core/access-control-api');
      if (p.action === 'remove') {
        if (p.id) return ac.removeEntry(cx.db, p.id);
        if (!p.agentId || !p.visitorId) return { success: false, error: 'remove 需要 id 或 agentId+visitorId' };
        const __wasBlk = ac.isBlacklisted(cx.db, p.agentId, p.visitorId);
        const r = ac.removeEntryByVisitor(cx.db, p.agentId, p.visitorId, 'blacklist');
        if (!r.success || !__wasBlk) return r;
        const statusRoute = resolveStatusNotificationRoute(p);
        if (!statusRoute.route && statusRoute.resolution.status === 'selection_required') {
          return { ...r, notificationStatus: 'skipped', notificationReason: 'conversation_required',
            candidateConversationIds: statusRoute.resolution.candidateConversationIds };
        }
        const notification = cx.sendSystemMessage
          ? await cx.sendSystemMessage(p.agentId, p.visitorId, 'restriction_lifted', {}, Math.floor(Date.now() / 1000), statusRoute.route || undefined)
          : { notificationStatus: 'skipped', notificationReason: 'delivery_unavailable' };
        return { ...r, ...notification };
      }
      if (!p.agentId || !p.visitorId) return { success: false, error: 'add 需要 agentId+visitorId' };
      return ac.addEntry(cx.db, { agentId: p.agentId, listType: 'blacklist', visitorId: p.visitorId, reason: p.reason });
    },

    // ─── 20. 查看黑白名单 ───

    async list_access_lists(p: McpToolParams = {}) {
      const ac = require('../core/access-control-api');
      const limit = p.limit ? Math.min(p.limit, 100) : undefined;
      const offset = p.offset || 0;
      const keyword = p.keyword || '';
      return ac.getList(cx.db, { agentId: p.agentId, listType: p.listType, limit, offset, keyword });
    },

    // ─── 21. 白名单模式 ───

    async set_private_mode(p: McpToolParams = {}) {
      if (cx.toggleWhitelistMode) {
        return cx.toggleWhitelistMode({ agentId: p.agentId, enabled: p.enabled });
      }
      const newMode = p.enabled ? 'private' : 'public';
      cx.exec(`UPDATE agents SET access_mode=?, updated_at=? WHERE agent_id=?`, [newMode, Date.now(), p.agentId]);
      return { success: true, accessMode: newMode };
    },

    // ═══════════════════════════════════════════
    //  群聊（group chat）—— 全部走服务端 /api/group/v1/*（服务端为权威 + 单一写者）
    // lite 不直连 WuKongIM 做群管理；消息收发统一走 VokoIMSDK Hub。
    // ═══════════════════════════════════════════

    // 本地补全成员昵称 + isAgent + mute_until（服务端成员回 uid/role/joined_at/mute_until）
    _enrichMembers(srvMembers: GroupMember[] = []) {
      const uids = srvMembers.map((member) => member.uid);
      if (!uids.length) return [];
      const placeholders = uids.map(() => '?').join(',');
      const agentRows = cx.query<AgentUidRow>(`SELECT imUid FROM agents WHERE imUid IN (${placeholders})`, uids);
      const agentUidSet = new Set(agentRows.map((row) => row.imUid));
      const byUid = new Map<string, GroupMember>(srvMembers.map((member) => [member.uid, member]));
      return uids.map((uid) => {
        const cache = cx.query<UserCacheRow>(`SELECT nickname FROM user_cache WHERE uid=? LIMIT 1`, [uid])[0];
        return { uid, nickname: cache?.nickname || null, isAgent: agentUidSet.has(uid), role: byUid.get(uid)?.role || null, mute_until: byUid.get(uid)?.mute_until || null };
      });
    },

    async create_group(p: McpToolParams = {}) {
      // actor = 创建 agent 的 imUid（owner_uid）；返回 channel_id 作为 lite 侧 channelId
      // 群列表由 list_groups 从服务端获取，本地不持久化群
      try {
        const data = await groupClient.createGroup(cx, { agentId: p.agentId, name: p.name, members: [] });
        return { success: true, channelId: data.channel_id };
      } catch (e: unknown) {
        return { success: false, error: toolErrorMessage(e), noToken: toolErrorHasNoToken(e) };
      }
    },

    async invite_to_group(p: McpToolParams = {}) {
      if (!Array.isArray(p.members) || p.members.length === 0) {
        return { success: false, error: 'members 为必填数组，例如 ["visitorUid"]', code: 'MEMBERS_REQUIRED', failed: [] };
      }
      // actor = operator_uid；服务端按 invite_confirm 决定直加/审批，并发系统消息
      try {
        await groupClient.invite(cx, { agentId: p.agentId, channelId: p.channelId, members: p.members || [] });
        return { success: true, failed: [] };
      } catch (e: unknown) {
        return { success: false, error: toolErrorMessage(e), failed: p.members || [] };
      }
    },

    async create_invite_link(p: McpToolParams = {}) {
      try {
        const data = await groupClient.createInviteLink(cx, {
          agentId: p.agentId, channelId: p.channelId,
          expiresInSeconds: p.expiresInSeconds || null,
          maxUses: p.maxUses || null
        });
        return { success: true, code: data.code, channel_id: data.channel_id, expires_at: data.expires_at };
      } catch (e: unknown) {
        return { success: false, error: toolErrorMessage(e) };
      }
    },

    async join_by_invite_code(p: McpToolParams = {}) {
      try {
        const data = await groupClient.joinByInviteCode(cx, { code: p.code, agentId: p.agentId });
        return { success: true, ...data };
      } catch (e: unknown) {
        return { success: false, error: toolErrorMessage(e) };
      }
    },

    async mute_member(p: McpToolParams = {}) {
      try {
        const data = await groupClient.muteMember(cx, {
          agentId: p.agentId, channelId: p.channelId,
          targetUid: p.targetUid, muted: !!p.muted,
          durationSeconds: p.durationSeconds || null
        });
        return { success: true, ...data };
      } catch (e: unknown) {
        return { success: false, error: toolErrorMessage(e) };
      }
    },

    async accept_invitation(p: McpToolParams = {}) {
      // 第一期 direct-add：invite 时成员已由服务端加入，此处仅校验是否已是成员
      try {
        await groupClient.getInfo(cx, { agentId: p.agentId, channelId: p.channelId });
        return { success: true, channelId: p.channelId };
      } catch (e: unknown) {
        return { success: false, error: toolErrorMessage(e) };
      }
    },

    async decline_invitation(p: McpToolParams = {}) {
      // 第一期 direct-add 下无可撤销语义（成员在 invite 时即加入）；保留为 no-op，想退出用 quit
      return { success: true, channelId: p.channelId };
    },

    async get_group_members(p: McpToolParams = {}) {
      try {
        const data = await groupClient.getInfo(cx, { agentId: p.agentId, channelId: p.channelId });
        return { success: true, members: this._enrichMembers(data.members) };
      } catch (e: unknown) {
        return { success: false, error: toolErrorMessage(e) };
      }
    },

    async get_group_context(p: McpToolParams = {}) {
      try {
        const data = await groupClient.getInfo(cx, { agentId: p.agentId, channelId: p.channelId });
        const members = this._enrichMembers(data.members);
        // 最近消息：本地 messages 表（channel_id 匹配即可，WKSDK 的 channel_type 不可靠）
        const limit = Math.min(p.limit || 20, 100);
        const offset = Math.max(0, Number(p.offset) || 0);
        // 先按 client_msg_no / message_seq 去重，再分页；多取一条用于判断是否还有更早历史。
        const raw = cx.query<GroupHistoryRow>(
          `WITH ranked AS (
             SELECT id, from_uid, content, timestamp, content_type, message_seq, client_msg_no, mention,
                    ROW_NUMBER() OVER (
                      PARTITION BY COALESCE(client_msg_no, CASE WHEN message_seq IS NOT NULL THEN 'seq:' || message_seq ELSE id END)
                      ORDER BY timestamp DESC, rowid DESC
                    ) AS rn
             FROM messages WHERE channel_id=? AND channel_type=2
           )
           SELECT id, from_uid, content, timestamp, content_type, message_seq, client_msg_no, mention
           FROM ranked WHERE rn=1 ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
          [p.channelId, limit + 1, offset]
        );
        const hasMore = raw.length > limit;
        const rows = raw.slice(0, limit);
        const nameMap = new Map(members.map((member: { uid: string; nickname?: string | null }) => [
          member.uid,
          member.nickname || member.uid,
        ]));
        const messages = rows.reverse().map((r) => ({
          fromUid: r.from_uid,
          senderName: nameMap.get(r.from_uid) || r.from_uid,
          content: r.content,
          timestamp: r.timestamp,
          contentType: r.content_type || 1,
          mention: (() => { try { return r.mention ? JSON.parse(r.mention) : null; } catch (_: unknown) { return null; } })(),
        }));
        return { success: true, channelId: p.channelId, groupId: data.id || data.group_id || null, groupName: data.name || p.channelId, notice: data.notice || '', avatar: data.avatar || '', approve_mode: data.approve_mode || 'manual', searchable: data.searchable != null ? data.searchable : 1, status: data.status || 'active', dissolvedAt: data.dissolved_at || null, members, messages, hasMore, offset };
      } catch (e: unknown) {
        return { success: false, error: toolErrorMessage(e) };
      }
    },

    async kick_from_group(p: McpToolParams = {}) {
      // actor = operator_uid（须群 owner/admin；群主不可被踢，服务端兜底）
      try {
        await groupClient.kick(cx, { agentId: p.agentId, channelId: p.channelId, targetUid: p.targetUid });
        return { success: true };
      } catch (e: unknown) {
        return { success: false, error: toolErrorMessage(e), noToken: toolErrorHasNoToken(e) };
      }
    },

    async get_group_status(p: McpToolParams = {}) {
      try {
        const data = await groupClient.getInfo(cx, { agentId: p.agentId, channelId: p.channelId });
        return { success: true, status: data.status || 'active', dissolvedAt: data.dissolved_at || null };
      } catch (e: unknown) {
        return { success: false, error: toolErrorMessage(e), noToken: toolErrorHasNoToken(e) };
      }
    },

    async dissolve_group(p: McpToolParams = {}) {
      try {
        const data = await groupClient.dissolve(cx, { agentId: p.agentId, channelId: p.channelId });
        return { success: true, dissolved: data.dissolved !== false, alreadyDissolved: !!data.already_dissolved, channelId: data.channel_id || p.channelId };
      } catch (e: unknown) {
        return { success: false, error: toolErrorMessage(e), noToken: toolErrorHasNoToken(e) };
      }
    },

    async quit_group(p: McpToolParams = {}) {
      try {
        await groupClient.quit(cx, { agentId: p.agentId, channelId: p.channelId });
        const imUid = groupClient.getAgentImUid(cx, p.agentId);
        if (imUid) cx.exec('DELETE FROM conversations WHERE user_uid=? AND channel_id=? AND channel_type=2', [imUid, p.channelId]);
        return { success: true };
      } catch (e: unknown) {
        return { success: false, error: toolErrorMessage(e), noToken: toolErrorHasNoToken(e) };
      }
    },

    async update_group(p: McpToolParams = {}) {
      // actor = operator_uid（须群 owner/admin）；只传需改的字段
      try {
        await groupClient.updateGroup(cx, { agentId: p.agentId, channelId: p.channelId, name: p.name, notice: p.notice, avatar: p.avatar, approve_mode: p.approve_mode, searchable: p.searchable });
        return { success: true };
      } catch (e: unknown) {
        return { success: false, error: toolErrorMessage(e), noToken: toolErrorHasNoToken(e) };
      }
    },

    async list_groups(p: McpToolParams = {}) {
      // 群列表来自服务端（按成员 uid 查，分页），不在本地持久化
      try {
        const response: unknown = await groupClient.listMyGroups(cx, { agentId: p.agentId, limit: p.limit, offset: p.offset });
        if (!response || typeof response !== 'object') throw new Error(t('mcp.error.invalid_group_list_response'));
        const { groups, total } = response as { groups?: unknown; total?: unknown };
        if (!Array.isArray(groups)) throw new Error(t('mcp.error.invalid_group_list_response'));
        return {
          success: true,
          groups: groups.filter(isGroupSummary).map((group) => ({
            ...group,
            status: group.status || 'active',
            dissolved_at: group.dissolved_at || null,
          })),
          total: typeof total === 'number' ? total : groups.length,
        };
      } catch (e: unknown) {
        return { success: false, error: toolErrorMessage(e), noToken: toolErrorHasNoToken(e) };
      }
    },

    async search_groups(p: McpToolParams = {}) {
      // 搜索可加入的公开群（按群名/channel_id 模糊），非成员可用
      try {
        const response: unknown = await groupClient.searchGroups(cx, { agentId: p.agentId, keyword: p.keyword, page: p.page, page_size: p.page_size });
        if (!response || typeof response !== 'object') throw new Error(t('mcp.error.invalid_group_search_response'));
        const { groups, total } = response as { groups?: unknown; total?: unknown };
        if (!Array.isArray(groups)) throw new Error(t('mcp.error.invalid_group_search_response'));
        const activeGroups = groups
          .filter(isGroupSummary)
          .filter((group) => (group.status || 'active') !== 'dissolved');
        return { success: true, groups: activeGroups, total: typeof total === 'number' ? total : activeGroups.length };
      } catch (e: unknown) {
        return { success: false, error: toolErrorMessage(e), noToken: toolErrorHasNoToken(e) };
      }
    },

    async apply_group(p: McpToolParams = {}) {
      // 提交入群申请：status = pending / joined / already_member / duplicate
      try {
        const r = await groupClient.applyGroup(cx, { agentId: p.agentId, channelId: p.channelId, message: p.message });
        return { success: true, ...r };
      } catch (e: unknown) {
        return { success: false, error: toolErrorMessage(e), noToken: toolErrorHasNoToken(e) };
      }
    },

    async list_group_applies(p: McpToolParams = {}) {
      // 取群的入群申请列表（owner/admin 用）
      try {
        const applies = await groupClient.getApplyList(cx, { agentId: p.agentId, channelId: p.channelId });
        return { success: true, applies };
      } catch (e: unknown) {
        return { success: false, error: toolErrorMessage(e), noToken: toolErrorHasNoToken(e) };
      }
    },

    async approve_group_apply(p: McpToolParams = {}) {
      // 审批入群申请（action = 'approve' | 'reject'）
      try {
        await groupClient.approveApply(cx, { agentId: p.agentId, channelId: p.channelId, applyId: p.applyId, action: p.action });
        return { success: true };
      } catch (e: unknown) {
        return { success: false, error: toolErrorMessage(e), noToken: toolErrorHasNoToken(e) };
      }
    },

    // ─── 31. 邀请好友 ───

    // ═══════════════════════════════════════════
    //  审核规则管理
    // ═══════════════════════════════════════════

    async list_audit_rules(p: McpToolParams = {}) {
      const sql = p.direction
        ? 'SELECT * FROM audit_rules WHERE direction = ? ORDER BY is_default DESC, created_at ASC'
        : 'SELECT * FROM audit_rules ORDER BY is_default DESC, created_at ASC';
      const rows = p.direction ? cx.query(sql, [p.direction]) : cx.query(sql);
      return { success: true, data: rows };
    },

    async manage_audit_rules(p: McpToolParams = {}) {
      if (p.action === 'add') {
        if (!p.direction || !p.keyword || !p.actionType) {
          return { success: false, error: 'add 需要 direction, keyword, actionType' };
        }
        const id = `audit_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        cx.exec(
          `INSERT INTO audit_rules (id, direction, keyword, action, prompt, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
          [id, p.direction, p.keyword, p.actionType, p.prompt || null, Date.now(), Date.now()]
        );
        return { success: true, id, message: `审核规则已添加 (${id})` };
      }

      if (p.action === 'update') {
        if (!p.ruleId) return { success: false, error: 'update 需要 ruleId' };
        const sets = []; const vals = [];
        if (p.direction !== undefined) { sets.push('direction = ?'); vals.push(p.direction); }
        if (p.keyword !== undefined) { sets.push('keyword = ?'); vals.push(p.keyword); }
        if (p.actionType !== undefined) { sets.push('action = ?'); vals.push(p.actionType); }
        if (p.prompt !== undefined) { sets.push('prompt = ?'); vals.push(p.prompt); }
        if (sets.length === 0) return { success: false, error: '无可更新的字段' };
        sets.push('updated_at = ?'); vals.push(Date.now());
        vals.push(p.ruleId);
        cx.exec(`UPDATE audit_rules SET ${sets.join(', ')} WHERE id = ?`, vals);
        return { success: true, message: `审核规则已更新 (${p.ruleId})` };
      }

      if (p.action === 'delete') {
        if (!p.ruleId) return { success: false, error: 'delete 需要 ruleId' };
        cx.exec('DELETE FROM audit_rules WHERE id = ?', [p.ruleId]);
        return { success: true, message: `审核规则已删除 (${p.ruleId})` };
      }

      return { success: false, error: `未知 action: ${p.action}` };
    },

    async invite_friend(p: McpToolParams = {}) {
      const { agentId, friendEmail: rawEmails } = p;
      const emailList = [...new Set(
        String(rawEmails || '').split(/[,;\n\r，]+/).map((email) => email.trim().toLowerCase()).filter(Boolean)
      )];
      if (emailList.length === 0) return { success: false, error: '没有有效的受邀邮箱' };
      const results = [];
      for (const email of emailList) {
        results.push(await createAgentInvitation({
          db: cx.db,
          apiBaseUrl: cx.VOKO_API_URL,
          agentId: String(agentId || ''),
          email,
        }));
      }
      if (results.length === 1) return { agentId, ...results[0] };
      return {
        success: results.every((result) => result.success !== false),
        agentId,
        results,
      };
    },
  };
  const registrationOrchestrator = createRegistrationOrchestrator({
    db: cx.db,
    sendCode: (params: unknown) => cx.agentRegistration.sendCode(params),
    loginByCode: (params: unknown) => cx.agentRegistration.loginByCode(params),
    completeAgent: (params: unknown) => handlers.create_agent_by_token(params),
    getLoggedEmail: () => {
      return _currentOwnerEmail();
    },
    runLoopbackTest: async (request: DynamicRow) => {
      const agentId = String(request.agentId || '');
      const providerId = String(request.providerId || '');
      const mode = String(request.mode || '');
      const definition = getProviderTransport(providerId);
      const provider = (global as any).__dispatcher?.resolveProviderTransport?.(agentId, providerId, mode) || null;
      if (!agentId || !providerId || !mode || !definition?.supportsLoopback || !provider) {
        return { success: false, detail: 'No safe loopback adapter is available' };
      }
      const result = await provider.runLoopbackTest(agentId, request);
      return {
        success: result?.ok === true,
        challengeMatched: result?.challengeMatched === true,
        detail: result?.detail || null,
        providerId,
        mode,
        loopbackSessionId: result?.loopbackSessionId || null,
      };
    },
    cleanupLoopbackSession: async (request: DynamicRow) => {
      const agentId = String(request.agentId || '');
      const providerId = String(request.providerId || '');
      const mode = String(request.mode || '');
      const provider = (global as any).__dispatcher?.resolveProviderTransport?.(agentId, providerId, mode) || null;
      if (!provider?.cleanupLoopbackSession) return { success: false, cleaned: false };
      const result = await provider.cleanupLoopbackSession(agentId, String(request.loopbackSessionId || '') || undefined);
      return { success: result?.ok !== false, cleaned: result?.cleaned === true };
    },
  });
  handlers.manage_agent_registration = async (params: McpToolParams = {}) =>
    registrationOrchestrator.manage(params);

  handlers.bug_report = async (params: McpToolParams = {}) => {
    if (typeof cx.bugReport !== 'function') return { success: false, error: 'Bug report service is unavailable' };
    return cx.bugReport({ ...params, source: (params as any).source || 'agent' });
  };

  // 对所有携带现有 agentId 的 MCP/CLI/Web handler 统一执行 owner 边界校验。
  // 注册流程访问尚未落库的 Agent，不受此包装影响。
  for (const [name, handler] of Object.entries(handlers)) {
    if (typeof handler !== 'function' || name === 'bug_report' || name.startsWith('_')) continue;
    handlers[name] = async (params: McpToolParams = {}) => {
      const ownershipError = _agentOwnershipError(params?.agentId);
      if (ownershipError) return { success: false, error: ownershipError, code: 'AGENT_OWNER_MISMATCH' };
      try {
        const result = await handler.call(handlers, params);
        const success = !(result && typeof result === 'object' && (result as { success?: unknown }).success === false);
        recordHighRiskTool(name, params, success);
        return result;
      } catch (error) {
        recordHighRiskTool(name, params, false);
        throw error;
      }
    };
  }

  return handlers;
}

module.exports = { createToolHandlers };
