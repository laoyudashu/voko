const test = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');

const { runInteractiveLogin, runInteractiveRegistration } = require('../build/cli-interactive');
const { hasGraphicalSession, interactiveStartEnabled, hasAgentForOwner } = require('../build/index');

function outputBuffer() {
  let text = '';
  const output = new Writable({ write(chunk, _encoding, done) { text += chunk.toString(); done(); } });
  output.isTTY = true;
  return { output, text: () => text };
}

function questions(values) {
  const queue = [...values];
  return async () => queue.shift() ?? '';
}

test('interactive login saves authentication without printing the user access token', async () => {
  const calls = [];
  const buffered = outputBuffer();
  const result = await runInteractiveLogin({
    agentRegistration: {
      sendCode: async (params) => { calls.push(['send', params]); return { success: true }; },
      loginByCode: async (params) => { calls.push(['login', params]); return { success: true, email: params.email, userAccessToken: 'ut_secret' }; },
    },
  }, { output: buffered.output, question: questions(['Owner@Example.com', '123456']) });
  assert.equal(result.email, 'owner@example.com');
  assert.deepEqual(calls, [
    ['send', { email: 'owner@example.com' }],
    ['login', { email: 'owner@example.com', code: '123456' }],
  ]);
  assert.doesNotMatch(buffered.text(), /ut_secret/);
});

test('interactive commands reject non-TTY input instead of blocking automation', async () => {
  const input = { isTTY: false };
  const output = { isTTY: false };
  await assert.rejects(() => runInteractiveLogin({}, { input, output }), /requires a TTY/);
});

test('interactive registration follows the shared state machine and keeps pull enabled', async () => {
  const calls = [];
  const buffered = outputBuffer();
  const manage = async (params) => {
    calls.push(params);
    if (params.action === 'start') return {
      success: true, registrationId: 'reg-1', nextAction: { type: 'select_provider' },
      environment: { detected: [{ type: 'workbuddy', label: 'WorkBuddy', instances: [] }], more: [{ type: 'codex', label: 'Codex' }], fallback: { type: 'others', label: 'Others', instances: [] } },
    };
    if (params.action === 'discover_provider_instances') return {
      success: true, instances: [{ id: 'expert-one', name: 'Expert One' }],
    };
    if (params.action === 'select_provider') return {
      success: true, registrationId: 'reg-1', suggestedBasicInfo: { agentName: 'Expert One', description: 'Suggested' },
      deliveryModes: [{ mode: 'pull', label: 'Pull', status: 'ready', required: true, selected: true }],
    };
    if (params.action === 'set_basic_info') return {
      success: true, registrationId: 'reg-1', deliveryModes: [{ mode: 'pull', label: 'Pull', status: 'ready', required: true, selected: true }],
    };
    if (params.action === 'select_delivery') return { success: true, registrationId: 'reg-1' };
    if (params.action === 'complete') return { success: true, result: { agentId: 'agent-1', agentName: 'Headless Agent' } };
    throw new Error(`unexpected action ${params.action}`);
  };
  const result = await runInteractiveRegistration({}, {
    output: buffered.output,
    manage,
    question: questions(['', '', '', '', '', '', '', '', '']),
  });
  assert.equal(result.result.agentId, 'agent-1');
  assert.ok(calls.some((item) => item.action === 'discover_provider_instances'));
  assert.equal(calls.find((item) => item.action === 'select_provider').instanceId, 'expert-one');
  assert.equal(calls.find((item) => item.action === 'set_basic_info').agentName, 'Expert One');
  assert.deepEqual(calls.find((item) => item.action === 'select_delivery').deliveryModes, []);
  assert.equal(calls.find((item) => item.action === 'complete').accessMode, 'private');
  assert.doesNotMatch(buffered.text(), /Codex|Others/);
});

test('interactive registration rejects an empty detected list without offering more or fallback providers', async () => {
  const buffered = outputBuffer();
  await assert.rejects(() => runInteractiveRegistration({}, {
    output: buffered.output,
    manage: async () => ({
      success: true, registrationId: 'reg-empty', nextAction: { type: 'select_provider' },
      environment: { detected: [], more: [{ type: 'codex', label: 'Codex' }], fallback: { type: 'others', label: 'Others' } },
    }),
    question: questions([]),
  }), /No local Agent providers were detected/);
  assert.doesNotMatch(buffered.text(), /Codex|Others/);
});

test('graphical-session detection preserves desktops and rejects SSH/headless sessions', () => {
  assert.equal(hasGraphicalSession('linux', { DISPLAY: ':0' }), true);
  assert.equal(hasGraphicalSession('linux', {}), false);
  assert.equal(hasGraphicalSession('darwin', {}), true);
  assert.equal(hasGraphicalSession('darwin', { SSH_TTY: '/dev/ttys001' }), false);
  assert.equal(hasGraphicalSession('win32', {}), true);
  assert.equal(hasGraphicalSession('win32', { SSH_CONNECTION: 'remote' }), false);
});

test('automatic onboarding only runs in a headless interactive terminal', () => {
  const ttyIn = { isTTY: true }, ttyOut = { isTTY: true };
  assert.equal(interactiveStartEnabled({}, 'linux', {}, ttyIn, ttyOut), true);
  assert.equal(interactiveStartEnabled({}, 'linux', { DISPLAY: ':0' }, ttyIn, ttyOut), false);
  assert.equal(interactiveStartEnabled({ 'no-interactive': true }, 'linux', {}, ttyIn, ttyOut), false);
  assert.equal(interactiveStartEnabled({}, 'linux', {}, { isTTY: false }, ttyOut), false);
});

test('headless onboarding only registers when the signed-in owner has no Agent', () => {
  const calls = [];
  const db = { prepare: () => ({ get: (email) => { calls.push(email); return email === 'owner@example.com' ? { 1: 1 } : undefined; } }) };
  assert.equal(hasAgentForOwner(db, ' Owner@Example.com '), true);
  assert.equal(hasAgentForOwner(db, 'other@example.com'), false);
  assert.deepEqual(calls, ['owner@example.com', 'other@example.com']);
});
