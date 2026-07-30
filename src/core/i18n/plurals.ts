/**
 * i18n/plurals.js — 复数规则
 *
 * 轻量实现，不引入 ICU MessageFormat。
 * 中文无复数（恒 'other'）；英文 1='one'，其余='other'。
 * 字典里复数 key 的值写成 { "one": "...", "other": "..." }。
 * 新增语言在此加规则即可。
 */

function pluralRule(locale: string, count: unknown): 'one' | 'other' {
  const n = Number(count);
  if (locale === 'en') return n === 1 ? 'one' : 'other';
  // zh 及其它默认无复数
  return 'other';
}

module.exports = { pluralRule };
