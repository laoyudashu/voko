const test = require('node:test');
const assert = require('node:assert/strict');
const { CliAdapter } = require('../build/core/adapters/cli-adapter');
const { AcpAdapter } = require('../build/core/adapters/acp-adapter');

const challenge = 'voko-0123456789abcdef01234567';

test('CliAdapter loopback uses an isolated invocation and exact challenge matching', async () => {
  const provider = new CliAdapter({
    name: 'loopback-fixture', cmd: process.execPath,
    args: ['-e', "const m=process.argv[1].match(/voko-[a-f0-9]{24}/);console.log(m?m[0]:'')", '{prompt}'],
    parser: 'raw', matchType: 'fixture', timeout: 5000,
  });
  let replies = 0;
  provider.on('agent.reply', () => { replies++; });
  const result = await provider.runLoopbackTest('agent-1', { acknowledgeCost: true, challenge });
  assert.equal(result.ok, true);
  assert.equal(result.challengeMatched, true);
  assert.equal(replies, 0);
});

test('AcpAdapter loopback creates and disposes an uncached session without reply events', async () => {
  let disposed = 0;
  const updates = [];
  const session = {
    sessionId: 'loopback-session',
    async prompt(content) {
      const match = content.match(/voko-[a-f0-9]{24}/);
      updates.push({ kind: 'session_update', update: { sessionUpdate: 'agent_message_chunk', content: { text: match[0] } } });
      updates.push({ kind: 'stop' });
    },
    async nextUpdate() { return updates.shift(); },
    dispose() { disposed++; },
  };
  const provider = new AcpAdapter({ streamFactory: async () => ({ stream: {} }) });
  provider._ensureAgent = async () => ({
    agentCtx: { buildSession: () => ({ start: async () => session }) },
    sessions: new Map(), agentIds: new Set(['agent-1']),
  });
  let replies = 0;
  provider.on('agent.reply', () => { replies++; });
  const result = await provider.runLoopbackTest('agent-1', { acknowledgeCost: true, challenge });
  assert.equal(result.ok, true);
  assert.equal(result.loopbackSessionId, 'loopback-session');
  assert.equal(disposed, 1);
  assert.equal(replies, 0);
});
