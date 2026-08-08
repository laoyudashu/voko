'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { migrateMcpConfigs } = require('../build/core/mcp-config-diagnostics');

test('MCP migration repairs JSON, TOML, and Goose YAML VOKO entries with backups', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voko-mcp-migration-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const jsonPath = path.join(dir, 'client.json');
  const tomlPath = path.join(dir, 'config.toml');
  const yamlPath = path.join(dir, 'goose.yaml');
  fs.writeFileSync(jsonPath, JSON.stringify({ mcpServers: { voko: { url: 'http://localhost:3002/mcp', token: 'secret' } } }));
  fs.writeFileSync(tomlPath, '[mcp_servers.voko]\nurl = "http://localhost:3002/mcp"\n');
  fs.writeFileSync(yamlPath, 'extensions:\n  voko:\n    uri: http://localhost:3002/mcp\n    token: secret\n');

  const result = migrateMcpConfigs({ paths: [
    { client: 'JSON', path: jsonPath },
    { client: 'Codex', path: tomlPath },
    { client: 'Goose', path: yamlPath },
  ] });

  assert.equal(result.changed, 3);
  assert.equal(result.errors, 0);
  assert.equal(fs.existsSync(`${jsonPath}.voko-mcp.bak`), true);
  assert.equal(fs.existsSync(`${tomlPath}.voko-mcp.bak`), true);
  assert.equal(fs.existsSync(`${yamlPath}.voko-mcp.bak`), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(jsonPath, 'utf8')).mcpServers.voko, { command: 'voko', args: ['mcp'] });
  assert.match(fs.readFileSync(tomlPath, 'utf8'), /command = "voko"[\s\S]*args = \["mcp"\]/);
  assert.match(fs.readFileSync(yamlPath, 'utf8'), /type: stdio[\s\S]*cmd: voko[\s\S]*args: \[mcp\]/);
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});
