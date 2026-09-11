export {};

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const { getHermesDir, getHermesProfilesDir } = require('../core/hermes-paths');
const { resolveHermesCommand } = require('../core/dispatcher/hermes-command');
let lastDiscoveryStatus:{ok:boolean;reason:string;detail:string;source:string|null;at:number}=
  {ok:false,reason:'not_run',detail:'',source:null,at:0};

/** Profile metadata is local. Do not start Python or scan skills to populate a picker. */
function readLocalProfiles() {
  const root = getHermesDir();
  try { if (!fs.statSync(root).isDirectory()) return null; }
  catch (_) { return null; }
  const profilesDir = path.join(root, 'profiles');
  const names = ['default'];
  try {
    for (const entry of fs.readdirSync(profilesDir).sort()) {
      if (entry !== 'default' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(entry)
        && fs.statSync(path.join(profilesDir, entry), { throwIfNoEntry: false })?.isDirectory()) names.push(entry);
    }
  } catch (error: any) { if (error.code !== 'ENOENT') return null; }
  let active = 'default';
  try { active = fs.readFileSync(path.join(root, 'active_profile'), 'utf8').trim() || 'default'; }
  catch (_) {}
  const configuredHome = String(process.env.HERMES_HOME || '').trim();
  if (configuredHome && path.resolve(path.dirname(configuredHome)) === path.resolve(profilesDir)) {
    active = path.basename(configuredHome);
  }
  if (!names.includes(active)) active = 'default';
  return names.map(name => {
    let model = 'unknown';
    try {
      const file = path.join(name === 'default' ? root : path.join(profilesDir, name), 'config.yaml');
      const document = YAML.parseDocument(fs.readFileSync(file, 'utf8'), { version: '1.1', prettyErrors: false });
      if (!document.errors.length) {
        const value = document.toJS()?.model;
        const selected = typeof value === 'string' ? value : value?.default || value?.model;
        if (typeof selected === 'string' && selected) model = selected;
      }
    } catch (_) { /* Missing/malformed model settings do not remove a native profile. */ }
    return { name, model, isDefault: name === active };
  });
}

/**
 * 发现 Hermes 下的所有 profiles（agents）
 * 从 demo/discover.js 适配而来
 * 返回: [{ name, model, isDefault }]
 */
function discoverHermes() {
  const local = readLocalProfiles();
  if (local) {
    lastDiscoveryStatus = { ok: true, reason: 'ready', detail: '', source: 'profiles_directory', at: Date.now() };
    return local;
  }
  const profiles = [];
  let cliFailure: { reason:string; detail:string } | null = null;

  // 方案1：解析 hermes profile list 输出（用 spawnSync 避免 Windows cmd.exe 乱码）
  try {
    let result = spawnSync(resolveHermesCommand(), ['profile', 'list'], {
      encoding: 'utf-8',
      timeout: 2000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    if (result.error?.code === 'ETIMEDOUT') {
      result = spawnSync(resolveHermesCommand(), ['profile', 'list'], {
        encoding: 'utf-8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
    }
    if (result.error || result.status !== 0) throw result.error || new Error('non-zero exit');
    const output = result.stdout;
    const lines = output.split('\n').filter((l?: any) => l.trim());

    let parsing = false;
    for (const line of lines) {
      if (line.includes('───')) {
        parsing = true;
        continue;
      }
      if (!parsing) continue;

      const trimmed = line.trim();
      if (!trimmed) continue;

      const isDefault = trimmed.startsWith('◆');
      const clean = trimmed.replace(/^◆\s*/, '');
      // Hermes aligns some rows with a single space when the profile name
      // reaches the model column.  Fall back to token parsing in that case so
      // the persisted profile id does not include the model text.
      let parts = clean.split(/\s{2,}/).map((s?: any) => s.trim());
      if (parts.length === 1) {
        const tokens = clean.split(/\s+/).filter(Boolean);
        if (tokens.length > 1) parts = [tokens[0], tokens[1]];
      } else if (/\s/.test(parts[0])) {
        const tokens = parts[0].split(/\s+/).filter(Boolean);
        if (tokens.length > 1) parts = [tokens[0], tokens.slice(1).join(' ') || parts[1]];
      }

      if (parts.length >= 1) {
        profiles.push({
          name: parts[0],
          model: parts[1] || 'unknown',
          isDefault
        });
      }
    }
  } catch (err: any) {
    const code=String(err?.code||'');
    const reason=code==='ENOENT'?'not_found':code==='ETIMEDOUT'?'timeout':
      err?.message==='non-zero exit'?'nonzero':'status_failed';
    cliFailure={reason,detail:code||String(err?.message||'unknown')};
    console.warn(`[HermesDiscover] CLI discovery failed reason=${reason} detail=${cliFailure.detail}`);
  }

  // 方案2：回退读取 profiles 目录
  if (profiles.length === 0) {
    const profilesDir = getHermesProfilesDir();
    try {
      if (fs.existsSync(profilesDir)) {
        const dirs = fs.readdirSync(profilesDir);
        for (const dir of dirs) {
          const configPath = path.join(profilesDir, dir, 'config.yaml');
          let model = 'unknown';
          if (fs.existsSync(configPath)) {
            const configContent = fs.readFileSync(configPath, 'utf-8');
            const modelMatch = configContent.match(/default:\s*(\S+)/);
            if (modelMatch) model = modelMatch[1];
          }
          profiles.push({ name: dir, model, isDefault: false });
        }
      }
    } catch (err: any) {
      console.warn('[HermesDiscover] 读取 profiles 目录失败:', err.message);
    }
  }

  if (profiles.length === 0 && cliFailure) {
    console.warn(`[HermesDiscover] no profiles discovered reason=${cliFailure.reason}`);
  }
  lastDiscoveryStatus={
    ok:profiles.length>0,
    reason:profiles.length>0?'ready':(cliFailure?.reason||'no_profiles'),
    detail:cliFailure?.detail||'',
    source:profiles.length>0?(cliFailure?'profiles_directory':'cli'):null,
    at:Date.now(),
  };
  return profiles;
}

function getLastHermesDiscoveryStatus(){return {...lastDiscoveryStatus};}

module.exports = { discoverHermes, getLastHermesDiscoveryStatus };
