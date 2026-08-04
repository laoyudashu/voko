export type AgentBackend =
  | 'openclaw'
  | 'hermes'
  | 'goose'
  | 'claude-code'
  | 'codex'
  | 'gemini'
  | 'cursor'
  | 'grok'
  | 'opencode'
  | 'pi'
  | 'cline'
  | 'others';

export interface AgentRecord {
  agentId: string;
  agentName?: string;
  backendType?: AgentBackend | string;
  status?: string;
  imUid?: string;
}

export interface ConversationRecord {
  agentId: string;
  channelId: string;
  lastMessage?: string;
  timestamp?: number;
}

export interface MessageRecord {
  agentId: string;
  channelId: string;
  content: string;
  messageType?: string;
  timestamp: number;
  isMe?: boolean | number;
}

export type WorkerRequest =
  | { type: 'req'; id: string; method: string; params?: unknown; ts?: number }
  | { type: 'send'; channelId: string; content: unknown; messageType?: string; localMsgId?: string }
  | { type: 'disconnect' }
  | { type: 'ping' };

export type WorkerResponse =
  | { type: 'res'; id: string; ok: boolean; payload?: unknown; error?: unknown; ts?: number }
  | { type: 'event'; event: string; payload?: unknown; seq?: number; ts?: number }
  | { type: string; agentId?: string; [key: string]: unknown };

export interface VokoResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}
