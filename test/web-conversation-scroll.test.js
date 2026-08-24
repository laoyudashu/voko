const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'index.js'), 'utf8');

test('private conversation initially follows late layout changes to the latest message', () => {
  assert.match(source, /const initialMessageScrollScript=/);
  assert.match(source, /new ResizeObserver\(latest\)/);
  assert.match(source, /requestAnimationFrame\(function\(\)\{latest\(\);requestAnimationFrame\(latest\)\}\)/);
});

test('private conversation stops initial bottom-follow when the user interacts with history', () => {
  assert.match(source, /addEventListener\("wheel",stop/);
  assert.match(source, /addEventListener\("touchstart",stop/);
  assert.match(source, /addEventListener\("pointerdown",stop/);
  assert.match(source, /setTimeout\(stop,2000\)/);
});
