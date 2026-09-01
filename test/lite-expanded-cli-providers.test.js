const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { QwenCliProvider } = require('../build/core/dispatcher/providers/qwen-cli');
const { KiroCliProvider } = require('../build/core/dispatcher/providers/kiro-cli');
const { AiderCliProvider } = require('../build/core/dispatcher/providers/aider-cli');
const { ClineCliProvider } = require('../build/core/dispatcher/providers/cline-cli');
const { ClineAcpProvider } = require('../build/core/dispatcher/providers/cline-acp');
const { ZeroClawAcpProvider } = require('../build/core/dispatcher/providers/zeroclaw-acp');
const { ZeroClawCliProvider } = require('../build/core/dispatcher/providers/zeroclaw-cli');
const { GitHubCopilotAcpProvider } = require('../build/core/dispatcher/providers/github-copilot-acp');
const { GitHubCopilotCliProvider } = require('../build/core/dispatcher/providers/github-copilot-cli');
const { PiCliProvider } = require('../build/core/dispatcher/providers/pi-cli');
const { OpenHandsAcpProvider } = require('../build/core/dispatcher/providers/openhands-acp');
const {
  OpenHandsCliProvider,
  normalizeOpenHandsSessionId,
} = require('../build/core/dispatcher/providers/openhands-cli');
const { GrokCliProvider } = require('../build/core/dispatcher/providers/grok-cli');
const { ReasonixCliProvider } = require('../build/core/dispatcher/providers/reasonix-cli');
const { CodexCliProvider } = require('../build/core/dispatcher/providers/codex-cli');
const { ClaudeCliProvider } = require('../build/core/dispatcher/providers/claude-cli');
const { CursorAcpProvider } = require('../build/core/dispatcher/providers/cursor-acp');
const { CursorCliProvider } = require('../build/core/dispatcher/providers/cursor-cli');
const OpenClawCliProvider = require('../build/core/dispatcher/providers/openclaw-cli');
const HermesCliProvider = require('../build/core/dispatcher/providers/hermes-cli');
const { createParser } = require('../build/core/adapters/cli-parsers');
const { classifyCliFailure, runCli, sanitizeCliDiagnostic } = require('../build/core/adapters/cli-spawner');
const { CliAdapter } = require('../build/core/adapters/cli-adapter');
const {
  RegistrationOrchestrator,
  currentAgentTypeFromProcessRows,
} = require('../build/core/registration-orchestrator');

test('CLI auth messages including signed-in wording are safe to fallback', () => {
  assert.equal(classifyCliFailure({ stdout: 'Not signed in. Run login.', stderr: '' }), 'not_delivered');
  assert.equal(classifyCliFailure({ stdout: 'Not logged in.', stderr: '' }), 'not_delivered');
});

test('CLI timeout carries a stable Provider code and retryability', async () => {
  await assert.rejects(() => runCli({
    cmd: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 10000)'],
    timeout: 20,
    tag: 'timeout-contract',
  }), error => error.code === 'PROVIDER_TIMEOUT'
    && error.deliveryOutcome === 'outcome_unknown'
    && error.retryable === true);
});

test('CLI diagnostics redact credentials and user directories', () => {
  const diagnostic = sanitizeCliDiagnostic(
    'failed at C:\\Users\\laoyu\\agent token=secret-value Bearer abc.def.ghi /home/tjyu/config',
  );
  assert.equal(diagnostic,
    'failed at [user-dir]\\agent token=[redacted] Bearer [redacted] [user-dir]/config');
  assert.doesNotMatch(diagnostic, /laoyu|tjyu|secret-value|abc\.def/);
});

test('CLI diagnostics preserve the trailing root cause after noisy warnings', () => {
  const diagnostic = sanitizeCliDiagnostic(`${'warning '.repeat(80)}ROOT_CAUSE model=unsupported`);
  assert.ok(diagnostic.length <= 400);
  assert.match(diagnostic, /^warning/);
  assert.match(diagnostic, /ROOT_CAUSE model=unsupported$/);
});

test('generic CLI exit exposes only a sanitized stderr diagnostic', async () => {
  const provider = new CliAdapter({
    name: 'DIAGNOSTIC TEST CLI', cmd: process.execPath,
    args: ['-e', "process.stderr.write('failed token=secret-value at /home/private/config'); process.exit(7)"],
    matchType: 'reasonix', adapterType: 'reasonix-cli', timeout: 5000,
  });
  await assert.rejects(() => provider.push({
    agentId: 'agent-reasonix', fromUid: 'visitor', content: 'private prompt', messageId: 'diagnostic-test',
  }), error => error.code === 'PROVIDER_CLI_EXIT'
    && error.exitCode === 7
    && error.retryable === false
    && error.diagnostic === 'failed token=[redacted] at [user-dir]/config'
    && !String(error.diagnostic).includes('private prompt'));
});

test('CLI auth failure invalidates the route until the next health check', async () => {
  const provider = new CliAdapter({
    name: 'AUTH TEST CLI', cmd: process.execPath,
    args: ['-e', "process.stdout.write('Not signed in.\n'); process.exit(1)"],
    matchType: 'grok', adapterType: 'grok-cli', timeout: 5000,
  });
  provider._available = true;
  await assert.rejects(() => provider.push({
    agentId: 'agent-grok', fromUid: 'visitor-grok', content: 'hello', messageId: 'auth-test',
  }), error => error.deliveryOutcome === 'not_delivered');
  assert.equal(provider._available, false);
});

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
  assert.doesNotMatch(provider._args.join(' '), /--trust-tools(?:=|\s|$)/);
  assert.doesNotMatch(provider._args.join(' '), /trust-all-tools|write|shell|read|grep/);
});

test('Cline unattended delivery is plan-only and denies shell commands', () => {
  const provider = new ClineCliProvider();
  assert.equal(provider._cmd, 'cline');
  assert.equal(provider._parserName, 'cline-jsonl');
  assert.equal(provider._args.at(-1), '{prompt}');
  assert.ok(provider._args.includes('--plan'));
  assert.deepEqual(provider._args.slice(provider._args.indexOf('--auto-approve'), provider._args.indexOf('--auto-approve') + 2), ['--auto-approve', 'false']);
  assert.equal(JSON.parse(provider._env.CLINE_COMMAND_PERMISSIONS).deny[0], '*');
});

test('Cline exposes ACP as the primary isolated delivery and CLI as fallback', () => {
  const provider = new ClineAcpProvider();
  assert.equal(provider._cliPath, 'cline');
  assert.deepEqual(provider._cliArgs, ['--acp']);
  assert.equal(provider._adapterType, 'cline-acp');
});

test('Cline JSONL parser emits partial text once and ignores tool questions', () => {
  const chunks = [];
  const parser = createParser({ format: 'cline-jsonl', onText: (chunk) => chunks.push(chunk) });
  parser.handleLine(JSON.stringify({ type: 'ask', ask: 'tool', text: 'approval?' }));
  parser.handleLine(JSON.stringify({ type: 'say', say: 'text', text: 'Hel', partial: true }));
  parser.handleLine(JSON.stringify({ type: 'say', say: 'text', text: 'Hello', partial: false }));
  assert.deepEqual(chunks, ['Hel']);

  const currentChunks = [];
  const currentParser = createParser({ format: 'cline-jsonl', onText: (chunk) => currentChunks.push(chunk) });
  currentParser.handleLine(JSON.stringify({ type: 'agent_event', event: { type: 'iteration_start' } }));
  currentParser.handleLine(JSON.stringify({ type: 'agent_event', event: { type: 'done', text: 'final' } }));
  currentParser.handleLine(JSON.stringify({ type: 'run_result', finishReason: 'completed', text: 'final' }));
  assert.deepEqual(currentChunks, ['final']);
});

test('ZeroClaw exposes ACP and isolated stateful CLI as independent routes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-zeroclaw-fallback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = {
    _dbPath: path.join(root, 'voko.db'),
    prepare(sql) {
      assert.match(sql, /backend_instance_id/);
      return { get: () => ({ backend_instance_id: 'voko_test' }) };
    },
  };
  const acp = new ZeroClawAcpProvider({ db });
  const provider = new ZeroClawCliProvider({ db });
  assert.equal(acp._adapterType, 'zeroclaw-acp');
  assert.deepEqual(acp._cliArgs, ['acp']);
  assert.deepEqual(acp.options.sessionRequest('agent-voko'), { agentAlias: 'voko_test' });
  assert.equal(acp._instanceAlias('agent-voko'), 'voko_test');
  assert.equal(provider._adapterType, 'zeroclaw-cli');
  assert.equal(provider._instanceAlias('agent-voko'), 'voko_test');
  const invocation = provider._prepareInvocation({
    agentId: 'agent-voko', fromUid: 'visitor-secret', channelId: 'visitor-secret', channelType: 1,
  }, 'hello');
  assert.deepEqual(invocation.args.slice(0, 3), ['agent', '--agent', 'voko_test']);
  assert.ok(invocation.args.includes('--session-state-file'));
  assert.equal(provider._parserName, 'zeroclaw-interactive');
  assert.equal(invocation.args.includes('--message'), false);
  const stateFile = invocation.args[invocation.args.indexOf('--session-state-file') + 1];
  assert.match(path.basename(stateFile), /^[a-f0-9]{64}\.json$/);
  assert.doesNotMatch(stateFile, /agent-voko|visitor-secret/);
  fs.writeFileSync(stateFile, '{}', { mode: 0o644 });
  invocation.afterRun();
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

test('Hermes CLI does not use an Agent UUID when backend instance is missing', async () => {
  const agentId = 'f08d57a7-6af4-4b5f-a543-7d143e64dc53';
  let invoked = false;
  const provider = new HermesCliProvider({
    db: { prepare: () => ({ get: () => ({ backend_instance_id: null }) }) },
    runCli: async () => { invoked = true; return { stdout: '', stderr: '', code: 0, signal: null }; },
  });
  provider._available = true;

  assert.equal(provider._instanceForAgent(agentId), null);
  assert.equal(provider.isAvailable(agentId), false);
  await assert.rejects(
    provider.push({ agentId, fromUid: 'visitor', content: 'hello', messageId: 'missing-profile' }),
    /Hermes CLI unavailable: agent is not bound to a Hermes profile/,
  );
  assert.equal(invoked, false);
});

test('OpenClaw rejects a failed CLI process and Hermes reports a background delivery error', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-cli-fallback-failure-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previousPath = process.env.PATH;
  const previousOpenClawBin = process.env.VOKO_OPENCLAW_BIN;
  t.after(() => { process.env.PATH = previousPath; });
  t.after(() => {
    if (previousOpenClawBin === undefined) delete process.env.VOKO_OPENCLAW_BIN;
    else process.env.VOKO_OPENCLAW_BIN = previousOpenClawBin;
  });
  for (const command of ['openclaw', 'hermes']) {
    const file = path.join(root, process.platform === 'win32' ? `${command}.cmd` : command);
    fs.writeFileSync(file, process.platform === 'win32' ? '@exit /b 7\r\n' : '#!/bin/sh\nexit 7\n', { mode: 0o755 });
  }
  process.env.PATH = `${root}${path.delimiter}${previousPath || ''}`;
  // Linux runtime discovery intentionally prefers user-local binary folders
  // ahead of PATH. Pin this test to its fake executable so it never depends
  // on a real OpenClaw installation on the host.
  process.env.VOKO_OPENCLAW_BIN = path.join(root, process.platform === 'win32' ? 'openclaw.cmd' : 'openclaw');
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
  assert.equal(errors[0].agentId, 'voko-agent');
  assert.equal(errors[0].turnId, 'message');
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
  const receipts = await Promise.all([first, second]);
  assert.deepEqual(receipts[0], {
    accepted: true, queued: true, nativeSessionId: 'hermes:agent-a:visitor-1',
    providerInstanceId: 'shared-profile', deliveryMode: 'cli', adapterType: 'hermes-cli',
  });
  assert.equal(active <= 1, true);
  await provider.waitForIdle('shared-profile');
  assert.equal(maxActive, 1);
  assert.equal(starts.length, 2);
});

test('Hermes CLI maps the leased visitor policy to real chat permission flags', async () => {
  let invocation;
  const provider = new HermesCliProvider({
    db: { prepare: () => ({ get: () => ({ backend_instance_id: 'visitor-profile' }), all: () => [] }) },
    runCli: async (input) => {
      invocation = input;
      return { stdout: 'policy reply', stderr: '', code: 0, signal: null };
    },
  });
  await provider.push({ agentId: 'agent-a', fromUid: 'visitor', content: 'hello', messageId: 'policy-turn',
    providerSecurityPolicy: { transportId: 'hermes-cli', config: {
      toolProfile: 'default', safeMode: 'disabled', approvalMode: 'bypass', acceptHooks: 'enabled',
    } } });
  await provider.waitForIdle();
  assert.deepEqual(invocation.args.slice(0, 4), ['--profile', 'visitor-profile', 'chat', '-q']);
  assert.equal(invocation.args.includes('-z'), false);
  assert.equal(invocation.args.includes('--toolsets'), false);
  assert.equal(invocation.args.includes('--safe-mode'), false);
  assert.equal(invocation.args.includes('--yolo'), true);
  assert.equal(invocation.args.includes('--accept-hooks'), true);
});

test('Hermes CLI defaults visitor turns to the safe toolset and isolated configuration', async () => {
  let invocation;
  const provider = new HermesCliProvider({
    db: { prepare: () => ({ get: () => ({ backend_instance_id: 'visitor-profile' }), all: () => [] }) },
    runCli: async (input) => { invocation = input; return { stdout: 'safe reply', stderr: '', code: 0, signal: null }; },
  });
  await provider.push({ agentId: 'agent-a', fromUid: 'visitor', content: 'hello', messageId: 'safe-turn' });
  await provider.waitForIdle();
  assert.equal(invocation.args.includes('--toolsets'), true);
  assert.equal(invocation.args[invocation.args.indexOf('--toolsets') + 1], 'safe');
  assert.equal(invocation.args.includes('--safe-mode'), true);
  assert.equal(invocation.args.includes('--yolo'), false);
  assert.equal(invocation.args.includes('--accept-hooks'), false);
});

test('Hermes consecutive attachment turns preserve exact turn correlation while remaining serial', async () => {
  let active = 0; let maxActive = 0;
  const replies = [];
  const provider = new HermesCliProvider({
    db: { prepare: () => ({ get: () => ({ backend_instance_id: 'shared-profile' }), all: () => [] }) },
    runCli: async () => {
      active += 1; maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active -= 1;
      return { stdout: 'attachment reply', stderr: '', code: 0, signal: null };
    },
  });
  provider.on('agent.reply', reply => replies.push(reply));
  await Promise.all([
    provider.push({ agentId: 'agent-a', fromUid: 'visitor', content: 'file', messageId: 'm-file', turnId: 'turn-file', attachments: [] }),
    provider.push({ agentId: 'agent-a', fromUid: 'visitor', content: 'image', messageId: 'm-image', turnId: 'turn-image', attachments: [] }),
  ]);
  await provider.waitForIdle('shared-profile');
  assert.equal(maxActive, 1);
  assert.deepEqual(replies.map(reply => reply.turnId), ['turn-file', 'turn-image']);
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

test('Hermes CLI publishes an upstream authentication error as AUTH_REQUIRED, never as an Agent reply', async () => {
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
  assert.equal(errors[0].kind, 'auth_required');
  assert.equal(errors[0].errorCode, 'PROVIDER_AUTH_REQUIRED');
});

test('Cursor exposes ACP and CLI as independent Dispatcher routes', () => {
  const acp = new CursorAcpProvider();
  const cli = new CursorCliProvider();
  assert.equal(acp._adapterType, 'cursor-acp');
  assert.equal(acp._cliArgs.at(-1), 'acp');
  assert.equal(acp._matchType, 'cursor');
  assert.equal(acp._cliFallback, undefined);
  assert.equal(cli._adapterType, 'cursor-cli');
  assert.deepEqual(cli._argsForSession('cursor-session', false).slice(-2), ['--resume', 'cursor-session']);
  assert.equal(cli._sessionIdFromLine(JSON.stringify({ type: 'result', session_id: 'cursor-session' })), 'cursor-session');
});

test('GitHub Copilot exposes ACP and restricted CLI as independent routes', () => {
  const acp = new GitHubCopilotAcpProvider();
  const cli = new GitHubCopilotCliProvider();
  assert.equal(acp._adapterType, 'github-copilot-acp');
  assert.equal(acp._matchType, 'github-copilot');
  assert.equal(acp._cliFallback, undefined);
  assert.equal(cli._adapterType, 'github-copilot-cli');
  if (!acp._runtime || !cli._runtime) return;
  const acpArgs = acp._cliArgs.join(' ');
  const cliArgs = cli._args.join(' ');
  assert.match(acpArgs, /--acp/);
  assert.match(cliArgs, /-p \{prompt\}/);
  for (const flag of [
    '--no-custom-instructions',
    '--disable-builtin-mcps',
    '--no-remote',
    '--no-remote-export',
    '--deny-tool=read',
    '--deny-tool=write',
    '--deny-tool=shell',
    '--deny-tool=url',
    '--no-ask-user',
    '--no-auto-update',
  ]) {
    assert.match(acpArgs, new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(cliArgs, new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
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
  const sessionArgs = provider._argsForSession(sessionId, true).slice(-2);
  assert.equal(sessionArgs[0], '--session');
  assert.match(sessionArgs[1], new RegExp(`voko-pi-${sessionId}\\.jsonl$`));
});

test('OpenHands ACP runtime always uses UTF-8 without enabling a headless fallback', () => {
  const provider = new OpenHandsAcpProvider();
  assert.equal(provider._adapterType, 'openhands-acp');
  assert.deepEqual(provider._cliArgs, ['acp', '--override-with-envs']);
  assert.equal(provider.options.env.PYTHONUTF8, '1');
  assert.equal(provider.options.env.PYTHONIOENCODING, 'utf-8');
  assert.equal(provider.options.env.OPENHANDS_SUPPRESS_BANNER, '1');
  if (process.platform === 'win32') {
    const pythonHookDir = String(provider.options.env.PYTHONPATH || '').split(path.delimiter)[0];
    assert.match(pythonHookDir, /openhands-python/);
    assert.equal(fs.existsSync(path.join(pythonHookDir, 'sitecustomize.py')), true);
  }
  assert.equal(provider.options.env.LITELLM_LOCAL_MODEL_COST_MAP, 'True');
  if (process.platform === 'win32') {
    assert.equal(provider.options.env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(provider.options.env.GCM_INTERACTIVE, 'Never');
    assert.match(provider.options.env.GIT_DIR, /voko-openhands-git-disabled-/);
    assert.equal(provider.options.env.GIT_CONFIG_PARAMETERS, "'remote.origin.url'=''");
    assert.equal(provider.options.env.GIT_CONFIG_COUNT, '2');
    assert.equal(provider.options.env.GIT_CONFIG_KEY_0, 'http.lowspeedtime');
    assert.equal(provider.options.env.GIT_CONFIG_VALUE_0, '5');
    assert.equal(provider.options.env.GIT_CONFIG_KEY_1, 'http.lowspeedlimit');
    assert.equal(provider.options.env.GIT_CONFIG_VALUE_1, '1');
  }
  assert.equal(provider._cliFallback, undefined);
});

test('OpenHands CLI is a restricted JSON fallback and accepts ACP bindings', () => {
  const provider = new OpenHandsCliProvider();
  assert.equal(provider._adapterType, 'openhands-cli');
  assert.equal(provider._parserName, 'openhands-jsonl');
  assert.deepEqual(provider._args, ['--headless', '--json', '--override-with-envs', '--file', '{promptFile}']);
  assert.equal(provider._requireOutput, true);
  assert.equal(provider._requireSessionId, true);
  assert.equal(provider._env.VOKO_OPENHANDS_CLI_SAFE, '1');
  assert.equal(provider._env.OPENHANDS_SUPPRESS_BANNER, '1');
  assert.equal(provider._env.PYTHONUTF8, '1');
  assert.equal(provider._cwd, os.tmpdir());
  assert.deepEqual(provider._argsForSession('native-openhands-id', false).slice(-2), ['--resume', 'native-openhands-id']);
  assert.equal(
    normalizeOpenHandsSessionId('0123456789abcdef0123456789abcdef'),
    '01234567-89ab-cdef-0123-456789abcdef',
  );
  assert.equal(normalizeOpenHandsSessionId('01234567-89ab-cdef-0123-456789abcdef'), '01234567-89ab-cdef-0123-456789abcdef');
  assert.equal(provider._argsForSession(null, true).includes('--resume'), false);
  assert.equal(provider.acceptsBinding({
    providerType: 'openhands', adapterType: 'openhands-acp', nativeSessionId: 'native-openhands-id',
  }), true);
  assert.equal(provider.acceptsBinding({
    providerType: 'openhands', adapterType: 'other-cli', nativeSessionId: 'native-openhands-id',
  }), false);
  if (process.platform === 'win32') {
    const pythonHookDir = String(provider._env.PYTHONPATH || '').split(path.delimiter)[0];
    assert.match(pythonHookDir, /openhands-python/);
    assert.equal(fs.existsSync(path.join(pythonHookDir, 'sitecustomize.py')), true);
  }
});

test('OpenHands JSONL parser keeps only agent text and surfaces generic errors', () => {
  const chunks = [];
  const parser = createParser({ format: 'openhands-jsonl', onText: (chunk) => chunks.push(chunk) });
  parser.handleLine(JSON.stringify({ kind: 'MessageEvent', source: 'user', llm_message: { role: 'user', content: [{ type: 'text', text: 'ignore' }] } }));
  parser.handleLine(JSON.stringify({ kind: 'MessageEvent', source: 'agent', llm_message: { role: 'assistant', content: [{ type: 'text', text: 'OPENHANDS_' }] } }));
  parser.handleLine(JSON.stringify({ kind: 'MessageEvent', source: 'agent', llm_message: { role: 'assistant', content: [{ type: 'text', text: 'CLI_OK' }] } }));
  assert.equal(chunks.join(''), 'OPENHANDS_CLI_OK');
  const failed = createParser({ format: 'openhands-jsonl' });
  failed.handleLine(JSON.stringify({ kind: 'ConversationErrorEvent', code: 'LLMBadRequestError', detail: 'secret path should not escape' }));
  assert.equal(failed.error, 'OpenHands LLMBadRequestError');
});

test('Grok unattended delivery is tool-free and resumes only its bound session', () => {
  const provider = new GrokCliProvider();
  const args = provider._args.join(' ');
  assert.equal(provider._adapterType, 'grok-cli');
  assert.match(args, /--permission-mode plan/);
  assert.match(args, /--deny \*/);
  assert.doesNotMatch(args, /--tools=none/);
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
    delete process.env.DEEPSEEK_MODEL;
    const piWithDefaultModel = new PiCliProvider();
    assert.match(piWithDefaultModel._args.join(' '), /--provider deepseek --model deepseek-v4-flash/);
    process.env.DEEPSEEK_MODEL = 'deepseek-chat';

    const aider = new AiderCliProvider();
    assert.equal(aider._env.AIDER_MODEL, 'deepseek/deepseek-chat');
    assert.equal(aider._env.PYTHONUTF8, '1');
    assert.equal(aider._env.PYTHONIOENCODING, 'utf-8');
    assert.doesNotMatch(aider._args.join(' '), /test-only-secret/);

    const openhands = new OpenHandsAcpProvider();
    assert.deepEqual(openhands._cliArgs, ['acp', '--override-with-envs']);
    assert.equal(openhands.options.env.LLM_API_KEY, 'test-only-secret');
    assert.equal(openhands.options.env.LLM_BASE_URL, 'https://api.deepseek.test');
    assert.equal(openhands.options.env.LLM_MODEL, 'deepseek-chat');
    assert.doesNotMatch(openhands._cliArgs.join(' '), /test-only-secret/);
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

test('Claude accepts its persisted claude-code CLI session binding', () => {
  const claude = new ClaudeCliProvider();
  assert.equal(claude.acceptsBinding({
    providerType: 'claude-code',
    adapterType: 'claude-cli',
    deliveryMode: 'cli',
    nativeSessionId: 'session-id',
  }), true);
  assert.equal(claude.acceptsBinding({
    providerType: 'claude',
    adapterType: 'claude-cli',
    deliveryMode: 'cli',
    nativeSessionId: 'session-id',
  }), false);
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
  const commands = new Set(['qwen', 'kiro-cli', 'copilot', 'openhands', 'aider', 'cline', 'q', 'cursor-agent', 'grok', 'zeroclaw']);
  const service = new RegistrationOrchestrator({
    commandAvailable: (command) => commands.has(command),
  });
  const environment = service.inspectEnvironment();

  for (const type of ['qwen-code', 'kiro', 'github-copilot', 'openhands', 'aider', 'cline', 'amazon-q', 'cursor', 'grok', 'zeroclaw']) {
    assert.ok(environment.detected.some((provider) => provider.type === type), type);
  }
  for (const type of ['qwen-code', 'kiro', 'aider', 'grok']) {
    assert.deepEqual(service.deliveryCapabilities(type).map((mode) => mode.mode), ['cli', 'pull']);
  }
  assert.deepEqual(service.deliveryCapabilities('cline').map((mode) => mode.mode), ['acp', 'cli', 'pull']);
  assert.deepEqual(service.deliveryCapabilities('github-copilot').map((mode) => mode.mode), ['acp', 'cli', 'pull']);
  assert.deepEqual(service.deliveryCapabilities('cursor').map((mode) => mode.mode), ['acp', 'cli', 'pull']);
  assert.deepEqual(service.deliveryCapabilities('openhands').map((mode) => mode.mode), ['pull']);
  assert.equal(service.deliveryCapabilities('openhands')[0].status, 'ready');
  assert.equal(service.deliveryCapabilities('openhands')[0].selected, true);
  assert.deepEqual(service.deliveryCapabilities('amazon-q').map((mode) => mode.mode), ['pull']);
  const zeroModes = service.deliveryCapabilities('zeroclaw');
  assert.deepEqual(zeroModes.map((mode) => mode.mode), ['acp_ws', 'acp', 'cli', 'pull']);
  assert.equal(zeroModes[0].status, 'configuration_required');
  assert.equal(zeroModes[0].selected, false);
  assert.equal(zeroModes[1].status, 'configuration_required');
});

test('Cline registration preflight accepts ACP and CLI delivery', async () => {
  const service = new RegistrationOrchestrator({
    getLoggedEmail: async () => 'owner@example.com',
    detectCurrentAgentType: () => null,
    commandAvailable: (command) => command === 'cline',
  });
  const started = await service.start({ email: 'owner@example.com' });
  service.setBasicInfo(started.registrationId, { agentName: 'Cline smoke' });
  const selected = service.selectProvider(started.registrationId, { providerType: 'cline' });
  assert.equal(selected.success, true);
  assert.equal(service.preflightDelivery(started.registrationId, { mode: 'acp' }).ready, true);
  assert.equal(service.preflightDelivery(started.registrationId, { mode: 'cli' }).ready, true);
});

test('OpenHands registration keeps Pull as the safe default', async () => {
  const service = new RegistrationOrchestrator({
    getLoggedEmail: async () => 'owner@example.com',
    detectCurrentAgentType: () => null,
    commandAvailable: (command) => command === 'openhands',
  });
  const started = await service.start({ email: 'owner@example.com' });
  const selected = service.selectProvider(started.registrationId, { providerType: 'openhands' });
  assert.equal(selected.success, true);
  const configured = service.setBasicInfo(started.registrationId, { agentName: 'OpenHands smoke' });
  assert.deepEqual(configured.deliveryModes.map((mode) => mode.mode), ['pull']);
  assert.deepEqual(configured.deliveryModes.filter((mode) => mode.selected).map((mode) => mode.mode), ['pull']);
  assert.equal(service.preflightDelivery(started.registrationId, { mode: 'pull' }).ready, true);
});

test('current Agent process ancestry recognizes the added CLI families', () => {
  assert.equal(currentAgentTypeFromProcessRows(['qwen.exe --prompt']), 'qwen-code');
  assert.equal(currentAgentTypeFromProcessRows(['kiro-cli.exe chat']), 'kiro');
  assert.equal(currentAgentTypeFromProcessRows(['copilot.exe -p hello']), 'github-copilot');
  assert.equal(currentAgentTypeFromProcessRows(['openhands --headless']), 'openhands');
  assert.equal(currentAgentTypeFromProcessRows(['aider --message hello']), 'aider');
  assert.equal(currentAgentTypeFromProcessRows(['cline --plan --json']), 'cline');
  assert.equal(currentAgentTypeFromProcessRows(['q.exe chat']), 'amazon-q');
  assert.equal(currentAgentTypeFromProcessRows(['zeroclaw.exe agent --agent voko_test']), 'zeroclaw');
});

test('Reasonix CLI provider spawns headless with stream-json and positional prompt', () => {
  const provider = new ReasonixCliProvider();
  assert.equal(provider._cmd, 'reasonix');
  assert.equal(provider._matchType, 'reasonix');
  assert.equal(provider._adapterType, 'reasonix-cli');
  assert.equal(provider._cwd, os.tmpdir());
  // Reasonix 1.27 requires a positional task; CliAdapter replaces {prompt}.
  assert.ok(provider._args.includes('run'));
  assert.ok(provider._args.includes('--permission-mode'));
  assert.ok(provider._args.includes('dontAsk'));
  assert.ok(provider._args.includes('--output-format'));
  assert.ok(provider._args.includes('stream-json'));
  assert.equal(provider._args.includes('-'), false);
  assert.equal(provider._args.at(-1), '{prompt}');
  assert.match(provider._promptTemplate, /不得调用工具/);
  // parser 指向新增的 reasonix 专用解析器
  assert.equal(provider._parserName, 'reasonix-stream-json');
  // session resume：argsForSession 带 --resume
  const resumeArgs = provider._argsForSession('rx-session-1', false);
  assert.ok(resumeArgs.includes('--resume'));
  assert.ok(resumeArgs.includes('rx-session-1'));
  assert.equal(resumeArgs.includes('-'), false);
  assert.equal(resumeArgs.at(-1), '{prompt}');
  // 无 session 时不含 --resume
  const noSessionArgs = provider._argsForSession(null, false);
  assert.ok(!noSessionArgs.includes('--resume'));
  assert.equal(noSessionArgs.at(-1), '{prompt}');
  // sessionIdFromLine 从 stream-json 事件提取
  assert.equal(provider._sessionIdFromLine(JSON.stringify({ type: 'session_created', session_id: 'rx-abc' })), 'rx-abc');
  assert.equal(provider._sessionIdFromLine(JSON.stringify({ type: 'run_done', session_id: 'rx-xyz' })), 'rx-xyz');
  assert.equal(provider._sessionIdFromLine(JSON.stringify({ type: 'text', data: 'hi' })), null);
  assert.equal(provider._sessionIdFromLine('not json'), null);
  // match 只认 backend_type === 'reasonix'
  assert.equal(provider.match('agent-1', { backend_type: 'reasonix' }), true);
  assert.equal(provider.match('agent-1', { backend_type: 'codex' }), false);
});

test('reasonix-stream-json parser extracts run_done result and streaming text', () => {
  // 累积流式增量
  const streamed = [];
  let done = false;
  const parser = createParser({
    format: 'reasonix-stream-json',
    onText: (chunk) => streamed.push(chunk),
    onDone: () => { done = true; },
  });
  parser.handleLine(JSON.stringify({ type: 'text', data: 'Hello ' }));
  parser.handleLine(JSON.stringify({ type: 'text', data: 'world' }));
  parser.handleLine(JSON.stringify({ type: 'run_done', result: 'Hello world', session_id: 's1', is_error: false }));
  assert.equal(streamed.join(''), 'Hello world');
  assert.equal(done, true);
});

test('reasonix-stream-json parser matches Reasonix 1.21 stream-json events', () => {
  const streamed = [];
  let done = false;
  const parser = createParser({
    format: 'reasonix-stream-json',
    onText: (chunk) => streamed.push(chunk),
    onDone: () => { done = true; },
  });
  parser.handleLine(JSON.stringify({ kind: 'text', text: 'RAW_' }));
  parser.handleLine(JSON.stringify({ kind: 'text', text: 'OK' }));
  parser.handleLine(JSON.stringify({ kind: 'message', text: 'RAW_OK' }));
  parser.handleLine(JSON.stringify({ type: 'result', result: 'RAW_OK', session_id: 's-real' }));
  assert.equal(streamed.join(''), 'RAW_OK');
  assert.equal(done, true);
});

test('reasonix-stream-json parser falls back to run_done.result when no streaming', () => {
  const streamed = [];
  let done = false;
  const parser = createParser({
    format: 'reasonix-stream-json',
    onText: (chunk) => streamed.push(chunk),
    onDone: () => { done = true; },
  });
  // 无 text 增量，直接 run_done
  parser.handleLine(JSON.stringify({ type: 'run_done', result: '最终回复', session_id: 's2' }));
  assert.equal(streamed.join(''), '最终回复');
  assert.equal(done, true);
});

test('reasonix-stream-json parser surfaces error events', () => {
  const streamed = [];
  let done = false;
  const parser = createParser({
    format: 'reasonix-stream-json',
    onText: (chunk) => streamed.push(chunk),
    onDone: () => { done = true; },
  });
  parser.handleLine(JSON.stringify({ type: 'error', message: 'api timeout' }));
  assert.match(streamed.join(''), /reasonix error.*api timeout/);
  assert.equal(done, true);
});
