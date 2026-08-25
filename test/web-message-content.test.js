const test = require('node:test');
const assert = require('node:assert/strict');

const { createMessageRenderer, messageExpandScript } = require('../src/web/message-content');

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

test('图片附件 JSON 只渲染文件占位符，点击后才请求资源', () => {
  const content = JSON.stringify({
    name: '屏幕截图 2026-02-25 164355.png',
    url: 'https://files.example.com/screenshot.png',
    size: 44169,
    type: 3,
  });
  const html = renderer.render(8, content);

  assert.match(html, /class="voko-file-card voko-image-file-link"/);
  assert.match(html, /href="https:\/\/files\.example\.com\/screenshot\.png"/);
  assert.match(html, /屏幕截图 2026-02-25 164355\.png/);
  assert.match(html, /43 KB · PNG/);
  assert.doesNotMatch(html, /<img|\ssrc=/);
});

test('端到端加密图片仅放行严格的本地解密路径', () => {
  const token='a'.repeat(43);const content = JSON.stringify({name:'voko.png',url:'/api/e2ee/attachments/upload_12345678/download?token='+token,
    size:2652,mimeType:'image/png'});
  const html = renderer.render(2,content);
  assert.match(html,/class="voko-file-card voko-image-file-link"/);
  assert.match(html,new RegExp('href="/api/e2ee/attachments/upload_12345678/download\\?token='+token+'"'));
  assert.doesNotMatch(html,/<img|\ssrc=/);
  assert.doesNotMatch(renderer.render(2,JSON.stringify({...JSON.parse(content),url:'/api/e2ee/attachments/..%2fsecret/download'})),/href=/);
});

test('E2EE v2 附件在列表中显示文件名而不是 JSON', () => {
  const content = JSON.stringify({ name: '1.tx.txt', fileName: '1.tx.txt',
    url: '/api/e2ee-v2/attachments/e2ee-de05725a-89de-4d40-b034-f8db3f709b52?agentId=lawyer',
    size: 5, type: 'text/plain', mimeType: 'text/plain' });

  assert.equal(renderer.preview(1, content), '📎 1.tx.txt');
  assert.match(renderer.previewHtml(1, content), /class="voko-paperclip-icon"/);
  assert.match(renderer.previewHtml(1, content), />1\.tx\.txt</);
  const html = renderer.render(1, content);
  assert.match(html, /class="voko-file-card"/);
  assert.match(html, /href="\/api\/e2ee-v2\/attachments\/e2ee-de05725a-89de-4d40-b034-f8db3f709b52\?agentId=lawyer"/);
  assert.doesNotMatch(html, /\{&quot;name&quot;/);
});

test('long text keeps a collapsed preview and exposes an expandable full message', () => {
  const content = 'a'.repeat(600);
  const html = renderer.render(1, content);

  assert.match(html, /data-voko-expandable/);
  assert.match(html, /data-voko-message-preview/);
  assert.match(html, /data-voko-message-full hidden/);
  assert.match(html, /data-voko-expand-message/);
  assert.match(html, new RegExp('a{500}…'));
  assert.match(html, new RegExp('a{600}'));
});

test('message expand script is valid inline JavaScript', () => {
  const script = messageExpandScript((key) => key);
  assert.doesNotThrow(() => new Function(script.replace(/^<script>|<\/script>$/g, '')));
});
