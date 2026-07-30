/**
 * skill-def.js — 技能定义
 *
 * Skill = prompt 片段 + 绑定的 MCP 工具集 + /command 触发名 + 版本。
 * 一个 agent 可组合多个技能，技能也可独立热更新。
 *
 * 用法：
 *   const skill = defineSkill({ name: 'query-order', command: '/query-order', ... });
 *   if (isValidSkill(skill)) registry.add(skill);
 */

// ── 内置技能分类 ─────────────────────────────────────────────────────

const SkillCategory = Object.freeze({
  CHAT: 'chat',
  CUSTOMER_SERVICE: 'customer_service',
  TOOL: 'tool',
  ADMIN: 'admin',
});
export {};

export type SkillCategoryValue = typeof SkillCategory[keyof typeof SkillCategory];

export interface SkillExample {
  user: string;
  assistant: string;
}

export interface SkillSpec {
  name: string;
  version?: string;
  description?: string;
  category?: SkillCategoryValue;
  command?: string;
  prompt?: string;
  mcpTools?: string[];
  examples?: SkillExample[];
}

export interface Skill {
  name: string;
  version: string;
  description: string;
  category: SkillCategoryValue;
  command: string;
  prompt: string;
  mcpTools: string[];
  examples: SkillExample[];
}

// ── 技能定义工厂 ─────────────────────────────────────────────────────

/**
 * 定义一个新技能。
 *
 * @param {object} spec
 * @param {string} spec.name        - 技能唯一名称（同时也是 /command 名）
 * @param {string} [spec.version='1.0.0']
 * @param {string} spec.description - 简短说明
 * @param {string} [spec.category]  - SkillCategory 常量
 * @param {string} [spec.command]   - 触发命令（如 '/query-order'），默认 '/{name}'
 * @param {string} spec.prompt      - 注入 agent 的 system prompt 片段
 * @param {string[]} [spec.mcpTools] - 技能依赖的 MCP 工具名列表
 * @param {object[]} [spec.examples] - [{ user, assistant }] 示例对话
 * @returns {Skill}
 */
function defineSkill(spec: SkillSpec): Skill {
  return {
    name: spec.name,
    version: spec.version || '1.0.0',
    description: spec.description || '',
    category: spec.category || SkillCategory.TOOL,
    command: spec.command || `/${spec.name}`,
    prompt: spec.prompt || '',
    mcpTools: spec.mcpTools || [],
    examples: spec.examples || [],
  };
}

/** 判断对象是否为合法 Skill */
function isValidSkill(skill: unknown): any {
  const candidate = skill as Partial<Skill> | null | undefined;
  return candidate
    && typeof candidate.name === 'string' && candidate.name.length > 0
    && typeof candidate.prompt === 'string'
    && typeof candidate.command === 'string';
}

/** 获取技能匹配的命令列表（含别名） */
function getSkillCommands(skill: Skill): string[] {
  return [skill.command, `/${skill.name}`].filter((v, i, a) => a.indexOf(v) === i);
}

module.exports = { SkillCategory, defineSkill, isValidSkill, getSkillCommands };
