import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { parseOwnerEnvelopeJson, verifyOwnerEnvelope } from './envelope';
import type { VokoOwnerEnvelope } from './envelope';
import { OwnerLinkSecurityError, OwnerLinkStore } from './store';

const OWNER_IM_UID_PATTERN = /^owner_[A-Za-z0-9._:-]{1,122}$/;
const OWNER_COMMAND_OPERATIONS = new Set(['execute', 'cancel']);
const AGENT_UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const AGENT_DID_PATTERN = /^did:wba:[^\s:]+(?::[^\s:]+)*:([a-f0-9]{32})$/i;

interface OwnerLinkInboundMessage {
  fromUid?: string;
  content?: string;
  messageId?: string;
  clientMsgNo?: string;
  channelId?: string;
  [key: string]: unknown;
}

interface OwnerLinkBridgeOptions {
  database: DatabaseSync;
  resolvePublicKey: (keyId: string) => crypto.KeyLike | null;
  matchesAgentId?: (localAgentId: string, envelopeAgentId: string) => boolean;
  now?: () => number;
  onCommand?: (messageId: string) => void | Promise<void>;
}

interface OwnerLinkInboundResult {
  handled: boolean;
  accepted?: boolean;
  state?: string;
  code?: string;
}

function safeCode(error: unknown): string {
  if (error instanceof OwnerLinkSecurityError) return error.code;
  const message = error instanceof Error ? error.message : String(error);
  return /^OWNER_[A-Z0-9_]+$/.test(message) ? message : 'OWNER_ENVELOPE_REJECTED';
}

function matchesLocalAgentIdentity(localAgentId: string, localDid: unknown, envelopeAgentId: string): boolean {
  if (localAgentId === envelopeAgentId) return true;
  if (!AGENT_UUID_PATTERN.test(envelopeAgentId)) return false;
  const didMatch = String(localDid || '').match(AGENT_DID_PATTERN);
  return !!didMatch && didMatch[1].toLowerCase() === envelopeAgentId.replace(/-/g, '').toLowerCase();
}

class OwnerLinkBridge {
  readonly store: OwnerLinkStore;
  private readonly now: () => number;
  private onCommand: ((messageId: string) => void | Promise<void>) | null;
  constructor(private readonly options: OwnerLinkBridgeOptions) {
    this.store = new OwnerLinkStore(options.database);
    this.now = options.now || Date.now;
    this.onCommand = options.onCommand || null;
    this.store.recoverReservedCommands(this.now());
  }

  setCommandHandler(handler: ((messageId: string) => void | Promise<void>) | null): void {
    this.onCommand = handler;
  }

  isReservedOwnerSender(fromUid: unknown): boolean {
    const uid = String(fromUid || '');
    return OWNER_IM_UID_PATTERN.test(uid) || (!!uid && this.store.isKnownOwnerImUid(uid));
  }

  handleInbound(agentId: string, message: OwnerLinkInboundMessage): OwnerLinkInboundResult {
    const fromUid = String(message.fromUid || '');
    if (!this.isReservedOwnerSender(fromUid)) return { handled: false };
    const now = this.now();
    let envelope: VokoOwnerEnvelope | null = null;
    try {
      envelope = parseOwnerEnvelopeJson(String(message.content || ''), { now });
      if (envelope.kind !== 'command' || !OWNER_COMMAND_OPERATIONS.has(envelope.operation)) {
        throw new OwnerLinkSecurityError('OWNER_DIRECTION_INVALID');
      }
      const matchesAgentId = this.options.matchesAgentId
        ? this.options.matchesAgentId(agentId, envelope.agentId) : envelope.agentId === agentId;
      if (!matchesAgentId) throw new OwnerLinkSecurityError('OWNER_AGENT_MISMATCH');
      if (envelope.ownerImUid !== fromUid) throw new OwnerLinkSecurityError('OWNER_IM_UID_MISMATCH');
      if (message.clientMsgNo && envelope.messageId !== message.clientMsgNo) {
        throw new OwnerLinkSecurityError('OWNER_TRANSPORT_MESSAGE_ID_MISMATCH');
      }
      if (!verifyOwnerEnvelope(envelope, this.options.resolvePublicKey, { now })) {
        throw new OwnerLinkSecurityError('OWNER_SIGNATURE_INVALID');
      }
      const persisted = this.store.persistVerified(envelope, fromUid, now, agentId);
      if (persisted.status === 'inserted' && this.onCommand) {
        const messageId = envelope.messageId;
        queueMicrotask(() => void Promise.resolve(this.onCommand?.(messageId)).catch(() => {}));
      }
      return { handled: true, accepted: true, state: persisted.state };
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : '';
      if (!(error instanceof OwnerLinkSecurityError) && !/^OWNER_[A-Z0-9_]+$/.test(rawMessage)) throw error;
      const code = safeCode(error);
      this.store.recordSecurityEvent({
        code,
        messageId: envelope?.messageId || (typeof message.messageId === 'string' ? message.messageId : null),
        conversationId: envelope?.ownerConversationId,
        agentId,
        details: { code, fromUidHash: crypto.createHash('sha256').update(fromUid).digest('hex') },
        now,
      });
      return { handled: true, accepted: false, code };
    }
  }
}

export { OWNER_IM_UID_PATTERN, OwnerLinkBridge, matchesLocalAgentIdentity };
export type { OwnerLinkBridgeOptions, OwnerLinkInboundMessage, OwnerLinkInboundResult };
