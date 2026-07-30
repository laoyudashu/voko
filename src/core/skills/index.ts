/**
 * skills/index.js — Skills 能力系统入口
 *
 * 统一导出 skill-def + registry + agent 技能绑定函数。
 *
 *   技能注入：
 *     const { defaultRegistry, buildAgentPrompt } = require('./core/skills');
 *     defaultRegistry.init();
 *     const prompt = buildAgentPrompt(db, agentId, defaultRegistry);
 */

const { defineSkill, isValidSkill, SkillCategory, getSkillCommands } = require('./skill-def');
const { SkillRegistry, defaultRegistry } = require('./registry');
import type { Skill } from './skill-def';
import type { SkillRegistry as SkillRegistryType } from './registry';

interface Statement {
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
}

interface DatabaseLike {
  prepare(sql: string): Statement;
}

interface AgentSkillRow {
  skill_name: string;
  enabled?: number;
  config?: string | null;
}

type SkillConfig = Record<string, unknown>;
type ConfigBySkill = Record<string, SkillConfig>;
type AssignedSkill = Skill & { config: SkillConfig };

/**
 * 从 DB agent_skills 表读取某 agent 启用的技能，拼接 system prompt。
 *
 * @param {object} db           - better-sqlite3 实例
 * @param {string} agentId
 * @param {SkillRegistry} [registry] - 技能注册表，默认 defaultRegistry
 * @returns {{ prompt: string, skills: object[] }}
 */
function buildAgentPrompt(
  db: DatabaseLike,
  agentId: string,
  registry?: SkillRegistryType,
): { prompt: string; skills: AssignedSkill[] } {
  const reg = registry || defaultRegistry;
  reg.init();

  let rows: AgentSkillRow[];
  try {
    rows = db.prepare(
      `SELECT skill_name, config FROM agent_skills WHERE agent_id=? AND enabled=1 ORDER BY created_at ASC`
    ).all(agentId) as AgentSkillRow[];
  } catch {
    rows = [];
  }

  const skills: AssignedSkill[] = [];
  const parts: string[] = [];

  for (const row of rows) {
    const def = reg.get(row.skill_name);
    if (!def) continue;

    let config: SkillConfig = {};
    try { if (row.config) config = JSON.parse(row.config) as SkillConfig; } catch {}

    skills.push({ ...def, config });
    if (def.prompt) parts.push(def.prompt);
  }

  return {
    prompt: parts.join('\n\n'),
    skills,
  };
}

/**
 * 为 agent 分配技能。
 *
 * @param {object} db
 * @param {string} agentId
 * @param {string[]} skillNames
 * @param {object} [configs] - { skillName: { ... } } 可选 per-skill 配置
 */
function assignSkills(
  db: DatabaseLike,
  agentId: string,
  skillNames: string[],
  configs?: ConfigBySkill,
): void {
  const now = Date.now();
  // 清除旧分配
  db.prepare(`DELETE FROM agent_skills WHERE agent_id=?`).run(agentId);
  // 写入新分配
  const insert = db.prepare(
    `INSERT INTO agent_skills (id, agent_id, skill_name, enabled, config, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)`
  );
  for (const name of skillNames) {
    const id = `askill_${now}_${Math.random().toString(36).substr(2, 6)}`;
    const config = configs?.[name] ? JSON.stringify(configs[name]) : null;
    insert.run(id, agentId, name, config, now, now);
  }
}

/**
 * 获取 agent 已分配的技能名称列表。
 */
function getAgentSkills(db: DatabaseLike, agentId: string): AgentSkillRow[] {
  try {
    return db.prepare(
      `SELECT skill_name, enabled, config FROM agent_skills WHERE agent_id=? ORDER BY created_at ASC`
    ).all(agentId) as AgentSkillRow[];
  } catch {
    return [];
  }
}

module.exports = {
  defineSkill,
  isValidSkill,
  SkillCategory,
  SkillRegistry,
  defaultRegistry,
  buildAgentPrompt,
  assignSkills,
  getAgentSkills,
};
