const { test, expect } = require('./fixtures');
const fs = require('node:fs');
const path = require('node:path');

function manifest() {
  return JSON.parse(fs.readFileSync(process.env.VOKO_E2E_SERVICES_FILE, 'utf8'));
}

function readMessages(channelId, agentId) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(manifest().dbPath, { readOnly: true });
  try {
    return db.prepare('SELECT id, content, is_me FROM messages WHERE agent_id=? AND channel_id=? ORDER BY rowid ASC')
      .all(agentId, channelId);
  } finally {
    db.close();
  }
}

async function callMcp(request, name, args, id = Date.now()) {
  const response = await request.post('/mcp', {
    data: { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
  });
  expect(response.ok()).toBeTruthy();
  const envelope = await response.json();
  expect(envelope.error).toBeUndefined();
  const text = envelope.result?.content?.find(item => item.type === 'text')?.text;
  expect(text).toBeTruthy();
  return JSON.parse(text);
}

async function setOwner(request, agentId, ownerEmail) {
  const response = await request.post('/__test__/agent-owner', { data: { agentId, ownerEmail } });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function inject(request, input) {
  const response = await request.post(`${manifest().services.api}/__test__/im/message`, { data: input });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

test('invalid local credentials cannot mutate protected Web APIs', async ({ request }) => {
  const denied = await request.post('/api/reload-web', {
    headers: { 'x-voko-token': 'wrong-test-token' },
  });
  expect(denied.status()).toBe(401);
  const health = await request.get('/health', { headers: { 'x-voko-token': 'wrong-test-token' } });
  expect(health.ok()).toBeTruthy();
});

test('MCP Agent ownership prevents cross-Agent history, sends, and uploads', async ({ request }, testInfo) => {
  const suffix = testInfo.repeatEachIndex || 0;
  const channelId = `e2e-security-isolation-${suffix}`;
  await setOwner(request, 'e2e-agent-2', 'another-owner@example.test');
  try {
    await inject(request, {
      toUid: 'e2e-im-uid-2', fromUid: 'e2e-visitor', channelId, channelType: 1,
      messageId: `230${suffix}1`, messageSeq: 23001 + suffix, content: 'isolated Agent message',
    });
    const history = await callMcp(request, 'voko_get_chat_history', {
      agentId: 'e2e-agent-2', channelId, channelType: 1,
    }, 23002 + suffix);
    expect(history).toMatchObject({ success: false, code: 'AGENT_OWNER_MISMATCH' });
    const sent = await callMcp(request, 'voko_send_message', {
      agentId: 'e2e-agent-2', toUid: channelId, content: 'unauthorized send', channelType: 1,
    }, 23003 + suffix);
    expect(sent).toMatchObject({ success: false, code: 'AGENT_OWNER_MISMATCH' });
    const uploaded = await callMcp(request, 'voko_upload_and_send_file', {
      agentId: 'e2e-agent-2', toUid: channelId, filePath: path.join(manifest().tempDir, 'missing.txt'),
    }, 23004 + suffix);
    expect(uploaded).toMatchObject({ success: false, code: 'AGENT_OWNER_MISMATCH' });
    expect(readMessages(channelId, 'e2e-agent-2')).toHaveLength(1);
    expect(readMessages(channelId, 'e2e-agent')).toHaveLength(0);
  } finally {
    await setOwner(request, 'e2e-agent-2', 'e2e-owner@example.test');
  }
});

test('oversized MCP attachment is rejected before OSS or message delivery', async ({ request }, testInfo) => {
  const suffix = testInfo.repeatEachIndex || 0;
  const channelId = `e2e-security-size-${suffix}`;
  const filePath = path.join(manifest().tempDir, `oversized-${suffix}.bin`);
  fs.writeFileSync(filePath, Buffer.alloc(25 * 1024 * 1024 + 1));
  const result = await callMcp(request, 'voko_upload_and_send_file', {
    agentId: 'e2e-agent', toUid: channelId, filePath,
  }, 23100 + suffix);
  expect(result.success).toBe(false);
  expect(result.error).toMatch(/25 MB|25MB|25/);
  expect(readMessages(channelId, 'e2e-agent')).toHaveLength(0);
});
