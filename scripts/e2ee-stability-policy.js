'use strict';

const RELEASE_DURATION_MS = 30 * 60 * 1000;
const MAX_RSS_INCREASE = 30 * 1024 * 1024;
const MAX_OPERATION_P95_MICROS = 5_000;

function parseDuration(value) {
  const match = /^(\d+)(ms|s|m|h)?$/.exec(value || '');
  if (!match) throw new Error(`Invalid stability duration: ${value}`);
  const scale = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2] || 's'];
  return Number(match[1]) * scale;
}

function validateStabilitySummary(summary, requestedDurationMs) {
  const errors = [];
  if (!/^[0-9a-f]{40}$/.test(summary?.commit || '')) errors.push('tested commit is missing or invalid');
  if (typeof summary?.platform !== 'string' || !summary.platform) errors.push('platform is missing');
  if (typeof summary?.arch !== 'string' || !summary.arch) errors.push('architecture is missing');
  if (summary?.passed !== true) errors.push('summary did not pass');
  if (!Number.isFinite(summary?.durationMs) || summary.durationMs < requestedDurationMs) errors.push('duration was shorter than requested');
  if (!Number.isSafeInteger(summary?.messages) || summary.messages < 1) errors.push('no messages were processed');
  for (const field of ['lost', 'duplicateDeliveries', 'crossedSessions']) {
    if (summary?.[field] !== 0) errors.push(`${field} must be zero`);
  }
  if (!Number.isFinite(summary?.startRssBytes) || !Number.isFinite(summary?.peakRssBytes)
      || summary.peakRssBytes < summary.startRssBytes) errors.push('RSS evidence is missing or invalid');
  if (!Number.isFinite(summary?.operationP95Micros) || summary.operationP95Micros > MAX_OPERATION_P95_MICROS) {
    errors.push(`operation P95 exceeds ${MAX_OPERATION_P95_MICROS}us`);
  }
  if (!Number.isFinite(summary?.messagesPerSecond) || summary.messagesPerSecond <= 0) errors.push('throughput evidence is missing');
  if (requestedDurationMs >= RELEASE_DURATION_MS) {
    if (summary.peakRssBytes - summary.startRssBytes > MAX_RSS_INCREASE) errors.push('RSS increase exceeds 30MiB');
    for (const field of ['duplicatesRejected', 'stateRecoveries', 'pcsUpdates']) {
      if (!Number.isSafeInteger(summary?.[field]) || summary[field] < 1) errors.push(`${field} was not exercised`);
    }
  }
  if (errors.length) throw new Error(`E2EE stability gate failed: ${errors.join('; ')}`);
}

module.exports = { parseDuration, validateStabilitySummary, RELEASE_DURATION_MS };
