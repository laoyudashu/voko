export type OwnerEnvelopeKind = 'command' | 'receipt' | 'event';
export type OwnerOperation =
  | 'execute' | 'cancel' | 'approve' | 'reject'
  | 'accepted' | 'working' | 'completed' | 'failed' | 'canceled';

export interface VokoOwnerEnvelope<TPayload = Record<string, unknown>> {
  version: 'voko.owner/1';
  kind: OwnerEnvelopeKind;
  messageId: string;
  ownerConversationId: string;
  ownerIdentityId: string;
  ownerImUid: string;
  agentId: string;
  ownershipEpoch: number;
  conversationEpoch: number;
  sequence: number;
  operation: OwnerOperation;
  payload: TPayload;
  payloadDigest: string;
  keyId: string;
  algorithm: 'Ed25519';
  createdAt: string;
  expiresAt: string;
  signature: string;
}

export interface OwnerSessionCreated {
  csrfToken: string;
  deviceId: string;
  userId: string;
  email: string;
  idleExpiresInSeconds: 604800;
  absoluteExpiresInSeconds: 2592000;
}

export interface OwnerConversationBinding {
  ownerConversationId: string;
  ownerIdentityId: string;
  ownerImUid: string;
  ownershipEpoch: number;
  conversationEpoch: number;
}
