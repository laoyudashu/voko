export type SessionMode = 'deterministic-key' | 'agent-issued-id';

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
  channelId?: string;
  channelType?: number;
  contentType?: number;
  messageId?: string;
  turnId?: string;
  timestamp?: number;
  securityContext?: {
    version: number;
    policyId: string;
    sourceType: string;
    trustLevel: string;
    instructions: string[];
    ownerCommandsOnlyVia: string;
  };
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
  configured: boolean;
  available: boolean;
  status: 'available' | 'unavailable' | 'on-demand' | 'fallback' | 'unknown';
}

export interface AgentDeliveryStatus {
  backendType: string | null;
  configuredModes: string[];
  automaticDeliveryReady: boolean;
  automaticReadyModes: string[];
  activeAutomaticMode: string | null;
  pullReady: boolean;
  lastDeliveredMode: string | null;
  methods: AgentDeliveryMethodStatus[];
}
