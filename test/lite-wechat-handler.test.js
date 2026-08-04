const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const test = require('node:test');

const handlerPath = path.join(
  __dirname,
  '..',
  'build',
  'server',
  'wechat-handler.js',
);

function loadHandler() {
  delete require.cache[require.resolve(handlerPath)];
  return require(handlerPath);
}

function createRequest(onEnd) {
  const request = new EventEmitter();
  request.body = '';
  request.write = (chunk) => {
    request.body += chunk;
  };
  request.end = () => onEnd?.(request);
  request.setTimeout = (_timeout, callback) => {
    request.timeoutCallback = callback;
  };
  request.destroy = () => {
    const error = new Error('aborted');
    error.code = 'ECONNRESET';
    request.emit('error', error);
  };
  return request;
}

async function withHttpsRequest(implementation, run) {
  const https = require('node:https');
  const original = https.request;
  https.request = implementation;
  try {
    await run();
  } finally {
    https.request = original;
  }
}

function emitJsonResponse(callback, payload) {
  const response = new EventEmitter();
  callback(response);
  response.emit('data', Buffer.from(JSON.stringify(payload)));
  response.emit('end');
}

test('fetchUpdates 等待本批微信消息处理完成后再返回', async () => {
  const WechatHandler = loadHandler();
  const handler = new WechatHandler({
    botToken: 'token',
    ownerUserId: 'owner',
  });
  let processingFinished = false;
  handler.processUpdates = async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    processingFinished = true;
  };

  await withHttpsRequest((_options, callback) => createRequest(() => {
    emitJsonResponse(callback, {
      ret: 0,
      get_updates_buf: 'cursor-2',
      msgs: [{ message_type: 1 }],
    });
  }), async () => {
    await handler.fetchUpdates();
  });

  assert.equal(processingFinished, true);
  assert.equal(handler.getUpdatesBuf, 'cursor-2');
});

test('stop 会中断并结束正在等待的微信长轮询', async () => {
  const WechatHandler = loadHandler();
  const handler = new WechatHandler({
    botToken: 'token',
    ownerUserId: 'owner',
  });
  handler.enabled = true;

  await withHttpsRequest(() => createRequest(), async () => {
    const pending = handler.fetchUpdates();
    handler.stop();
    await Promise.race([
      pending,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('fetchUpdates did not settle after stop')),
        100,
      )),
    ]);
  });

  assert.equal(handler._currentReq, null);
});

test('微信长轮询超时按空轮询收敛而不是报错', async () => {
  const WechatHandler = loadHandler();
  const handler = new WechatHandler({
    botToken: 'token',
    ownerUserId: 'owner',
  });
  handler.enabled = true;
  let request;

  await withHttpsRequest(() => {
    request = createRequest();
    return request;
  }, async () => {
    const pending = handler.fetchUpdates();
    request.timeoutCallback();
    await pending;
  });

  assert.equal(handler._currentReq, null);
});

test('非数组 msgs 被识别为无效微信响应', async () => {
  const WechatHandler = loadHandler();
  const handler = new WechatHandler({
    botToken: 'token',
    ownerUserId: 'owner',
  });

  await withHttpsRequest((_options, callback) => createRequest(() => {
    emitJsonResponse(callback, {
      ret: 0,
      msgs: { message_type: 1 },
    });
  }), async () => {
    await assert.rejects(handler.fetchUpdates(), /Invalid WeChat updates response/);
  });
});

test('畸形微信消息不会被静默丢弃并推进游标', async () => {
  const WechatHandler = loadHandler();
  const handler = new WechatHandler({
    botToken: 'token',
    ownerUserId: 'owner',
  });

  await withHttpsRequest((_options, callback) => createRequest(() => {
    emitJsonResponse(callback, {
      ret: 0,
      get_updates_buf: 'must-not-advance',
      msgs: [{
        message_type: 1,
        item_list: [null],
      }],
    });
  }), async () => {
    await assert.rejects(handler.fetchUpdates(), /Invalid WeChat message payload/);
  });

  assert.equal(handler.getUpdatesBuf, '');
});

test('只处理主人消息并等待主人回复回调完成', async () => {
  const WechatHandler = loadHandler();
  const replies = [];
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.map((value) => typeof value === 'string' ? value : JSON.stringify(value)).join(' '));
  let callbackFinished = false;
  const handler = new WechatHandler({
    botToken: 'token',
    ownerUserId: 'owner',
  }, {
    getInterventionByParentMsgId: (messageId) => messageId === 'context-1'
      ? { id: 'intervention-1' }
      : null,
    onOwnerReply: async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      replies.push(args);
      callbackFinished = true;
    },
  });

  try {
    await handler.processUpdates([
      {
        message_type: 1,
        from_user_id: 'other',
        message_id: 10,
        context_token: 'context-1',
        item_list: [{ type: 1, text_item: { text: '其他用户' } }],
      },
      {
        message_type: 1,
        from_user_id: 'owner',
        message_id: 11,
        context_token: 'context-1',
        item_list: [{ type: 1, text_item: { text: '主人回复' } }],
      },
    ]);
  } finally {
    console.log = originalLog;
  }

  assert.equal(callbackFinished, true);
  assert.equal(replies.length, 1);
  assert.equal(replies[0][1], '主人回复');
  assert.equal(replies[0][2], '11');
  assert.doesNotMatch(logs.join('\n'), /context-1|其他用户|主人回复|fromUserId|messageId.*(?:10|11)/);
});

test('sendMessageToOwnerWithTracking 保持微信消息 ID 返回契约', async () => {
  const WechatHandler = loadHandler();
  const handler = new WechatHandler({
    botToken: 'token',
    ownerUserId: 'owner',
  });

  await withHttpsRequest((options, callback) => createRequest((request) => {
    assert.equal(options.method, 'POST');
    const body = JSON.parse(request.body);
    assert.equal(body.msg.to_user_id, 'owner');
    assert.equal(body.msg.item_list[0].text_item.text, '需要主人确认');
    emitJsonResponse(callback, { ret: 0 });
  }), async () => {
    const result = await handler.sendMessageToOwnerWithTracking(
      '需要主人确认',
      'visitor-1',
      'session-1',
    );
    assert.match(result.messageId, /^msg_/);
    assert.equal(result.sentMessageId, result.messageId);
  });
});

test('二维码状态缺少 status 时拒绝畸形响应', async () => {
  const WechatHandler = loadHandler();
  const handler = new WechatHandler({
    botToken: 'token',
    ownerUserId: 'owner',
  });
  handler.qrCodeToken = 'qr-token';

  await withHttpsRequest((_options, callback) => createRequest(() => {
    emitJsonResponse(callback, { ret: 0 });
  }), async () => {
    await assert.rejects(
      handler.pollQrCodeStatus(),
      /Invalid WeChat QR status response/,
    );
  });
});
