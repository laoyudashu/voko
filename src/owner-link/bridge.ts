import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { parseOwnerWire, verifyOwnerEnvelope } from './envelope';
import type { OwnerEnvelope } from './envelope';
import { OwnerLinkSecurityError, OwnerLinkStore } from './store';

const OWNER_IM_UID_PATTERN = /^voko_owner_[A-Za-z0-9_-]{8,160}$/;

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
  now?: () => number;
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

class OwnerLinkBridge {
  readonly store: OwnerLinkStore;
  private readonly now: () => number;
  constructor(private readonly options: OwnerLinkBridgeOptions) {
    this.store = new OwnerLinkStore(options.database);
    this.now = options.now || Date.now;
    this.store.recoverReservedCommands(this.now());
  }

  isReservedOwnerSender(fromUid: unknown): boolean {
    const uid = String(fromUid || '');
    return OWNER_IM_UID_PATTERN.test(uid) || (!!uid && this.store.isKnownOwnerImUid(uid));
  }

  handleInbound(agentId: string, message: OwnerLinkInboundMessage): OwnerLinkInboundResult {
    const fromUid = String(message.fromUid || '');
    if (!this.isReservedOwnerSender(fromUid)) return { handled: false };
    const now = this.now();
    let envelope: OwnerEnvelope | null = null;
    try {
      envelope = parseOwnerWire(String(message.content || ''), { now });
      if (envelope.agentId !== agentId) throw new OwnerLinkSecurityError('OWNER_AGENT_MISMATCH');
      if (message.clientMsgNo && envelope.messageId !== message.clientMsgNo) {
        throw new OwnerLinkSecurityError('OWNER_TRANSPORT_MESSAGE_ID_MISMATCH');
      }
      if (!verifyOwnerEnvelope(envelope, this.options.resolvePublicKey, { now })) {
        throw new OwnerLinkSecurityError('OWNER_SIGNATURE_INVALID');
      }
      const persisted = this.store.persistVerified(envelope, fromUid, now);
      return { handled: true, accepted: true, state: persisted.state };
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : '';
      if (!(error instanceof OwnerLinkSecurityError) && !/^OWNER_[A-Z0-9_]+$/.test(rawMessage)) throw error;
      const code = safeCode(error);
      this.store.recordSecurityEvent({
        code,
        messageId: envelope?.messageId || (typeof message.messageId === 'string' ? message.messageId : null),
        conversationId: envelope?.conversationId,
        agentId,
        details: { code, fromUidHash: crypto.createHash('sha256').update(fromUid).digest('hex') },
        now,
      });
      return { handled: true, accepted: false, code };
    }
  }
}

export { OWNER_IM_UID_PATTERN, OwnerLinkBridge };
export type { OwnerLinkBridgeOptions, OwnerLinkInboundMessage, OwnerLinkInboundResult };
