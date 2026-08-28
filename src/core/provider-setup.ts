const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn, spawnSync } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

type SetupAction = 'install_workbuddy' | 'login_workbuddy' | 'login_qwen_office' | 'open_dumate';

function launchDetached(command: string, args: string[] = []): void {
  if (!command) throw new Error('PROVIDER_COMMAND_NOT_FOUND');
  if (process.platform === 'win32') {
    // npm providers commonly resolve to .cmd shims, which Node cannot spawn
    // directly without a shell. Run the fixed command in a visible PowerShell
    // terminal and keep it open so login prompts and failures remain readable.
    const setupCwd = path.join(os.homedir(), '.voko', 'provider-login');
    fs.mkdirSync(setupCwd, { recursive: true });
    const env = { ...process.env, VOKO_PROVIDER_SETUP_EXE: command,
      VOKO_PROVIDER_SETUP_ARGS: JSON.stringify(args), VOKO_PROVIDER_SETUP_CWD: setupCwd };
    const interactiveScript = "$Host.UI.RawUI.WindowTitle='VOKO Provider Login'; $a=ConvertFrom-Json $env:VOKO_PROVIDER_SETUP_ARGS; & $env:VOKO_PROVIDER_SETUP_EXE @a";
    const interactiveEncoded = Buffer.from(interactiveScript, 'utf16le').toString('base64');
    // Use Start-Process as the Windows desktop process API. A short hidden
    // launcher creates an independent normal PowerShell window; neither the
    // title nor provider paths pass through cmd.exe/start string parsing.
    const launcherScript = `Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile','-NoExit','-EncodedCommand','${interactiveEncoded}' -WorkingDirectory $env:VOKO_PROVIDER_SETUP_CWD -WindowStyle Normal`;
    const launcherEncoded = Buffer.from(launcherScript, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', launcherEncoded], {
      detached: true, stdio: 'ignore', windowsHide: true, env,
    });
    child.unref();
    return;
  }
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

function findWindowsDuMateApp(): string | null {
  const candidates = [
    path.join(String(process.env.LOCALAPPDATA || ''), 'Programs', 'DuMate', 'DuMate.exe'),
    path.join(String(process.env.ProgramFiles || 'C:\\Program Files'), 'DuMate', 'DuMate.exe'),
    path.join(String(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'), 'DuMate', 'DuMate.exe'),
  ];
  for (const hive of ['HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall']) {
    try {
      const result = spawnSync('reg.exe', ['query', hive, '/s', '/f', 'DuMate'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
      const text = String(result.stdout || '');
      const icon = text.match(/^\s*DisplayIcon\s+REG_SZ\s+(.+)$/mi)?.[1]?.trim().replace(/^"|"$/g, '').replace(/,\d+$/, '');
      const root = text.match(/^\s*InstallLocation\s+REG_SZ\s+(.+)$/mi)?.[1]?.trim();
      if (icon) candidates.unshift(icon);
      if (root) candidates.unshift(path.join(root, 'DuMate.exe'));
    } catch {}
  }
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

export function getProviderManualCommand(providerType: unknown): string {
  const type = String(providerType || '');
  if (type === 'workbuddy') return 'codebuddy';
  if (type === 'qwen-office') {
    const { qwenOfficeLoginCommand } = require('./dispatcher/qwen-office-command');
    return qwenOfficeLoginCommand();
  }
  if (type === 'dumate') {
    if (process.platform === 'darwin') return 'open -a DuMate';
    if (process.platform === 'win32') {
      const command = findWindowsDuMateApp();
      return command ? `Start-Process -FilePath '${command.replace(/'/g, "''")}'` : 'Start-Process DuMate';
    }
  }
  return '';
}

async function installWorkBuddy(): Promise<Record<string, unknown>> {
  let npmCommand = 'npm';
  let npmArgs = ['install', '-g', '@tencent-ai/codebuddy-code'];
  if (process.platform === 'win32') {
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (!fs.existsSync(npmCli)) throw new Error('NPM_NOT_FOUND');
    // npm.cmd is a command script, not a Windows executable. Passing it to
    // execFile() can fail before npm starts with `spawn EINVAL`. Running npm's
    // JavaScript entry point with the current Node executable is shell-free and
    // is unaffected by PowerShell execution policy.
    npmCommand = process.execPath;
    npmArgs = [npmCli, ...npmArgs];
  }
  const result = await execFileAsync(npmCommand, npmArgs, {
    encoding: 'utf8', windowsHide: true, timeout: 180_000, maxBuffer: 2 * 1024 * 1024,
  });
  const { invalidateWorkBuddyRuntime, resolveWorkBuddyRuntime, probeWorkBuddyCliVersion } = require('./dispatcher/workbuddy-command');
  invalidateWorkBuddyRuntime();
  const runtime = resolveWorkBuddyRuntime();
  if (!runtime.command) throw new Error('WORKBUDDY_INSTALL_VERIFY_FAILED');
  return { installed: true, componentStatus: 'installed', version: probeWorkBuddyCliVersion(runtime), summary: String(result.stdout || '').trim().split(/\r?\n/).slice(-3) };
}

export async function runProviderSetup(actionValue: unknown): Promise<Record<string, unknown>> {
  const action = String(actionValue || '') as SetupAction;
  if (action === 'install_workbuddy') return installWorkBuddy();
  if (action === 'login_workbuddy') {
    const { resolveWorkBuddyRuntime, workBuddySpawnCommand } = require('./dispatcher/workbuddy-command');
    const launch = workBuddySpawnCommand(resolveWorkBuddyRuntime());
    if (!launch) throw new Error('WORKBUDDY_CLI_NOT_INSTALLED');
    // `/login` is an in-TUI slash command, not a CLI argument. Passing it on the
    // command line is treated as a prompt and exits immediately while logged out.
    launchDetached(launch.command, [...launch.argsPrefix]);
    return { launched: true, interactionRequired: true, instruction: '在打开的 CodeBuddy 终端中输入 /login' };
  }
  if (action === 'login_qwen_office') {
    const { resolveQwenOfficeCommand, invalidateQwenOfficeReadiness } = require('./dispatcher/qwen-office-command');
    const command = resolveQwenOfficeCommand();
    if (!command) throw new Error('QWEN_OFFICE_CLI_NOT_INSTALLED');
    invalidateQwenOfficeReadiness(command);
    launchDetached(command, ['login']);
    return { launched: true };
  }
  if (action === 'open_dumate') {
    if (process.platform === 'darwin') launchDetached('/usr/bin/open', ['-a', 'DuMate']);
    else if (process.platform === 'win32') {
      const command = findWindowsDuMateApp();
      if (!command) throw new Error('DUMATE_APP_NOT_FOUND');
      launchDetached(command);
    } else throw new Error('DUMATE_DESKTOP_UNSUPPORTED');
    return { launched: true };
  }
  throw new Error('PROVIDER_SETUP_ACTION_NOT_ALLOWED');
}

module.exports = { runProviderSetup, getProviderManualCommand };
