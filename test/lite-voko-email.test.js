const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const buildRoot = path.join(__dirname, '..', 'build');
const { AgentEmailApi } = require(path.join(buildRoot, 'server', 'agent-email-api.js'));
const VokoEmailHandler = require(path.join(buildRoot, 'server', 'voko-email-handler.js'));

async function withFetch(implementation, run) {
  const original = global.fetch;
  global.fetch = implementation;
  try {
    await run();
  } finally {
    global.fetch = original;
  }
}

test('AgentEmailApi send 保持请求和成功返回契约', async () => {
  const api = new AgentEmailApi({
    apiBaseUrl: 'https://api.example.test/',
    getUserAccessToken: () => 'user-token',
  });

  await withFetch(async (url, options) => {
    assert.equal(url, 'https://api.example.test/api/external/v1/email/send');
    assert.equal(options.headers.Authorization, 'Bearer user-token');
    const body = JSON.parse(options.body);
    assert.equal(body.agentDid, 'did:voko:agent-1');
    assert.equal(body.template_data.CONTENT, '邮件正文');
    assert.equal(body.subject, '邮件标题');
    return new Response(JSON.stringify({
      success: true,
      data: {
        message_id: 'message-1',
        external_id: 'external-1',
      },
    }), { status: 200 });
  }, async () => {
    assert.deepEqual(await api.send('did:voko:agent-1', '邮件正文', {
      subject: '邮件标题',
      external_id: 'external-1',
    }), {
      message_id: 'message-1',
      external_id: 'external-1',
    });
  });
});

test('AgentEmailApi 拒绝 message_id 类型错误的成功响应', async () => {
  const api = new AgentEmailApi({
    apiBaseUrl: 'https://api.example.test',
    getUserAccessToken: () => 'user-token',
  });

  await withFetch(async () => new Response(JSON.stringify({
    success: true,
    data: { message_id: 123 },
  }), { status: 200 }), async () => {
    await assert.rejects(
      api.send('did:voko:agent-1', '邮件正文'),
      /邮件|message|rejected|拒绝/i,
    );
  });
});

test('queryReply 对损坏 data 返回 null', async () => {
  const api = new AgentEmailApi({
    apiBaseUrl: 'https://api.example.test',
    getUserAccessToken: () => 'user-token',
  });

  await withFetch(async () => new Response(JSON.stringify({
    success: true,
    data: 'invalid',
  }), { status: 200 }), async () => {
    assert.equal(await api.queryReply({ message_id: 'message-1' }), null);
  });
});

test('queryReply 将 404 标记为终态，供轮询器停止重试', async () => {
  const api = new AgentEmailApi({
    apiBaseUrl: 'https://api.example.test',
    getUserAccessToken: () => 'user-token',
  });

  await withFetch(async () => new Response(JSON.stringify({
    success: false,
    message: '邮件记录不存在或无权访问',
  }), { status: 404 }), async () => {
    const result = await api.queryReply({ message_id: 'stale-message' });
    assert.equal(result?.terminal, 'not_found');
    assert.equal(result?.has_reply, false);
  });
});

test('queryReply 对重复的非 JSON 网关响应只告警一次', async () => {
  const api = new AgentEmailApi({
    apiBaseUrl: 'https://api.example.test',
    getUserAccessToken: () => 'user-token',
  });
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    await withFetch(
      async () => new Response('<html><h1>Bad Gateway</h1></html>', {
        status: 502,
        headers: { 'Content-Type': 'text/html' },
      }),
      async () => {
        assert.equal(await api.queryReply({ message_id: 'message-1' }), null);
        assert.equal(await api.queryReply({ message_id: 'message-1' }), null);
      },
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].join(' '), /HTTP 502/);
  assert.doesNotMatch(warnings[0].join(' '), /Bad Gateway/);
});

test('pollReplies 每次只请求一页并保留十进制字符串游标', async () => {
  const api = new AgentEmailApi({
    apiBaseUrl: 'https://api.example.test',
    getUserAccessToken: () => 'user-token',
  });
  let requests = 0;
  await withFetch(async (url, options) => {
    requests += 1;
    assert.equal(url, 'https://api.example.test/api/external/v1/email/replies/poll');
    assert.deepEqual(JSON.parse(options.body), { cursor: '9007199254740993', limit: 100 });
    return new Response(JSON.stringify({ success: true, data: {
      events: [{ event_id: '9007199254740994', message_id: 'mail-1', external_id: 'oi-1',
        status: 'replied', raw_text: '同意', actor_email: 'owner@example.com',
        replied_at: '2026-08-24T13:30:00Z' }],
      next_cursor: '9007199254740994', has_more: true,
    } }), { status: 200 });
  }, async () => {
    const page = await api.pollReplies({ cursor: '9007199254740993', limit: 100 });
    assert.equal(page.events[0].event_id, '9007199254740994');
    assert.equal(page.has_more, true);
  });
  assert.equal(requests, 1);
});

test('pollReplies 对旧服务端 404 不回退逐 message_id 查询', async () => {
  const api = new AgentEmailApi({
    apiBaseUrl: 'https://api.example.test',
    getUserAccessToken: () => 'user-token',
  });
  let requests = 0;
  await withFetch(async () => {
    requests += 1;
    return new Response(JSON.stringify({ success: false }), { status: 404 });
  }, async () => {
    assert.equal(await api.pollReplies({ cursor: '0', limit: 100 }), null);
  });
  assert.equal(requests, 1);
});

test('VOKO Email Handler 从 Agent DID 构造邮件并保持 messageId 契约', async () => {
  const calls = [];
  const handler = new VokoEmailHandler({}, {
    agentEmailApi: {
      async send(...args) {
        calls.push(args);
        return { message_id: 'message-1', external_id: 'external-1' };
      },
    },
    db: {
      prepare(sql) {
        return {
          get: () => sql.includes('FROM agents')
            ? ({ did: 'did:voko:agent-1', agent_name: 'Gym' })
            : ({ nickname: '小明' }),
        };
      },
    },
    isEnabled: () => true,
  });

  const result = await handler.sendMessageToOwnerWithTracking(
    '需要主人确认',
    'visitor-1',
    'session-1',
    'agent-1',
  );
  assert.deepEqual(result, {
    messageId: 'message-1',
    sentMessageId: 'message-1',
  });
  assert.equal(calls[0][0], 'did:voko:agent-1');
  assert.equal(calls[0][1], '需要主人确认');
  assert.equal(calls[0][2].subject, '[VOKO] Gym 请求主人介入：小明（visitor-1）');
  assert.equal(calls[0][2].context.visitor_id, 'visitor-1');
});

test('VOKO Email Handler 在 Agent DID 缺失时不调用远端 API', async () => {
  let sent = false;
  const handler = new VokoEmailHandler({}, {
    agentEmailApi: {
      async send() {
        sent = true;
        return { message_id: 'unexpected' };
      },
    },
    db: {
      prepare() {
        return { get: () => ({ did: null, agent_name: 'Gym' }) };
      },
    },
  });

  await assert.rejects(
    handler.sendMessageToOwnerWithTracking('content', 'visitor', null, 'agent-1'),
  );
  assert.equal(sent, false);
});
