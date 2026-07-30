/**
 * transcript-types.js — 统一流式 TranscriptEntry 类型
 *
 * 借鉴 Paperclip TranscriptEntry 设计，将不同 provider（ACP / CLI / WS / HTTP）
 * 的流式输出统一为 VokoTranscriptEntry 类型，供调度层、IPC 层、控制台消费。
 *
 * 条目类型：
 *   thinking      — agent 思考过程（内部推理，可选展示）
 *   text          — 回复文本块（流式增量）
 *   tool_call     — agent 请求调用工具
 *   tool_result   — 工具执行结果
 *   error         — 执行错误
 *   complete      — turn 完成（含最终文本 + 用量统计）
 *
 * 用法：
 *   const entry = VokoTranscriptEntry.text('Hello');
 *   bus.emit('agent.run.log', entry);
 */

// ── 类型常量 ─────────────────────────────────────────────────────────

const EntryType = Object.freeze({
  THINKING: 'thinking',
  TEXT: 'text',
  TOOL_CALL: 'tool_call',
  TOOL_RESULT: 'tool_result',
  ERROR: 'error',
  COMPLETE: 'complete',
});
export {};

type EntryTypeValue = typeof EntryType[keyof typeof EntryType];

interface TranscriptError {
  code: string;
  message: string;
}

interface TranscriptOptions {
  agentId?: string;
  visitorId?: string;
  sessionKey?: string;
  text?: string;
  toolCall?: Record<string, unknown>;
  toolResult?: Record<string, unknown>;
  error?: TranscriptError;
  usage?: { inputTokens: number; outputTokens: number };
  done?: boolean;
  seq?: number;
  timestamp?: number;
}

interface TranscriptEntry {
  type: EntryTypeValue;
  agentId: string;
  visitorId: string;
  sessionKey: string;
  seq: number;
  timestamp: number;
  done: boolean;
  text?: string;
  toolCall?: Record<string, unknown>;
  toolResult?: Record<string, unknown>;
  error?: TranscriptError;
  usage?: { inputTokens: number; outputTokens: number };
}

// ── 工厂函数 ─────────────────────────────────────────────────────────

/**
 * 创建 VokoTranscriptEntry。
 *
 * @param {string}   type      - 条目类型（EntryType 常量）
 * @param {object}   [opts]
 * @param {string}   [opts.agentId]
 * @param {string}   [opts.visitorId]
 * @param {string}   [opts.sessionKey]
 * @param {string}   [opts.text]          - 文本内容（thinking/text 类型用）
 * @param {object}   [opts.toolCall]      - 工具调用信息（tool_call 类型用）
 * @param {object}   [opts.toolResult]    - 工具结果（tool_result 类型用）
 * @param {object}   [opts.error]         - { code, message }（error 类型用）
 * @param {object}   [opts.usage]         - { inputTokens, outputTokens }（complete 类型用）
 * @param {boolean}  [opts.done=false]    - 是否终态（complete 默认为 true）
 * @param {number}   [opts.seq]           - 序号（用于排序）
 * @param {number}   [opts.timestamp]     - 时间戳
 * @returns {VokoTranscriptEntry}
 */
function createEntry(type: EntryTypeValue, opts: TranscriptOptions = {}): TranscriptEntry {
  const entry: TranscriptEntry = {
    type,
    agentId: opts.agentId || '',
    visitorId: opts.visitorId || '',
    sessionKey: opts.sessionKey || '',
    seq: opts.seq ?? 0,
    timestamp: opts.timestamp ?? Date.now(),
    done: opts.done ?? (type === EntryType.COMPLETE),
  };

  switch (type) {
    case EntryType.THINKING:
      entry.text = opts.text || '';
      break;
    case EntryType.TEXT:
      entry.text = opts.text || '';
      break;
    case EntryType.TOOL_CALL:
      entry.toolCall = opts.toolCall || { name: '', arguments: {} };
      break;
    case EntryType.TOOL_RESULT:
      entry.toolResult = opts.toolResult || { content: '', isError: false };
      break;
    case EntryType.ERROR:
      entry.error = opts.error || { code: 'unknown', message: '' };
      entry.text = opts.text || '';
      break;
    case EntryType.COMPLETE:
      entry.text = opts.text || '';
      entry.usage = opts.usage || { inputTokens: 0, outputTokens: 0 };
      if (opts.error) entry.error = opts.error;
      break;
  }

  return entry;
}

// ── 便捷工厂 ─────────────────────────────────────────────────────────

const VokoTranscriptEntry = {
  /** 思考过程块 */
  thinking(text: string, opts: TranscriptOptions = {}) { return createEntry(EntryType.THINKING, { ...opts, text }); },

  /** 文本回复块（流式增量） */
  text(text: string, opts: TranscriptOptions = {}) { return createEntry(EntryType.TEXT, { ...opts, text }); },

  /** 工具调用请求 */
  toolCall(toolCall: Record<string, unknown>, opts: TranscriptOptions = {}) { return createEntry(EntryType.TOOL_CALL, { ...opts, toolCall }); },

  /** 工具执行结果 */
  toolResult(toolResult: Record<string, unknown>, opts: TranscriptOptions = {}) { return createEntry(EntryType.TOOL_RESULT, { ...opts, toolResult }); },

  /** 错误 */
  error(error: TranscriptError, opts: TranscriptOptions = {}) { return createEntry(EntryType.ERROR, { ...opts, error }); },

  /** turn 完成 */
  complete(text: string, opts: TranscriptOptions = {}) { return createEntry(EntryType.COMPLETE, { ...opts, text }); },
};

// ── 工具函数 ─────────────────────────────────────────────────────────

/** 判断是否为终态条目 */
function isTerminal(entry: Partial<TranscriptEntry> | null | undefined): boolean {
  return entry?.done === true || entry?.type === EntryType.COMPLETE || entry?.type === EntryType.ERROR;
}

/** 从 agent.reply 事件构建 text 或 complete 条目 */
function fromAgentReply(reply: {
  done?: boolean;
  content?: string;
  agentId?: string;
  visitorId?: string;
  sessionKey?: string;
  error?: TranscriptError;
}): TranscriptEntry {
  if (reply.done) {
    return VokoTranscriptEntry.complete(reply.content || '', {
      agentId: reply.agentId,
      visitorId: reply.visitorId,
      sessionKey: reply.sessionKey,
      error: reply.error ? { code: reply.error.code, message: reply.error.message } : undefined,
    });
  }
  return VokoTranscriptEntry.text(reply.content || '', {
    agentId: reply.agentId,
    visitorId: reply.visitorId,
    sessionKey: reply.sessionKey,
  });
}

/** 序列化为普通对象（JSON safe） */
function toPlainObject(entry: unknown): unknown {
  if (!entry || typeof entry !== 'object') return entry;
  const typedEntry = entry as Partial<TranscriptEntry>;
  const { type, agentId, visitorId, sessionKey, seq, timestamp, done, text, toolCall, toolResult, error, usage } = typedEntry;
  return { type, agentId, visitorId, sessionKey, seq, timestamp, done, text, toolCall, toolResult, error, usage };
}

module.exports = {
  EntryType,
  VokoTranscriptEntry,
  createEntry,
  isTerminal,
  fromAgentReply,
  toPlainObject,
};
