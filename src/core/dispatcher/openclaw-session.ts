const crypto = require('crypto');

/** Keep OpenClaw's instance selector while isolating every VOKO Agent. */
export function buildOpenClawSessionKey(instanceId: string, agentId: string, target: string): string {
  const scope = crypto.createHash('sha256').update(agentId).digest('hex').slice(0, 16);
  return `agent:${instanceId}:voko-${scope}:${target}`;
}

/** New scoped keys remain reversible so replies retain the original visitor/group target. */
export function parseOpenClawSessionTarget(value: string): string {
  const match = String(value || '').match(/^voko-[a-f0-9]{16}:(.+)$/);
  return match?.[1] || value;
}
