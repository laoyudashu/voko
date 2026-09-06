const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { scanFiles } = require('../scripts/scan-package-secrets');

test('package secret scan reports locations without returning secret values', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-secret-scan-'));
  try {
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(
      path.join(root, 'src', 'config.js'),
      "const password = 'this-must-not-ship';\nconst ok = process.env.PASSWORD;\n",
    );

    const findings = scanFiles(root, ['src']);
    assert.deepEqual(findings, [{ rule: 'literal-secret', file: path.join('src', 'config.js'), line: 1 }]);
    assert.equal(JSON.stringify(findings).includes('this-must-not-ship'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('package secret scan accepts environment-only secret configuration', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-secret-scan-'));
  try {
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.writeFileSync(
      path.join(root, 'scripts', 'config.js'),
      'const secretKey = process.env.OSS_ACCESS_KEY_SECRET;\n',
    );
    assert.deepEqual(scanFiles(root, ['scripts']), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const { execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const { scanTarball } = require('../scripts/scan-package-secrets');
const scanner = path.resolve(__dirname, '../scripts/scan-package-secrets.js');

function packedFixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-packed-secret-scan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, 'package', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  const archive = path.join(root, 'release.tgz');
  execFileSync('tar', ['-czf', archive, '-C', root, 'package']);
  return { root, archive };
}

test('release artifact scan covers built code, README and text without a recognized suffix', t => {
  const secret = "const password = 'synthetic-release-value';\n";
  const { archive } = packedFixture(t, {
    'build/main.js': secret, 'README.md': secret, 'assets/notes.data': secret, LICENSE: secret,
  });
  const result = scanTarball(archive);
  assert.deepEqual(result.findings.map(item => item.file).sort(),
    ['LICENSE', 'README.md', 'assets/notes.data', 'build/main.js']);
  assert.equal(result.filesScanned, 4);
  assert.equal(result.sha256, crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'));
  assert.equal(JSON.stringify(result).includes('synthetic-release-value'), false);
});

test('artifact scan accepts CRLF tar listings without skipping secret members', t => {
  const { archive } = packedFixture(t, { 'README.md': "const password = 'synthetic-crlf-value';\n" });
  const cp = require('node:child_process');
  const original = cp.execFileSync;
  t.mock.method(cp, 'execFileSync', (cmd, args, options) => {
    const result = original(cmd, args, options);
    return cmd === 'tar' && args.some(arg => ['-tf', '-tvf'].includes(arg))
      ? Buffer.from(result.toString('utf8').replace(/\r?\n/g, '\r\n')) : result;
  });
  assert.deepEqual(scanTarball(archive).findings, [{ rule: 'literal-secret', file: 'README.md', line: 1 }]);
});

test('artifact listing with invalid UTF-8 is rejected before extraction', t => {
  const { archive } = packedFixture(t, { 'README.md': 'test' });
  const cp = require('node:child_process');
  const original = cp.execFileSync;
  let extraction = false;
  t.mock.method(cp, 'execFileSync', (cmd, args, options) => {
    if (args.includes('-xf')) { extraction = true; throw new Error('Unexpected extraction'); }
    if (args.includes('-tf')) {
      const bytes = Buffer.concat([Buffer.from('package/\npackage/ca'), Buffer.from([0xff]), Buffer.from('.txt\n')]);
      return options.encoding === 'utf8' ? bytes.toString('utf8') : bytes;
    }
    return original(cmd, args, options);
  });
  assert.throws(() => scanTarball(archive), /archive.*encoding/i);
  assert.equal(extraction, false);
});

test('artifact bytes are authoritative and unpackaged workspace fixtures are ignored', t => {
  const { root, archive } = packedFixture(t, { 'build/main.js': 'module.exports = true;\n' });
  fs.mkdirSync(path.join(root, 'test'));
  fs.writeFileSync(path.join(root, 'test', 'fixture.js'), "const password = 'synthetic-not-packed';\n");
  // Changing the source tree after packing must not change which bytes are scanned.
  fs.writeFileSync(path.join(root, 'package', 'build', 'main.js'), "const password = 'synthetic-after-pack';\n");
  assert.deepEqual(scanTarball(archive).findings, []);
});

test('artifact CLI fails closed and prints only rule locations, never matched values', t => {
  const { archive } = packedFixture(t, { 'build/main.js': "const password = 'synthetic-secret-value';\n" });
  const result = spawnSync(process.execPath, [scanner, '--tarball', archive], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  const output = result.stdout + result.stderr;
  assert.match(output, /literal-secret: build\/main\.js:1/);
  assert.doesNotMatch(output, /synthetic-secret-value/);
});

test('artifact scan skips binary contents while recognizing UTF-16 text with a BOM', t => {
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("const password = 'synthetic-utf16-value';\n", 'utf16le')]);
  const { archive } = packedFixture(t, {
    'binary.wasm': Buffer.from([0, 97, 115, 109, 0xff]), 'notes.dat': utf16,
  });
  const result = scanTarball(archive);
  assert.equal(result.filesScanned, 1);
  assert.deepEqual(result.findings.map(item => item.file), ['notes.dat']);
});

// Minimal ustar fixtures exercise dangerous metadata without asking tar to create devices or outside paths.
function maliciousArchive(t, entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-archive-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const chunks = [];
  for (const { name, type = '0', link = '', content = 'synthetic', size } of entries) {
    const bytes = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write((size ?? bytes.length).toString(8).padStart(11, '0') + '\0', 124);
    header.write('00000000000\0', 136); header.fill(32, 148, 156); header.write(type, 156);
    header.write(link, 157, 100); header.write('ustar\0', 257); header.write('00', 263);
    const checksum = [...header].reduce((sum, value) => sum + value, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  const archive = path.join(root, 'unsafe.tgz');
  fs.writeFileSync(archive, require('node:zlib').gzipSync(Buffer.concat(chunks)));
  return { root, archive };
}

for (const [label, entry] of [
  ['parent traversal', { name: 'package/../../outside.txt' }],
  ['absolute path', { name: '/tmp/voko-archive-outside.txt' }],
  ['symlink', { name: 'package/link', type: '2', link: '../../outside', content: '' }],
  ['hardlink', { name: 'package/link', type: '1', link: '../../outside', content: '' }],
  ['device', { name: 'package/device', type: '3', content: '' }],
]) {
  test(`artifact ${label} is rejected before extracting anything`, t => {
    const { archive } = maliciousArchive(t, [entry]);
    let extraction = false;
    // The external tar binary is only allowed to list entries until validation succeeds.
    const childProcess = require('node:child_process');
    const original = childProcess.execFileSync;
    t.mock.method(childProcess, 'execFileSync', (cmd, args, options) => {
      if (args.some(arg => /^-x/.test(arg))) { extraction = true; throw new Error('Unexpected extraction'); }
      return original(cmd, args, options);
    });
    assert.throws(() => scanTarball(archive), /archive/i);
    assert.equal(extraction, false);
  });
}

test('artifact member and expanded-byte budgets reject before extraction', t => {
  const { archive } = packedFixture(t, { 'a.txt': '12345', 'b.txt': '67890' });
  assert.throws(() => scanTarball(archive, { maxMembers: 1 }), /archive/i);
  assert.throws(() => scanTarball(archive, { maxExpandedBytes: 4 }), /archive/i);
});

for (const [label, names] of [
  ['case-folded', ['package/README.md', 'package/readme.md']],
  ['Unicode-normalized', ['package/caf\u00e9.txt', 'package/cafe\u0301.txt']],
]) {
  test(`artifact ${label} collisions are rejected before extraction`, t => {
    const { archive } = maliciousArchive(t, [
      { name: names[0], content: "const password = 'synthetic-collision-secret';\n" },
      { name: names[1], content: 'safe replacement\n' },
    ]);
    const childProcess = require('node:child_process');
    const original = childProcess.execFileSync;
    let extraction = false;
    t.mock.method(childProcess, 'execFileSync', (cmd, args, options) => {
      if (args.some(arg => /^-x/.test(arg))) { extraction = true; throw new Error('Unexpected extraction'); }
      return original(cmd, args, options);
    });
    assert.throws(() => scanTarball(archive), /archive/i);
    assert.equal(extraction, false);
  });
}

test('artifact filesystem aliases fail closed even if their path spellings differ', t => {
  const { archive } = packedFixture(t, { 'first.txt': 'first file', 'second.txt': 'second file' });
  const original = fs.fstatSync;
  // Model a filesystem equivalence not captured by the portable name check.
  t.mock.method(fs, 'fstatSync', (file, ...args) => {
    const stat = original(file, ...args);
    if (stat.isFile()) { stat.dev = 42; stat.ino = 100; }
    return stat;
  });
  assert.throws(() => scanTarball(archive), /archive/i);
});

test('additional filesystem case folding cannot turn a secret member into a clean scan', t => {
  const { root, archive } = maliciousArchive(t, [
    { name: 'package/stra\u00dfe.txt', content: "const password = 'synthetic-filesystem-secret';\n" },
    { name: 'package/strasse.txt', content: 'safe replacement\n' },
  ]);
  fs.writeFileSync(path.join(root, 'stra\u00dfe.txt'), 'filesystem probe');
  const aliases = fs.existsSync(path.join(root, 'strasse.txt'));
  if (aliases) assert.throws(() => scanTarball(archive), /Aliased release archive/);
  else {
    let result;
    try { result = scanTarball(archive); }
    catch (error) {
      // Windows bsdtar may not preserve this raw UTF-8 ustar name. Refusing
      // the unreadable member is fail-closed, never a successful clean scan.
      assert.equal(process.platform, 'win32');
      if (/archive.*encoding/i.test(error.message)) return;
      assert.equal(error.code, 'ENOENT');
      assert.equal(path.basename(error.path), 'stra\u00dfe.txt');
      return;
    }
    assert.equal(result.findings.length, 1);
  }
});

// Mutate real temporary files immediately after the scanner inspects them.
// Supports both the previous path-based checks and descriptor-based checks.
function afterInspection(t, matches, mutate) {
  const opened = new Map();
  const originalOpen = fs.openSync;
  t.mock.method(fs, 'openSync', (file, ...args) => {
    const fd = originalOpen(file, ...args); opened.set(fd, file); return fd;
  });
  let mutated = false;
  for (const method of ['statSync', 'lstatSync', 'fstatSync']) {
    const original = fs[method];
    t.mock.method(fs, method, (fileOrFd, ...args) => {
      const stat = original(fileOrFd, ...args);
      const file = method === 'fstatSync' ? opened.get(fileOrFd) : fileOrFd;
      if (!mutated && typeof file === 'string' && matches(file)) {
        mutated = true; mutate(file);
      }
      return stat;
    });
  }
  return () => assert.equal(mutated, true, 'filesystem race fixture must execute');
}

for (const target of ['archive', 'member']) {
  test(`artifact scan reads the inspected ${target} even if its pathname is replaced`, t => {
    const { archive } = packedFixture(t, { 'entry.txt': "const password = 'synthetic-descriptor-secret';\n" });
    const wasMutated = afterInspection(t,
      file => target === 'archive' ? file === archive : file.endsWith(path.join('contents', 'package', 'entry.txt')),
      file => { fs.renameSync(file, file + '.original'); fs.writeFileSync(file, 'safe replacement'); });
    const result = scanTarball(archive);
    wasMutated();
    assert.deepEqual(result.findings.map(f => f.file), ['entry.txt']);
  });

  test(`artifact scan rejects ${target} growth beyond its read budget`, t => {
    const { archive } = packedFixture(t, { 'entry.txt': 'safe initial file' });
    const budget = target === 'archive' ? 64 * 1024 * 1024 : 16 * 1024;
    const wasMutated = afterInspection(t,
      file => target === 'archive' ? file === archive : file.endsWith(path.join('contents', 'package', 'entry.txt')),
      file => fs.truncateSync(file, budget + 1));
    assert.throws(() => scanTarball(archive, { maxExpandedBytes: 16 * 1024 }), /size budget/i);
    wasMutated();
  });
}

test('artifact archive symlinks are not followed', t => {
  if (!fs.constants.O_NOFOLLOW) return t.skip('O_NOFOLLOW is unavailable on this platform');
  const { root, archive } = packedFixture(t, { 'entry.txt': 'safe file' });
  const link = path.join(root, 'linked.tgz');
  fs.symlinkSync(archive, link);
  assert.throws(() => scanTarball(link));
});

for (const replacement of ['symlink', 'directory']) {
  test(`extracted regular members replaced with a ${replacement} are rejected`, t => {
    if (replacement === 'symlink' && !fs.constants.O_NOFOLLOW) return t.skip('O_NOFOLLOW is unavailable on this platform');
    const { root, archive } = packedFixture(t, { 'entry.txt': 'safe file' });
    const outside = path.join(root, 'outside.txt'); fs.writeFileSync(outside, 'outside fixture');
    const childProcess = require('node:child_process'), original = childProcess.execFileSync;
    t.mock.method(childProcess, 'execFileSync', (cmd, args, options) => {
      const result = original(cmd, args, options);
      if (args.includes('-xf')) {
        const file = path.join(args[args.indexOf('-C') + 1], 'package/entry.txt');
        fs.unlinkSync(file);
        if (replacement === 'symlink') fs.symlinkSync(outside, file);
        else fs.mkdirSync(file);
      }
      return result;
    });
    assert.throws(() => scanTarball(archive));
  });
}

for (const outcome of ['success', 'budget failure']) {
  test(`artifact descriptors are closed after ${outcome}`, t => {
    const { archive } = packedFixture(t, { 'entry.txt': 'safe file' });
    if (outcome === 'budget failure') fs.truncateSync(archive, 64 * 1024 * 1024 + 1);
    const descriptors = new Set(), originalOpen = fs.openSync, originalClose = fs.closeSync;
    t.mock.method(fs, 'openSync', (...args) => {
      const fd = originalOpen(...args); descriptors.add(fd); return fd;
    });
    t.mock.method(fs, 'closeSync', fd => {
      try { return originalClose(fd); } finally { descriptors.delete(fd); }
    });
    if (outcome === 'success') assert.deepEqual(scanTarball(archive).findings, []);
    else assert.throws(() => scanTarball(archive), /size budget/);
    assert.equal(descriptors.size, 0);
  });
}

test('non-regular archive FIFO is rejected without waiting for a writer', t => {
  if (process.platform === 'win32' || !fs.constants.O_NONBLOCK) return t.skip('POSIX nonblocking FIFO fixture');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-archive-fifo-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fifo = path.join(root, 'archive.tgz');
  execFileSync('mkfifo', [fifo]);
  const result = spawnSync(process.execPath, [scanner, '--tarball', fifo], { encoding: 'utf8', timeout: 1500 });
  assert.equal(result.error, undefined, 'scanner must reject the FIFO without hanging');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /file type/);
});
