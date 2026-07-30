const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { createMcpServer, getToolList } = require('../build/mcp/server');
const registry = require('../build/channels/registry');

describe('Lite MCP and channel contracts', () => {
  it('MCP tool list keeps unique names and object schemas', async () => {
    const handlers = new Proxy({}, { get: () => async () => ({ success: true }) });
    const tools = await getToolList(createMcpServer(handlers, { locale: 'zh' }));
    assert.ok(tools.length >= 50);
    assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length);
    for (const tool of tools) {
      assert.equal(typeof tool.description, 'string');
      assert.equal(tool.inputSchema?.type, 'object');
    }
  });

  it('channel registry exposes every configured channel definition', () => {
    const names = registry.getRegisteredNames();
    assert.deepEqual(names, ['voko-email']);
    for (const name of names) {
      const definition = registry.getChannelDef(name);
      assert.equal(typeof definition.displayName, 'string');
      assert.ok(Array.isArray(definition.configFields));
      assert.equal(typeof definition.handlerClass, 'string');
    }
  });
});
