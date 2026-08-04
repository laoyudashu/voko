const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { QwenCliProvider } = require('../build/core/dispatcher/providers/qwen-cli');
const { KiroCliProvider } = require('../build/core/dispatcher/providers/kiro-cli');
const { AiderCliProvider } = require('../build/core/dispatcher/providers/aider-cli');
const { ZeroClawAcpProvider } = require('../build/core/dispatcher/providers/zeroclaw-acp');
const { GitHubCopilotAcpProvider } = require('../build/core/dispatcher/providers/github-copilot-acp');
const { PiCliProvider } = require('../build/core/dispatcher/providers/pi-cli');
const { OpenHandsAcpProvider } = require('../build/core/dispatcher/providers/openhands-acp');
const { GrokCliProvider } = require('../build/core/dispatcher/providers/grok-cli');
const { CodexCliProvider } = require('../build/core/dispatcher/providers/codex-cli');
const { ClaudeCliProvider } = require('../build/core/dispatcher/providers/claude-cli');
const { CursorAcpProvider } = require('../build/core/dispatcher/providers/cursor-acp');
const { CursorCliProvider } = require('../build/core/dispatcher/providers/cursor-cli');
const OpenClawCliProvider = require('../build/core/dispatcher/providers/openclaw-cli');
const HermesCliProvider = require('../build/core/dispatcher/providers/hermes-cli');
const { createParser } = require('../build/core/adapters/cli-parsers');
const {
  RegistrationOrchestrator,
  currentAgentTypeFromProcessRows,
} = require('../build/core/registration-orchestrator');

test('Qwen Code unattended delivery is tool-free and bounded', () => {
  const provider = new QwenCliProvider();
  assert.equal(provider._cmd, 'qwen');
  assert.equal(provider._cwd, os.tmpdir());
  assert.ok(provider._args.includes('--safe-mode'));
  assert.deepEqual(
    provider._args.slice(provider._args.indexOf('--approval-mode'), provider._args.indexOf('--approval-mode') + 2),
    ['--approval-mode', 'plan'],
  );
  assert.match(provider._args.join(' '), /--exclude-tools .*shell.*write.*edit.*agent/);
  assert.match(provider._args.join(' '), /--max-tool-calls 0/);
  assert.doesNotMatch(provider._args.join(' '), /yolo|auto-edit/);
  assert.equal(provider._adapterType, 'qwen-cli');
  assert.deepEqual(provider._argsForSession('qwen-session', false).slice(-2), ['--resume', 'qwen-session']);
  assert.equal(provider._sessionIdFromLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'qwen-session' })), 'qwen-session');
  assert.equal(provider._sessionIdFromLine(JSON.stringify({ type: 'assistant', session_id: 'ignored' })), null);
});

test('Kiro unattended delivery does not pre-authorize any tool category', () => {
  const provider = new KiroCliProvider();
  assert.equal(provider._cmd, 'kiro-cli');
  assert.equal(provider._cwd, os.tmpdir());
  assert.ok(provider._args.includes('--no-interactive'));
  assert.equal(provider._parserName, 'kiro-output');
  assert.match(provider._args.join(' '), /--wrap never/);
  assert.doesNotMatch(provider._args.join(' '), /trust-all-tools|write|shell|read|grep/);
});

test('ZeroClaw uses ACP and an isolated stateful CLI fallback with the persisted alias', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-zeroclaw-fallback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = {
    _dbPath: path.join(root, 'voko.db'),
    prepare(sql) {
      assert.match(sql, /backend_instance_id/);
      return { get: () => ({ backend_instance_id: 'voko_test' }) };
    },
  };
  const provider = new ZeroClawAcpProvider({ db });
  assert.equal(provider._adapterType, 'zeroclaw-acp');
  assert.deepEqual(provider._cliArgs, ['acp']);
  assert.deepEqual(provider.options.sessionRequest('agent-voko'), { agentAlias: 'voko_test' });
  assert.equal(provider._instanceAlias('agent-voko'), 'voko_test');
  const fallbackArgs = provider._cliFallback.argsForPayload({
    agentId: 'agent-voko', fromUid: 'visitor-secret', channelId: 'visitor-secret', channelType: 1,
  });
  assert.deepEqual(fallbackArgs.slice(0, 3), ['agent', '--agent', 'voko_test']);
  assert.ok(fallbackArgs.includes('--session-state-file'));
  assert.equal(provider._cliFallback.stdinPrompt, true);
  assert.equal(provider._cliFallback.parser, 'zeroclaw-interactive');
  assert.equal(fallbackArgs.includes('--message'), false);
  const stateFile = fallbackArgs[fallbackArgs.indexOf('--session-state-file') + 1];
  assert.match(path.basename(stateFile), /^[a-f0-9]{64}\.json$/);
  assert.doesNotMatch(stateFile, /agent-voko|visitor-secret/);
  fs.writeFileSync(stateFile, '{}', { mode: 0o644 });
  provider._cliFallback.afterRun({
    agentId: 'agent-voko', fromUid: 'visitor-secret', channelId: 'visitor-secret', channelType: 1,
  });
  if (process.platform !== 'win32') assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
});

test('OpenClaw and Hermes CLI fallbacks target the persisted backend instance', () => {
  const db = {
    prepare(sql) {
      assert.match(sql, /backend_instance_id/);
      return {
        get: (_agentId, backendType) => ({
          backend_instance_id: backendType === 'openclaw' ? 'openclaw-instance' : 'hermes-profile',
        }),
      };
    },
  };
  assert.equal(new OpenClawCliProvider({ db })._instanceForAgent('voko-agent'), 'openclaw-instance');
  assert.equal(new HermesCliProvider({ db })._instanceForAgent('voko-agent'), 'hermes-profile');
});

test('OpenClaw rejects a failed CLI process and Hermes reports a background delivery error', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-cli-fallback-failure-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previousPath = process.env.PATH;
  t.after(() => { process.env.PATH = previousPath; });
  for (const command of ['openclaw', 'hermes']) {
    const file = path.join(root, process.platform === 'win32' ? `${command}.cmd` : command);
    fs.writeFileSync(file, process.platform === 'win32' ? '@exit /b 7\r\n' : '#!/bin/sh\nexit 7\n', { mode: 0o755 });
  }
  process.env.PATH = `${root}${path.delimiter}${previousPath || ''}`;
  const db = {
    prepare(sql) {
      if (/backend_instance_id/.test(sql)) return { get: () => ({ backend_instance_id: 'isolated-test' }) };
      return { get: () => null, all: () => [], run: () => ({ changes: 0 }) };
    },
  };
  const payload = { agentId: 'voko-agent', fromUid: 'visitor', content: 'hello', messageId: 'message' };
  await assert.rejects(new OpenClawCliProvider({ db }).push(payload), /OpenClaw exited with code 7/);
  const errors = [];
  const hermes = new HermesCliProvider({
    db,
    runCli: async () => ({ stdout: '', stderr: '', code: 7, signal: null }),
  });
  hermes.on('delivery.error', (error) => errors.push(error));
  await hermes.push(payload);
  await hermes.waitForIdle();
  assert.equal(errors[0].kind, 'execution_failed');
});

test('Hermes CLI fallback queues the same profile serially without blocking dispatch', async () => {
  let active = 0;
  let maxActive = 0;
  const starts = [];
  const provider = new HermesCliProvider({
    db: {
      prepare: () => ({ get: () => ({ backend_instance_id: 'shared-profile' }) }),
    },
    runCli: async ({ args }) => {
      active++;
      maxActive = Math.max(maxActive, active);
      starts.push(args[args.length - 1]);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return { stdout: 'queued reply', stderr: '', code: 0, signal: null };
    },
  });
  const first = provider.push({ agentId: 'agent-a', fromUid: 'visitor-1', content: 'one', messageId: 'm1' });
  const second = provider.push({ agentId: 'agent-a', fromUid: 'visitor-2', content: 'two', messageId: 'm2' });
  await Promise.all([first, second]);
  assert.equal(active <= 1, true);
  await provider.waitForIdle('shared-profile');
  assert.equal(maxActive, 1);
  assert.equal(starts.length, 2);
});

test('Hermes CLI fallback classifies approval and timeout failures', async () => {
  for (const [message, kind] of [['Hermes pending approval', 'approval_required'], ['cli 超时 (120000ms)', 'timeout']]) {
    const errors = [];
    const provider = new HermesCliProvider({
      db: { prepare: () => ({ get: () => ({ backend_instance_id: 'profile-a' }) }) },
      runCli: async () => { throw new Error(message); },
    });
    provider.on('delivery.error', (error) => errors.push(error));
    await provider.push({ agentId: 'agent-a', fromUid: 'visitor', content: 'hello', messageId: kind });
    await provider.waitForIdle();
    assert.equal(errors[0].kind, kind);
  }
});

test('Hermes CLI does not publish an upstream authentication error as an Agent reply', async () => {
  const errors = [];
  const replies = [];
  const provider = new HermesCliProvider({
    db: { prepare: () => ({ get: () => ({ backend_instance_id: 'profile-a' }) }) },
    runCli: async () => ({ stdout: 'HTTP 401: Missing Authentication header\n', stderr: '', code: 0, signal: null }),
  });
  provider.on('delivery.error', (error) => errors.push(error));
  provider.on('agent.reply', (reply) => replies.push(reply));
  await provider.push({ agentId: 'agent-a', fromUid: 'visitor', content: 'hello', messageId: 'auth-error' });
  await provider.waitForIdle();
  assert.equal(replies.length, 0);
  assert.equal(errors[0].kind, 'execution_failed');
});

test('Cursor exposes ACP and CLI as independent Dispatcher routes', () => {
  const acp = new CursorAcpProvider();
  const cli = new CursorCliProvider();
  assert.equal(acp._adapterType, 'cursor-acp');
  assert.equal(acp._cliArgs.at(-1), 'acp');
  assert.equal(acp._matchType, 'cursor');
  assert.equal(acp._cliFallback, null);
  assert.equal(cli._adapterType, 'cursor-cli');
  assert.deepEqual(cli._argsForSession('cursor-session', false).slice(-2), ['--resume', 'cursor-session']);
  assert.equal(cli._sessionIdFromLine(JSON.stringify({ type: 'result', session_id: 'cursor-session' })), 'cursor-session');
});

test('GitHub Copilot uses ACP with a restricted CLI fallback', () => {
  const provider = new GitHubCopilotAcpProvider();
  assert.equal(provider._adapterType, 'github-copilot-acp');
  assert.equal(provider._matchType, 'github-copilot');
  if (!provider._runtime) return;
  const acpArgs = provider._cliArgs.join(' ');
  const fallbackArgs = provider._cliFallback.args.join(' ');
  assert.match(acpArgs, /--acp/);
  assert.match(fallbackArgs, /-p \{prompt\}/);
  for (const flag of [
    '--no-custom-instructions',
    '--disable-builtin-mcps',
    '--no-remote',
    '--no-remote-export',
    '--available-tools=',
    '--no-ask-user',
    '--no-auto-update',
  ]) {
    assert.match(acpArgs, new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(fallbackArgs, new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('Aider unattended delivery cannot edit, commit, browse or suggest commands', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-aider-session-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const provider = new AiderCliProvider({ db: { _dbPath: path.join(root, 'voko.db'), prepare() {} } });
  const args = provider._args.join(' ');
  assert.equal(provider._cwd, os.tmpdir());
  assert.match(args, /--chat-mode ask/);
  assert.equal(provider._parserName, 'aider-output');
  for (const flag of [
    '--dry-run', '--no-git', '--no-auto-commits', '--no-browser',
    '--no-detect-urls', '--no-suggest-shell-commands', '--analytics-disable',
    '--no-check-update',
  ]) assert.ok(provider._args.includes(flag), flag);
  assert.doesNotMatch(args, /yes-always/);
  assert.equal(provider._adapterType, 'aider-cli');
  const sessionId = provider._createManagedSessionId();
  const firstArgs = provider._argsForSession(sessionId, true);
  const resumeArgs = provider._argsForSession(sessionId, false);
  const historyFile = firstArgs[firstArgs.indexOf('--chat-history-file') + 1];
  assert.match(path.basename(historyFile), /^[a-f0-9]{64}\.md$/);
  assert.doesNotMatch(historyFile, new RegExp(sessionId));
  if (process.platform !== 'win32') assert.equal(fs.statSync(historyFile).mode & 0o777, 0o600);
  assert.equal(firstArgs.includes('--restore-chat-history'), false);
  assert.equal(resumeArgs.includes('--restore-chat-history'), true);
});

test('Pi unattended delivery has native sessions with no tools, extensions or skills', () => {
  const provider = new PiCliProvider();
  const args = provider._args.join(' ');
  assert.equal(provider._adapterType, 'pi-cli');
  assert.match(args, /--no-tools/);
  assert.match(args, /--no-extensions/);
  assert.match(args, /--no-skills/);
  assert.doesNotMatch(args, /--tools\s/);
  const sessionId = provider._createManagedSessionId();
  assert.deepEqual(provider._argsForSession(sessionId, true).slice(-2), ['--session-id', sessionId]);
});

test('OpenHands ACP runtime always uses UTF-8 without enabling a headless fallback', () => {
  const provider = new OpenHandsAcpProvider();
  assert.equal(provider._adapterType, 'openhands-acp');
  assert.deepEqual(provider._cliArgs, ['acp']);
  assert.equal(provider.options.env.PYTHONUTF8, '1');
  assert.equal(provider.options.env.PYTHONIOENCODING, 'utf-8');
  assert.equal(provider.options.env.OPENHANDS_SUPPRESS_BANNER, '1');
  assert.equal(provider._cliFallback, null);
});

test('Grok unattended delivery is tool-free and resumes only its bound session', () => {
  const provider = new GrokCliProvider();
  const args = provider._args.join(' ');
  assert.equal(provider._adapterType, 'grok-cli');
  assert.match(args, /--permission-mode plan/);
  assert.match(args, /--tools=none/);
  assert.match(args, /--disable-web-search/);
  assert.match(args, /--no-subagents/);
  assert.match(args, /--no-memory/);
  assert.doesNotMatch(args, /always-approve|bypassPermissions|yolo/);
  const sessionId = provider._createManagedSessionId();
  assert.deepEqual(
    provider._argsForSession(sessionId, true).slice(-4),
    ['--session-id', sessionId, '--single', '{prompt}'],
  );
  assert.deepEqual(
    provider._argsForSession(sessionId, false).slice(-4),
    ['--resume', sessionId, '--single', '{prompt}'],
  );
});

test('DeepSeek environment is mapped without embedding credentials in command arguments', () => {
  const previous = {
    key: process.env.DEEPSEEK_API_KEY,
    base: process.env.DEEPSEEK_BASE_URL,
    model: process.env.DEEPSEEK_MODEL,
  };
  process.env.DEEPSEEK_API_KEY = 'test-only-secret';
  process.env.DEEPSEEK_BASE_URL = 'https://api.deepseek.test';
  process.env.DEEPSEEK_MODEL = 'deepseek-chat';
  try {
    const qwen = new QwenCliProvider();
    assert.match(qwen._args.join(' '), /--auth-type openai --model deepseek-chat/);
    assert.equal(qwen._env.OPENAI_API_KEY, 'test-only-secret');
    assert.doesNotMatch(qwen._args.join(' '), /test-only-secret/);

    const pi = new PiCliProvider();
    assert.match(pi._args.join(' '), /--provider deepseek --model deepseek-chat/);

    const aider = new AiderCliProvider();
    assert.equal(aider._env.AIDER_MODEL, 'deepseek/deepseek-chat');
    assert.equal(aider._env.PYTHONUTF8, '1');
    assert.equal(aider._env.PYTHONIOENCODING, 'utf-8');
    assert.doesNotMatch(aider._args.join(' '), /test-only-secret/);
  } finally {
    if (previous.key === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previous.key;
    if (previous.base === undefined) delete process.env.DEEPSEEK_BASE_URL;
    else process.env.DEEPSEEK_BASE_URL = previous.base;
    if (previous.model === undefined) delete process.env.DEEPSEEK_MODEL;
    else process.env.DEEPSEEK_MODEL = previous.model;
  }
});

test('Codex and Claude run safely from a non-project temporary directory', () => {
  const codex = new CodexCliProvider();
  assert.ok(codex._args.includes('--skip-git-repo-check'));
  assert.match(codex._args.join(' '), /--sandbox read-only/);

  const claude = new ClaudeCliProvider();
  const args = claude._args.join(' ');
  for (const flag of [
    '--bare', '--safe-mode', '--tools=', '--strict-mcp-config',
    '--no-chrome', '--disable-slash-commands',
  ]) assert.ok(claude._args.includes(flag), flag);
  assert.ok(!claude._args.includes('--no-session-persistence'));
  assert.ok(claude._argsForSession('session-id', false).includes('--resume'));
  assert.match(args, /--permission-mode plan/);
  assert.doesNotMatch(args, /dangerously-skip-permissions|bypassPermissions/);
});

test('Aider parser emits only the model reply', () => {
  let output = '';
  const parser = createParser({
    format: 'aider-output',
    onText: (chunk) => { output += chunk; },
  });
  for (const line of [
    'Analytics have been permanently disabled.',
    "Can't initialize prompt toolkit: No Windows console found.",
    'cmd.exe?',
    '',
    'Aider v0.86.2',
    'Model: deepseek/deepseek-chat with ask edit format, prompt cache, infinite',
    'output',
    'Git repo: none',
    'Repo-map: disabled',
    '',
    'VOKO_PROVIDER_OK',
    '',
    'Tokens: 94 sent, 7 received. Cost: $0.000015 message.',
  ]) parser.handleLine(line);
  assert.equal(output.trim(), 'VOKO_PROVIDER_OK');
});

test('Aider parser excludes DeepSeek reasoning blocks', () => {
  let output = '';
  const parser = createParser({
    format: 'aider-output',
    onText: (chunk) => { output += chunk; },
  });
  [
    'Aider v0.86.2',
    'Repo-map: disabled',
    '',
    '--------------',
    '► **THINKING**',
    '',
    'internal reasoning',
    '--------------',
    '► **ANSWER**',
    '',
    'VOKO_PROVIDER_OK',
    '',
    'Tokens: 100 sent, 10 received.',
    '$0.000045 session.',
  ].forEach((line) => parser.handleLine(line));
  assert.equal(output.trim(), 'VOKO_PROVIDER_OK');
});

test('Kiro parser removes terminal formatting and usage lines', () => {
  let output = '';
  const parser = createParser({
    format: 'kiro-output',
    onText: (chunk) => { output += chunk; },
  });
  [
    '\u001b[38;5;141m> \u001b[0mVOKO_KIRO_OK',
    '\u001b[38;5;8m',
    ' ▸ Credits: 0.07 • Time: 4s',
    '\u001b[0m',
  ].forEach((line) => parser.handleLine(line));
  assert.equal(output.trim(), 'VOKO_KIRO_OK');
});

test('ZeroClaw interactive parser emits only the Agent reply', () => {
  const chunks = [];
  const parser = createParser({ format: 'zeroclaw-interactive', onText: (chunk) => chunks.push(chunk) });
  parser.handleLine('🦀 ZeroClaw Interactive Mode');
  parser.handleLine('Type /help for commands.');
  parser.handleLine('');
  parser.handleLine('> first line');
  parser.handleLine('second line');
  parser.handleLine('> ');
  parser.finish();
  assert.equal(chunks.join(''), 'first line\nsecond line\n');
});

test('registration detects all added CLIs but only exposes safe automatic delivery', () => {
  const commands = new Set(['qwen', 'kiro-cli', 'copilot', 'openhands', 'aider', 'q', 'cursor-agent', 'grok', 'zeroclaw']);
  const service = new RegistrationOrchestrator({
    commandAvailable: (command) => commands.has(command),
  });
  const environment = service.inspectEnvironment();

  for (const type of ['qwen-code', 'kiro', 'github-copilot', 'openhands', 'aider', 'amazon-q', 'cursor', 'grok', 'zeroclaw']) {
    assert.ok(environment.detected.some((provider) => provider.type === type), type);
  }
  for (const type of ['qwen-code', 'kiro', 'aider', 'grok']) {
    assert.deepEqual(service.deliveryCapabilities(type).map((mode) => mode.mode), ['cli', 'pull']);
  }
  assert.deepEqual(service.deliveryCapabilities('github-copilot').map((mode) => mode.mode), ['acp', 'cli', 'pull']);
  assert.deepEqual(service.deliveryCapabilities('cursor').map((mode) => mode.mode), ['acp', 'cli', 'pull']);
  for (const type of ['openhands', 'amazon-q']) {
    assert.deepEqual(service.deliveryCapabilities(type).map((mode) => mode.mode), ['pull']);
  }
  const zeroModes = service.deliveryCapabilities('zeroclaw');
  assert.deepEqual(zeroModes.map((mode) => mode.mode), ['acp_ws', 'acp', 'cli', 'pull']);
  assert.equal(zeroModes[0].status, 'configuration_required');
  assert.equal(zeroModes[0].selected, false);
  assert.equal(zeroModes[1].status, 'configuration_required');
});

test('current Agent process ancestry recognizes the added CLI families', () => {
  assert.equal(currentAgentTypeFromProcessRows(['qwen.exe --prompt']), 'qwen-code');
  assert.equal(currentAgentTypeFromProcessRows(['kiro-cli.exe chat']), 'kiro');
  assert.equal(currentAgentTypeFromProcessRows(['copilot.exe -p hello']), 'github-copilot');
  assert.equal(currentAgentTypeFromProcessRows(['openhands --headless']), 'openhands');
  assert.equal(currentAgentTypeFromProcessRows(['aider --message hello']), 'aider');
  assert.equal(currentAgentTypeFromProcessRows(['q.exe chat']), 'amazon-q');
  assert.equal(currentAgentTypeFromProcessRows(['zeroclaw.exe agent --agent voko_test']), 'zeroclaw');
});
