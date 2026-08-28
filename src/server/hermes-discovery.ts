export {};

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { getHermesProfilesDir } = require('../core/hermes-paths');
const { resolveHermesCommand } = require('../core/dispatcher/hermes-command');
let lastDiscoveryStatus:{ok:boolean;reason:string;detail:string;source:string|null;at:number}=
  {ok:false,reason:'not_run',detail:'',source:null,at:0};

/**
 * 发现 Hermes 下的所有 profiles（agents）
 * 从 demo/discover.js 适配而来
 * 返回: [{ name, model, isDefault }]
 */
function discoverHermes() {
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
