const ANSI_ESCAPE = /\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]/g;
const REASONING_TAG = '(?:REASONING_SCRATCHPAD|think|thinking|reasoning|thought)';
const REASONING_BOX_TOP = /^[\t ]*[┌╭][─━-]*[\t ]*(?:Reasoning|Thinking|思考|推理)[\t ]*[─━-]*[┐╮]?[\t ]*$/im;
const REASONING_BOX_BOTTOM = /^[\t ]*[└╰][─━-]+[┘╯]?[\t ]*$/m;

export interface ProviderOutputBoundaryResult {
  content: string;
  rejected: boolean;
  reason?: 'reasoning_only' | 'unterminated_reasoning_block';
}

/**
 * Remove explicit provider reasoning protocol from a completed, user-facing
 * reply. Natural prose that merely contains words such as "reasoning" is left
 * untouched; only tagged blocks, CLI reasoning boxes and [thinking] preview
 * records are protocol artifacts.
 */
export function sanitizeFinalProviderReply(content: unknown): ProviderOutputBoundaryResult {
  const original = typeof content === 'string' ? content : String(content ?? '');
  let visible = original.replace(ANSI_ESCAPE, '');

  // Reasoning models sometimes leak XML scratchpads into their nominal text
  // field. Closed blocks are unambiguous and may appear before or after text.
  const closedTag = new RegExp(
    `(^|\\n)[\\t ]*<(${REASONING_TAG})(?:\\s[^>]*)?>[\\s\\S]*?<\\/\\2>[\\t ]*(?=\\n|$)`,
    'gi',
  );
  visible = visible.replace(closedTag, '$1');

  // Hermes and similar terminal UIs render reasoning in a Unicode box. Strip
  // complete boxes, but reject an unterminated box: there is no reliable way
  // to distinguish the final answer from the reasoning tail in that format.
  for (;;) {
    const top = REASONING_BOX_TOP.exec(visible);
    if (!top || top.index === undefined) break;
    const afterTop = top.index + top[0].length;
    const tail = visible.slice(afterTop);
    const bottom = REASONING_BOX_BOTTOM.exec(tail);
    if (!bottom || bottom.index === undefined) {
      return { content: '', rejected: true, reason: 'unterminated_reasoning_block' };
    }
    visible = visible.slice(0, top.index)
      + tail.slice(bottom.index + bottom[0].length);
  }

  // Verbose CLIs can emit a multi-line compact preview without an ending
  // marker. Do not guess where its final answer starts.
  if (/^[\t ]*\[(?:thinking|reasoning)\][\t ]+/im.test(visible)) {
    return { content: '', rejected: true, reason: 'unterminated_reasoning_block' };
  }

  // An unterminated XML scratchpad cannot be separated from a later answer.
  const openTag = new RegExp(`(^|\\n)[\\t ]*<${REASONING_TAG}(?:\\s[^>]*)?>`, 'i');
  if (openTag.test(visible)) {
    return { content: '', rejected: true, reason: 'unterminated_reasoning_block' };
  }

  const cleaned = visible.trim();
  if (!cleaned && original.trim()) {
    return { content: '', rejected: true, reason: 'reasoning_only' };
  }
  return { content: cleaned, rejected: false };
}
