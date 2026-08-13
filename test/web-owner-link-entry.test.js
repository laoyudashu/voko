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
  assert.match(source, /data-role="confirm-owner-link"/);
  assert.match(source, /max-width:350px/);
  assert.match(source, /class="btn-sm" data-role="confirm-owner-link"/);
  assert.match(source, /button class="btn-sm btn-outline" value="cancel"/);
  assert.match(source, /openOwnerLinkDialog\(t\)/);
  assert.doesNotMatch(source, /id="owner-link-open"/);
  assert.doesNotMatch(source, /id="owner-link-url"/);
  assert.doesNotMatch(source, /id="owner-link-expiry"/);
  assert.match(source, /dlg\.close\(\)/);
  assert.match(source, /btn btn-sm btn-outline home-access-action home-owner-action/);
  assert.match(source, /ownerLinkSessionKey="voko\.owner-links\.v1"/);
  assert.match(source, /sessionStorage\.setItem\(ownerLinkSessionKey/);
  assert.match(source, /data-owner-link-value/);
  assert.match(source, /data-owner-link-actions/);
  assert.match(source, /data-owner-link-copy/);
  assert.match(source, /saveOwnerLink\(aid,d\);renderOwnerLinkEntry\(aid,d\)/);
  assert.doesNotMatch(source, /localStorage\.setItem\(ownerLinkSessionKey/);
  assert.match(source, /if\(opts\.a2aModule\)\{try\{opts\.a2aModule\.withDatabase/);
  assert.match(source, /a2a\?\.published\?copyButton/);
});
