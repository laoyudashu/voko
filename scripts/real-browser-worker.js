#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith('--')) continue;
    const key = current.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) values[key] = true;
    else { values[key] = next; index += 1; }
  }
  return values;
}

function markerOccurrence(text, marker) {
  if (!marker) return 0;
  return String(text || '').split(String(marker)).length - 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url) throw new Error('--url is required');
  const artifactDir = path.resolve(args.artifact || path.join(process.cwd(), 'browser-artifact'));
  const profileDir = path.resolve(args.profile || path.join(artifactDir, 'profile'));
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.mkdirSync(profileDir, { recursive: true });

  const browserOptions = {
    headless: args.headed ? false : true,
    viewport: { width: Number(args.width || 1280), height: Number(args.height || 800) },
  };
  if (args.executable) browserOptions.executablePath = args.executable;
  const context = await chromium.launchPersistentContext(profileDir, browserOptions);
  const page = context.pages()[0] || await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const requestFailures = [];
  const httpErrors = [];
  const dialogs = [];
  const websockets = [];
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 500));
  });
  page.on('pageerror', error => pageErrors.push(String(error.message || error).slice(0, 500)));
  page.on('requestfailed', request => requestFailures.push({
    url: request.url().replace(/[?#].*$/, ''),
    reason: request.failure()?.errorText || 'unknown',
  }));
  page.on('response', response => {
    if (response.status() >= 400) httpErrors.push({
      status: response.status(),
      url: response.url().replace(/[?#].*$/, ''),
    });
  });
  page.on('dialog', async dialog => {
    dialogs.push({ type: dialog.type(), message: dialog.message().slice(0, 300) });
    await dialog.dismiss();
  });
  page.on('websocket', socket => {
    const entry = { url: socket.url().replace(/[?#].*$/, ''), closed: false, errors: [] };
    websockets.push(entry);
    socket.on('close', () => { entry.closed = true; });
    socket.on('socketerror', error => entry.errors.push(String(error).slice(0, 300)));
  });

  const startedAt = Date.now();
  await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: Number(args.timeout || 60_000) });
  const chatComposer = page.locator('div.bg-white.border-t input[type="text"]').last();
  await chatComposer.waitFor({ state: 'attached', timeout: Number(args.timeout || 60_000) });
  const input = chatComposer;
  await page.waitForFunction(() => {
    const candidates = Array.from(document.querySelectorAll('div.bg-white.border-t input[type="text"]'));
    const candidate = candidates[candidates.length - 1];
    return candidate && !candidate.disabled;
  }, null, { timeout: Number(args.readyTimeout || 45_000) });
  const uploadButton = page.locator('button[title]').filter({ has: page.locator('svg') }).first();
  const messageViewport = page.locator('.overflow-y-auto').filter({ has: page.locator('.space-y-4, .rounded-2xl') }).first();
  await page.screenshot({ path: path.join(artifactDir, 'chat-ready.png'), fullPage: true });

  let turn = null;
  if (args.message) {
    const marker = String(args.expect || args.message);
    const agentBubbles = page.locator('.rounded-2xl:not(.bg-blue-500)');
    const beforeAgentBubbleCount = await agentBubbles.count();
    const beforeLastAgentText = beforeAgentBubbleCount > 0 ? await agentBubbles.last().innerText().catch(() => '') : '';
    const sentAt = Date.now();
    await input.fill(String(args.message));
    await input.press('Enter');
    try {
      await page.waitForFunction(({ count, lastText }) => {
        const bubbles = Array.from(document.querySelectorAll('.rounded-2xl'))
          .filter(element => !element.classList.contains('bg-blue-500'));
        return bubbles.length > count || (bubbles.length > 0 && (bubbles.at(-1).textContent || '') !== lastText);
      }, { count: beforeAgentBubbleCount, lastText: beforeLastAgentText }, { timeout: Number(args.replyTimeout || 180_000) });
      const replyText = await agentBubbles.last().innerText().catch(() => '');
      turn = { submitted: true, sentAt, repliedAt: Date.now(), marker,
        replyMatched: true, markerEchoed: replyText.includes(marker), replyText: replyText.slice(0, 1000) };
    } catch (error) {
      turn = { submitted: true, sentAt, repliedAt: null, marker, replyMatched: false,
        error: String(error.message || error).slice(0, 1000), outcome: 'submitted_result_unknown_no_retry' };
    }
    await page.screenshot({ path: path.join(artifactDir, 'chat-replied.png'), fullPage: true });
  }

  const inputVisible = await input.isVisible();
  const inputEnabled = await input.isEnabled();
  const result = {
    ok: inputVisible && inputEnabled && (!args.message || turn?.replyMatched === true),
    url: page.url(),
    title: await page.title(),
    loadMs: Date.now() - startedAt,
    viewport: page.viewportSize(),
    input: {
      visible: inputVisible,
      enabled: inputEnabled,
      placeholder: await input.getAttribute('placeholder'),
    },
    upload: {
      visible: await uploadButton.isVisible().catch(() => false),
      enabled: await uploadButton.isEnabled().catch(() => false),
      title: await uploadButton.getAttribute('title').catch(() => null),
    },
    messageViewportVisible: await messageViewport.isVisible().catch(() => false),
    processingVisible: await page.getByText('Agent 正在处理…', { exact: true }).isVisible().catch(() => false),
    consoleErrors,
    pageErrors,
    requestFailures,
    httpErrors,
    dialogs,
    websockets,
    turn,
  };
  fs.writeFileSync(path.join(artifactDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  await context.close();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { markerOccurrence, parseArgs };
