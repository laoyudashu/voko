'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  COPY_ICON,
  UI_CONTROL_CSS,
  copyButton,
  copyControlScript,
} = require('../src/web/ui-controls');

test('shared copy control uses one icon interaction and a checked success state', () => {
  const html = copyButton({ label: 'Copy value', attrs: 'data-voko-copy-value="value"' });
  const script = copyControlScript();

  assert.match(html, /class="voko-copy-button"/);
  assert.match(html, /data-voko-copy-value="value"/);
  assert.ok(html.includes(COPY_ICON));
  assert.match(script, /copiedIcon=.*m5 12/);
  assert.match(script, /classList\.add\("is-copied"\)/);
  assert.match(script, /classList\.remove\("is-copied"\)/);
  assert.match(script, /getAttribute\("data-voko-copy-icon-target"\)/);
  assert.match(script, /button\.querySelector\(iconSelector\)/);
  assert.match(script, /icon\.innerHTML=copiedIcon/);
  assert.match(script, /navigator\.clipboard\.writeText/);
});

test('shared controls define consistent default, compact and table sizes', () => {
  assert.match(UI_CONTROL_CSS, /button,\.btn\{min-height:40px/);
  assert.match(UI_CONTROL_CSS, /\.btn-sm\{min-height:32px/);
  assert.match(UI_CONTROL_CSS, /\.btn-xs\{min-height:26px/);
  assert.match(UI_CONTROL_CSS, /\.voko-copy-button\{[^}]*width:28px[^}]*height:28px/);
  assert.match(UI_CONTROL_CSS, /\.voko-copy-button\.is-copied\{color:#168447/);
  assert.match(UI_CONTROL_CSS, /\.home-access-copy-item\.is-copied \.home-copy-action-icon\{color:#168447;background:#edf9f1\}/);
});
