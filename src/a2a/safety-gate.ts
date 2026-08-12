const { checkAuditRules } = require('../core/audit');
const { classifyUncertain } = require('../core/safety-classifier');
class A2ASafetyRejection extends Error { constructor(readonly reasonCode: string) { super('A2A content rejected by safety policy'); this.name = 'A2ASafetyRejection'; } }
class A2ASafetyGate {
  constructor(private readonly db: any) {}
  async assertAllowed(content: string, direction: 'inbound' | 'outbound'): Promise<void> {
    let decision = checkAuditRules(content, direction, this.db);
    if (decision.verdict === 'uncertain' || decision.action === 'soft_deny') decision = await classifyUncertain(this.db, content, direction, decision);
    if (decision.action === 'hard_deny' || decision.action === 'soft_deny') throw new A2ASafetyRejection(String(decision.reasonCode || 'safety_policy'));
  }
}
export { A2ASafetyGate, A2ASafetyRejection };
