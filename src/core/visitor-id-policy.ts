export {};

const RESERVED_VISITOR_PREFIXES = ['cron:', 'system:', 'internal:', 'scheduler:'];

function reservedVisitorPrefix(value: unknown): string | null {
  const visitorId = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return RESERVED_VISITOR_PREFIXES.find(prefix => visitorId.startsWith(prefix)) || null;
}

function isExternalVisitorIdAllowed(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0 && reservedVisitorPrefix(value) === null;
}

module.exports = { RESERVED_VISITOR_PREFIXES, reservedVisitorPrefix, isExternalVisitorIdAllowed };
