class FaultController {
  constructor() { this.rules = new Map(); }

  set({ target, mode, delayMs = 0, count = Infinity }) {
    if (!target || !mode) throw new Error('fault target and mode are required');
    this.rules.set(target, { mode, delayMs, remaining: count });
  }

  clear(target) {
    if (target) this.rules.delete(target);
    else this.rules.clear();
  }

  peek(target) {
    const rule = this.rules.get(target);
    return rule ? { mode: rule.mode, delayMs: rule.delayMs, remaining: rule.remaining } : null;
  }

  consume(target) {
    const rule = this.rules.get(target);
    if (!rule || rule.remaining <= 0) return null;
    if (Number.isFinite(rule.remaining)) rule.remaining -= 1;
    if (rule.remaining === 0) this.rules.delete(target);
    return { mode: rule.mode, delayMs: rule.delayMs };
  }
}

module.exports = { FaultController };
