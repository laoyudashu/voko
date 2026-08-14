import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

const CONFIG_TYPE = 'owner_codex_bridge_v1';
interface AgentCodexConfig { cwd: string | null; profile: string | null }

function readAll(db: DatabaseSync): Record<string, AgentCodexConfig> {
  try {
    const row = db.prepare('SELECT data FROM config WHERE type=?').get(CONFIG_TYPE) as any;
    const parsed = JSON.parse(String(row?.data || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) { return {}; }
}

function readOwnerCodexConfig(db: DatabaseSync, agentId: string): AgentCodexConfig {
  const value = readAll(db)[String(agentId)] || {} as AgentCodexConfig;
  return { cwd: typeof value.cwd === 'string' && value.cwd ? value.cwd : null,
    profile: typeof value.profile === 'string' && value.profile ? value.profile : null };
}

function saveOwnerCodexConfig(db: DatabaseSync, agentId: string, input: Partial<AgentCodexConfig>): AgentCodexConfig {
  const agent = db.prepare("SELECT agent_id FROM agents WHERE agent_id=? AND backend_type='codex'").get(String(agentId));
  if (!agent) throw new Error('OWNER_CODEX_AGENT_NOT_FOUND');
  let cwd: string|null = input.cwd == null || String(input.cwd).trim() === '' ? null : path.resolve(String(input.cwd).trim());
  if (cwd) {
    try { if (!fs.statSync(cwd).isDirectory()) throw new Error(); cwd = fs.realpathSync(cwd); }
    catch (_) { throw new Error('OWNER_CODEX_WORKDIR_INVALID'); }
  }
  const profile = input.profile == null || String(input.profile).trim() === '' ? null : String(input.profile).trim();
  if (profile && !/^[A-Za-z0-9._-]{1,64}$/.test(profile)) throw new Error('OWNER_CODEX_PROFILE_INVALID');
  const all = readAll(db); all[String(agentId)] = { cwd, profile };
  db.prepare(`INSERT INTO config(type,data,updated_at) VALUES(?,?,?)
    ON CONFLICT(type) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at`)
    .run(CONFIG_TYPE,JSON.stringify(all),Date.now());
  return { cwd, profile };
}

export { readOwnerCodexConfig, saveOwnerCodexConfig };
