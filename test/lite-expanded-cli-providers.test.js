const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const { QwenCliProvider } = require('../build/core/dispatcher/providers/qwen-cli');
const { KiroCliProvider } = require('../build/core/dispatcher/providers/kiro-cli');
const { AiderCliProvider } = require('../build/core/dispatcher/providers/aider-cli');
const { PiCliProvider } = require('../build/core/dispatcher/providers/pi-cli');
const { CodexCliProvider } = require('../build/core/dispatcher/providers/codex-cli');
const { ClaudeCliProvider } = require('../build/core/dispatcher/providers/claude-cli');
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
});

test('Kiro unattended delivery does not pre-authorize any tool category', () => {
  const provider = new KiroCliProvider();
  assert.equal(provider._cmd, 'kiro-cli');
  assert.equal(provider._cwd, os.tmpdir());
  assert.ok(provider._args.includes('--no-interactive'));
  assert.ok(provider._args.includes('--trust-tools='));
  assert.match(provider._args.join(' '), /--wrap never/);
  assert.doesNotMatch(provider._args.join(' '), /trust-all-tools|write|shell|read|grep/);
});

test('Aider unattended delivery cannot edit, commit, browse or suggest commands', () => {
  const provider = new AiderCliProvider();
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
    '--no-chrome', '--disable-slash-commands', '--no-session-persistence',
  ]) assert.ok(claude._args.includes(flag), flag);
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

test('registration detects all added CLIs but only exposes safe automatic delivery', () => {
  const commands = new Set(['qwen', 'kiro-cli', 'copilot', 'openhands', 'aider', 'q', 'cursor-agent', 'grok']);
  const service = new RegistrationOrchestrator({
    commandAvailable: (command) => commands.has(command),
  });
  const environment = service.inspectEnvironment();

  for (const type of ['qwen-code', 'kiro', 'github-copilot', 'openhands', 'aider', 'amazon-q', 'cursor', 'grok']) {
    assert.ok(environment.detected.some((provider) => provider.type === type), type);
  }
  for (const type of ['qwen-code', 'kiro', 'aider']) {
    assert.deepEqual(service.deliveryCapabilities(type).map((mode) => mode.mode), ['cli', 'pull']);
  }
  for (const type of ['github-copilot', 'openhands', 'amazon-q', 'grok']) {
    assert.deepEqual(service.deliveryCapabilities(type).map((mode) => mode.mode), ['pull']);
  }
});

test('current Agent process ancestry recognizes the added CLI families', () => {
  assert.equal(currentAgentTypeFromProcessRows(['qwen.exe --prompt']), 'qwen-code');
  assert.equal(currentAgentTypeFromProcessRows(['kiro-cli.exe chat']), 'kiro');
  assert.equal(currentAgentTypeFromProcessRows(['copilot.exe -p hello']), 'github-copilot');
  assert.equal(currentAgentTypeFromProcessRows(['openhands --headless']), 'openhands');
  assert.equal(currentAgentTypeFromProcessRows(['aider --message hello']), 'aider');
  assert.equal(currentAgentTypeFromProcessRows(['q.exe chat']), 'amazon-q');
});
