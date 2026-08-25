const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readProviderInstanceMetadata } = require('../build/core/dispatcher/provider-instance-metadata');

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-provider-profile-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

describe('provider instance metadata', () => {
  it('reads only explicit OpenClaw identity fields for the selected workspace', (t) => {
    const home = tempHome(t);
    const workspace = path.join(home, 'workspace-lawyer');
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(path.join(home, '.openclaw'), { recursive: true });
    fs.writeFileSync(path.join(home, '.openclaw', 'openclaw.json'), JSON.stringify({
      agents: { list: [{ id: 'lawyer', workspace }] },
    }));
    fs.writeFileSync(path.join(workspace, 'IDENTITY.md'), [
      '**名字：** 智小律',
      '**角色：** 律师事务所 AI 接待助手',
      '**风格：** 专业、温暖、值得信赖',
      '这里是不可作为注册资料的正文。',
    ].join('\n'));

    assert.deepStrictEqual(readProviderInstanceMetadata('openclaw', 'lawyer', { home }), {
      name: '智小律',
      description: '律师事务所 AI 接待助手；专业、温暖、值得信赖',
      tags: ['专业', '温暖', '值得信赖'],
    });
  });

  it('ignores untouched OpenClaw identity placeholders', (t) => {
    const home = tempHome(t);
    const workspace = path.join(home, '.openclaw', 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'IDENTITY.md'), '**Name:** _(pick something)_\n**Creature:** _(AI? robot?)_\n**Vibe:** _(how do you feel?)_');
    assert.deepStrictEqual(readProviderInstanceMetadata('openclaw', 'main', { home }), {});
  });

  it('reads supported markdown-agent frontmatter', (t) => {
    const home = tempHome(t);
    const root = path.join(home, '.claude', 'agents');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'reviewer.md'), '---\nname: Code Reviewer\ndescription: Reviews focused diffs\ntags: [code, review]\n---\nPrivate instructions');
    assert.deepStrictEqual(readProviderInstanceMetadata('claude-code', 'reviewer', { home }), {
      name: 'Code Reviewer', description: 'Reviews focused diffs', tags: ['code', 'review'],
    });
  });
});
