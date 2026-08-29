#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { parseArgs } = require('./real-browser-worker');

const SAFE_PATHS = [
  '/', '/agent/add?new=1', '/capabilities', '/audit-rules', '/bug-report',
  '/interventions', '/invite', '/payment-auth', '/payments', '/send-message',
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = new URL(args.url || 'http://127.0.0.1:3100/');
  const artifactDir = path.resolve(args.artifact || path.join(process.cwd(), 'voko-web-artifact'));
  const profileDir = path.resolve(args.profile || path.join(artifactDir, 'profile'));
  fs.mkdirSync(artifactDir, { recursive: true });
  const launchOptions = { headless: args.headed ? false : true };
  if (args.executable) launchOptions.executablePath = args.executable;
  const context = await chromium.launchPersistentContext(profileDir, launchOptions);
  const page = context.pages()[0] || await context.newPage();
  const pages = [];
  const paths = [...SAFE_PATHS];
  if (args.deep) {
    await page.goto(baseUrl.href, { waitUntil: 'domcontentloaded', timeout: Number(args.timeout || 30_000) });
    const links = await page.locator('a[href]').evaluateAll(elements => elements.map(element => element.getAttribute('href')));
    for (const href of links) {
      if (!href || !(/^\/agents\/[a-zA-Z0-9-]+(?:\/caps|\/edit)?$/.test(href)
          || /^\/external-integrations\?agentId=[a-zA-Z0-9-]+$/.test(href))) continue;
      if (!paths.includes(href)) paths.push(href);
    }
  }

  for (const safePath of paths) {
    const url = new URL(safePath, baseUrl);
    const consoleErrors = [];
    const pageErrors = [];
    const failedRequests = [];
    const onConsole = message => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 400)); };
    const onPageError = error => pageErrors.push(String(error.message || error).slice(0, 400));
    const onRequestFailed = request => failedRequests.push(request.url().replace(/[?#].*$/, ''));
    page.on('console', onConsole);
    page.on('pageerror', onPageError);
    page.on('requestfailed', onRequestFailed);
    const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: Number(args.timeout || 30_000) });
    await page.waitForTimeout(250);
    const bodyText = await page.locator('body').innerText().catch(() => '');
    const metrics = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      forms: document.forms.length,
      buttons: document.querySelectorAll('button').length,
      dialogs: document.querySelectorAll('dialog').length,
    }));
    const item = {
      path: safePath,
      status: response?.status() || 0,
      title: await page.title(),
      bodyChars: bodyText.length,
      blank: bodyText.trim().length === 0,
      horizontalOverflow: metrics.scrollWidth > metrics.clientWidth + 2,
      ...metrics,
      consoleErrors,
      pageErrors,
      failedRequests,
    };
    item.ok = item.status >= 200 && item.status < 400 && !item.blank && pageErrors.length === 0;
    pages.push(item);
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
    page.off('requestfailed', onRequestFailed);
    if (safePath === '/' || safePath.startsWith('/agent/add')) {
      const name = safePath === '/' ? 'home.png' : 'agent-add.png';
      await page.screenshot({ path: path.join(artifactDir, name), fullPage: true });
    }
  }

  const parkedResponse = await page.goto(new URL('/trusted-remote', baseUrl).href, {
    waitUntil: 'domcontentloaded', timeout: Number(args.timeout || 30_000),
  });
  const parkedOwnerIo = { status: parkedResponse?.status() || 0, hidden: parkedResponse?.status() === 404 };
  const result = {
    ok: pages.every(pageResult => pageResult.ok) && parkedOwnerIo.hidden,
    baseUrl: baseUrl.href,
    pages,
    parkedOwnerIo,
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
