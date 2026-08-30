const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { discoverWorkBuddyAgents, resolveWorkBuddyAgentTarget, readWorkBuddyAgentAvatar } = require('../build/core/dispatcher/workbuddy-agents');
const { resolveWorkBuddyRuntime } = require('../build/core/dispatcher/workbuddy-command');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-workbuddy-agents-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.codebuddy-plugin'), { recursive: true });
  const plugins = [];
  function add(id, overrides = {}) {
    const pluginRoot = path.join(root, 'plugins', id);
    fs.mkdirSync(path.join(pluginRoot, '.codebuddy-plugin'), { recursive: true });
    fs.mkdirSync(path.join(pluginRoot, 'agents'), { recursive: true });
    const source = overrides.source || `./plugins/${id}`;
    plugins.push({ name: id, source, description: `${id} entry` });
    fs.writeFileSync(path.join(pluginRoot, '.codebuddy-plugin', 'plugin.json'), JSON.stringify({
      name: id, plugin: id, expertType: 'agent', agentName: overrides.agentName || id,
      agents: [overrides.agentPath || `./agents/${id}.md`], displayName: { zh: `${id} 名称` },
      displayDescription: { zh: `${id} 介绍` }, tags: overrides.tags, avatar: overrides.avatar,
    }));
    fs.writeFileSync(path.join(pluginRoot, 'agents', `${id}.md`), `---\nname: ${overrides.frontmatterName || id}\ndescription: fixture\n---\nbody\n`);
    if (overrides.avatarData) fs.writeFileSync(path.join(pluginRoot, overrides.avatar), overrides.avatarData);
  }
  return { root, plugins, add, save() { fs.writeFileSync(path.join(root, '.codebuddy-plugin', 'marketplace.json'),
    JSON.stringify({ name: 'my-experts', plugins })); } };
}

test('discovers stable WorkBuddy agent IDs and localized metadata from valid marketplace plugins', (t) => {
  const f = fixture(t); f.add('english-vocab-coach'); f.add('tcm-consultant'); f.save();
  const found = discoverWorkBuddyAgents({ root: f.root });
  assert.deepEqual(found.map(item => item.id), ['english-vocab-coach', 'tcm-consultant']);
  assert.equal(found[0].available, true);
  assert.match(found[0].description, /介绍/);
  assert.equal(found[0].source, 'my-experts/english-vocab-coach');
  assert.equal(resolveWorkBuddyAgentTarget('tcm-consultant', { root: f.root }).pluginRoot,
    path.join(f.root, 'plugins', 'tcm-consultant'));
});

test('uses marketplace manifests as the authority when known_marketplaces omits my-experts', (t) => {
  const workBuddyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-workbuddy-home-'));
  t.after(() => fs.rmSync(workBuddyHome, { recursive: true, force: true }));
  const marketplaceRoot = path.join(workBuddyHome, 'plugins', 'marketplaces', 'my-experts');
  const f = fixture(t);
  f.add('primary-math-exam-expert');
  f.save();
  fs.mkdirSync(path.join(workBuddyHome, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(workBuddyHome, 'plugins', 'known_marketplaces.json'), JSON.stringify({
    'workbuddy-builtin': { installLocation: path.join(workBuddyHome, 'plugins', 'marketplaces', 'workbuddy-builtin') },
  }));
  fs.mkdirSync(path.dirname(marketplaceRoot), { recursive: true });
  fs.cpSync(f.root, marketplaceRoot, { recursive: true });

  assert.deepEqual(discoverWorkBuddyAgents({ workBuddyHome }).map(item => item.id), ['primary-math-exam-expert']);
});

test('respects WORKBUDDY_CONFIG_DIR for the default expert marketplace', (t) => {
  const previous = process.env.WORKBUDDY_CONFIG_DIR;
  const workBuddyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-workbuddy-config-'));
  t.after(() => {
    if (previous === undefined) delete process.env.WORKBUDDY_CONFIG_DIR;
    else process.env.WORKBUDDY_CONFIG_DIR = previous;
    fs.rmSync(workBuddyHome, { recursive: true, force: true });
  });
  const f = fixture(t);
  f.add('configured-expert');
  f.save();
  const marketplaceRoot = path.join(workBuddyHome, 'plugins', 'marketplaces', 'my-experts');
  fs.mkdirSync(path.dirname(marketplaceRoot), { recursive: true });
  fs.cpSync(f.root, marketplaceRoot, { recursive: true });
  process.env.WORKBUDDY_CONFIG_DIR = workBuddyHome;

  assert.deepEqual(discoverWorkBuddyAgents().map(item => item.id), ['configured-expert']);
});

test('WorkBuddy runtime discovers the macOS application bundle CLI', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-workbuddy-mac-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const cli = path.join(home, 'Applications', 'WorkBuddy.app', 'Contents', 'Resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy');
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, 'test');
  const runtime = resolveWorkBuddyRuntime({ platform: 'darwin', homeDir: home, env: {} });
  assert.equal(runtime.command, cli);
});

test('filters malformed, mismatched and traversal marketplace entries', (t) => {
  const f = fixture(t); f.add('valid-agent'); f.add('wrong-frontmatter', { frontmatterName: 'other' });
  f.plugins.push({ name: 'escape-agent', source: '../outside', description: 'bad' }); f.save();
  assert.deepEqual(discoverWorkBuddyAgents({ root: f.root }).map(item => item.id), ['valid-agent']);
  assert.equal(resolveWorkBuddyAgentTarget('../../escape', { root: f.root }), null);
});

test('reports a corrupt marketplace as discovery failure instead of an empty list', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, '.codebuddy-plugin', 'marketplace.json'), '{broken');
  assert.throws(() => discoverWorkBuddyAgents({ root: f.root }), /manifest is invalid/);
});

test('localizes object-shaped tags and only reads verified plugin image bytes', (t) => {
  const f = fixture(t);
  const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  f.add('safe-agent', {
    tags: [{ zh: '英语词汇', en: 'English vocabulary' }, { zh: '学习', en: 'Learning' }],
    avatar: 'avatar.png', avatarData: png,
  });
  f.add('fake-image', { avatar: 'avatar.png', avatarData: Buffer.from('not an image') });
  f.add('traversal-image', { avatar: '../outside.png' });
  f.save();

  const found = discoverWorkBuddyAgents({ root: f.root });
  assert.deepEqual(found.find(item => item.id === 'safe-agent').tags, ['英语词汇', '学习']);
  const avatar = readWorkBuddyAgentAvatar('safe-agent', { root: f.root });
  assert.equal(avatar.mimeType, 'image/png');
  assert.deepEqual(avatar.data, png);
  assert.equal(readWorkBuddyAgentAvatar('fake-image', { root: f.root }), null);
  assert.equal(readWorkBuddyAgentAvatar('traversal-image', { root: f.root }), null);
  assert.equal(readWorkBuddyAgentAvatar('../../escape', { root: f.root }), null);
});
