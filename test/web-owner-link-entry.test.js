'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('owner link entry uses the authenticated server API without persisting one-time links', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'index.js'), 'utf8');
  const route = source.match(/R\.post\('\/api\/owner-link\/create'[\s\S]*?\n  \}\);/)[0];
  assert.match(route, /getUserAccessToken\(db,ownerEmail\)/);
  assert.match(route, /serverAgentIdFromDid\(row\.did\)/);
  assert.match(route, /Authorization:'Bearer '\+userAccessToken/);
  assert.match(route, /\/api\/owner-links\/v1/);
  assert.match(route, /ownerUrl\.startsWith\('https:\/\/'\)/);
  assert.doesNotMatch(route, /INSERT|UPDATE|owner_link_url/);
});

test('home access entry distinguishes visitor, owner and A2A actions', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'index.js'), 'utf8');
  assert.match(source, /accessIcon\('visitor'\)/);
  assert.match(source, /accessIcon\('owner'\)/);
  assert.match(source, /accessIcon\('a2a'\)/);
  assert.match(source, /copyButton\(\{esc,label:L\('web\.home\.access\.copy_a2a'\)/);
  assert.match(source, /data-role="gen-owner-link"/);
  assert.match(source, /ownerLinkDialog\(\)/);
  assert.match(source, /e\.target\.closest\?e\.target\.closest\("\[data-role\]"\)/);
  assert.match(source, /max-width:460px/);
  assert.match(source, /id="dlg-owner-link-v2"/);
  assert.match(source, /data-role="owner-link-close"/);
  assert.match(source, /openOwnerLinkDialog\(t\)/);
  assert.doesNotMatch(source, /id="owner-link-open"/);
  assert.doesNotMatch(source, /id="owner-link-url"/);
  assert.doesNotMatch(source, /id="owner-link-expiry"/);
  assert.match(source, /dlg\.close\(\)/);
  assert.match(source, /btn btn-sm btn-outline home-access-action home-owner-action/);
  assert.match(source, /sessionStorage\.removeItem\("voko\.owner-links\.v1"\)/);
  assert.match(source, /data-owner-link-actions/);
  assert.match(source, /data-role="owner-link-copy-value"/);
  assert.match(source, /data-role="copy-owner-link"/);
  assert.match(source, /owner_copy_template\.replace\("\{agent\}"/);
  assert.match(source, /navigator\.clipboard\.writeText\(value\)/);
  assert.match(source, /data-agent-name=/);
  assert.match(source, /dlg\.showModal\(\);createOwnerLink\(\)/);
  assert.doesNotMatch(source, /localStorage\.setItem\(ownerLinkSessionKey/);
  assert.match(source, /if\(opts\.a2aModule\)\{try\{opts\.a2aModule\.withDatabase/);
  assert.match(source, /a2a\?\.published\?copyButton/);
});

test('home owner access summarizes authorized devices and supports revocation', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'index.js'), 'utf8');
  assert.match(source, /R\.get\('\/api\/owner-link\/devices'/);
  assert.match(source, /R\.delete\('\/api\/owner-link\/devices\/:deviceId'/);
  assert.match(source, /data-role="owner-devices"/);
  assert.match(source, /data-role="disconnect-owner-device"/);
  assert.match(source, /owner_devices_summary\.replace\("\{authorized\}"/);
  assert.match(source, /list\.filter\(function\(d\)\{return d\.online\}\)\.length/);
  assert.doesNotMatch(source, /setInterval\(loadOwnerDevices/);
  assert.match(source, /new EventSource\("\/api\/owner-link\/device-events"\)/);
  assert.match(source, /events\.addEventListener\("devices"/);
  assert.match(source, /R\.get\('\/api\/owner-link\/device-events'/);
  assert.match(source, /window\.addEventListener\("focus",loadOwnerDevices\)/);
  assert.doesNotMatch(source, /Edg\\\//);
  assert.match(source, /<thead><tr><th>'\+I\.owner_device/);
  assert.match(source, /min-width:680px/);
  assert.match(source, /if\(!authorized\)return I\.owner_disabled/);
  assert.match(source, /class="home-access-value" style="font-size:13px"/);
});
