#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SAFE_PATHS = ['/', '/agent/add?new=1', '/a2a-tasks', '/capabilities', '/audit-rules',
  '/bug-report', '/interventions', '/invite', '/payment-auth', '/payments', '/send-message'];
const SKIP_TEXT = /退出|注销|删除|解绑|踢出|退出群|支付|发送消息|创建支付|确认支付/i;
const SKIP_ROLE = /disconnect-owner-device|logout-btn/;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) out[key] = true;
    else out[key] = argv[++i];
  }
  return out;
}

async function request(port, method, endpoint, body) {
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.value?.error) throw new Error(`${method} ${endpoint}: ${json.value?.message || response.status}`);
  return json.value;
}

async function waitReady(port, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { await request(port, 'GET', '/status'); return; } catch { await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  throw new Error('geckodriver did not become ready');
}

const CONTROL_SCRIPT = `return Array.from(document.querySelectorAll('button,summary,input[type="submit"],a[href^="javascript:"]')).map((e,index)=>({index,tag:e.tagName.toLowerCase(),text:String(e.innerText||e.value||e.getAttribute('aria-label')||e.title||'').trim().replace(/\\s+/g,' ').slice(0,160),role:e.getAttribute('data-role')||'',type:e.getAttribute('type')||'',href:e.getAttribute('href')||'',disabled:Boolean(e.disabled),visible:typeof e.checkVisibility==='function'?e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}):Boolean(e.getClientRects().length)}));`;
const BLOCK_SCRIPT = `window.__vokoMutations=[];window.__vokoNativeFetch=window.fetch.bind(window);window.fetch=function(input,init){var method=String(init&&init.method||'GET').toUpperCase();if(!['GET','HEAD','OPTIONS'].includes(method)){window.__vokoMutations.push({method,url:new URL(typeof input==='string'?input:input.url,location.href).pathname});return Promise.resolve(new Response(JSON.stringify({success:false,error:'BLOCKED_BY_TEST'}),{status:409,headers:{'Content-Type':'application/json'}}))}return window.__vokoNativeFetch(input,init)};document.addEventListener('submit',function(e){var f=e.target,method=String(f.method||'GET').toUpperCase();if(method!=='GET'){e.preventDefault();e.stopImmediatePropagation();window.__vokoMutations.push({method,url:new URL(f.action||location.href,location.href).pathname})}},true);return true;`;

function key(item) { return [item.tag, item.role, item.type, item.text, item.href].join('|'); }
function unique(items) { return [...new Map(items.filter(x => x.visible && !x.disabled).map(x => [key(x), x])).keys()]; }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = new URL(args.url || 'http://127.0.0.1:3100/');
  const artifact = path.resolve(args.artifact || 'voko-web-webdriver-artifact');
  fs.mkdirSync(artifact, { recursive: true });
  const port = Number(args.port || 4444);
  const driver = spawn(args.driver || 'geckodriver', ['--port', String(port)], { stdio: ['ignore', 'ignore', 'ignore'] });
  let sessionId;
  const exec = script => request(port, 'POST', `/session/${sessionId}/execute/sync`, { script, args: [] });
  const go = async pagePath => {
    const target = new URL(pagePath, baseUrl).href;
    await request(port, 'POST', `/session/${sessionId}/url`, { url: target });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const current = await request(port, 'GET', `/session/${sessionId}/url`).catch(() => '');
      const ready = await exec('return document.readyState').catch(() => '');
      if (current === target && (ready === 'interactive' || ready === 'complete')) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  };
  try {
    await waitReady(port);
    const session = await request(port, 'POST', '/session', { capabilities: { alwaysMatch: {
      browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless'] },
    } } });
    sessionId = session.sessionId;
    await go('/');
    let paths = [...SAFE_PATHS];
    if (args.deep) {
      const hrefs = await exec("return Array.from(document.querySelectorAll('a[href]')).map(e=>e.getAttribute('href'))");
      for (const href of hrefs) if (/^\/agents\/[a-zA-Z0-9-]+(?:\/caps|\/edit)?$/.test(href)
        || /^\/external-integrations\?agentId=[a-zA-Z0-9-]+$/.test(href)) if (!paths.includes(href)) paths.push(href);
      const representative = paths.find(value => /^\/agents\/[a-zA-Z0-9-]+$/.test(value));
      if (representative) for (const suffix of ['/status', '/whitelist', '/blacklist', '/access-mode', '/visibility',
        '/pricing', '/invite', '/human', '/visitor', '/upload']) paths.push(`${representative}${suffix}`);
    }
    const results = [];
    for (const pagePath of paths) {
      await go(pagePath);
      const initial = await exec(CONTROL_SCRIPT);
      const initialKeys = unique(initial);
      for (const branchKey of initialKeys) {
        await go(pagePath);
        await exec(BLOCK_SCRIPT);
        const current = await exec(CONTROL_SCRIPT);
        const item = current.find(candidate => key(candidate) === branchKey && candidate.visible && !candidate.disabled);
        if (!item) { results.push({ path: pagePath, key: branchKey, status: 'not_visible' }); continue; }
        if (SKIP_ROLE.test(item.role) || SKIP_TEXT.test(item.text)) { results.push({ path: pagePath, key: branchKey, item, status: 'skipped_risky' }); continue; }
        let error = null;
        try { await exec(`var e=document.querySelectorAll('button,summary,input[type="submit"],a[href^="javascript:"]')[${item.index}];e.click();return true;`); }
        catch (failure) { error = String(failure.message || failure).slice(0, 500); }
        await new Promise(resolve => setTimeout(resolve, 200));
        const after = await exec(CONTROL_SCRIPT).catch(() => []);
        results.push({ path: pagePath, key: branchKey, item, status: error ? 'click_failed' : 'clicked', error,
          revealedKeys: unique(after).filter(value => !initialKeys.includes(value)),
          mutations: await exec('return window.__vokoMutations||[]').catch(() => []),
          finalUrl: await request(port, 'GET', `/session/${sessionId}/url`).catch(() => '') });
      }
    }
    const summary = { ok: !results.some(x => x.status === 'click_failed'), baseUrl: baseUrl.href,
      browser: 'firefox-geckodriver', paths: paths.length, branches: results.length,
      clicked: results.filter(x => x.status === 'clicked').length,
      skippedRisky: results.filter(x => x.status === 'skipped_risky').length,
      failed: results.filter(x => x.status === 'click_failed').length, results };
    fs.writeFileSync(path.join(artifact, 'result.json'), `${JSON.stringify(summary, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ ...summary, results: undefined }, null, 2)}\n`);
    process.exitCode = summary.ok ? 0 : 1;
  } finally {
    if (sessionId) await request(port, 'DELETE', `/session/${sessionId}`).catch(() => {});
    driver.kill('SIGTERM');
  }
}

main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
