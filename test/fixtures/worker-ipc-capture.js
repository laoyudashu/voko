'use strict';

// Minimal real fork target for argv/IPC security regression coverage.
process.once('message', (message) => {
  if (!message || message.type !== 'worker.init') process.exit(2);
  process.on('message', (next) => {
    if (next && next.type === 'disconnect') process.exit(0);
  });
  process.send?.({ type: 'event', event: 'worker.status', payload: { agentId: process.argv[2], status: 'ready' }, seq: 1, ts: Date.now() });
});
