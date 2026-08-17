import crypto from 'node:crypto';

export class CanaryMonitor {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private emergencyTriggered = false;
  private lastFailures = 0;
  private lastReport: Record<string, unknown> | null = null;

  constructor(private readonly runtime: any, private readonly options: {
    intervalMs?: number; failureThreshold?: number; onReport?: (report: Record<string, unknown>) => void;
  } = {}) {}

  start(): () => void {
    if (this.timer) return () => this.stop();
    const intervalMs = Math.max(5_000,Number(this.options.intervalMs || 60_000));
    this.check();
    this.timer = setInterval(() => this.check(),intervalMs);
    this.timer.unref?.();
    return () => this.stop();
  }

  stop(): void { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = null; }

  snapshot(): Record<string, unknown> | null { return this.lastReport ? { ...this.lastReport } : null; }

  async check(): Promise<Record<string, unknown>> {
    const status = this.runtime.diagnostics();
    const failureDelta = Math.max(0,Number(status.failures || 0) - this.lastFailures);
    this.lastFailures = Number(status.failures || 0);
    const threshold = Math.max(1,Number(this.options.failureThreshold || 3));
    const unsafe = Number(status.plaintextFallbacks || 0) > 0 || failureDelta >= threshold;
    if (unsafe && !this.emergencyTriggered) {
      this.emergencyTriggered = true;
      await this.runtime.emergencyDisable();
      console.error('[E2EE Canary] 监控触发紧急关闭；旧消息不会重放，也不会降级明文');
    }
    const current = this.runtime.diagnostics();
    const report = Object.freeze({ schemaVersion:1,generatedAt:new Date().toISOString(),
      runtimeEnabled:current.enabled===true,emergencyDisabled:current.emergencyDisabled===true,
      scopeRef:crypto.createHash('sha256').update(String(current.scopeCount || 0)).digest('base64url').slice(0,12),
      received:Number(current.received||0),replied:Number(current.replied||0),rejected:Number(current.rejected||0),
      failures:Number(current.failures||0),plaintextFallbacks:Number(current.plaintextFallbacks||0),
      sessions:current.sessions||[],receipts:current.receipts||[],productionEnabled:false });
    this.lastReport = report;
    try { this.options.onReport?.(report); } catch {}
    return report;
  }
}

module.exports = { CanaryMonitor };
