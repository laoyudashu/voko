const fs = require('node:fs');
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
    const env = { ...process.env, VOKO_PROVIDER_SETUP_EXE: command, VOKO_PROVIDER_SETUP_ARGS: JSON.stringify(args) };
    const script = '$a=ConvertFrom-Json $env:VOKO_PROVIDER_SETUP_ARGS; & $env:VOKO_PROVIDER_SETUP_EXE @a';
    const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-NoExit', '-EncodedCommand', encodedScript], {
      detached: true, stdio: 'ignore', windowsHide: false, env,
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

async function installWorkBuddy(): Promise<Record<string, unknown>> {
  const npmCommand = process.platform === 'win32'
    ? path.join(path.dirname(process.execPath), 'npm.cmd')
    : 'npm';
  if (process.platform === 'win32' && !fs.existsSync(npmCommand)) throw new Error('NPM_NOT_FOUND');
  const result = await execFileAsync(npmCommand, ['install', '-g', '@tencent-ai/codebuddy-code'], {
    encoding: 'utf8', windowsHide: true, timeout: 180_000, maxBuffer: 2 * 1024 * 1024,
  });
  const { invalidateWorkBuddyRuntime, resolveWorkBuddyRuntime, probeWorkBuddyCliVersion } = require('./dispatcher/workbuddy-command');
  invalidateWorkBuddyRuntime();
  const runtime = resolveWorkBuddyRuntime();
  if (!runtime.command) throw new Error('WORKBUDDY_INSTALL_VERIFY_FAILED');
  return { installed: true, version: probeWorkBuddyCliVersion(runtime), summary: String(result.stdout || '').trim().split(/\r?\n/).slice(-3) };
}

export async function runProviderSetup(actionValue: unknown): Promise<Record<string, unknown>> {
  const action = String(actionValue || '') as SetupAction;
  if (action === 'install_workbuddy') return installWorkBuddy();
  if (action === 'login_workbuddy') {
    const { resolveWorkBuddyRuntime, workBuddySpawnCommand } = require('./dispatcher/workbuddy-command');
    const launch = workBuddySpawnCommand(resolveWorkBuddyRuntime());
    if (!launch) throw new Error('WORKBUDDY_CLI_NOT_INSTALLED');
    launchDetached(launch.command, [...launch.argsPrefix, '/login']);
    return { launched: true };
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

module.exports = { runProviderSetup };
