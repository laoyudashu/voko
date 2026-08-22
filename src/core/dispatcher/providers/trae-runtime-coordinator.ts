/** Trae ACP accepts only one active prompt per server process. */
const tails = new Map<string, Promise<void>>();

export async function withTraeRuntimeLock<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
  const key = String(agentId || 'unknown');
  const previous = tails.get(key) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  tails.set(key, current);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (tails.get(key) === current) tails.delete(key);
  }
}

module.exports = { withTraeRuntimeLock };
