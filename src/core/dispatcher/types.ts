export type SessionMode = 'deterministic-key' | 'agent-issued-id';

export interface AgentMeta {
  backend_type?: string | null;
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
  [key: string]: unknown;
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
