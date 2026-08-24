export {};

const readline = require('node:readline/promises');
const { createContext } = require('./context');
const { createToolHandlers } = require('./mcp/tools');
const { runWithRegistrationCaller } = require('./core/registration-caller-context');

type InteractiveOptions = {
  input?: NodeJS.ReadableStream & { isTTY?: boolean };
  output?: NodeJS.WritableStream & { isTTY?: boolean };
  question?: (prompt: string) => Promise<string>;
  manage?: (params: any) => Promise<any>;
};

function createPrompt(options: InteractiveOptions = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  if (!options.question && (!input.isTTY || !output.isTTY)) {
    throw new Error('Interactive login requires a TTY; use voko manage_agent_registration --action start --registration-mode agent for headless login');
  }
  if (options.question) return { question: options.question, close() {} };
  return readline.createInterface({ input, output });
}

function write(output: NodeJS.WritableStream, text: string) {
  output.write(text + '\n');
}

function validEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

async function askRequired(prompt: any, label: string): Promise<string> {
  while (true) {
    const value = String(await prompt.question(label)).trim();
    if (value) return value;
  }
}

async function askYesNo(prompt: any, label: string, defaultYes = false): Promise<boolean> {
  const suffix = defaultYes ? ' [Y/n] ' : ' [y/N] ';
  const value = String(await prompt.question(label + suffix)).trim().toLowerCase();
  if (!value) return defaultYes;
  return value === 'y' || value === 'yes';
}

function chooseIndex(raw: string, count: number, fallback = 0): number {
  const parsed = Number.parseInt(raw, 10) - 1;
  return Number.isInteger(parsed) && parsed >= 0 && parsed < count ? parsed : fallback;
}

async function runInteractiveLogin(core: any, options: InteractiveOptions = {}) {
  const output = options.output || process.stdout;
  const prompt = createPrompt(options);
  try {
    let email = '';
    while (!validEmail(email)) {
      email = String(await prompt.question('Email: ')).trim().toLowerCase();
      if (!validEmail(email)) write(output, 'Please enter a valid email address.');
    }
    const sent = await core.agentRegistration.sendCode({ email });
    if (!sent?.success) throw new Error(sent?.error || 'Unable to send verification code');
    write(output, `Verification code sent to ${email}.`);
    let loggedIn: any = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const code = await askRequired(prompt, '6-digit verification code: ');
      if (!/^\d{6}$/.test(code)) {
        write(output, 'Verification code must contain 6 digits.');
        continue;
      }
      loggedIn = await core.agentRegistration.loginByCode({ email, code });
      if (loggedIn?.success) break;
      if (attempt < 2) write(output, loggedIn?.error || 'Verification failed. Try again.');
    }
    if (!loggedIn?.success) throw new Error(loggedIn?.error || 'Login failed');
    write(output, `Logged in as ${String(loggedIn.email || email).toLowerCase()}.`);
    return { success: true, email: String(loggedIn.email || email).toLowerCase() };
  } finally {
    prompt.close();
  }
}

function createRegistrationHandler(core: any) {
  const cx = createContext(core);
  const handlers = createToolHandlers(cx);
  return (params: any) => runWithRegistrationCaller(
    { source: 'cli_interactive' },
    () => handlers.manage_agent_registration(params),
  );
}

async function runInteractiveRegistration(core: any, options: InteractiveOptions = {}) {
  const output = options.output || process.stdout;
  const prompt = createPrompt(options);
  const manage = options.manage || createRegistrationHandler(core);
  try {
    let state = await manage({ action: 'start' });
    if (!state?.success && state?.nextAction?.type === 'request_owner_email') {
      throw new Error('Run `voko login` before interactive Agent registration');
    }
    if (!state?.success) throw new Error(state?.error || 'Unable to start registration');
    if (state.nextAction?.type === 'submit_email_code') {
      const code = await askRequired(prompt, '6-digit verification code: ');
      state = await manage({ action: 'verify_email', registrationId: state.registrationId, code });
      if (!state?.success) throw new Error(state?.error || 'Email verification failed');
    }

    if (state.nextAction?.type === 'select_provider' || state.nextAction?.type === 'select_provider_instance') {
      const detected = Array.isArray(state.environment?.detected) ? state.environment.detected : [];
      const providers = [...detected, state.environment?.fallback || { type: 'others', label: 'Others', instances: [] }];
      write(output, 'Available Agent providers:');
      providers.forEach((item: any, index: number) => write(output, `  ${index + 1}. ${item.label || item.type}`));
      const selected = providers[chooseIndex(String(await prompt.question('Provider [1]: ')), providers.length)];
      const instances = Array.isArray(selected.instances) ? selected.instances : [];
      let instanceId = '';
      if (instances.length > 1) {
        instances.forEach((item: any, index: number) => write(output, `  ${index + 1}. ${item.name || item.id}`));
        instanceId = instances[chooseIndex(String(await prompt.question('Instance [1]: ')), instances.length)].id;
      } else if (instances.length === 1) instanceId = instances[0].id;
      state = await manage({ action: 'select_provider', registrationId: state.registrationId, providerType: selected.type, instanceId });
      if (!state?.success) throw new Error(state?.error || 'Unable to select Provider');
    }

    const suggested = state.suggestedBasicInfo || {};
    const suggestedName = String(suggested.agentName || '').trim();
    const enteredName = String(await prompt.question(`Agent name${suggestedName ? ` [${suggestedName}]` : ''}: `)).trim();
    const agentName = enteredName || suggestedName;
    if (!agentName) throw new Error('Agent name is required');
    const description = String(await prompt.question(`Description${suggested.description ? ` [${suggested.description}]` : ' (optional)'}: `)).trim()
      || String(suggested.description || '');
    const category = String(await prompt.question(`Category [${suggested.category || 'general'}]: `)).trim()
      || String(suggested.category || 'general');
    const tagsText = String(await prompt.question(`Tags, comma-separated${suggested.tags?.length ? ` [${suggested.tags.join(',')}]` : ''}: `)).trim();
    const tags = (tagsText || (suggested.tags || []).join(',')).split(',').map((item: string) => item.trim()).filter(Boolean);
    const iconUrl = String(await prompt.question(`Icon${suggested.iconUrl ? ` [${suggested.iconUrl}]` : ' (optional)'}: `)).trim() || String(suggested.iconUrl || '');
    const contactPhone = String(await prompt.question(`Phone${suggested.contactPhone ? ` [${suggested.contactPhone}]` : ' (optional)'}: `)).trim() || String(suggested.contactPhone || '');
    const address = String(await prompt.question(`Address${suggested.address ? ` [${suggested.address}]` : ' (optional)'}: `)).trim() || String(suggested.address || '');
    state = await manage({ action: 'set_basic_info', registrationId: state.registrationId,
      agentName, description, category, tags, iconUrl, contactPhone, address });
    if (!state?.success) throw new Error(state?.error || 'Unable to save Agent information');

    for (const mode of state.deliveryModes || []) {
      if (mode.action !== 'configure') continue;
      if (!await askYesNo(prompt, `Configure ${mode.label || mode.mode}?`, false)) continue;
      const plan = await manage({ action: 'configure_delivery', registrationId: state.registrationId, mode: mode.mode });
      if (!plan?.success) throw new Error(plan?.error || 'Unable to prepare Provider configuration');
      write(output, plan.changePlan?.message || 'Provider configuration will be backed up before changes.');
      if (!await askYesNo(prompt, 'Apply this change?', false)) continue;
      const started = await manage({
        action: 'configure_delivery', registrationId: state.registrationId, mode: mode.mode,
        approved: true, approvalToken: plan.approvalToken,
      });
      if (!started?.success) throw new Error(started?.error || 'Provider configuration failed');
      if (started.taskId) {
        let completed = false;
        for (let attempt = 0; attempt < 60; attempt++) {
          const status = await manage({ action: 'configuration_status', registrationId: state.registrationId, taskId: started.taskId });
          if (status.done) {
            if (!status.ok) throw new Error(status.error || 'Provider configuration failed');
            completed = true;
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        if (!completed) throw new Error('Provider configuration timed out');
      }
      state = await manage({ action: 'status', registrationId: state.registrationId });
    }

    const readyModes = (state.deliveryModes || []).filter((mode: any) => mode.status === 'ready');
    const optionalModes = readyModes.filter((mode: any) => mode.mode !== 'pull');
    const selectedModes: string[] = [];
    for (const mode of optionalModes) {
      if (await askYesNo(prompt, `Enable ${mode.label || mode.mode}?`, mode.selected !== false)) selectedModes.push(mode.mode);
    }
    state = await manage({ action: 'select_delivery', registrationId: state.registrationId, deliveryModes: selectedModes });
    if (!state?.success) throw new Error(state?.error || 'Unable to select delivery modes');
    const accessMode = await askYesNo(prompt, 'Allow public visitors?', false) ? 'public' : 'private';
    state = await manage({ action: 'complete', registrationId: state.registrationId, accessMode });
    if (!state?.success) throw new Error(state?.error || 'Agent registration failed');
    write(output, `Agent registered: ${state.result?.agentName || agentName} (${state.result?.agentId || ''})`);
    return state;
  } finally {
    prompt.close();
  }
}

module.exports = { runInteractiveLogin, runInteractiveRegistration, _test: { chooseIndex, validEmail } };
