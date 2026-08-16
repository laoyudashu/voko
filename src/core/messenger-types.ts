import type { PushPayload } from './dispatcher/types';
import type { DatabaseLike } from '../types/database';

export type ChannelType = 1 | 2;
export type AuditDirection = 'inbound' | 'outbound';
export type AuditAction = 'allow' | 'soft_deny' | 'hard_deny' | null;

export interface Mention {
  all?: boolean;
  uids?: string[];
}

export interface InboundMessage {
  fromUid: string;
  toUid: string;
  channelId: string;
  content: string;
  messageId: string;
  timestamp: number;
  channelType?: number;
  contentType?: number;
  messageSeq?: number;
  clientMsgNo?: string;
  noPersist?: number | boolean;
  redDot?: number | boolean;
  syncOnce?: number | boolean;
  mention?: Mention | null;
  _voko?: { protocolVersion?: number; routeId?: string; replyToRouteId?: string;
    conversationKey?: string; conversationStart?: boolean;
    conversationDisposition?: 'created' | 'reused'; canonicalConversationKey?: string } | null;
}

export interface ForwardPayload {
  agentId: string;
  fromUid: string;
  content: string;
  channelId: string;
  channelType: number;
  contentType: number;
  messageId: string;
  timestamp: number;
  mention?: Mention | null;
  _voko?: InboundMessage['_voko'];
}

export interface AgentReplyMessage {
  agentId: string;
  visitorId: string;
  content: string;
  sessionKey?: string;
  done?: boolean;
  replyId?: string;
  turnId?: string;
  channelId?: string;
  channelType?: number;
  senderUid?: string;
  interventionResume?: boolean;
  a2aManaged?: boolean;
  a2aPeerUid?: string;
  a2aScope?: string;
  remoteRouteId?: string | null;
  remoteConversationKey?: string | null;
  conversationStart?: boolean;
  sourceMessageId?: string;
  sourceRouteClaimSafe?: boolean;
  replyRouteContext?: {
    conversationId: string;
    providerFamily: string;
    providerInstanceKey: string;
    nativeSessionId: string;
    strictSessionRoute: true;
  } | null;
}

export interface AuditRuleMatch {
  prompt_key?: string | null;
  prompt?: string | null;
  [key: string]: unknown;
}

export interface AuditResult {
  action: AuditAction;
  verdict?: 'allow' | 'deny' | 'uncertain';
  matchedKeyword?: string | null;
  matchedRule?: AuditRuleMatch | null;
  [key: string]: unknown;
}

export interface MessageContext {
  channelId?: string;
  channelType?: number;
  senderUid?: string;
}

export interface OwnerInterventionInput {
  id: string;
  visitorId: string;
  sessionKey: string;
  problem: string;
  agentSuggestion?: string | null;
  askTime: number;
  expireTime?: number | null;
  status?: string;
  ownerReply?: string | null;
  replyTime?: number | null;
  parentMessageId?: string | null;
  channelType?: number | string | null;
  resolvedAt?: number | null;
  createdAt: number;
  updatedAt: number;
  agentId?: string | null;
  skipReply?: boolean;
  sourceSenderUid?: string | null;
  targetChannelId?: string | null;
  targetChannelType?: number | null;
  sourceMessageId?: string | null;
}

export interface DeliverResult {
  success: boolean;
  via?: string;
  messageId?: string;
  clientMsgNo?: string;
  messageSeq?: number;
  error?: string;
  [key: string]: unknown;
}

export type Deliver = (
  agentId: string,
  channelId: string,
  content: string,
  messageType?: string,
  channelType?: ChannelType,
  mentions?: Mention | null,
  localMsgId?: string | null,
) => Promise<DeliverResult>;

export interface WorkerEntryLike {
  worker: {
    send(message: Record<string, unknown>): void;
  };
}

export interface BackendHandlerLike {
  setCaseMapEntry?(agentId: string, channelId: string): void;
}

export interface DispatcherLike {
  dispatch(agentId: string, payload: PushPayload): unknown;
  markConverged?(fromUid: string, peerUid: string, scope: string): unknown;
  isAgentImUid?(uid: string): boolean;
}

export interface AccessControlLike {
  isBlacklisted(db: DatabaseLike, agentId: string, visitorId: string): boolean;
  isWhitelisted(db: DatabaseLike, agentId: string, visitorId: string): boolean;
  addEntry(db: DatabaseLike, entry: Record<string, unknown>): unknown;
  autoApproveIfFriendRequest(
    db: DatabaseLike,
    sendSystemMessage: NonNullable<MessageHandlerOptions['sendSystemMessage']>,
    intervention: Record<string, unknown>,
    ownerReply: string,
  ): unknown;
}

export interface DatabaseApiLike {
  saveOwnerIntervention(intervention: OwnerInterventionInput): unknown;
}

export interface MessageHandlerOptions {
  databaseAPI?: DatabaseApiLike;
  agentWorkers?: Map<string, WorkerEntryLike>;
  hermesHandler?: BackendHandlerLike;
  openclawHandler?: BackendHandlerLike;
  dispatcher?: DispatcherLike;
  ac?: AccessControlLike;
  sendSystemMessage?: (
    agentId: string,
    visitorId: string,
    code: string,
    params?: Record<string, unknown>,
    timestamp?: number,
    route?: { conversationId?: string | null },
  ) => unknown;
  deliver?: Deliver;
  checkAuditRules?: (content: string, direction: AuditDirection) => AuditResult;
  classifyAuditDecision?: (
    content: string,
    direction: AuditDirection,
    decision: AuditResult,
  ) => Promise<AuditResult>;
  substitutePromptVariables?: (
    prompt: string,
    variables: Record<string, unknown>,
  ) => string;
  notifyUI?: (eventName: string, data: Record<string, unknown>) => unknown;
  enqueueIntervention?: (intervention: Record<string, unknown>) => unknown;
  createPendingPayment?: (
    agentId: string,
    fromUid: string,
    toUid: string | undefined,
    pricing: Record<string, unknown>,
    timestamp: number,
    sourceMessageId?: string | null,
  ) => unknown;
  onOwnerInterventionNew?: () => unknown;
  getGroupInfo?: (agentId: string, channelId: string) => Promise<{
    status?: string;
    dissolved_at?: string | null;
    dissolvedAt?: string | null;
    members?: Array<{ uid?: string; role?: string }>;
  }>;
}
