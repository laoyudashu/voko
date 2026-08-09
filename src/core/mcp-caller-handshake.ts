import crypto from 'node:crypto';

const CHALLENGE_TTL_MS = 2 * 60 * 1000;
const BINDING_TTL_MS = 12 * 60 * 60 * 1000;

interface ChallengeRecord {
  connectionId: string;
  expiresAt: number;
}

export interface McpCallerHandshakeBinding {
  providerType: string;
  providerInstanceId: string | null;
  instanceId: string | null;
  nativeSessionId: string;
  evidence: 'provider_bridge';
  expiresAt: number;
}

const challenges = new Map<string, ChallengeRecord>();
const bindings = new Map<string, McpCallerHandshakeBinding>();
const TRUSTED_EVIDENCE = new Set(['provider_env', 'provider_process', 'provider_hook', 'provider_event', 'voko_created']);

function clean(value: unknown, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

function challengeKey(challenge: string): string {
  return crypto.createHash('sha256').update(challenge, 'utf8').digest('hex');
}

function cleanup(now: number): void {
  for (const [key, value] of challenges) if (value.expiresAt <= now) challenges.delete(key);
  for (const [key, value] of bindings) if (value.expiresAt <= now) bindings.delete(key);
}

export function isMcpCallerHandshakeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(String(env.VOKO_MCP_IDENTITY_HANDSHAKE || ''));
}

export function issueMcpCallerHandshake(
  connectionId: string,
  options: { now?: number; ttlMs?: number } = {},
): { challenge: string; expiresAt: number } {
  const connection = clean(connectionId, 128);
  if (!connection) throw new Error('MCP caller connection is required');
  const now = options.now ?? Date.now();
  cleanup(now);
  const challenge = crypto.randomBytes(32).toString('base64url');
  const expiresAt = now + Math.max(5_000, options.ttlMs ?? CHALLENGE_TTL_MS);
  challenges.set(challengeKey(challenge), { connectionId: connection, expiresAt });
  return { challenge, expiresAt };
}

export function completeMcpCallerHandshake(
  challenge: string,
  caller: {
    providerType?: string | null;
    providerInstanceId?: string | null;
    instanceId?: string | null;
    nativeSessionId?: string | null;
    evidence?: string | null;
  },
  options: { now?: number; ttlMs?: number } = {},
): { connectionId: string; expiresAt: number } {
  const token = clean(challenge, 128);
  const providerType = clean(caller?.providerType, 64).toLowerCase();
  const nativeSessionId = clean(caller?.nativeSessionId, 512);
  if (!token || !providerType || !nativeSessionId || !TRUSTED_EVIDENCE.has(String(caller?.evidence || ''))) {
    throw new Error('Trusted Provider caller context is required');
  }
  const now = options.now ?? Date.now();
  cleanup(now);
  const key = challengeKey(token);
  const pending = challenges.get(key);
  if (!pending || pending.expiresAt <= now) throw new Error('MCP identity challenge is invalid or expired');
  challenges.delete(key);
  const expiresAt = now + Math.max(60_000, options.ttlMs ?? BINDING_TTL_MS);
  const instance = clean(caller.providerInstanceId || caller.instanceId, 192) || null;
  bindings.set(pending.connectionId, {
    providerType,
    providerInstanceId: instance,
    instanceId: instance,
    nativeSessionId,
    evidence: 'provider_bridge',
    expiresAt,
  });
  return { connectionId: pending.connectionId, expiresAt };
}

export function resolveMcpCallerHandshake(
  connectionId: string,
  now = Date.now(),
): McpCallerHandshakeBinding | null {
  cleanup(now);
  const value = bindings.get(clean(connectionId, 128));
  return value ? { ...value } : null;
}

export function resetMcpCallerHandshakes(): void {
  challenges.clear();
  bindings.clear();
}

module.exports = {
  completeMcpCallerHandshake,
  isMcpCallerHandshakeEnabled,
  issueMcpCallerHandshake,
  resetMcpCallerHandshakes,
  resolveMcpCallerHandshake,
};
