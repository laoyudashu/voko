/**
 * A2A STATE 解析器 —— 从 agent 回复中鲁棒提取收敛协议状态。
 *
 * 背景：dispatcher 注入的 prompt 要求 agent 回复以 [STATE]{...}[/STATE] 开头，
 * 但生产环境 LLM 输出服从性非 100%，会出现各种畸形（markdown 包裹、Python bool、
 * 尾逗号、字段名变体、缺结束标签、多块复读等）。本模块用「先粗后细」四级管线容错：
 *   strict  —— 标准 JSON.parse（80% 一次过）
 *   loose   —— 归一化（中文引号/Python bool/尾逗号）后再 parse
 *   regex   —— 整体 parse 彻底失败时，字段级正则抽取收敛判据
 *   none    —— 确实没有 STATE 块
 *
 * 设计原则：
 *   1. 收敛判据逻辑（validConvergence）与原实现一字不差，零行为回归；
 *      本模块只负责"把 state 解出来 + 归一化类型"，不改判定规则。
 *   2. method 字段供观测：监控有多少比例走了容错，反哺 prompt 调优。
 *   3. 纯函数，零副作用，零 IO，易测。
 */

/** 归一化后的 A2A STATE（字段全部可选，调用方按需取用并判空）。 */
export interface A2AState {
  goal?: string;
  agenda?: unknown[];
  turn?: number;
  proposal?: string;
  expects_reply?: boolean;
  converged?: boolean;
}

export type ParseMethod = 'strict' | 'loose' | 'regex' | 'none';

export interface ParseStateResult {
  /** 归一化后的状态；null 表示内容里确实没有 STATE 块。 */
  state: A2AState | null;
  /** 是否成功解析出状态（用于降级策略判断）。 */
  parsed: boolean;
  /** 用了哪级容错，便于观测 LLM 输出质量与容错命中率。 */
  method: ParseMethod;
}

/**
 * 粗提取 STATE 块的 JSON 文本。
 * 容忍：前置寒暄、markdown 代码块包裹、缺失结束标签、多个 STATE 块（取最后一个）。
 *
 * 结束边界用 `(?:\[\/STATE\]|\n(?=\[)|$)`：
 *   - 正常 `[/STATE]` 闭合
 *   - 缺失结束标签时，遇到下一段 `[xxx]` 开头（如 `[SYSTEM]`）或文末收口
 *   - 避免非贪婪 `*?` 在缺闭合时一直吞到文末带出噪音
 */
const STATE_BLOCK_RE = /\[STATE\]([\s\S]*?)(?:\[\/STATE\]|\n(?=\[)|$)/gi;

function stripCodeFence(text: string): string {
  return text
    // ```lang ... ``` （含 json/js 等语言标记）
    .replace(/^\s*`{3,}[a-zA-Z]*\s*\n?/, '')
    .replace(/\n?\s*`{3,}\s*$/, '')
    // ~~~ ... ~~~
    .replace(/^\s*~{3,}.*\n?/, '')
    .replace(/\n?\s*~{3,}\s*$/, '')
    .trim();
}

export function extractStateRaw(content: string): string | null {
  if (!content) return null;
  const matches = [...content.matchAll(STATE_BLOCK_RE)];
  if (matches.length === 0) return null;
  // 多块取最后一个：LLM 常复读上一条 STATE 再写自己的，最后一条才是当前声明。
  const raw = stripCodeFence(matches[matches.length - 1][1]);
  return raw || null;
}

/**
 * 归一化畸形 JSON 后尝试 parse。
 * 修复：中文引号、Python 风格 True/False/None、尾逗号。
 */
function looseJsonParse(raw: string): Record<string, unknown> | null {
  const fixed = raw
    .replace(/[\u201c\u201d]/g, '"')   // “ ” → "
    .replace(/\bTrue\b/g, 'true')
    .replace(/\bFalse\b/g, 'false')
    .replace(/\bNone\b/g, 'null')
    .replace(/,\s*([}\]])/g, '$1');     // 尾逗号
  try {
    const v = JSON.parse(fixed);
    return v && typeof v === 'object' && !Array.isArray(v)
      ? v as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/** 把任意值归一化为 boolean（容忍字符串/数字）。无法判定时返回 undefined。 */
function toBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true', 'yes', '1'].includes(s)) return true;
    if (['false', 'no', '0'].includes(s)) return false;
    return undefined;
  }
  if (typeof v === 'number') return v !== 0;
  return undefined;
}

/**
 * 字段级正则兜底：整体 parse 彻底失败时，直接抽收敛判据所需字段。
 * 即便 JSON 结构损坏，也尽量拿出 converged / expects_reply / agenda 是否为空。
 */
function extractFieldsByRegex(text: string): A2AState | null {
  // 键名容忍可选引号：匹配 "converged" 或 converged（裸字段）
  const getBool = (key: string): boolean | undefined => {
    const m = text.match(new RegExp(`"?${key}"?\\s*:\\s*"?([A-Za-z01]+)"?`, 'm'));
    if (!m) return undefined;
    return /^(true|yes|1|True)$/i.test(m[1]);
  };

  // agenda 是否为空：容忍键名有无引号，匹配 agenda:[] 或 "agenda":[]
  const agendaEmptyMatch = text.match(/"?agenda"?\s*:\s*\[\s*\]/m);
  const agendaHasItem = /"?agenda"?\s*:\s*\[\s*"/.test(text);
  let agenda: unknown[] | undefined;
  if (agendaEmptyMatch) agenda = [];
  else if (agendaHasItem) agenda = ['<non-empty>'];

  const converged = getBool('converged');
  const expectsReply = getBool('expects_reply') ?? getBool('expect_reply');

  // 至少要抽到一个布尔字段才算有意义，否则当没有 STATE
  if (converged === undefined && expectsReply === undefined) return null;
  return { converged, expects_reply: expectsReply, agenda };
}

/**
 * 字段名变体归一化 + 类型宽容。
 * 处理 LLM 把 expects_reply 写成 expect_reply / expectsReply 等情况。
 */
function normalize(raw: Record<string, unknown>): A2AState {
  const agendaRaw = raw.agenda;
  let agenda: unknown[] | undefined;
  if (Array.isArray(agendaRaw)) {
    agenda = agendaRaw.filter(x => x !== null && x !== undefined && x !== '');
  }

  return {
    goal: typeof raw.goal === 'string' ? raw.goal : undefined,
    agenda,
    turn: typeof raw.turn === 'number' ? raw.turn : (typeof raw.turn === 'string' ? Number(raw.turn) || undefined : undefined),
    proposal: typeof raw.proposal === 'string' ? raw.proposal : undefined,
    expects_reply: toBool(raw.expects_reply ?? raw.expect_reply ?? raw.expectsReply ?? raw.expectsreply),
    converged: toBool(raw.converged),
  };
}

/**
 * 从 agent 回复中解析 A2A STATE。入口函数。
 * 调用方应优先使用 result.state 判定收敛，并用 result.method 做观测埋点。
 */
export function parseA2AState(content: string): ParseStateResult {
  const raw = extractStateRaw(content);
  if (!raw) return { state: null, parsed: false, method: 'none' };

  // strict：标准 JSON.parse
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return { state: normalize(v as Record<string, unknown>), parsed: true, method: 'strict' };
    }
  } catch { /* 降级 */ }

  // loose：归一化后 parse
  const loose = looseJsonParse(raw);
  if (loose) return { state: normalize(loose), parsed: true, method: 'loose' };

  // regex：字段级兜底
  const regexState = extractFieldsByRegex(raw);
  if (regexState) return { state: regexState, parsed: true, method: 'regex' };

  // 有 STATE 块但怎么都解析不出来：返回空 state + none，调用方按降级策略处理
  return { state: null, parsed: false, method: 'none' };
}

/**
 * 从回复内容中剥离 STATE 块及其 markdown 包裹，保证访客侧零协议噪音。
 * 与 extractStateRaw 对称：容忍代码块围栏、缺失结束标签。
 * 返回剥离后的干净内容。
 */
export function stripStateBlock(content: string): string {
  if (!content) return '';
  return content
    // 1. [Conversation info ...] 元数据块（agent 误带回，保留原有清理逻辑）
    .replace(/\[Conversation info[^\]]*\][\s\S]*?(```\s*)?/g, '')
    // 2. 带代码块围栏的 STATE 块：```json\n[STATE]...[/STATE]\n```
    .replace(/`{3,}[a-zA-Z]*\s*\n?\s*\[STATE\][\s\S]*?(?:\[\/STATE\]|\n(?=\[)|$)\s*\n?`{3,}/gi, '')
    // 3. 裸 STATE 块（含缺失结束标签的情况）
    .replace(/\[STATE\][\s\S]*?(?:\[\/STATE\]|\n(?=\[)|$)/gi, '')
    // 4. 剥离后残留的孤立 ``` 围栏行
    .replace(/^\s*`{3,}\s*$/gm, '')
    // 5. 压缩剥离后产生的 3+ 连续换行为最多 2 个（保留段落分隔，去除多余空行）
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 提取 A2A 对端可见回复。新版协议优先读取 [FINAL]；旧版未包裹的普通回复继续兼容。
 * 对明显只是在复述 A2A/STATE 控制过程的旧版输出直接丢弃，避免内部策略落库或发给对端。
 */
export function extractA2AVisibleReply(content: string): string {
  if (!content) return '';
  const finalBlocks = [...content.matchAll(/\[FINAL\]([\s\S]*?)\[\/FINAL\]/gi)];
  if (finalBlocks.length) return finalBlocks[finalBlocks.length - 1][1].trim();

  const visible = stripStateBlock(content)
    .replace(/\[\/?FINAL\]/gi, '')
    .trim();
  const protocolNarration =
    /(?:\b(?:peer|counterpart)\b|对端|对方).*(?:\bA2A\b|\bSTATE\b|规则|协议|收敛|边界)/i.test(visible)
    || /(?:按|依照|according to).{0,12}(?:\bA2A\b|\bSTATE\b).{0,12}(?:规则|协议|rule|protocol)/i.test(visible);
  return protocolNarration ? '' : visible;
}
