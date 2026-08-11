/**
 * Cline CLI and ACP clients share one per-user Hub. Keep VOKO-originated Cline
 * turns serial so concurrent agents cannot race Hub startup or session creation.
 */
let tail: Promise<void> = Promise.resolve();

export async function withClineRuntimeLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = tail;
  let release!: () => void;
  tail = new Promise<void>((resolve) => { release = resolve; });
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
  }
}

module.exports = { withClineRuntimeLock };
