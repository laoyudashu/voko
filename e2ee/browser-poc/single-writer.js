const release = new Promise((resolve) => {
  window.releaseGroupLock = resolve;
});

navigator.locks.request(
  'voko-e2ee-group:test-group',
  { ifAvailable: true },
  async (lock) => {
    document.body.dataset.status = lock ? 'acquired' : 'blocked';
    if (lock) await release;
  },
);
