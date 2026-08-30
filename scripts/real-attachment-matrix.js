#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { createReporter, loadEnv } = require('./real-test');
const { configFromEnv, pollResult, resolveAgent } = require('./real-matrix');

const ROOT = path.join(__dirname, '..');
const ENV_FILE = path.resolve(process.env.VOKO_REAL_MATRIX_ENV || path.join(ROOT, '.env.real-matrix.local'));
const ARTIFACT_ROOT = path.join(ROOT, 'artifacts', 'real-tests');

const CASES = [
  { senderHost: 'macos', sender: ['TEST-MAC-QWEN-CODE', 'qwen-code'], targetHost: 'windows', target: ['TEST-WINDOWS-QWEN-CODE', 'qwen-code'], kind: 'file' },
  { senderHost: 'macos', sender: ['TEST-MAC-GOOSE', 'goose'], targetHost: 'windows', target: ['TEST-WINDOWS-OPENCODE', 'opencode'], kind: 'image' },
  { senderHost: 'windows', sender: ['TEST-WINDOWS-ZEROCLAW', 'zeroclaw'], targetHost: 'linux', target: ['TEST-LINUX-REASONIX', 'reasonix'], kind: 'file' },
  { senderHost: 'windows', sender: ['TEST-WINDOWS-CLAUDE-CODE', 'claude-code'], targetHost: 'linux', target: ['TEST-LINUX-HERMES-HUMAN', 'hermes'], kind: 'image' },
  { senderHost: 'linux', sender: ['TEST-LINUX-HERMES-HUMAN', 'hermes'], targetHost: 'macos', target: ['TEST-MAC-QWEN-CODE', 'qwen-code'], kind: 'file' },
  { senderHost: 'linux', sender: ['TEST-LINUX-REASONIX', 'reasonix'], targetHost: 'macos', target: ['TEST-MAC-GITHUB-COPILOT', 'github-copilot'], kind: 'image' },
];

const SAME_OWNER_CASES = [
  { senderHost: 'macos', sender: ['TEST-MAC-CODEX', 'codex'], targetHost: 'macos', target: ['TEST-MAC-HERMES', 'hermes'], kind: 'file' },
  { senderHost: 'macos', sender: ['TEST-MAC-CODEX', 'codex'], targetHost: 'macos', target: ['TEST-MAC-HERMES', 'hermes'], kind: 'image' },
  { senderHost: 'windows', sender: ['TEST-WINDOWS-GOOSE', 'goose'], targetHost: 'windows', target: ['TEST-WINDOWS-AIDER', 'aider'], kind: 'file' },
  { senderHost: 'windows', sender: ['TEST-WINDOWS-GOOSE', 'goose'], targetHost: 'windows', target: ['TEST-WINDOWS-AIDER', 'aider'], kind: 'image' },
  { senderHost: 'linux', sender: ['TEST-LINUX-HERMES', 'hermes'], targetHost: 'linux', target: ['TEST-LINUX-OPENCODE', 'opencode'], kind: 'file' },
  { senderHost: 'linux', sender: ['TEST-LINUX-HERMES', 'hermes'], targetHost: 'linux', target: ['TEST-LINUX-OPENCODE', 'opencode'], kind: 'image' },
];

const FILES = {
  macos: {
    file: path.join(ROOT, 'artifacts', 'real-inputs', 'voko-real-test.txt'),
    image: path.join(ROOT, 'artifacts', 'real-tests', 'web-mac-current-final', 'home.png'),
  },
  windows: {
    file: 'C:\\Users\\laoyu\\AppData\\Local\\VOKO\\real-inputs\\voko-real-test.txt',
    image: 'C:\\Users\\laoyu\\AppData\\Local\\VOKO\\real-inputs\\voko-real-test.png',
  },
  linux: {
    file: '/home/tjyu/.local/share/voko-real-inputs/voko-real-test.txt',
    image: '/home/tjyu/.local/share/voko-real-inputs/voko-real-test.png',
  },
};

function selector(pair) { return { agentName: pair[0], backendType: pair[1] }; }

function resultMessageId(result) {
  return result?.messageId || result?.fileMessageId || result?.attachmentMessageId || null;
}

async function main() {
  loadEnv(ENV_FILE);
  const config = configFromEnv();
  const reporter = createReporter('attachment-matrix', ARTIFACT_ROOT);
  const caseFilter = String(process.env.VOKO_REAL_ATTACHMENT_CASE || '').trim();
  const topology = String(process.env.VOKO_REAL_MATRIX_TOPOLOGY || 'cross-owner').trim();
  const configuredCases = topology === 'same-owner' ? SAME_OWNER_CASES : CASES;
  const cases = caseFilter ? configuredCases.filter(item => `${item.senderHost}:${item.kind}` === caseFilter) : configuredCases;
  if (!cases.length) throw new Error(`no attachment case matched ${caseFilter}`);
  const inventories = Object.fromEntries(Object.entries(config.hosts).map(([name, host]) => [name, host.inventory()]));
  // Keep the production visibility policy intact. Dedicated cross-owner test
  // Agents need durable visibility or friendship before this matrix is run.
  for (const item of cases) {
    const senderHost = config.hosts[item.senderHost];
    const sender = resolveAgent(inventories[item.senderHost], selector(item.sender));
    const target = resolveAgent(inventories[item.targetHost], selector(item.target));
    const marker = `${reporter.runId}-${item.senderHost}-${item.kind}`;
    try {
      const sent = senderHost.json(['upload_and_send_file', '--agentId', sender.agentId, '--toUid', target.imUid,
        '--channelType', '1', '--filePath', FILES[item.senderHost][item.kind],
        '--message', `VOKO附件真机测试 ${marker}。请确认附件类型并简短回复。`, '--json'], 180_000);
      const messageId = resultMessageId(sent);
      reporter.check(`${item.senderHost} ${item.kind} upload accepted`, sent.success !== false && !!messageId,
        `target=${item.target[0]} message=${messageId ? 'present' : 'missing'}`);
      if (!messageId) continue;
      const result = await pollResult(senderHost, sender.agentId, messageId, 300_000);
      const completed = result?.execution?.state === 'COMPLETED'
        && result?.execution?.phase === 'reply' && result?.reply?.state === 'DELIVERED';
      reporter.check(`${item.targetHost} ${item.target[0]} processed ${item.kind}`, completed,
        `execution=${result?.execution?.state || 'unknown'} reply=${result?.reply?.state || 'unknown'}`);
    } catch (error) {
      const detail = String(error?.message || error);
      const accessHint = /PEER_NOT_FOUND|E2EE_V2_DIRECTORY_HTTP_404/.test(detail)
        ? ' Durable cross-owner visibility/friendship is required; the matrix does not change Agent visibility.'
        : '';
      reporter.check(`${item.senderHost} to ${item.targetHost} ${item.kind} loop`, false, detail + accessHint);
    }
  }
  process.exitCode = reporter.finish() ? 0 : 1;
}

if (require.main === module) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

module.exports = { resultMessageId, selector };
