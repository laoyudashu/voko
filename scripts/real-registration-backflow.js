#!/usr/bin/env node
'use strict';

const baseUrl = new URL(process.argv[2] || 'http://127.0.0.1:3100/');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function post(action, registrationId, data = {}) {
  const response = await fetch(new URL('/api/agent-registration', baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, registrationId, ...data }),
    signal: AbortSignal.timeout(60_000),
  });
  const result = await response.json();
  assert(response.ok && result.success !== false, `${action} failed: ${result.code || result.error || response.status}`);
  return result;
}

async function main() {
  const page = await fetch(new URL('/agent/add?new=1', baseUrl), { signal: AbortSignal.timeout(60_000) });
  const html = await page.text();
  assert(page.ok, `registration page returned ${page.status}`);
  const email = (html.match(/id="registration-wizard"[^>]*data-email="([^"]+)"/) || [])[1];
  assert(email, 'registration page did not expose the bound owner email');

  const started = await post('start', '', { email });
  const inspected = await post('inspect_environment', started.registrationId);
  const providers = inspected.environment?.detected || [];
  assert(providers.length > 0, 'no provider detected');
  const selected = providers.find(provider => provider.requiresInstance !== true || provider.instances?.length)
    || providers[0];
  const instanceId = selected.requiresInstance ? selected.instances?.[0]?.id : '';
  await post('select_provider', started.registrationId, { providerType: selected.type, instanceId });
  const reselected = await post('reselect_provider', started.registrationId);

  assert(reselected.status === 'provider_selection_required', `unexpected status ${reselected.status}`);
  assert(reselected.provider === null, 'provider draft was not cleared');
  assert(reselected.basicInfo === null, 'basic info draft was not cleared');
  assert(Array.isArray(reselected.environment?.detected), 'compact environment is missing');
  assert(reselected.environment.detected.length === providers.length, 'provider inventory changed during reselect');
  assert(reselected.environment.summary?.providerCount === providers.length, 'provider count summary is inconsistent');
  process.stdout.write(`${JSON.stringify({ ok: true, providerCount: providers.length, selectedProvider: selected.type })}\n`);
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
