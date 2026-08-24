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
    const whoami = tools.find((tool) => tool.name === 'voko_whoami');
    assert.ok(whoami);
    assert.match(whoami.description, /select an Agent explicitly/);
    const registration = tools.find((tool) => tool.name === 'voko_manage_agent_registration');
    assert.ok(registration.inputSchema.properties.action.enum.includes('reselect_provider'));
    for (const field of ['tags', 'iconUrl', 'contactPhone', 'address']) {
      assert.ok(registration.inputSchema.properties[field], `missing registration field ${field}`);
    }
    assert.match(registration.inputSchema.properties.action.description, /reselect_provider/);
    const bindOnce = tools.find((tool) => tool.name === 'voko_bind_agent_instance_once');
    assert.deepEqual(bindOnce.inputSchema.required, ['agentId', 'backendInstanceId']);
    assert.equal(tools.some((tool) => tool.name === 'voko_prepare_identity_handshake' || tool.name === 'voko_complete_identity_handshake'), false);
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
