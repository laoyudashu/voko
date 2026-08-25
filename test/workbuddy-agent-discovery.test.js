const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { discoverWorkBuddyAgents, resolveWorkBuddyAgentTarget, readWorkBuddyAgentAvatar } = require('../build/core/dispatcher/workbuddy-agents');

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
  const found = discoverWorkBuddyAgents({ root: f.root, requireRegisteredMarketplace: false });
  assert.deepEqual(found.map(item => item.id), ['english-vocab-coach', 'tcm-consultant']);
  assert.equal(found[0].available, true);
  assert.match(found[0].description, /介绍/);
  assert.equal(found[0].source, 'my-experts/english-vocab-coach');
  assert.equal(resolveWorkBuddyAgentTarget('tcm-consultant', { root: f.root, requireRegisteredMarketplace: false }).pluginRoot,
    path.join(f.root, 'plugins', 'tcm-consultant'));
});

test('filters malformed, mismatched and traversal marketplace entries', (t) => {
  const f = fixture(t); f.add('valid-agent'); f.add('wrong-frontmatter', { frontmatterName: 'other' });
  f.plugins.push({ name: 'escape-agent', source: '../outside', description: 'bad' }); f.save();
  assert.deepEqual(discoverWorkBuddyAgents({ root: f.root, requireRegisteredMarketplace: false }).map(item => item.id), ['valid-agent']);
  assert.equal(resolveWorkBuddyAgentTarget('../../escape', { root: f.root, requireRegisteredMarketplace: false }), null);
});

test('reports a corrupt marketplace as discovery failure instead of an empty list', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, '.codebuddy-plugin', 'marketplace.json'), '{broken');
  assert.throws(() => discoverWorkBuddyAgents({ root: f.root, requireRegisteredMarketplace: false }), /manifest is invalid/);
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

  const found = discoverWorkBuddyAgents({ root: f.root, requireRegisteredMarketplace: false });
  assert.deepEqual(found.find(item => item.id === 'safe-agent').tags, ['英语词汇', '学习']);
  const avatar = readWorkBuddyAgentAvatar('safe-agent', { root: f.root, requireRegisteredMarketplace: false });
  assert.equal(avatar.mimeType, 'image/png');
  assert.deepEqual(avatar.data, png);
  assert.equal(readWorkBuddyAgentAvatar('fake-image', { root: f.root, requireRegisteredMarketplace: false }), null);
  assert.equal(readWorkBuddyAgentAvatar('traversal-image', { root: f.root, requireRegisteredMarketplace: false }), null);
  assert.equal(readWorkBuddyAgentAvatar('../../escape', { root: f.root, requireRegisteredMarketplace: false }), null);
});
