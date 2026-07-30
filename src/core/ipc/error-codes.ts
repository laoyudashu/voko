/**
 * error-codes.js — VOKO 统一错误码
 *
 * 覆盖所有 provider（ACP / CLI / WS / HTTP）的异常场景。
 * 所有 provider 和 IPC 层的错误应统一使用此处定义的 code。
 *
 * message 现由 i18n 字典渲染（locales/{zh,en}/errors.json），按 locale 本地化：
 *   - 未传 message → 按 code + locale 查字典（meta 同时作为插值参数）
 *   - 传了 message → 显式覆盖（向后兼容历史调用方）
 *
 * 用法：
 *   const err = VokoError.spawnFailed('openclaw not found');   // 显式覆盖
 *   → { code: 'spawn_failed', message: 'openclaw not found' }
 *   const err = VokoError.nonzeroExit(2);                       // 走字典
 *   → { code: 'nonzero_exit', message: '进程退出 code=2' }
 */

// ── 错误码常量 ───────────────────────────────────────────────────────

const ErrorCode = Object.freeze({
  /** 子进程 spawn 失败（CLI not found / permission denied） */
  SPAWN_FAILED: 'spawn_failed',

  /** 进程执行超时 */
  TIMEOUT: 'timeout',

  /** 操作被取消（用户取消 / 系统 shutdown） */
  CANCELLED: 'cancelled',

  /** 子进程非零退出 */
  NONZERO_EXIT: 'nonzero_exit',

  /** stdout 输出解析失败 */
  OUTPUT_PARSE_ERROR: 'output_parse_error',

  /** ACP session 无效或已过期 */
  SESSION_INVALID: 'session_invalid',

  /** 远程 endpoint 不可达 */
  UNREACHABLE: 'unreachable',

  /** ACP 协议不可用（agent 不支持 / 初始化失败） */
  ACP_UNAVAILABLE: 'acp_unavailable',

  /** ACP prompt 执行失败 */
  ACP_PROMPT_FAILED: 'acp_prompt_failed',

  /** CLI fallback 执行失败 */
  CLI_FALLBACK_FAILED: 'cli_fallback_failed',

  /** 参数不完整 */
  INVALID_PARAMS: 'invalid_params',

  /** provider 内部未知错误 */
  UNKNOWN: 'unknown',
});

// ── 错误对象工厂 ──────────────────────────────────────────────────────

const { t, getLocale } = require('../i18n');
export {};

type ErrorMeta = Record<string, unknown>;
type ErrorCodeValue = typeof ErrorCode[keyof typeof ErrorCode];

interface VokoErrorValue {
  code: string;
  message: string;
  meta?: ErrorMeta;
}

/**
 * 创建 VokoError 对象。
 *
 * @param {string} code     - ErrorCode 常量（同时作为 i18n key 后缀：'errors.' + code）
 * @param {string} [message] - 显式消息；省略/空则按 code 查 i18n 字典
 * @param {object} [meta]   - 额外元数据（也作为字典插值参数，如 {exitCode}）
 * @param {string} [locale] - 覆盖 locale；省略则用进程默认
 * @returns {{ code: string, message: string, meta?: object }}
 */
function vokoError(
  code: ErrorCodeValue | string,
  message?: string | null,
  meta?: ErrorMeta,
  locale?: string,
): VokoErrorValue {
  const err: VokoErrorValue = { code, message: '' };
  if (message) {
    err.message = message;                          // 调用方显式覆盖
  } else {
    err.message = t('errors.' + code, meta, locale || getLocale());
  }
  if (meta) err.meta = meta;
  return err;
}

// ── 便捷工厂 ─────────────────────────────────────────────────────────

const VokoError = {
  spawnFailed(msg?: string, meta?: ErrorMeta) { return vokoError(ErrorCode.SPAWN_FAILED, msg, meta); },
  timeout(msg?: string, meta?: ErrorMeta) { return vokoError(ErrorCode.TIMEOUT, msg, meta); },
  cancelled(msg?: string, meta?: ErrorMeta) { return vokoError(ErrorCode.CANCELLED, msg, meta); },
  // 不再硬编码中文，交由字典 errors.nonzero_exit（用 meta.exitCode 插值）
  nonzeroExit(code: number, meta?: ErrorMeta) { return vokoError(ErrorCode.NONZERO_EXIT, null, { ...meta, exitCode: code }); },
  outputParseError(msg?: string, meta?: ErrorMeta) { return vokoError(ErrorCode.OUTPUT_PARSE_ERROR, msg, meta); },
  sessionInvalid(msg?: string, meta?: ErrorMeta) { return vokoError(ErrorCode.SESSION_INVALID, msg, meta); },
  unreachable(msg?: string, meta?: ErrorMeta) { return vokoError(ErrorCode.UNREACHABLE, msg, meta); },
  acpUnavailable(msg?: string, meta?: ErrorMeta) { return vokoError(ErrorCode.ACP_UNAVAILABLE, msg, meta); },
  acpPromptFailed(msg?: string, meta?: ErrorMeta) { return vokoError(ErrorCode.ACP_PROMPT_FAILED, msg, meta); },
  cliFallbackFailed(msg?: string, meta?: ErrorMeta) { return vokoError(ErrorCode.CLI_FALLBACK_FAILED, msg, meta); },
  invalidParams(msg?: string, meta?: ErrorMeta) { return vokoError(ErrorCode.INVALID_PARAMS, msg, meta); },
  // msg 可选：传了用 msg（兼容旧调用），没传走字典 errors.unknown
  unknown(msg?: string, meta?: ErrorMeta) { return vokoError(ErrorCode.UNKNOWN, msg, meta); },

  /** 从 Error 实例或字符串创建 */
  from(err: unknown, defaultCode: ErrorCodeValue = ErrorCode.UNKNOWN): VokoErrorValue {
    const candidate = err as Partial<VokoErrorValue> | null;
    if (candidate && typeof candidate === 'object' && candidate.code
      && Object.values(ErrorCode).includes(candidate.code as ErrorCodeValue)) {
      return candidate as VokoErrorValue; // 已经是 VokoError
    }
    const msg = candidate?.message || String(err || '');
    return vokoError(defaultCode, msg);
  },
};

module.exports = { ErrorCode, VokoError, vokoError };
