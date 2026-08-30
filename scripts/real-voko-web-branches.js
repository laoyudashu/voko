#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { chromium, firefox } = require('playwright');

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) args[key] = true;
    else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

const ROOT = path.join(__dirname, '..');
const SAFE_PATHS = [
  '/', '/agent/add?new=1', '/a2a-tasks', '/capabilities', '/audit-rules', '/bug-report',
  '/interventions', '/invite', '/payment-auth', '/payments', '/send-message',
];
const SKIP_TEXT = /退出|注销|删除|解绑|踢出|退出群|支付|发送消息|创建支付|确认支付/i;
const SKIP_ROLE = /disconnect-owner-device|logout-btn/;

function controlKey(item) {
  return [item.tag, item.role || '', item.type || '', item.text || '', item.href || ''].join('|');
}

async function discoverPaths(page, baseUrl, deep) {
  const paths = [...SAFE_PATHS];
  if (!deep) return paths;
  await gotoWithRetry(page, baseUrl.href, 30_000);
  const links = await page.locator('a[href]').evaluateAll(elements => elements.map(element => element.getAttribute('href')));
  for (const href of links) {
    if (!href || !(/^\/agents\/[a-zA-Z0-9-]+(?:\/caps|\/edit)?$/.test(href)
        || /^\/external-integrations\?agentId=[a-zA-Z0-9-]+$/.test(href))) continue;
    if (!paths.includes(href)) paths.push(href);
  }
  const representative = paths.find(candidate => /^\/agents\/[a-zA-Z0-9-]+$/.test(candidate));
  if (representative) {
    for (const suffix of ['/status', '/whitelist', '/blacklist', '/access-mode', '/visibility',
      '/pricing', '/invite', '/human', '/visitor', '/upload']) {
      paths.push(`${representative}${suffix}`);
    }
    await gotoWithRetry(page, new URL(representative, baseUrl).href, 30_000);
    const detailLinks = await page.locator('a[href]').evaluateAll(elements => elements.map(element => element.getAttribute('href')));
    for (const href of detailLinks) {
      if (!href || !(/^\/agents\/[a-zA-Z0-9-]+\/(?:c|owner-chats|external|a2a)\//.test(href))) continue;
      if (!paths.includes(href)) paths.push(href);
    }
  }
  return paths;
}

async function controlsOn(page) {
  return page.locator('button, summary, input[type="submit"], a[href^="javascript:"]').evaluateAll(elements =>
    elements.map((element, index) => ({
      index,
      tag: element.tagName.toLowerCase(),
      text: String(element.innerText || element.value || element.getAttribute('aria-label') || element.title || '').trim().replace(/\s+/g, ' ').slice(0, 160),
      role: element.getAttribute('data-role') || '',
      type: element.getAttribute('type') || '',
      href: element.getAttribute('href') || '',
      disabled: Boolean(element.disabled),
      visible: typeof element.checkVisibility === 'function'
        ? element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
        : Boolean(element.getClientRects().length),
    })));
}

function uniqueControlKeys(items) {
  return [...new Map(items
    .filter(item => item.visible && !item.disabled)
    .map(item => [controlKey(item), item])).keys()];
}

async function gotoWithRetry(page, url, timeout) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { return await page.goto(url, { waitUntil: 'domcontentloaded', timeout }); }
    catch (error) {
      lastError = error;
      if (attempt === 0) await page.waitForTimeout(500);
    }
  }
  throw lastError;
}

async function clickControl(page, item) {
  const locator = page.locator('button, summary, input[type="submit"], a[href^="javascript:"]').nth(item.index);
  try {
    await locator.click({ timeout: 12_000 });
    return null;
  } catch (firstError) {
    try {
      await page.waitForTimeout(250);
      await locator.click({ timeout: 5_000 });
      return null;
    } catch (secondError) {
      return String(secondError.message || firstError.message || secondError).split('\n').slice(0, 12).join(' ').slice(0, 1200);
    }
  }
}

async function exerciseSequence(page, baseUrl, pagePath, sequence, timeout) {
  const attemptedMutations = [];
  const dialogs = [];
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 500)); });
  page.on('pageerror', error => pageErrors.push(String(error.message || error).slice(0, 500)));
  const response = await gotoWithRetry(page, new URL(pagePath, baseUrl).href, timeout);
  await page.waitForTimeout(600);
  await page.route('**/*', async route => {
    const request = route.request();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      const requestUrl = request.url().replace(/[?#].*$/, '');
      if (request.method() === 'POST' && /\/delivery-channels\/refresh$/.test(requestUrl)) {
        await route.continue();
        return;
      }
      attemptedMutations.push({ method: request.method(), url: requestUrl });
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  page.on('dialog', async dialog => {
    dialogs.push({ type: dialog.type(), message: dialog.message().slice(0, 240) });
    await dialog.dismiss();
  });
  const initialKeys = uniqueControlKeys(await controlsOn(page));
  let clickError = null;
  let item = null;
  for (const key of sequence) {
    const controls = await controlsOn(page);
    item = controls.find(candidate => controlKey(candidate) === key && candidate.visible && !candidate.disabled);
    if (!item) return { sequence, key, status: 'not_visible' };
    if (SKIP_ROLE.test(item.role) || SKIP_TEXT.test(item.text)) return { sequence, key, status: 'skipped_risky', item };
    clickError = await clickControl(page, item);
    if (clickError) break;
    await page.waitForTimeout(180);
  }
  const after = await controlsOn(page);
  const revealedKeys = uniqueControlKeys(after).filter(key => !initialKeys.includes(key));
  const visibleDialogs = await page.locator('dialog[open]').count().catch(() => 0);
  const bodyText = await page.locator('body').innerText().catch(() => '');
  return {
    sequence, key: sequence[sequence.length - 1], item,
    status: clickError ? 'click_failed' : 'clicked', clickError, revealedKeys,
    visibleDialogs, dialogs, attemptedMutations,
    consoleErrors, pageErrors,
    httpStatus: response?.status() || 0,
    feedback: bodyText.slice(-600),
    finalUrl: page.url(),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = new URL(args.url || 'http://127.0.0.1:3100/');
  const artifactDir = path.resolve(args.artifact || path.join(ROOT, 'artifacts', 'real-tests', 'web-branches'));
  fs.mkdirSync(artifactDir, { recursive: true });
  const engine = args.browser === 'firefox' ? firefox : chromium;
  const launch = { headless: args.headed ? false : true };
  if (args.executable) launch.executablePath = args.executable;
  const browser = await engine.launch(launch);
  const discovery = await browser.newPage();
  const paths = args.paths
    ? String(args.paths).split(',').map(value => value.trim()).filter(Boolean)
    : await discoverPaths(discovery, baseUrl, Boolean(args.deep));
  await discovery.close();
  const results = [];
  const seenByPath = {};
  for (const pagePath of paths) {
    const page = await browser.newPage();
    const response = await gotoWithRetry(page, new URL(pagePath, baseUrl).href, Number(args.timeout || 30_000));
    const controls = (await controlsOn(page)).filter(item => item.visible && !item.disabled);
    await page.close();
    const unique = uniqueControlKeys(controls);
    seenByPath[pagePath] = { status: response?.status() || 0, visibleControls: controls.length, uniqueBranches: unique.length };
    for (const key of unique) {
      const branchPage = await browser.newPage();
      try {
        const first = await exerciseSequence(branchPage, baseUrl, pagePath, [key], Number(args.timeout || 30_000));
        results.push({ path: pagePath, ...first });
        for (const revealedKey of first.revealedKeys || []) {
          const nestedPage = await browser.newPage();
          try {
            results.push({ path: pagePath, nested: true,
              ...(await exerciseSequence(nestedPage, baseUrl, pagePath, [key, revealedKey], Number(args.timeout || 30_000))) });
          } catch (error) {
            results.push({ path: pagePath, nested: true, sequence: [key, revealedKey], key: revealedKey,
              status: 'branch_failed', error: String(error.message || error).slice(0, 500) });
          } finally {
            await nestedPage.close();
          }
        }
      } catch (error) {
        results.push({ path: pagePath, sequence: [key], key, status: 'branch_failed', error: String(error.message || error).slice(0, 500) });
      } finally {
        await branchPage.close();
      }
    }
    fs.writeFileSync(path.join(artifactDir, 'progress.json'), `${JSON.stringify({
      completedPaths: Object.keys(seenByPath).length,
      totalPaths: paths.length,
      currentPath: pagePath,
      branches: results.length,
      failed: results.filter(item => ['click_failed', 'branch_failed'].includes(item.status)).length,
    }, null, 2)}\n`);
  }
  await browser.close();
  const summary = {
    ok: results.every(item => !['click_failed', 'branch_failed'].includes(item.status) && !(item.pageErrors?.length)),
    baseUrl: baseUrl.href,
    browser: args.browser || 'chromium',
    paths: paths.length,
    branches: results.length,
    clicked: results.filter(item => item.status === 'clicked').length,
    skippedRisky: results.filter(item => item.status === 'skipped_risky').length,
    failed: results.filter(item => ['click_failed', 'branch_failed'].includes(item.status)).length,
    mutationBranchesObserved: results.filter(item => item.attemptedMutations?.length).length,
    pageErrorBranches: results.filter(item => item.pageErrors?.length).length,
    seenByPath,
    results,
  };
  fs.writeFileSync(path.join(artifactDir, 'result.json'), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ...summary, results: undefined }, null, 2)}\n`);
  process.exitCode = summary.ok ? 0 : 1;
}

if (require.main === module) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

module.exports = { controlKey };
