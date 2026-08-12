import { OWNER_IM_UID_PATTERN, OwnerLinkBridge } from './bridge';
import type { OwnerLinkInboundMessage, OwnerLinkInboundResult } from './bridge';

class OwnerLinkIngress {
  constructor(private readonly bridge: OwnerLinkBridge | null) {}

  handle(agentId: string, message: OwnerLinkInboundMessage): OwnerLinkInboundResult {
    const fromUid = String(message.fromUid || '');
    if (!OWNER_IM_UID_PATTERN.test(fromUid) && !this.bridge?.isReservedOwnerSender(fromUid)) {
      return { handled: false };
    }
    if (!this.bridge) return { handled: true, accepted: false, code: 'OWNER_LINK_DISABLED' };
    return this.bridge.handleInbound(agentId, message);
  }
}

export { OwnerLinkIngress };
