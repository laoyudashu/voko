import crypto from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const { resolveZeroClawCommand, resolveZeroClawConfigDir } = require('./dispatcher/zeroclaw-command');

const PROFILE_LEAVES = [
  'level',
  'allowed_commands',
  'allowed_roots',
  'allowed_tools',
  'always_ask',
  'approval_route',
  'auto_approve',
  'block_high_risk_commands',
  'delegation_policy',
  'excluded_tools',
  'firejail_args',
  'forbidden_paths',
  'require_approval_for_medium_risk',
  'sandbox_backend',
  'sandbox_enabled',
  'shell_env_passthrough',
  'workspace_only',
] as const;

export interface ZeroClawNativeContext {
  agentId: string;
  instanceId: string;
  providerSubjectKey: string;
  owned: boolean;
}

export interface ZeroClawNativeObservation {
  config: Record<string, string>;
  nativePolicyDigest: string;
  nativeProfileId: string;
  nativeState: Record<string, unknown>;
}

export interface ZeroClawNativeApplyResult extends ZeroClawNativeObservation {
  lifecycleAction: 'restart_agent_runtime';
}

type CommandRunner = (args: string[], input?: string) => string;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(canonical(value)).digest('hex');
}

function jsonPointer(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}

function errorWithCode(code: string, message: string): Error {
  const error = new Error(message);
  (error as any).code = code;
  return error;
}

export class ZeroClawNativePolicyAdapter {
  readonly configDir: string;
  private readonly runner: CommandRunner;
  private readonly reloadGateway: boolean;

  constructor(options: { configDir?: string; runner?: CommandRunner; reloadGateway?: boolean } = {}) {
    this.configDir = options.configDir ? path.resolve(options.configDir) : resolveZeroClawConfigDir();
    this.reloadGateway = options.reloadGateway === true;
    this.runner = options.runner || ((args, input) => {
      const result = spawnSync(resolveZeroClawCommand(), args, {
        encoding: 'utf8', input, timeout: 10_000, windowsHide: true,
        env: { ...process.env }, maxBuffer: 1024 * 1024,
      });
      if (result.error || result.status !== 0) {
        const diagnostic = String(result.stderr || result.error?.message || 'ZeroClaw command failed')
          .replace(/[\r\n]+/g, ' ').slice(0, 400);
        throw errorWithCode('ZEROCLAW_NATIVE_POLICY_COMMAND_FAILED', diagnostic);
      }
      return String(result.stdout || '');
    });
  }

  private args(command: string[]): string[] {
    return ['config', ...command, '--config-dir', this.configDir];
  }

  private get(pathValue: string): unknown {
    const output = this.runner(this.args(['get', pathValue, '--json']));
    try {
      const value = JSON.parse(output).value;
      if (typeof value === 'string' && /^(?:true|false|null|-?\d+(?:\.\d+)?|[\[{])/.test(value.trim())) {
        try { return JSON.parse(value); } catch {}
      }
      return value;
    }
    catch { throw errorWithCode('ZEROCLAW_NATIVE_POLICY_INVALID_OUTPUT', 'ZeroClaw config get returned invalid JSON'); }
  }

  private readProfile(profileId: string): Record<string, unknown> {
    const profile: Record<string, unknown> = {};
    for (const leaf of PROFILE_LEAVES) {
      try {
        const value = this.get(`risk_profiles.${profileId}.${leaf}`);
        if (value !== undefined && value !== null) profile[leaf] = value;
      } catch (error) {
        // Older ZeroClaw releases may not expose every newer leaf. Missing
        // leaves are intentionally omitted so that the runtime keeps its own
        // version-specific default.
        if (/not[ _-]?found|unknown property/i.test(String((error as any)?.message || ''))) continue;
        throw error;
      }
    }
    try {
      const mode = this.get(`risk_profiles.${profileId}.delegation_policy.mode`);
      if (mode !== undefined && mode !== null) profile.delegation_policy = { mode };
    } catch (error) {
      if (!/not[ _-]?found|unknown property/i.test(String((error as any)?.message || ''))) throw error;
    }
    return profile;
  }

  private readProfiles(): Record<string, Record<string, unknown>> {
    const output = this.runner(this.args(['list', '--filter', 'risk_profiles']));
    const ids = new Set<string>();
    for (const match of output.matchAll(/risk_profiles\.([a-z0-9]+(?:_[a-z0-9]+)*)\./gi)) ids.add(match[1]);
    const profiles: Record<string, Record<string, unknown>> = {};
    for (const id of ids) profiles[id] = this.readProfile(id);
    return profiles;
  }

  private toVokoConfig(profile: Record<string, unknown>): Record<string, string> {
    return {
      autonomyLevel: String(profile.level || 'supervised'),
      requireApprovalForMediumRisk: profile.require_approval_for_medium_risk === false ? 'disabled' : 'enabled',
      blockHighRiskCommands: profile.block_high_risk_commands === false ? 'disabled' : 'enabled',
      workspaceOnly: profile.workspace_only === false ? 'disabled' : 'enabled',
    };
  }

  private fromVokoConfig(profile: Record<string, unknown>, config: Record<string, string>): Record<string, unknown> {
    return {
      ...profile,
      level: config.autonomyLevel,
      require_approval_for_medium_risk: config.requireApprovalForMediumRisk === 'enabled',
      block_high_risk_commands: config.blockHighRiskCommands === 'enabled',
      workspace_only: config.workspaceOnly === 'enabled',
    };
  }

  inspect(context: ZeroClawNativeContext): ZeroClawNativeObservation {
    if (!/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(context.instanceId)) {
      throw errorWithCode('ZEROCLAW_AGENT_ALIAS_INVALID', 'ZeroClaw Agent alias is invalid');
    }
    const profileId = String(this.get(`agents.${context.instanceId}.risk_profile`) || 'default');
    const profile = this.readProfile(profileId);
    const config = this.toVokoConfig(profile);
    return {
      config,
      nativePolicyDigest: digest({ configDir: this.configDir, alias: context.instanceId, profileId, profile }),
      nativeProfileId: profileId,
      nativeState: { profileId, configDirDigest: digest(this.configDir) },
    };
  }

  async apply(context: ZeroClawNativeContext, proposed: Record<string, string>, expectedNativeDigest: string): Promise<ZeroClawNativeApplyResult> {
    const before = this.inspect(context);
    if (expectedNativeDigest && before.nativePolicyDigest !== expectedNativeDigest) {
      throw errorWithCode('PROVIDER_NATIVE_POLICY_CONFLICT', 'ZeroClaw risk profile changed after preflight');
    }
    const profilesBefore = this.readProfiles();
    const sourceProfile = profilesBefore[before.nativeProfileId] || this.readProfile(before.nativeProfileId);
    const desiredProfile = this.fromVokoConfig(sourceProfile, proposed);
    // ZeroClaw 0.8.4 accepts dynamic risk-profile keys through `config set`,
    // but its RFC6902 endpoint rejects add/replace at a dynamic map path. Build
    // an immutable generation first, then atomically switch the Agent alias by
    // JSON Patch. An incomplete generation is never referenced.
    const ownerPrefix = `voko_${digest(context.agentId).slice(0, 8)}`;
    const dedicatedProfile = `${ownerPrefix}_${digest(desiredProfile).slice(0, 8)}`;
    const dedicatedExists = Object.prototype.hasOwnProperty.call(profilesBefore, dedicatedProfile);
    if (dedicatedExists && !context.owned && before.nativeProfileId !== dedicatedProfile) {
      throw errorWithCode('ZEROCLAW_PROFILE_OWNERSHIP_CONFLICT', 'The dedicated ZeroClaw profile already exists without VOKO ownership evidence');
    }

    const aliasPath = `/agents/${jsonPointer(context.instanceId)}/risk_profile`;
    if (!dedicatedExists) {
      for (const [leaf, value] of Object.entries(desiredProfile)) {
        if (leaf === 'delegation_policy' && value && typeof value === 'object') {
          for (const [nestedLeaf, nestedValue] of Object.entries(value as Record<string, unknown>)) {
            this.runner(this.args(['set', `risk_profiles.${dedicatedProfile}.${leaf}.${nestedLeaf}`,
              typeof nestedValue === 'string' ? nestedValue : JSON.stringify(nestedValue)]));
          }
        } else {
          this.runner(this.args(['set', `risk_profiles.${dedicatedProfile}.${leaf}`,
            typeof value === 'string' ? value : JSON.stringify(value)]));
        }
      }
    }
    if (before.nativeProfileId !== dedicatedProfile) this.runner(this.args(['patch', '--json', '-']), JSON.stringify([
      { op: 'test', path: aliasPath, value: before.nativeProfileId },
      { op: 'replace', path: aliasPath, value: dedicatedProfile },
    ]));
    try {
      // A WebSocket reconnect only proves transport connectivity; it does not
      // prove that the long-lived Gateway reread its risk profile. When WS is
      // actually configured, a successful native restart is the apply proof.
      // `gateway restart` transitions into the foreground gateway loop in
      // ZeroClaw 0.8.x, so a synchronous caller waits until timeout and then
      // kills the freshly restarted process. The service lifecycle command is
      // bounded and maps to launchd, systemd or Task Scheduler as appropriate.
      if (this.reloadGateway) this.runner(['service', 'restart', '--config-dir', this.configDir]);
      const after = this.inspect(context);
      if (canonical(after.config) !== canonical(proposed) || after.nativeProfileId !== dedicatedProfile) {
        throw errorWithCode('ZEROCLAW_NATIVE_POLICY_VERIFY_FAILED', 'ZeroClaw did not apply the requested risk profile');
      }
      return { ...after, lifecycleAction: 'restart_agent_runtime' };
    } catch (error) {
      const rollback: Array<Record<string, unknown>> = [
        { op: 'test', path: aliasPath, value: dedicatedProfile },
        { op: 'replace', path: aliasPath, value: before.nativeProfileId },
      ];
      try { this.runner(this.args(['patch', '--json', '-']), JSON.stringify(rollback)); }
      catch { throw errorWithCode('PROVIDER_NATIVE_POLICY_DRIFTED', 'ZeroClaw apply and rollback both failed'); }
      throw error;
    }
  }

  recover(context: ZeroClawNativeContext, pending: Record<string, string>, applied: Record<string, string>): 'pending'|'applied'|'drifted' {
    const observed = this.inspect(context).config;
    if (canonical(observed) === canonical(pending)) return 'pending';
    if (canonical(observed) === canonical(applied)) return 'applied';
    return 'drifted';
  }
}
