const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');

const { createWebRouter } = require('../build/web');

test('attachment page prefills recipient and sends multipart through upload_and_send_file', async (t) => {
  let sent;
  const handlers = {
    whoami: async () => ({ agents: [{ agentId: 'gym', agentName: 'Gym' }] }),
    upload_and_send_file: async (params) => {
      sent = params;
      return { success: true, messageId: 'file-message-1' };
    },
  };
  const db = { prepare: () => ({ get: () => null, all: () => [], run() {} }) };
  const app = express();
  app.use(express.raw({ type: 'multipart/form-data', limit: '25mb' }));
  app.use((req, _res, next) => {
    if (Buffer.isBuffer(req.body)) req.rawBody = req.body;
    req.locale = 'en';
    req.t = (key) => key;
    next();
  });
  app.use(createWebRouter(handlers, db));

  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${server.address().port}`;

  const page = await fetch(`${base}/agents/gym/upload?toUid=visitor-1&channelType=1`);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /id="upload-to" value="visitor-1"/);
  assert.match(html, /type="hidden" id="upload-channel-type" value="1"/);
  assert.doesNotMatch(html, /<select id="upload-channel-type"/);
  assert.match(html, /id="upload-message"/);
  assert.match(html, /id="upload-submit-btn"[^>]*>发送附件<\/button>/);
  assert.doesNotMatch(html, /get_upload_url|upload_url|\/upload-file|Get URL/);

  const groupPage = await fetch(`${base}/agents/gym/upload?toUid=group-1&channelType=2`);
  const groupHtml = await groupPage.text();
  assert.match(groupHtml, /id="upload-to" value="group-1"/);
  assert.match(groupHtml, /type="hidden" id="upload-channel-type" value="2"/);
  assert.doesNotMatch(groupHtml, /<select id="upload-channel-type"/);

  const boundary = '----voko-test-boundary';
  const multipart = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="note.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n--${boundary}--\r\n`,
    'utf8',
  );
  const response = await fetch(`${base}/api/agents/gym/send-file?toUid=visitor-1&channelType=1&message=hello`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: multipart,
  });
  assert.deepEqual(await response.json(), { success: true, messageId: 'file-message-1' });
  assert.equal(sent.agentId, 'gym');
  assert.equal(sent.toUid, 'visitor-1');
  assert.equal(sent.channelType, 1);
  assert.equal(sent.message, 'hello');
  assert.equal(sent.fileName, 'note.txt');
});
