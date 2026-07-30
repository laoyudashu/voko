const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Hermes 根目录候选路径（按优先级）
 * Windows: %LOCALAPPDATA%\hermes（默认安装） → ~/.hermes
 * 其他平台: ~/.hermes
 */
function getHermesDirCandidates() {
  const candidates = [];
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) candidates.push(path.join(localAppData, 'hermes'));
  }
  candidates.push(path.join(os.homedir(), '.hermes'));
  return candidates;
}

/** 返回第一个存在的 Hermes 根目录，均不存在则 null */
function findHermesDir() {
  for (const dir of getHermesDirCandidates()) {
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

/** Hermes 根目录：优先用已存在的，否则用默认候选（写入场景） */
function getHermesDir() {
  return findHermesDir() || getHermesDirCandidates()[0];
}

function getHermesProfilesDir() {
  return path.join(getHermesDir(), 'profiles');
}

function getHermesProfilePath(profileName, ...segments) {
  return path.join(getHermesProfilesDir(), profileName, ...segments);
}

function getHermesEnvPath() {
  return path.join(getHermesDir(), '.env');
}

function getHermesConfigPath() {
  return path.join(getHermesDir(), 'config.yaml');
}

module.exports = {
  getHermesDirCandidates,
  findHermesDir,
  getHermesDir,
  getHermesProfilesDir,
  getHermesProfilePath,
  getHermesEnvPath,
  getHermesConfigPath,
};
