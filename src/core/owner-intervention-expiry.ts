export {};

const OWNER_INTERVENTION_TTL_MS = 24 * 60 * 60 * 1000;

function ownerInterventionExpireTime(askTime: number): number {
  return askTime + OWNER_INTERVENTION_TTL_MS;
}

module.exports = { OWNER_INTERVENTION_TTL_MS, ownerInterventionExpireTime };
