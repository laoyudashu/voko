const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  discoverQwenOfficeAgents,
  resolveQwenOfficeAgentTarget,
} = require('../build/core/dispatcher/qwen-office-agents');

function writeExpertKit(workspaceBase, workspaceId, directory, manifest) {
  const pluginRoot = path.join(workspaceBase, workspaceId, directory);
  fs.mkdirSync(path.join(pluginRoot, '.qoder-plugin'), { recursive: true });
  for (const skill of manifest.skills || []) {
    if (!skill.startsWith('./')) continue;
    const skillRoot = path.resolve(pluginRoot, skill);
    fs.mkdirSync(skillRoot, { recursive: true });
    fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '# Skill\n');
  }
  fs.writeFileSync(path.join(pluginRoot, '.qoder-plugin', 'plugin.json'), JSON.stringify(manifest));
  return pluginRoot;
}

test('QwenWork expert-kit discovery returns stable workspace/plugin instances and exact CLI targets', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-qwenwork-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pluginRoot = writeExpertKit(root, 'mt80hmwaywym3lje', 'health-rumor-crusher', {
    name: 'health-rumor-crusher',
    displayName: '养生谣言粉碎机',
    descriptionZh: '基于证据核查健康说法',
    category: 'health',
    tags: ['health', 'fact-checking'],
    skills: ['./skills/check'],
  });

  const instances = discoverQwenOfficeAgents({ workspaceRoot: root });
  assert.deepEqual(instances, [{
    id: 'mt80hmwaywym3lje/health-rumor-crusher',
    name: '养生谣言粉碎机',
    description: '基于证据核查健康说法',
    source: 'qwenwork-workspace/mt80hmwaywym3lje/health-rumor-crusher',
    available: true,
    tags: ['health', 'fact-checking'],
    category: 'health',
  }]);
  const target = resolveQwenOfficeAgentTarget(instances[0].id, { workspaceRoot: root });
  assert.equal(target.workspaceRoot, path.join(root, 'mt80hmwaywym3lje'));
  assert.equal(target.pluginRoot, pluginRoot);
});

test('QwenWork discovery fails closed for manifests the qoderclicn plugin validator cannot load', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-qwenwork-invalid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeExpertKit(root, 'mt7zxd9zn555pwlu', 'bad-kit', {
    name: 'bad-kit',
    displayName: 'Bad Kit',
    skills: ['skills/missing-dot-prefix'],
  });
  assert.deepEqual(discoverQwenOfficeAgents({ workspaceRoot: root }), []);
  assert.equal(resolveQwenOfficeAgentTarget('mt7zxd9zn555pwlu/bad-kit', { workspaceRoot: root }), null);
});
