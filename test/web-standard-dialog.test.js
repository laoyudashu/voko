'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('Web UI uses the shared VOKO message dialog instead of native alerts', () => {
  const webDir = path.join(__dirname, '..', 'src', 'web');
  const nativeAlerts = fs.readdirSync(webDir).filter((name) => name.endsWith('.js')).filter((name) => { const source = fs.readFileSync(path.join(webDir, name), 'utf8'); return /(?:window\.)?alert\s*\(/.test(source) && !source.includes("script.replace('window.alert','showVokoMessage')"); });
  assert.deepEqual(nativeAlerts, []);
  const controls = fs.readFileSync(path.join(webDir, 'ui-controls.js'), 'utf8');
  assert.match(controls, /id="voko-message-dialog"/);
  assert.match(controls, /window\.showVokoMessage=/);
});
