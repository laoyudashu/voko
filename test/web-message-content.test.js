const test = require('node:test');
const assert = require('node:assert/strict');

const { createMessageRenderer } = require('../src/web/message-content');

const renderer = createMessageRenderer({
  image: '图片',
  openOriginal: '查看原图',
  openFile: '打开 / 下载',
  unavailable: '资源不可用',
  unknownFile: '未命名文件',
});

test('附件 JSON 即使外层是文本消息也渲染为文件卡片', () => {
  const content = JSON.stringify({
    name: '使用说明.pdf',
    url: 'https://files.example.com/manual.pdf',
    size: 44169,
    type: 3,
  });
  const html = renderer.render(1, content);

  assert.match(html, /class="voko-file-card"/);
  assert.match(html, /使用说明\.pdf/);
  assert.match(html, /43 KB/);
  assert.match(html, /PDF/);
  assert.doesNotMatch(html, /\{&quot;name&quot;/);
});

test('图片附件 JSON 根据文件名渲染图片预览', () => {
  const content = JSON.stringify({
    name: '屏幕截图 2026-02-25 164355.png',
    url: 'https://files.example.com/screenshot.png',
    size: 44169,
    type: 3,
  });
  const html = renderer.render(4, content);

  assert.match(html, /class="voko-media-image-preview"/);
  assert.match(html, /src="https:\/\/files\.example\.com\/screenshot\.png"/);
  assert.match(html, /屏幕截图 2026-02-25 164355\.png/);
  assert.doesNotMatch(html, /class="voko-file-card"/);
});
