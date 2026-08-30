export type SessionMode = 'deterministic-key' | 'agent-issued-id';
import type { ProviderCapabilities } from './provider-catalog';
import type { ProviderDeliveryPresentation } from '../provider-delivery-presentation';
export type ProviderDeliveryOutcome = 'delivered' | 'not_delivered' | 'outcome_unknown' | 'rejected';

export interface ProviderDeliveryReceipt {
  nativeSessionId?: string | null;
  providerInstanceId?: string | null;
  deliveryMode?: string;
  adapterType?: string;
  attachmentDelivery?: {
    transportDelivered: boolean;
    attachmentAccessed: boolean | null;
    contentUnderstood: boolean | null;
    mode: 'image' | 'embedded_resource' | 'resource_link' | 'staged_path' | 'none';
  };
}

export type ProviderCoreEventType = 'accepted' | 'reply' | 'completed' | 'failed' | 'status';

export interface ProviderCoreEvent {
  eventId: string;
  type: ProviderCoreEventType;
  providerId: string;
  providerInstanceId?: string | null;
  agentId: string;
  messageId?: string;
  turnId?: string;
  sourceMessageIds?: readonly string[];
  a2aDisposition?: 'new_topic' | 'automatic_reply' | 'explicit_reply';
  nativeSessionId?: string | null;
  occurredAt: number;
  terminal?: boolean;
  payload?: unknown;
}

export interface AgentMeta {
  backend_type?: string | null;
  backend_instance_id?: string | null;
  delivery_modes?: string[] | null;
  [key: string]: unknown;
}

export interface PushPayload {
  agentId: string;
  fromUid: string;
  senderUid?: string;
  sessionTarget?: string;
  content: string;
  rawContent?: string;
  attachments?: ReadonlyArray<Readonly<{ path: string; name: string; mediaType: string; size: number; sha256: string;
    sourceMessageId?: string }>>;
  messageSegments?: ReadonlyArray<Readonly<{ messageId: string; content: string; timestamp: number;
    attachmentIndexes: readonly number[] }>>;
  attachmentOutputDirectory?: string;
  channelId?: string;
  channelType?: number;
  contentType?: number;
  messageId?: string;
  turnId?: string;
  sourceMessageIds?: readonly string[];
  timestamp?: number;
  securityContext?: Readonly<{
    version: number;
    policyId: string;
    sourceType: string;
    trustLevel: string;
    instructions: readonly string[];
    ownerCommandsOnlyVia: string;
  }>;
  providerBinding?: {
    id: string;
    bindingVersion: number;
    providerType: string;
    providerInstanceId: string | null;
    deliveryMode: string;
    adapterType: string;
    nativeSessionId: string;
    sessionOrigin: 'caller' | 'voko_managed';
    channelId: string;
    channelType: number;
    sourceScope?: 'conversation' | 'trusted_owner' | 'a2a';
    strictSessionRoute?: boolean;
    nativeSessionNamespace?: string;
    restoreCompatibilityGroup?: string;
  } | null;
  [key: string]: unknown;
}

export interface ProviderSteerMetadata {
  turnId?: string;
  channelId?: string;
  channelType?: number;
  providerBinding?: PushPayload['providerBinding'];
}

export interface ProviderHealth {
  ok: boolean;
  status?: string;
  uptime?: number;
  lastActive?: number;
}

export interface ProviderReply {
  agentId: string;
  visitorId: string;
  content: string;
  sessionKey: string;
  done?: boolean;
  replyId?: string;
  turnId?: string;
  error?: string;
}

export interface ProviderStatus {
  agentId?: string;
  status: string;
  error?: string;
  [key: string]: unknown;
}

export interface AgentDeliveryMethodStatus {
  mode: string;
  provider: string | null;
  family?: string | null;
  configured: boolean;
  available: boolean;
  automaticReady?: boolean;
  status: 'available' | 'verification_required' | 'unavailable' | 'configuration_required' | 'on-demand' | 'fallback' | 'unknown';
  installed?: boolean;
  authenticationStatus?: 'verified' | 'unverified';
  reason?: string;
  detail?: string;
  exitCode?: number | null;
  attempts?: number;
  verificationStatus?: 'unverified' | 'loopback_verified' | 'quota_exhausted' | 'timeout' | 'login_failed' | 'parse_failed' | 'failed';
  verifiedAt?: number;
  setupCommand?: string;
  capabilities?: Readonly<Partial<ProviderCapabilities>>;
  presentation?: ProviderDeliveryPresentation;
}

export interface AgentDeliveryStatus {
  backendType: string | null;
  configuredModes: string[];
  automaticDeliveryReady: boolean;
  automaticReadyModes: string[];
  activeAutomaticMode: string | null;
  pullReady: boolean;
  pullOnly: boolean;
  lastDeliveredMode: string | null;
  temporaryPreferredMode: string | null;
  temporaryPreferredProvider: string | null;
  methods: AgentDeliveryMethodStatus[];
}
