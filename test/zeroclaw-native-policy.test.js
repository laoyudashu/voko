'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ZeroClawNativePolicyAdapter } = require('../build/core/zeroclaw-native-policy');

test('ZeroClaw native inspection preserves boolean false returned as a config string', () => {
  const values = {
    'agents.test.risk_profile': 'safe',
    'risk_profiles.safe.level': 'supervised',
    'risk_profiles.safe.require_approval_for_medium_risk': 'false',
    'risk_profiles.safe.block_high_risk_commands': 'true',
    'risk_profiles.safe.workspace_only': 'false',
    'risk_profiles.safe.delegation_policy.mode': 'forbidden',
  };
  const adapter = new ZeroClawNativePolicyAdapter({ configDir: '/tmp/zeroclaw-test', runner(args) {
    const getIndex = args.indexOf('get');
    if (getIndex < 0) throw new Error('unexpected command');
    const path = args[getIndex + 1];
    if (!Object.prototype.hasOwnProperty.call(values, path)) throw new Error('not found');
    return JSON.stringify({ path, value: values[path] });
  } });
  const observed = adapter.inspect({ agentId: 'agent', instanceId: 'test', providerSubjectKey: 'subject', owned: true });
  assert.deepEqual(observed.config, {
    autonomyLevel: 'supervised',
    requireApprovalForMediumRisk: 'disabled',
    blockHighRiskCommands: 'enabled',
    workspaceOnly: 'disabled',
  });
});

test('ZeroClaw native apply reloads a managed gateway through the bounded service lifecycle', async () => {
  const values = new Map([
    ['agents.test_agent.risk_profile', 'safe'],
    ['risk_profiles.safe.level', 'supervised'],
    ['risk_profiles.safe.require_approval_for_medium_risk', true],
    ['risk_profiles.safe.block_high_risk_commands', true],
    ['risk_profiles.safe.workspace_only', true],
  ]);
  const calls = [];
  const adapter = new ZeroClawNativePolicyAdapter({ configDir: '/tmp/zeroclaw-test', reloadGateway: true,
    runner(args, input) {
      calls.push(args);
      if (args[0] === 'service') return 'Service restarted';
      const command = args[1];
      if (command === 'list') {
        return [...values.keys()].filter(key => key.startsWith('risk_profiles.'))
          .map(key => `${key} = configured`).join('\n');
      }
      if (command === 'get') {
        const key = args[2];
        if (!values.has(key)) throw new Error('not found');
        return JSON.stringify({ path: key, value: values.get(key) });
      }
      if (command === 'set') {
        const raw = args[3];
        let value = raw;
        try { value = JSON.parse(raw); } catch {}
        values.set(args[2], value);
        return '';
      }
      if (command === 'patch') {
        const operations = JSON.parse(input);
        for (const operation of operations) {
          if (operation.op === 'test') assert.equal(values.get('agents.test_agent.risk_profile'), operation.value);
          if (operation.op === 'replace') values.set('agents.test_agent.risk_profile', operation.value);
        }
        return '';
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    } });
  const before = adapter.inspect({ agentId: 'agent-1', instanceId: 'test_agent', providerSubjectKey: 'subject', owned: true });
  const applied = await adapter.apply({ agentId: 'agent-1', instanceId: 'test_agent', providerSubjectKey: 'subject', owned: true }, {
    autonomyLevel: 'readonly', requireApprovalForMediumRisk: 'enabled', blockHighRiskCommands: 'enabled', workspaceOnly: 'enabled',
  }, before.nativePolicyDigest);
  assert.equal(applied.config.autonomyLevel, 'readonly');
  assert.ok(calls.some(args => args[0] === 'service' && args[1] === 'restart'));
  assert.equal(calls.some(args => args[0] === 'gateway' && args[1] === 'restart'), false);
});
