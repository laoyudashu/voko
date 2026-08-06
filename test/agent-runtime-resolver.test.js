const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AgentRuntimeResolver } = require('../build/core/runtime/agent-runtime-resolver');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-runtime-'));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function touch(file, content = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

test('Windows npm package bin resolves to node plus validated package entry', () => {
  const { root, cleanup } = fixture();
  try {
    touch(path.join(root, 'cline.cmd'), '@echo off');
    touch(path.join(root, 'node_modules', 'cline', 'package.json'), JSON.stringify({ bin: { cline: 'bin/cline' } }));
    const bin = path.join(root, 'node_modules', 'cline', 'bin', 'cline');
    touch(bin, '#!/usr/bin/env node');
    const resolver = new AgentRuntimeResolver({ platform: 'win32', env: { PATH: root }, nodePath: 'C:\\node\\node.exe' });
    const result = resolver.resolve({
      providerId: 'cline-acp', mode: 'acp',
      candidates: [{ kind: 'node-package-bin', command: 'cline', packageName: 'cline' }],
    });
    assert.equal(result.available, true);
    assert.equal(result.executable, 'C:\\node\\node.exe');
    assert.deepEqual(result.argvPrefix, [fs.realpathSync(bin)]);
    assert.equal(result.runtimeKind, 'node-script');
  } finally { cleanup(); }
});

test('Windows native resolution accepts exe but never executes cmd as native', () => {
  const { root, cleanup } = fixture();
  try {
    touch(path.join(root, 'tool.cmd'), '@echo off');
    const resolver = new AgentRuntimeResolver({ platform: 'win32', env: { PATH: root } });
    const missing = resolver.resolve({ providerId: 'tool', mode: 'acp', candidates: [{ kind: 'native', command: 'tool' }] });
    assert.equal(missing.available, false);
    touch(path.join(root, 'tool.exe'));
    resolver.invalidate();
    const native = resolver.resolve({ providerId: 'tool', mode: 'acp', candidates: [{ kind: 'native', command: 'tool' }] });
    assert.equal(native.available, true);
    assert.equal(path.basename(native.executable), 'tool.exe');
  } finally { cleanup(); }
});

test('Windows native resolution does not append exe to an already suffixed command', () => {
  const { root, cleanup } = fixture();
  try {
    touch(path.join(root, 'goose.exe'));
    const resolver = new AgentRuntimeResolver({ platform: 'win32', env: { PATH: root } });
    const result = resolver.resolve({
      providerId: 'goose', mode: 'acp', candidates: [{ kind: 'native', command: 'goose.exe' }],
    });
    assert.equal(result.available, true);
    assert.equal(path.basename(result.executable), 'goose.exe');
  } finally { cleanup(); }
});

test('negative cache is cleared explicitly after runtime installation', () => {
  const { root, cleanup } = fixture();
  try {
    const request = { providerId: 'late', mode: 'cli', candidates: [{ kind: 'native', command: 'late' }] };
    const resolver = new AgentRuntimeResolver({ platform: 'win32', env: { PATH: root }, negativeTtlMs: 60000 });
    assert.equal(resolver.resolve(request).available, false);
    touch(path.join(root, 'late.exe'));
    assert.equal(resolver.resolve(request).available, false);
    resolver.invalidate(request);
    assert.equal(resolver.resolve(request).available, true);
  } finally { cleanup(); }
});

test('package bin cannot escape its package root', () => {
  const { root, cleanup } = fixture();
  try {
    touch(path.join(root, 'unsafe.cmd'));
    touch(path.join(root, 'node_modules', 'unsafe', 'package.json'), JSON.stringify({ bin: { unsafe: '../../outside.js' } }));
    touch(path.join(root, 'node_modules', 'outside.js'));
    const resolver = new AgentRuntimeResolver({ platform: 'win32', env: { PATH: root } });
    const result = resolver.resolve({
      providerId: 'unsafe', mode: 'cli',
      candidates: [{ kind: 'node-package-bin', command: 'unsafe', packageName: 'unsafe' }],
    });
    assert.equal(result.available, false);
  } finally { cleanup(); }
});
