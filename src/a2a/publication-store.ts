import type { DatabaseSync } from 'node:sqlite';

class A2APublicationStore {
  constructor(private readonly db: DatabaseSync) {}

  getPublicEnabled(agentId: string): boolean | null {
    const row = this.db.prepare('SELECT public_enabled FROM a2a_agent_publication WHERE agent_id=?')
      .get(agentId) as { public_enabled: number } | undefined;
    return row ? row.public_enabled === 1 : null;
  }

  isPublicEnabled(agentId: string): boolean {
    return this.getPublicEnabled(agentId) === true;
  }

  setPublicEnabled(agentId: string, enabled: boolean): void {
    this.db.prepare(`INSERT INTO a2a_agent_publication(agent_id,public_enabled,updated_at) VALUES(?,?,?)
      ON CONFLICT(agent_id) DO UPDATE SET public_enabled=excluded.public_enabled,updated_at=excluded.updated_at`)
      .run(agentId, enabled ? 1 : 0, Date.now());
  }
}

export { A2APublicationStore };
