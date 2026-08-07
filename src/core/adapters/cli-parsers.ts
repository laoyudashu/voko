/**
 * cli-parsers.js — CLI stdout 解析器集
 *
 * 将不同 agent CLI 的 stdout 输出格式统一解析为文本块回调。
 * 每个解析器是一个函数：(line: string, ctx: ParserContext) => void
 *
 * 内置格式：
 *   - stream-json        : claude / cursor --output-format stream-json（Anthropic NDJSON）
 *   - gemini-stream-json : gemini --output-format stream-json
 *   - codex-jsonl        : codex exec --json（OpenAI NDJSON）
 *   - grok-stream-json   : grok --output-format streaming-json
 *   - cline-jsonl         : cline --json（Cline say/run_result JSONL）
 *   - jsonl              : 通用 JSONL（opencode --format json 等）
 *   - raw                : 纯文本，逐行累积
 *   - silent             : 不解析 stdout（fire-and-forget 通知模式）
 *
 * ParserContext：
 *   { text: string[], onText: (chunk: string) => void, onDone: () => void }
 */

// ── stream-json 解析器（claude --output-format stream-json） ──────────

/**
 * Claude Code v2.x stream-json 格式解析器。
 *
 * claude CLI v2.x 的 --output-format stream-json 输出 NDJSON 事件：
 *   stream_event.event.type === 'content_block_delta'
 *     → delta.type === 'text_delta' 时提取 delta.text（流式文本块）
 *   stream_event.event.type === 'message_stop'       → 流结束
 *   result                     → result 字段为最终文本
 *
 * 注意：stream_event 内部有 index 区分不同 content block（如 index=0 思考块、index=1 文本块），
 * 此处只处理 type='text_delta' 的文本块，忽略 thinking_delta。
 */
interface ParserContext {
  text: string[];
  onText: (chunk: string) => void;
  onDone: () => void;
  _streamed?: boolean;
  _lastTurnText?: string;
  _aiderPreamble?: boolean;
  _aiderSawRepoMap?: boolean;
  _aiderReplyStarted?: boolean;
  _aiderThinking?: boolean;
  _zeroclawReplyStarted?: boolean;
  _clineStreamed?: boolean;
  _clineFinalEmitted?: boolean;
}

interface ParserOptions {
  extractField?: string;
  [key: string]: unknown;
}

type LineParser = (line: string, ctx: ParserContext, options?: ParserOptions) => void;

interface CreateParserOptions {
  onText?: (chunk: string) => void;
  onDone?: () => void;
  format?: string;
  parserOpts?: ParserOptions;
}

interface ParserRunner {
  handleLine: (line: string) => void;
  finish: () => void;
  readonly fullText: string;
}

function streamJsonParser(line: string, ctx: ParserContext) {
  let obj;
  try { obj = JSON.parse(line); } catch { return; }
  if (!obj || typeof obj !== 'object') return;
  const type = obj.type;
  if (!type) return;

  // 流式增量（需 --include-partial-messages；Anthropic API content_block_delta）
  if (type === 'stream_event') {
    const ev = obj.event;
    if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
      ctx._streamed = true;
      ctx.onText(ev.delta.text);
    }
    return;
  }

  // claude CLI stream-json 最终结果行：result 字段为完整回复文本
  // （已收到流式增量时 result 与之和一致，跳过避免重复）
  if (type === 'result') {
    if (!ctx._streamed && typeof obj.result === 'string') ctx.onText(obj.result);
    ctx.onDone();
    return;
  }

  // 兜底：无 result 行时，assistant 块标记完成
  if (type === 'assistant') {
    ctx.onDone();
  }
}

// ── jsonl 解析器（Codex CLI / 通用 JSONL） ────────────────────────────

/**
 * 通用 JSONL 解析器。
 *
 * 每行一个 JSON 对象。通过 extractField 指定文本字段路径：
 *   jsonlParser(line, ctx, { extractField: 'text' })
 *   jsonlParser(line, ctx, { extractField: 'content' })
 * 默认提取顶层 text 字段。
 */
function jsonlParser(line: string, ctx: ParserContext, opts: ParserOptions = {}) {
  const field = opts.extractField || 'text';
  let obj;
  try { obj = JSON.parse(line); } catch { return; }
  if (!obj || typeof obj !== 'object') return;

  const value = obj[field];
  if (typeof value === 'string') {
    ctx.onText(value);
  }
}

// ── gemini-stream-json 解析器（gemini --output-format stream-json） ───
//
// Gemini CLI 的 stream-json 输出格式：
//   {"type":"message","role":"assistant","content":"...","delta":true}
//   只提取 assistant 的 message 事件中的 content 字段。

function geminiStreamJsonParser(line: string, ctx: ParserContext) {
  let obj;
  try { obj = JSON.parse(line); } catch { return; }
  if (!obj || typeof obj !== 'object') return;

  // assistant 消息事件（参考 Paperclip gemini-local parse.ts）
  if (obj.type === 'assistant') {
    const msg = obj.message;
    if (msg && Array.isArray(msg.content)) {
      // content 数组：[{type:"output_text"/"text","text":"..."}]
      for (const part of msg.content) {
        if ((part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') {
          ctx.onText(part.text);
        }
      }
    }
    return;
  }

  // message 事件（新版 Gemini CLI v0.38+ schema）
  if (obj.type === 'message' && obj.role === 'assistant') {
    const content = obj.content;
    if (typeof content === 'string') {
      ctx.onText(content);                         // {"type":"message","role":"assistant","content":"..."}
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if ((part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') {
          ctx.onText(part.text);                   // {"type":"message","role":"assistant","content":[{"type":"text","text":"..."}]}
        }
      }
    }
    return;
  }

  // text 事件（旧版 Gemini CLI 兼容）
  if (obj.type === 'text') {
    const parts = obj.parts || (obj.part ? [obj.part] : []);
    for (const p of parts) {
      if (typeof p.text === 'string') ctx.onText(p.text);
    }
    return;
  }

  // result 事件标记完成
  if (obj.type === 'result') {
    ctx.onDone();
  }
}

// ── codex-jsonl 解析器（codex exec --json） ────────────────────────────
//
// Codex CLI 的 --json 输出是 NDJSON ThreadEvent 流：
//   {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
//   {"type":"item.completed","item":{"type":"message","content":[{"type":"output_text","text":"..."}]}}
//
// 提取 AgentMessageItem 的文本（text 字段或 content 数组中的 text）。

function codexJsonlParser(line: string, ctx: ParserContext) {
  let obj;
  try { obj = JSON.parse(line); } catch { return; }
  if (!obj || typeof obj !== 'object') return;

  const item = obj.item;
  if (!item) return;

  // AgentMessageItem / message：提取文本
  if (item.type === 'agent_message' || item.type === 'message') {
    if (typeof item.text === 'string') {
      ctx.onText(item.text);
    } else if (Array.isArray(item.content)) {
      // content 数组：[{type:"output_text",text:"..."}]
      for (const block of item.content) {
        if (typeof block.text === 'string') ctx.onText(block.text);
      }
    }
  }
}

// ── reasonix-stream-json 解析器（reasonix run --output-format stream-json） ─
//
// Reasonix CLI 的 stream-json 输出为 NDJSON 事件流。1.21.0 的真实事件包括：
//   {"kind":"text","text":"流式文本块"}                    （流式增量）
//   {"kind":"message","text":"完整回复"}                  （回合消息）
//   {"type":"result","result":"最终回复","session_id":"..."}
// 旧版本/兼容入口可能使用 type=text/data、type=run_done/result 和 type=error/message，
// 因此解析器同时接受两套字段，且最终结果在已经收到增量时跳过以避免重复。

function reasonixStreamJsonParser(line: string, ctx: ParserContext) {
  let obj;
  try { obj = JSON.parse(line); } catch { return; }
  if (!obj || typeof obj !== 'object') return;
  const kind = obj.kind || obj.type;
  if (!kind) return;

  // 流式文本增量
  if (kind === 'text' && (typeof obj.text === 'string' || typeof obj.data === 'string')) {
    ctx._streamed = true;
    ctx.onText(typeof obj.text === 'string' ? obj.text : obj.data);
    return;
  }

  // 回合消息是无增量输出时的备用正文；正常情况下增量已经包含同一文本。
  if (kind === 'message' && !ctx._streamed && typeof obj.text === 'string') {
    ctx.onText(obj.text);
    return;
  }

  // 最终完成：result 字段为完整回复（若已流式累积则跳过避免重复）
  if (kind === 'run_done' || kind === 'result') {
    if (!ctx._streamed) {
      const result = obj.result;
      if (typeof result === 'string') {
        ctx.onText(result);
      } else if (result && typeof result === 'object' && typeof result.text === 'string') {
        ctx.onText(result.text);
      }
    }
    ctx.onDone();
    return;
  }

  // 错误事件
  if (kind === 'error' && typeof obj.message === 'string') {
    ctx.onText(`[reasonix error] ${obj.message}`);
    ctx.onDone();
  }
}

// ── grok-stream-json 解析器（grok --output-format streaming-json） ─────
//
// Grok CLI 的 streaming-json 输出（参考 Paperclip grok-local parse.ts）：
//   {"type":"text","data":"流式文本块"}
//   {"type":"thought","data":"思考内容"}
//   {"type":"end","sessionId":"...","stopReason":"..."}
//   {"type":"error","message":"..."}
//
// 提取 text 事件的 data 字段作为流式文本。

function grokStreamJsonParser(line: string, ctx: ParserContext) {
  let obj;
  try { obj = JSON.parse(line); } catch { return; }
  if (!obj || typeof obj !== 'object') return;

  // text 事件：流式文本增量
  if (obj.type === 'text' && typeof obj.data === 'string') {
    ctx.onText(obj.data);
  }
  // end 事件：流结束
  if (obj.type === 'end') {
    ctx.onDone();
  }
}

// ── pi-jsonl 解析器（pi -p --mode json） ───────────────────────────────

// ... (pi parser above) ...

// ── opencode-json 解析器（opencode run --format json） ─────────────────
//
// OpenCode 的 --format json 输出（参考 Paperclip opencode-local parse.ts）：
//   {"type":"text","part":{"text":"流式文本块"}}
//   {"type":"step_finish","part":{"tokens":{"input":N,"output":N}}}
//   {"type":"tool_use","part":{"state":{"status":"error"}}}
//   {"type":"error","error":"..."}
//
// 提取 text 事件的 part.text 嵌套字段。

function opencodeJsonParser(line: string, ctx: ParserContext) {
  let obj;
  try { obj = JSON.parse(line); } catch { return; }
  if (!obj || typeof obj !== 'object') return;

  // text 事件：提取 part.text（流式增量）
  if (obj.type === 'text') {
    const part = obj.part;
    if (part && typeof part.text === 'string') {
      ctx.onText(part.text);
    }
    return;
  }

  // error 事件
  if (obj.type === 'error') {
    const msg = obj.error || obj.message;
    if (typeof msg === 'string') {
      ctx.onText('[OpenCode Error] ' + msg + '\n');
    }
    return;
  }
}
//
// Pi Coding Agent (@mariozechner/pi-coding-agent) 的 --mode json 输出格式：
//   {"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"..."}}
//   {"type":"turn_end","message":{"role":"assistant","content":"完整回复"}}
//   {"type":"agent_end","messages":[...,{"role":"assistant","content":"..."}]}
//
// 提取 text_delta 流式增量 + turn_end/agent_end 的最终消息。

function piJsonlParser(line: string, ctx: ParserContext) {
  let obj;
  try { obj = JSON.parse(line); } catch { return; }
  if (!obj || typeof obj !== 'object') return;

  const t = obj.type;

  // 流式文本增量
  if (t === 'message_update') {
    const ev = obj.assistantMessageEvent;
    if (ev?.type === 'text_delta' && typeof ev.delta === 'string') {
      ctx.onText(ev.delta);
      ctx._streamed = true;  // 标记已流式输出，防 agent_end 再追加全文致翻倍
    }
    return;
  }

  // turn 结束：提取最终消息文本
  if (t === 'turn_end') {
    const msg = obj.message;
    if (msg) {
      const content = msg.content;
      if (typeof content === 'string') {
        ctx._lastTurnText = content;
      } else if (Array.isArray(content)) {
        ctx._lastTurnText = content.filter(c => c.type === 'text' && c.text).map(c => c.text).join('');
      }
    }
    return;
  }

  // agent 结束：提取最终消息
  if (t === 'agent_end') {
    const msgs = obj.messages;
    if (Array.isArray(msgs) && msgs.length > 0) {
      const last = msgs[msgs.length - 1];
      if (last?.role === 'assistant') {
        const content = last.content;
        if (typeof content === 'string') {
          ctx._lastTurnText = content;
        } else if (Array.isArray(content)) {
          ctx._lastTurnText = content.filter(c => c.type === 'text' && c.text).map(c => c.text).join('');
        }
      }
    }
    // 输出最终文本（如果流式增量未捕获到足够内容）
    if (ctx._lastTurnText && !ctx._streamed) {
      ctx.onText(ctx._lastTurnText);
    }
    ctx.onDone();
    return;
  }
}

// ── Cursor 流前缀标准化 ───────────────────────────────────────────────
//
// Cursor CLI 输出可能有 stdout:/stderr: 前缀，需要先剥离再解析。
// 参考 Paperclip shared/stream.ts normalizeCursorStreamLine()。

function _stripCursorPrefix(line: string): string {
  const m = line.match(/^(stdout|stderr):(.*)/);
  return m ? m[2] : line;
}

function cursorStreamJsonParser(line: string, ctx: ParserContext) {
  streamJsonParser(_stripCursorPrefix(line), ctx);
}

// ── raw 解析器（纯文本 fallback） ─────────────────────────────────────

/**
 * 纯文本解析器：每行作为一个文本块累积。
 * 行尾换行符已由 spawner 去除，此处补回。
 */
function rawParser(line: string, ctx: ParserContext) {
  if (line) ctx.onText(line + '\n');
}

function zeroclawInteractiveParser(line: string, ctx: ParserContext) {
  const plain = line
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .trimEnd();
  if (!plain || /ZeroClaw Interactive Mode/i.test(plain) || /^Type \/help/i.test(plain)) return;
  const promptLine = plain.match(/^\s*>\s?(.*)$/);
  if (promptLine) {
    const content = promptLine[1].trimEnd();
    if (!content) return;
    ctx._zeroclawReplyStarted = true;
    ctx.onText(content + '\n');
    return;
  }
  if (ctx._zeroclawReplyStarted) ctx.onText(plain + '\n');
}

// ── Aider 单次消息输出解析器 ──────────────────────────────────────────
//
// aider --message --no-stream 会在正文前后打印版本、模型和 token/cost 信息。
// 这些运行日志不能作为 Agent 回复发送给访客。
function aiderOutputParser(line: string, ctx: ParserContext) {
  if (ctx._aiderPreamble === undefined) ctx._aiderPreamble = true;
  const trimmed = line.trim();

  if (ctx._aiderPreamble) {
    if (/^Repo-map:/i.test(trimmed)) ctx._aiderSawRepoMap = true;
    if (ctx._aiderSawRepoMap && !trimmed) ctx._aiderPreamble = false;
    return;
  }

  if (/^►\s+\*\*THINKING\*\*$/i.test(trimmed)) {
    ctx._aiderThinking = true;
    return;
  }
  if (/^►\s+\*\*ANSWER\*\*$/i.test(trimmed)) {
    ctx._aiderThinking = false;
    ctx._aiderReplyStarted = false;
    return;
  }
  if (ctx._aiderThinking || /^-+$/.test(trimmed)) return;
  if (/^(Tokens:|Cost:)/i.test(trimmed) || /^\$[\d.]+\s+session\.$/i.test(trimmed)) return;
  if (!trimmed && !ctx._aiderReplyStarted) return;
  ctx._aiderReplyStarted = true;
  ctx.onText(line + '\n');
}

function kiroOutputParser(line: string, ctx: ParserContext) {
  const plain = line
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/^\s*>\s*/, '')
    .trimEnd();
  if (!plain.trim() || /^\s*▸\s*Credits:/i.test(plain)) return;
  ctx.onText(plain + '\n');
}

function clineJsonlParser(line: string, ctx: ParserContext) {
  let obj;
  try { obj = JSON.parse(line); } catch { return; }
  if (!obj || typeof obj !== 'object') return;

  // Cline's documented --json schema emits say/ask messages.
  if (obj.type === 'say' && typeof obj.text === 'string') {
    if (obj.say && obj.say !== 'text') return;
    if (!obj.text) return;
    if (obj.partial === true) {
      ctx._clineStreamed = true;
      ctx.onText(obj.text);
      return;
    }
    if (!ctx._clineStreamed && !ctx._clineFinalEmitted) {
      ctx._clineFinalEmitted = true;
      ctx.onText(obj.text);
    }
    return;
  }

  // Recent Cline CLI builds wrap lifecycle events and publish the final
  // assistant text on run_result. Ignore agent_event/tool status chatter and
  // use the final aggregate once, avoiding duplication with streamed output.
  if (obj.type === 'run_result' && obj.finishReason !== 'error' && typeof obj.text === 'string' && obj.text) {
    if (!ctx._clineStreamed && !ctx._clineFinalEmitted) {
      ctx._clineFinalEmitted = true;
      ctx.onText(obj.text);
    }
  }
}

// ── silent 解析器（fire-and-forget 通知模式） ─────────────────────────

/**
 * 静默模式：不解析 stdout，直接标记完成。
 * 用于 openclaw-cli / hermes-cli 等只通知不等待回复的场景。
 */
function silentParser(_line: string, _ctx: ParserContext) {
  // 所有行忽略，由调用方在进程退出时手动调用 ctx.onDone()
}

// ── 解析器运行器 ─────────────────────────────────────────────────────

/**
 * 创建解析上下文，对每一行调用 parser，完成后通知。
 *
 * @param {object}   options
 * @param {function} options.onText  - (chunk: string) => void  每段文本回调
 * @param {function} options.onDone - () => void                解析完成回调
 * @param {string}   [options.format='raw']  - 解析器名
 * @param {object}   [options.parserOpts]    - 传给解析器的额外选项
 * @returns {{ handleLine: (line:string) => void, finish: () => void }}
 */
function createParser({
  onText,
  onDone,
  format = 'raw',
  parserOpts = {},
}: CreateParserOptions): ParserRunner {
  const parsers: Record<string, LineParser> = {
    'stream-json': streamJsonParser,
    'cursor-stream-json': cursorStreamJsonParser,
    'gemini-stream-json': geminiStreamJsonParser,
    'codex-jsonl': codexJsonlParser,
    'reasonix-stream-json': reasonixStreamJsonParser,
    'grok-stream-json': grokStreamJsonParser,
    'pi-jsonl': piJsonlParser,
    'opencode-json': opencodeJsonParser,
    jsonl: jsonlParser,
    raw: rawParser,
    'zeroclaw-interactive': zeroclawInteractiveParser,
    'aider-output': aiderOutputParser,
    'kiro-output': kiroOutputParser,
    'cline-jsonl': clineJsonlParser,
    silent: silentParser,
  };
  const parser = parsers[format] || rawParser;

  const ctx: ParserContext = {
    text: [],
    onText: (chunk: string) => {
      ctx.text.push(chunk);
      if (onText) onText(chunk);
    },
    onDone: () => {
      if (onDone) onDone();
    },
  };

  return {
    /** 处理一行 stdout */
    handleLine(line: string) {
      parser(line, ctx, parserOpts);
    },
    /** 手动标记完成（silent 模式用） */
    finish() {
      ctx.onDone();
    },
    /** 累积的完整文本 */
    get fullText() { return ctx.text.join(''); },
  };
}

module.exports = {
  streamJsonParser,
  cursorStreamJsonParser,
  geminiStreamJsonParser,
  codexJsonlParser,
  grokStreamJsonParser,
  piJsonlParser,
  opencodeJsonParser,
  jsonlParser,
  rawParser,
  zeroclawInteractiveParser,
  aiderOutputParser,
  kiroOutputParser,
  clineJsonlParser,
  silentParser,
  createParser,
};
