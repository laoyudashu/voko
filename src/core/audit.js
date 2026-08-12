/**
 * Message audit engine. Deterministic checks always run first; optional model
 * assistance is only allowed to review an `uncertain` result.
 */

const MAX_RULE_PATTERN_LENGTH = 512;

function normalizeAuditText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/[\u00A0\t\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function luhnValid(value) {
  const digits = String(value || '').replace(/[ -]/g, '');
  if (!/^\d{12,19}$/.test(digits) || /^(\d)\1+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = Number(digits[i]);
    if (double) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function isValidChineseId(value) {
  const id = String(value || '').toUpperCase();
  if (!/^\d{17}[\dX]$/.test(id) || /^(\d)\1{16}[\dX]$/.test(id)) return false;
  const date = id.slice(6, 14);
  const parsed = new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10).replace(/-/g, '') !== date) return false;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checks = '10X98765432';
  const sum = id.slice(0, 17).split('').reduce((total, digit, index) => total + Number(digit) * weights[index], 0);
  return checks[sum % 11] === id[17];
}

function looksLikePlaceholder(value) {
  return /(?:example|sample|placeholder|your[-_ ]?(?:key|token)|xxx+|\*{3,}|<[^>]+>|测试|示例|占位)/i.test(value);
}

const SECRET_PATTERNS = [
  { code: 'openai_api_key', re: /\bsk-(?:proj-|svcacct-)?[a-z0-9_-]{20,}\b/ig },
  { code: 'anthropic_api_key', re: /\bsk-ant-[a-z0-9_-]{20,}\b/ig },
  { code: 'github_token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[a-z0-9]{20,}\b/ig },
  { code: 'aws_access_key', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { code: 'jwt', re: /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/g },
  { code: 'bearer_token', re: /\bauthorization\s*:\s*bearer\s+[a-z0-9._~+\/-]{16,}/ig },
  { code: 'private_key', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { code: 'credential_url', re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s/:]+:[^\s/@]+@/ig },
];

function deterministicSignals(message, direction) {
  const raw = String(message || '');
  if (Buffer.byteLength(raw, 'utf8') > 128 * 1024) {
    return { verdict: 'deny', action: 'hard_deny', source: 'validator', reasonCode: 'message_too_large', category: 'message_structure' };
  }
  const normalized = normalizeAuditText(raw);
  if (!normalized) return null;

  if (direction === 'outbound') {
    for (const item of SECRET_PATTERNS) {
      item.re.lastIndex = 0;
      const match = item.re.exec(raw);
      if (match && !looksLikePlaceholder(match[0])) {
        return { verdict: 'deny', action: 'hard_deny', source: 'validator', reasonCode: item.code, category: 'credential_exposure' };
      }
    }
    const numberCandidates = raw.match(/\b(?:\d[ -]?){12,19}\b/g) || [];
    if (numberCandidates.some(luhnValid)) {
      return { verdict: 'deny', action: 'hard_deny', source: 'validator', reasonCode: 'payment_card', category: 'pii_exposure' };
    }
    const idCandidates = raw.match(/\b\d{17}[\dXx]\b/g) || [];
    if (idCandidates.some(isValidChineseId)) {
      return { verdict: 'deny', action: 'hard_deny', source: 'validator', reasonCode: 'cn_identity_number', category: 'pii_exposure' };
    }
  }

  const hardInjection = [
    /(?:ignore|disregard|override|forget) (?:all |any )?(?:previous|prior)(?: system| developer)? (?:instructions?|rules?|prompts?)/i,
    /(?:ignore|disregard|override|forget) (?:the )?(?:system|developer) (?:instructions?|rules?|prompts?)/i,
    /(?:忽略|无视|覆盖|忘记|删除).{0,12}(?:之前|以上|系统|开发者).{0,8}(?:指令|规则|提示词|设定)/,
    /(?:reveal|print|dump|show).{0,24}(?:system|developer) prompt/i,
    /(?:输出|泄露|打印|展示).{0,16}(?:系统|开发者).{0,8}(?:提示词|指令)/,
  ];
  if (direction === 'inbound' && hardInjection.some((pattern) => pattern.test(normalized))) {
    return { verdict: 'deny', action: 'hard_deny', source: 'builtin', reasonCode: 'explicit_prompt_injection', category: 'prompt_injection' };
  }

  const roleForgery = /(?:<\|(?:system|assistant|tool)[^>]*\|>|<\/?system>|\[tool[_ -]?result\]|\btool[_ -]?result\s*:)/i;
  if (direction === 'inbound' && roleForgery.test(raw)) {
    return { verdict: 'deny', action: 'hard_deny', source: 'builtin', reasonCode: 'role_or_tool_forgery', category: 'role_or_tool_forgery' };
  }

  const weakSignals = [
    /(?:base64|hex|十六进制|解码).{0,30}(?:指令|instruction|prompt|执行)/i,
    /(?:upload|send|post|上传|发送).{0,40}(?:key|token|password|secret|凭证|密钥|密码)/i,
    /(?:read|cat|type|读取|打开).{0,30}(?:\.ssh|\.env|credentials|密钥|凭证)/i,
    /(?:bypass|jailbreak|绕过).{0,30}(?:safety|policy|审核|安全|限制)/i,
  ];
  if (weakSignals.some((pattern) => pattern.test(normalized))) {
    return { verdict: 'uncertain', action: 'soft_deny', source: 'builtin', reasonCode: 'suspicious_semantic_combination', category: 'prompt_injection' };
  }
  return null;
}

function safeRuleMatch(rule, raw, normalized) {
  const keyword = String(rule.keyword || '');
  if (!keyword) return false;
  if (keyword.startsWith('/') && keyword.endsWith('/') && keyword.length > 2) {
    const pattern = keyword.slice(1, -1);
    if (pattern.length > MAX_RULE_PATTERN_LENGTH) return false;
    // Reject the most common catastrophic nested-quantifier forms. This keeps
    // user rules compatible without allowing an unbounded regex workload.
    if (/\([^)]*\)[+*{]/.test(pattern) || /\\[1-9]/.test(pattern) || /\(\?[=!<]/.test(pattern)) return false;
    try { return new RegExp(pattern, 'iu').test(raw); } catch (_) { return false; }
  }
  return normalized.includes(normalizeAuditText(keyword));
}

function checkAuditRules(message, direction, db) {
  const raw = typeof message === 'string' ? message : String(message || '');
  const empty = { verdict: 'allow', action: null, source: 'fallback', reasonCode: 'empty', matchedRule: null, matchedKeyword: null };
  if (!raw.trim()) return empty;
  const normalized = normalizeAuditText(raw);
  let rules = [];
  try {
    const statement = db?.prepare?.('SELECT * FROM audit_rules WHERE direction = ?');
    if (typeof statement?.all === 'function') rules = statement.all(direction);
  } catch (_) { rules = []; }
  const matched = rules.filter((rule) => safeRuleMatch(rule, raw, normalized));
  const customHard = matched.find((rule) => !rule.is_default && rule.action === 'hard_deny');
  const customAllow = matched.find((rule) => !rule.is_default && rule.action === 'allow');
  const builtinHard = matched.find((rule) => rule.is_default && rule.action === 'hard_deny');
  const soft = matched.find((rule) => rule.action === 'soft_deny');
  const signal = deterministicSignals(raw, direction);
  // Owner allow rules may create content exceptions, but cannot override a
  // validated credential or PII disclosure.
  if (customHard) return { verdict: 'deny', action: 'hard_deny', source: 'custom',
    reasonCode: `rule:${customHard.id}`, matchedRule: customHard, matchedKeyword: customHard.keyword };
  if (signal?.verdict === 'deny' && ['credential_exposure', 'pii_exposure', 'message_structure'].includes(signal.category)) {
    return { ...signal, matchedRule: null, matchedKeyword: signal.reasonCode };
  }
  const selected = customAllow || builtinHard || soft || null;
  if (selected) {
    const verdict = selected.action === 'hard_deny' ? 'deny' : selected.action === 'soft_deny' ? 'uncertain' : 'allow';
    return { verdict, action: selected.action, source: selected.is_default ? 'builtin' : 'custom',
      reasonCode: `rule:${selected.id}`, matchedRule: selected, matchedKeyword: selected.keyword };
  }
  if (signal) return { ...signal, matchedRule: null, matchedKeyword: signal.reasonCode };
  return { verdict: 'allow', action: null, source: 'fallback', reasonCode: 'no_risk_signal', matchedRule: null, matchedKeyword: null };
}

function substitutePromptVariables(prompt, vars, db) {
  if (!prompt) return prompt;
  let ownerEmail = '';
  if (vars.agentId) {
    const row = db.prepare('SELECT owner_email FROM agents WHERE agent_id = ?').get(vars.agentId);
    if (row?.owner_email) ownerEmail = row.owner_email;
  }
  return String(prompt)
    .replace(/\{keyword\}/g, vars.keyword || '')
    .replace(/\{visitor_id\}/g, vars.visitorId || '')
    .replace(/\{owner_Email\}/g, ownerEmail)
    .replace(/\{agent_name\}/g, vars.agentId || '');
}

function triggerManualSendAuditIntervention(data, auditResult, db, databaseAPI, enqueueIntervention) {
  try {
    const now = Date.now();
    const backendRow = db.prepare('SELECT backend_type FROM agents WHERE agent_id = ?').get(data.agentId);
    const prefix = backendRow?.backend_type === 'hermes' ? 'hermes' : 'agent';
    const oiId = `audit_send_${now}_${Math.random().toString(36).slice(2, 8)}`;
    const blocked = auditResult.action === 'hard_deny';
    const problem = blocked
      ? `Manual send was blocked. Reason: ${auditResult.reasonCode || auditResult.matchedKeyword || 'audit rule'}`
      : `Manual send requires review. Reason: ${auditResult.reasonCode || auditResult.matchedKeyword || 'audit rule'}`;
    const record = { id: oiId, visitorId: data.channelId, sessionKey: `${prefix}:${data.agentId}:${data.channelId}`,
      problem, agentSuggestion: 'Review the outbound safety decision.', askTime: now, expireTime: null,
      status: 'pending', ownerReply: null, replyTime: null, parentMessageId: null, channelType: 'voko',
      resolvedAt: null, createdAt: now, updatedAt: now, agentId: data.agentId };
    const saved = databaseAPI.saveOwnerIntervention({ ...record, skipReply: true });
    if (saved?.success === false) return saved;
    db.prepare('UPDATE owner_interventions SET skip_reply = 1 WHERE id = ?').run(oiId);
    if (enqueueIntervention) enqueueIntervention({ ...record, skipReply: 1 });
  } catch (error) {
    console.error('[Audit] Failed to create manual-send intervention:', error.message);
  }
}

module.exports = { checkAuditRules, normalizeAuditText, deterministicSignals, luhnValid, isValidChineseId,
  substitutePromptVariables, triggerManualSendAuditIntervention };
