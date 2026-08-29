#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const { createReporter } = require('./real-test');
const { parseJson } = require('./real-matrix');

const ROOT = path.join(__dirname, '..');
const ARTIFACT_ROOT = path.join(ROOT, 'artifacts', 'real-tests');

function args(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    result[key.slice(2)] = argv[i + 1];
    i += 1;
  }
  return result;
}

function required(values, key) {
  const value = String(values[key] || '').trim();
  if (!value) throw new Error(`--${key} is required`);
  return value;
}

function run(command, commandArgs, timeout = 60_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd: ROOT, windowsHide: true });
    const output = [];
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${commandArgs[0]} timed out after ${timeout}ms`));
    }, timeout);
    child.stdout.on('data', chunk => output.push(chunk));
    child.stderr.on('data', chunk => output.push(chunk));
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timer);
      const text = Buffer.concat(output).toString('utf8');
      if (code !== 0) reject(new Error(`${commandArgs[0]} exited ${code}: ${text.slice(-1000)}`));
      else resolve(text);
    });
  });
}

async function history(voko, targetAgentId, groupId) {
  const output = await run(voko, ['get_chat_history', '--agentId', targetAgentId, '--channelId', groupId,
    '--channelType', '2', '--limit', '100', '--json']);
  return parseJson(output, 'get_chat_history');
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function confirmsAllSegments(message, marker) {
  const content = String(message?.content || '');
  return ['ALPHA', 'BETA', 'GAMMA'].every(part => content.includes(part));
}

async function main() {
  const values = args(process.argv.slice(2));
  const voko = values.voko || 'voko';
  const senderAgentId = required(values, 'senderAgentId');
  const targetAgentId = required(values, 'targetAgentId');
  const targetImUid = required(values, 'targetImUid');
  const groupId = required(values, 'groupId');
  const reporter = createReporter('group-turn', ARTIFACT_ROOT);
  const marker = values.verifyMarker || `GROUP-TURN-${reporter.runId}`;
  let startedAt = Date.now() - 1_000;
  const parts = [
    `${marker} 第一段 ALPHA。请等后续内容，不要提前回复。`,
    `${marker} 第二段 BETA。请继续等待最后一段。`,
    `${marker} 第三段 GAMMA。现在仅回复 GROUP-MERGED:ALPHA|BETA|GAMMA。`,
  ];
  let latest = null;
  if (values.verifyMarker) {
    latest = await history(voko, targetAgentId, groupId);
    const sources = (latest.messages || []).filter(message => message.agentId === senderAgentId
      && String(message.content || '').includes(marker));
    const timestamps = sources.map(message => Number(message.timestampMs || Number(message.timestamp || 0) * 1000));
    startedAt = timestamps.length ? Math.min(...timestamps) - 1 : Date.now();
    reporter.check('existing group turn marker found', sources.length === 3, `segments=${sources.length}`);
  } else {
    const sends = await Promise.all(parts.map(content => run(voko, ['send_message', '--agentId', senderAgentId,
      '--toUid', groupId, '--channelType', '2', '--content', content,
      '--mentions', JSON.stringify({ all: false, uids: [targetImUid] }), '--json'])));
    const accepted = sends.map((output, index) => parseJson(output, `group send ${index + 1}`));
    reporter.check('three group messages accepted', accepted.every(item => item.success === true && item.messageId),
      `accepted=${accepted.filter(item => item.success === true).length}/3`);
  }

  const deadline = Date.now() + Number(values.timeout || 180_000);
  while (Date.now() < deadline) {
    latest = await history(voko, targetAgentId, groupId);
    const replies = (latest.messages || []).filter(message => message.fromUid === targetImUid
      && Number(message.timestampMs || Number(message.timestamp || 0) * 1000) >= startedAt);
    if (replies.some(message => confirmsAllSegments(message, marker))) break;
    await sleep(3_000);
  }
  const recent = (latest?.messages || []).filter(message =>
    Number(message.timestampMs || Number(message.timestamp || 0) * 1000) >= startedAt);
  const replies = recent.filter(message => message.fromUid === targetImUid);
  const inbound = recent.filter(message => message.fromUid !== targetImUid
    && String(message.content || '').includes(marker));
  reporter.check('group retained all three source segments', inbound.length === 3, `segments=${inbound.length}`);
  reporter.check('group provider replied once for the merged turn', replies.length === 1,
    `replies=${replies.length}`);
  reporter.check('merged reply contains all source segments', replies.length === 1
    && confirmsAllSegments(replies[0], marker),
  replies[0]?.content || 'reply missing');
  reporter.check('reply stayed in the original group', replies.length === 1
    && replies[0].channelType === 2 && replies[0].channelId === groupId,
  replies[0] ? `channelType=${replies[0].channelType} channelId=${replies[0].channelId}` : 'reply missing');
  process.exitCode = reporter.finish() ? 0 : 1;
}

if (require.main === module) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

module.exports = { args, confirmsAllSegments };
