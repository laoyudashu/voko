const { test, expect } = require('./fixtures');
const fs = require('node:fs');
const path = require('node:path');

function manifest() {
  return JSON.parse(fs.readFileSync(process.env.VOKO_E2E_SERVICES_FILE, 'utf8'));
}

function readMessages(channelId, agentId = 'e2e-agent') {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(manifest().dbPath, { readOnly: true });
  try {
    return db.prepare('SELECT id, content, content_type, is_me, client_msg_no FROM messages WHERE agent_id=? AND channel_id=? ORDER BY rowid ASC')
      .all(agentId, channelId);
  } finally {
    db.close();
  }
}

async function rpc(request, message, headers = {}) {
  const response = await request.post('/mcp', { data: message, headers });
  return { response, envelope: await response.json() };
}

async function callMcp(request, name, args, id = Date.now()) {
  const { response, envelope } = await rpc(request, {
    jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args },
  });
  expect(response.ok()).toBeTruthy();
  expect(envelope.error).toBeUndefined();
  const text = envelope.result?.content?.find(item => item.type === 'text')?.text;
  expect(text).toBeTruthy();
  return JSON.parse(text);
}

test('authenticated MCP negotiates the current protocol and exposes only the one-step attachment tool', async ({ request }) => {
  const initialized = await rpc(request, {
    jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } },
  });
  expect(initialized.response.ok()).toBeTruthy();
  expect(initialized.envelope.result).toMatchObject({
    protocolVersion: '2025-11-25',
    serverInfo: { name: 'voko' },
  });

  const listed = await rpc(request, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  expect(listed.response.ok()).toBeTruthy();
  const names = (listed.envelope.result?.tools || []).map(tool => tool.name);
  expect(names).toContain('voko_upload_and_send_file');
  expect(names).not.toContain('get_upload_url');
  expect(names).not.toContain('voko_get_upload_url');
  const upload = listed.envelope.result.tools.find(tool => tool.name === 'voko_upload_and_send_file');
  expect(JSON.stringify(upload.inputSchema)).toContain('message');
  expect(JSON.stringify(upload.inputSchema)).toContain('filePath');
});

test('MCP upload_and_send_file sends optional text before one attachment message', async ({ request }, testInfo) => {
  const suffix = testInfo.repeatEachIndex || 0;
  const channelId = `e2e-mcp-upload-${suffix}`;
  const filePath = path.join(manifest().tempDir, `mcp-upload-${suffix}.txt`);
  fs.writeFileSync(filePath, 'MCP E2E attachment body', 'utf8');
  const result = await callMcp(request, 'voko_upload_and_send_file', {
    agentId: 'e2e-agent',
    toUid: channelId,
    filePath,
    fileName: 'mcp-upload.txt',
    message: 'MCP attachment note',
    channelType: 1,
  }, 3000 + suffix);
  expect(result.success).toBe(true);
  expect(result.messageId || result.attachmentMessageId || result.fileMessageId).toBeTruthy();
  await expect.poll(() => readMessages(channelId).filter(row => row.is_me === 1).length).toBeGreaterThanOrEqual(2);
  const rows = readMessages(channelId).filter(row => row.is_me === 1);
  expect(rows.some(row => row.content === 'MCP attachment note')).toBe(true);
  const attachmentRows = rows.filter(row => Number(row.content_type) === 8 || String(row.content).includes('mcp-upload.txt'));
  expect(attachmentRows).toHaveLength(1);
  expect(rows.find(row => row.content === 'MCP attachment note').client_msg_no).toBeTruthy();
  expect(attachmentRows[0].client_msg_no).toBeTruthy();
});

test('unauthenticated MCP is denied while the guest bug-report API remains public', async ({ request }) => {
  const denied = await request.post('/mcp', {
    headers: { 'x-voko-token': '' },
    data: { jsonrpc: '2.0', id: 10, method: 'tools/list' },
  });
  expect(denied.status()).toBe(401);

  const guest = await request.post('/api/bug-report', {
    headers: { 'x-voko-token': '' },
    data: {
      title: `guest MCP boundary ${Date.now()}`,
      description: 'public guest report boundary test',
      severity: 'low',
    },
  });
  expect(guest.ok()).toBeTruthy();
  expect(await guest.json()).toMatchObject({ success: true });
});
