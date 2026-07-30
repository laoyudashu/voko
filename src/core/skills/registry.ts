/**
 * registry.js — 技能注册表
 *
 * 管理 Skill 定义的注册、查询、匹配。支持内置预设技能和运行时注册。
 * 技能按 name 唯一索引。
 */

const { defineSkill, isValidSkill, SkillCategory } = require('./skill-def');
import type { Skill, SkillCategoryValue } from './skill-def';

// ── 内置技能 ─────────────────────────────────────────────────────────

/** 默认内置技能集 */
function _builtinSkills(): Skill[] {
  return [
    defineSkill({
      name: 'chat',
      version: '1.0.0',
      description: '基础对话能力',
      category: SkillCategory.CHAT,
      command: '/chat',
      prompt: '你是一个智能客服助手。请基于对话历史和访客消息，友好、准确地回复用户。',
      mcpTools: ['get_chat_history', 'send_message', 'get_visitor_profile'],
    }),
    defineSkill({
      name: 'query-order',
      version: '1.0.0',
      description: '查询订单状态',
      category: SkillCategory.CUSTOMER_SERVICE,
      command: '/query-order',
      prompt: '当用户查询订单状态时，你需要：\n'
        + '1. 询问用户的订单号\n'
        + '2. 调用 voko get_chat_history 查看历史消息中是否有订单号\n'
        + '3. 如有订单号，调用相关查询接口获取订单状态\n'
        + '4. 向用户清晰说明当前订单状态',
      mcpTools: ['get_chat_history', 'send_message'],
      examples: [
        { user: '我的订单到哪了', assistant: '请提供您的订单号，我来帮您查询。' },
        { user: '订单号是 ORD-20240701-001', assistant: '查询到您的订单当前状态为「已发货」，预计 7 月 5 日前送达。' },
      ],
    }),
    defineSkill({
      name: 'refund',
      version: '1.0.0',
      description: '处理退款/退货申请',
      category: SkillCategory.CUSTOMER_SERVICE,
      command: '/refund',
      prompt: '当用户申请退款或退货时：\n'
        + '1. 了解退款原因\n'
        + '2. 确认订单号和购买时间\n'
        + '3. 如需人工审核，使用 ask_human_for_help 升级给主人处理',
      mcpTools: ['get_chat_history', 'send_message', 'ask_human_for_help'],
    }),
    defineSkill({
      name: 'escalate',
      version: '1.0.0',
      description: '升级到人工客服',
      category: SkillCategory.CUSTOMER_SERVICE,
      command: '/escalate',
      prompt: '当用户要求转人工或问题无法解决时：\n'
        + '1. 先向用户确认已理解他的问题\n'
        + '2. 使用 ask_human_for_help 工具提交升级请求\n'
        + '3. 告知用户已通知主人，请耐心等待',
      mcpTools: ['send_message', 'ask_human_for_help'],
    }),
    defineSkill({
      name: 'lookup-knowledge',
      version: '1.0.0',
      description: '查询知识库信息',
      category: SkillCategory.TOOL,
      command: '/lookup-kb',
      prompt: '当用户询问商品信息、退换货政策、配送范围等知识库范畴的问题时：\n'
        + '1. 先查阅聊天历史中是否有相关信息\n'
        + '2. 根据已有信息准确回答\n'
        + '3. 不确定时不要编造，请用户联系主人',
      mcpTools: ['get_chat_history', 'get_visitor_profile', 'send_message'],
    }),
  ];
}

// ── 注册表类 ─────────────────────────────────────────────────────────

export class SkillRegistry {
  private _skills: Map<string, Skill>;
  private _initialized: boolean;

  constructor() {
    this._skills = new Map();  // name → Skill
    this._initialized = false;
  }

  /** 加载内置技能 */
  init() {
    if (this._initialized) return;
    for (const skill of _builtinSkills()) {
      this._skills.set(skill.name, skill);
    }
    this._initialized = true;
  }

  /** 注册单个技能（覆盖同名） */
  register(skill: Skill) {
    if (!isValidSkill(skill)) {
      throw new Error(`Invalid skill: ${JSON.stringify(skill?.name)}`);
    }
    this._skills.set(skill.name, skill);
  }

  /** 批量注册 */
  registerAll(skills: Skill[]) {
    for (const s of skills) this.register(s);
  }

  /** 按名称查询 */
  get(name: string): Skill | null {
    return this._skills.get(name) || null;
  }

  /** 查询全部 */
  list(category?: SkillCategoryValue): Skill[] {
    const all = Array.from(this._skills.values());
    if (category) return all.filter(s => s.category === category);
    return all;
  }

  /** 按命令匹配（/query-order → skill） */
  matchCommand(text: unknown): Skill | null {
    if (!text || typeof text !== 'string') return null;
    const trimmed = text.trim().toLowerCase();
    for (const skill of this._skills.values()) {
      if (trimmed === skill.command.toLowerCase() || trimmed === `/${skill.name.toLowerCase()}`) {
        return skill;
      }
    }
    return null;
  }

  /** 移除技能 */
  remove(name: string): boolean {
    return this._skills.delete(name);
  }

  /** 技能总数 */
  get size() { return this._skills.size; }
}

// ── 单例 ─────────────────────────────────────────────────────────────

const defaultRegistry = new SkillRegistry();

module.exports = { SkillRegistry, defaultRegistry };
