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
  assert.match(source, /data-role="copy-link"[^>]*title="'\+L\('web\.home\.access\.copy_a2a'\)/);
  assert.match(source, /data-role="gen-owner-link"/);
  assert.match(source, /ownerLinkDialog\(\)/);
  assert.match(source, /e\.target\.closest\?e\.target\.closest\("\[data-role\]"\)/);
  assert.match(source, /function markCopied\(button\)/);
  assert.doesNotMatch(source, /\[data-role=copy-link\][\s\S]{0,300}dlg-toast/);
  assert.match(source, /if\(opts\.a2aModule\)\{try\{opts\.a2aModule\.withDatabase/);
  assert.match(source, /a2a\?\.published\?'<button class="home-copy-icon" data-role="copy-link"/);
});
